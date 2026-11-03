/** PHANTOM HTTP app: emulated /api namespace + /__phantom control plane + dashboard static files. */
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { EngineSnapshot, JsonValue } from './resourceEngine.ts';
import { ResourceEngine, errorBody } from './resourceEngine.ts';
import type { TraceEvent } from './traceRecorder.ts';
import { TraceRecorder } from './traceRecorder.ts';
import { buildOpenApi, inferContract } from './contractInference.ts';
import type { BuildInfo, GeneratedFile, Mutation } from './backendGenerator.ts';
import { describeBuild, generateProject, writeProject, zipProject } from './backendGenerator.ts';
import type { RunningBackend } from './processManager.ts';
import { startGeneratedBackend } from './processManager.ts';
import type { ParityReport } from './parityVerifier.ts';
import { runParity } from './parityVerifier.ts';

export interface PhantomOptions {
  /** Directory for state, traces, builds and REAL backend data. Omit for a purely in-memory instance. */
  dataDir?: string;
  recordTraces?: boolean;
  /** Serve the built dashboard from this directory when it exists. */
  webDist?: string;
  allowedOrigins?: string[];
  realPort?: number;
  bodyLimit?: number;
  logger?: boolean;
}

export const DEFAULT_ORIGINS = ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://127.0.0.1:5173', 'http://localhost:5173'];

interface StoredBuild {
  info: BuildInfo;
  files: GeneratedFile[];
  traces: TraceEvent[];
}

export interface PhantomContext {
  app: FastifyInstance;
  engine: ResourceEngine;
  recorder: TraceRecorder;
  flush: () => void;
  shutdown: () => Promise<void>;
}

type BusEvent = { type: 'trace'; data: TraceEvent } | { type: 'reset' } | { type: 'build'; data: BuildInfo } | { type: 'real'; data: unknown } | { type: 'parity'; data: { id: string; buildId: string; summary: ParityReport['summary']; mutation: string | null } };

export async function createPhantom(options: PhantomOptions = {}): Promise<PhantomContext> {
  const bodyLimit = options.bodyLimit ?? 1_048_576;
  const origins = new Set(options.allowedOrigins ?? DEFAULT_ORIGINS);
  const engine = new ResourceEngine();
  const recorder = new TraceRecorder();
  const recordTraces = options.recordTraces ?? true;
  const dataDir = options.dataDir ? resolve(options.dataDir) : undefined;
  const realPort = options.realPort ?? 8788;
  const builds = new Map<string, StoredBuild>();
  const parityReports: ParityReport[] = [];
  const listeners = new Set<(e: BusEvent) => void>();
  const emit = (e: BusEvent) => listeners.forEach((l) => l(e));
  recorder.subscribe((t) => emit({ type: 'trace', data: t }));

  /* ------------------------------------------------------------- persistence ------------------------------------------------------------ */
  const statePath = dataDir && join(dataDir, 'state.json');
  const tracesPath = dataDir && join(dataDir, 'traces.json');
  const buildsDir = dataDir && join(dataDir, 'builds');
  if (dataDir) {
    mkdirSync(buildsDir!, { recursive: true });
    if (existsSync(statePath!)) engine.restore(JSON.parse(readFileSync(statePath!, 'utf8')) as EngineSnapshot);
    if (existsSync(tracesPath!)) recorder.load(JSON.parse(readFileSync(tracesPath!, 'utf8')) as TraceEvent[]);
    for (const id of readdirSync(buildsDir!)) {
      const meta = join(buildsDir!, `${id}.build.json`);
      if (!/^[a-z0-9-]+$/.test(id) || !existsSync(meta)) continue;
      try {
        const stored = JSON.parse(readFileSync(meta, 'utf8')) as { info: BuildInfo; traces: TraceEvent[] };
        const files = stored.info.files.map((f) => ({ path: f.path, content: readFileSync(join(buildsDir!, id, f.path), 'utf8') }));
        builds.set(id, { info: stored.info, files, traces: stored.traces });
      } catch {
        /* ignore unreadable build */
      }
    }
  }
  let savedVersion = engine.version;
  let savedTraces = recorder.all().length ? recorder.all()[recorder.all().length - 1].seq : 0;
  const flush = () => {
    if (!dataDir) return;
    const last = recorder.all().at(-1)?.seq ?? 0;
    if (engine.version !== savedVersion) {
      writeFileSync(statePath!, JSON.stringify(engine.snapshot()));
      savedVersion = engine.version;
    }
    if (last !== savedTraces) {
      writeFileSync(tracesPath!, JSON.stringify(recorder.all()));
      savedTraces = last;
    }
  };
  const flushTimer = dataDir ? setInterval(flush, 300) : undefined;
  flushTimer?.unref();

  /* ------------------------------------------------------------- REAL backend ----------------------------------------------------------- */
  let real: (RunningBackend & { buildId: string; startedAt: string; dataDir: string; migrated: boolean }) | undefined;
  let realError: string | undefined;
  const realStatus = () => ({
    running: !!real && real.child.exitCode === null,
    port: real?.port ?? realPort,
    url: `http://127.0.0.1:${real?.port ?? realPort}`,
    buildId: real?.buildId,
    pid: real?.pid,
    startedAt: real?.startedAt,
    dataDir: real?.dataDir,
    migrated: real?.migrated,
    health: real?.health,
    logs: real?.logs.slice(-20) ?? [],
    error: realError,
  });
  async function launchReal(buildId: string, migrate: boolean) {
    const build = builds.get(buildId);
    if (!build || !dataDir) throw httpError(404, 'build_not_found', 'Unknown build');
    if (build.info.mutation) throw httpError(400, 'mutant_build', 'Mutation-test builds cannot be launched as the REAL backend');
    if (real) await real.stop();
    real = undefined;
    const realData = join(dataDir, 'real-data', buildId);
    try {
      const started = await startGeneratedBackend({
        dir: build.info.dir,
        dataDir: realData,
        port: realPort,
        seedFile: migrate ? join(build.info.dir, 'seed.json') : undefined,
        corsOrigins: [...origins].join(','),
      });
      real = { ...started, buildId, startedAt: new Date().toISOString(), dataDir: realData, migrated: migrate };
      realError = undefined;
      started.child.once('exit', () => emit({ type: 'real', data: realStatus() }));
    } catch (e) {
      realError = (e as Error).message;
      throw httpError(502, 'launch_failed', realError);
    } finally {
      emit({ type: 'real', data: realStatus() });
    }
    return realStatus();
  }

  /* ------------------------------------------------------------- Fastify app ------------------------------------------------------------ */
  const app = Fastify({ logger: options.logger ?? false, bodyLimit });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string', bodyLimit }, (_req, body, done) => done(null, body));

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string; error?: string }, _req, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status === 413) return reply.code(413).send(errorBody('payload_too_large', `Request body exceeds ${bodyLimit} bytes`));
    if (error.error && status < 500) return reply.code(status).send(errorBody(error.error, error.message));
    if (status >= 500) app.log.error(error);
    return reply.code(status).send(errorBody(status >= 500 ? 'internal_error' : 'bad_request', status >= 500 ? 'Unexpected server error' : error.message));
  });

  // Strict CORS: only the dashboard origins. Cross-origin calls from anything else are rejected outright.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin) return;
    if (!origins.has(origin)) {
      return reply.code(403).send(errorBody('origin_forbidden', 'Origin is not allowed'));
    }
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-expose-headers', 'location, x-phantom-engine');
    if (req.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      reply.header('access-control-allow-headers', 'content-type');
      return reply.code(204).send();
    }
  });

  /* ------------------------------------------------------------- emulated API ----------------------------------------------------------- */
  const handleApi = async (req: FastifyRequest, reply: FastifyReply) => {
    const started = performance.now();
    const url = new URL(req.url, 'http://phantom.local');
    const raw = typeof req.body === 'string' ? req.body : undefined;
    const result = engine.handle(req.method, url.pathname, raw, url.searchParams);
    reply.header('x-phantom-engine', 'emulator');
    for (const [k, v] of Object.entries(result.headers ?? {})) reply.header(k, v);
    reply.code(result.status);
    if (recordTraces) {
      recorder.record({
        method: req.method,
        path: url.pathname,
        query: url.search.slice(1),
        route: result.route,
        resource: result.resource,
        status: result.status,
        durationMs: performance.now() - started,
        headers: req.headers,
        rawRequestBody: raw,
        responseBody: result.body as JsonValue | undefined,
      });
    }
    if (result.body === undefined) return reply.send();
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(result.body));
  };
  app.all('/api', handleApi);
  app.all('/api/*', handleApi);

  /* ------------------------------------------------------------- control plane ---------------------------------------------------------- */
  const latestBuild = () => [...builds.values()].filter((b) => !b.info.mutation).sort((a, b) => b.info.createdAt.localeCompare(a.info.createdAt))[0];

  app.get('/__phantom/status', async () => ({
    engine: 'phantom',
    version: '0.1.0',
    resources: engine.listResources(),
    traceCount: recorder.all().length,
    persistent: !!dataDir,
    builds: [...builds.values()].filter((b) => !b.info.mutation).map((b) => b.info.id),
    latestBuild: latestBuild()?.info,
    real: realStatus(),
  }));

  app.get('/__phantom/traces', async (req) => {
    const q = req.query as { after?: string; limit?: string };
    const after = Number(q.after ?? 0) || 0;
    const limit = Math.min(Math.max(Number(q.limit ?? 500) || 500, 1), 5000);
    return recorder.all().filter((t) => t.seq > after).slice(-limit);
  });

  app.get('/__phantom/contract', async () => inferContract(recorder.all()));
  app.get('/__phantom/state', async () => engine.snapshot());

  app.get('/__phantom/openapi.json', async (req, reply) => {
    if ((req.query as { download?: string }).download) reply.header('content-disposition', 'attachment; filename="phantom-openapi.json"');
    return buildOpenApi(inferContract(recorder.all()), { serverUrl: `http://127.0.0.1:8787`, title: 'Phantom inferred API' });
  });

  app.post('/__phantom/reset', async () => {
    engine.reset();
    recorder.clear();
    flush();
    emit({ type: 'reset' });
    return { ok: true };
  });

  app.get('/__phantom/events', (req, reply) => {
    reply.hijack();
    const origin = req.headers.origin;
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...(origin && origins.has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
    });
    reply.raw.write(': connected\n\n');
    const listener = (e: BusEvent) => reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify('data' in e ? e.data : {})}\n\n`);
    listeners.add(listener);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    req.raw.on('close', () => {
      clearInterval(ping);
      listeners.delete(listener);
    });
  });

  let buildCounter = 0;
  function createBuild(traces: TraceEvent[], mutation?: Mutation, persist = true): StoredBuild {
    const contract = inferContract(traces);
    if (contract.resources.length === 0) throw httpError(409, 'no_traffic', 'No API traffic recorded yet — use the TaskBoard first');
    const createdAt = new Date().toISOString();
    const id = `${mutation ? 'mutant' : 'build'}-${Date.now().toString(36)}${(buildCounter++).toString(36)}`;
    const files = generateProject(contract, { buildId: id, seed: mutation ? undefined : engine.snapshot(), mutation, createdAt });
    const dir = persist && buildsDir ? join(buildsDir, id) : mkdtempSync(join(tmpdir(), `phantom-${id}-`));
    writeProject(dir, files);
    const info = describeBuild(id, dir, contract, files, { buildId: id, mutation, createdAt });
    const stored = { info, files, traces: traces.map((t) => structuredClone(t)) };
    if (persist && buildsDir) {
      writeFileSync(join(buildsDir, `${id}.build.json`), JSON.stringify({ info, traces: stored.traces }));
      builds.set(id, stored);
    }
    return stored;
  }

  app.post('/__phantom/builds', async () => {
    const build = createBuild(recorder.all());
    if (!buildsDir) builds.set(build.info.id, build);
    emit({ type: 'build', data: build.info });
    return build.info;
  });

  app.get('/__phantom/builds', async () => [...builds.values()].map((b) => b.info).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));

  const getBuild = (id: string) => {
    const b = builds.get(id);
    if (!b) throw httpError(404, 'build_not_found', 'Unknown build');
    return b;
  };

  app.get('/__phantom/builds/:id/file', async (req) => {
    const b = getBuild((req.params as { id: string }).id);
    const path = String((req.query as { path?: string }).path ?? '');
    // Only paths from the build's own manifest are served — never a filesystem path from the request.
    const file = b.files.find((f) => f.path === path);
    if (!file) throw httpError(404, 'file_not_found', 'Not a file of this build');
    return { path: file.path, content: file.content };
  });

  app.get('/__phantom/builds/:id/download', async (req, reply) => {
    const b = getBuild((req.params as { id: string }).id);
    const zip = zipProject(b.files, `phantom-backend-${b.info.id}`);
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename="phantom-backend-${b.info.id}.zip"`);
    return reply.send(Buffer.from(zip));
  });

  async function parityFor(build: StoredBuild, mutation?: Mutation): Promise<ParityReport> {
    const target = mutation ? createBuild(build.traces, mutation, false) : build;
    const emuCtx = await createPhantom({ recordTraces: false });
    const emuAddress = await emuCtx.app.listen({ port: 0, host: '127.0.0.1' });
    const genData = mkdtempSync(join(tmpdir(), 'phantom-parity-db-'));
    let generated: RunningBackend | undefined;
    try {
      generated = await startGeneratedBackend({ dir: target.info.dir, dataDir: genData, port: 0 });
      const report = await runParity({
        buildId: build.info.id,
        traces: build.traces,
        resources: target.info.resources,
        emulator: { base: emuAddress, stop: () => emuCtx.shutdown() },
        generated: { base: generated.base, stop: generated.stop },
        mutation,
      });
      parityReports.unshift(report);
      parityReports.splice(20);
      emit({ type: 'parity', data: { id: report.id, buildId: report.buildId, summary: report.summary, mutation: report.mutation } });
      return report;
    } finally {
      await generated?.stop();
      await emuCtx.shutdown();
      rmSync(genData, { recursive: true, force: true });
      if (mutation) rmSync(target.info.dir, { recursive: true, force: true });
    }
  }

  app.post('/__phantom/builds/:id/parity', async (req) => {
    const b = getBuild((req.params as { id: string }).id);
    const mutation = jsonBody<{ mutation?: string }>(req).mutation || undefined;
    if (mutation !== undefined && mutation !== 'patch-ignores-body') throw httpError(400, 'invalid_mutation', 'Supported mutation: patch-ignores-body');
    return parityFor(b, mutation as Mutation | undefined);
  });

  app.get('/__phantom/parity', async () => parityReports);

  app.get('/__phantom/real', async () => realStatus());
  app.post('/__phantom/real/launch', async (req) => {
    const body = jsonBody<{ buildId?: string; migrate?: boolean }>(req);
    const buildId = body.buildId ?? latestBuild()?.info.id;
    if (!buildId) throw httpError(409, 'no_build', 'Generate a backend first');
    return launchReal(buildId, body.migrate !== false);
  });
  app.post('/__phantom/real/restart', async () => {
    if (!real) throw httpError(409, 'not_running', 'REAL backend is not running');
    // Restart reuses the same database directory and never re-imports the seed, so surviving data proves persistence.
    return launchReal(real.buildId, false);
  });
  app.post('/__phantom/real/stop', async () => {
    if (real) await real.stop();
    real = undefined;
    emit({ type: 'real', data: realStatus() });
    return realStatus();
  });

  /* ------------------------------------------------------------- dashboard -------------------------------------------------------------- */
  if (options.webDist && existsSync(join(options.webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: resolve(options.webDist), prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/__phantom') && !req.url.startsWith('/api')) return reply.sendFile('index.html');
      return reply.code(404).send(errorBody('not_found', 'Route not found'));
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/html').send('<h1>PHANTOM engine running</h1><p>Dashboard not built. Run <code>npm run build</code> or <code>npm run dev</code> (Vite on :5173).</p>'),
    );
  }

  const shutdown = async () => {
    if (flushTimer) clearInterval(flushTimer);
    flush();
    if (real) await real.stop();
    real = undefined;
    await app.close();
  };

  return { app, engine, recorder, flush, shutdown };
}

function jsonBody<T extends object>(req: FastifyRequest): Partial<T> {
  if (typeof req.body !== 'string' || req.body.trim() === '') return {};
  try {
    const v = JSON.parse(req.body) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Partial<T>;
  } catch {
    /* fall through */
  }
  throw httpError(400, 'invalid_body', 'Control requests take a JSON object body');
}

function httpError(statusCode: number, error: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, error });
}
