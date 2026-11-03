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
import { describeBuild, generateProject, renderSeed, writeProject, zipProject } from './backendGenerator.ts';
import type { RunningBackend } from './processManager.ts';
import { startGeneratedBackend } from './processManager.ts';
import type { ParityReport } from './parityVerifier.ts';
import { runParity } from './parityVerifier.ts';
import { generateFuzzTraces } from './fuzzGenerator.ts';
import { ShadowMode } from './shadowMode.ts';
import type { ShadowEvent } from './shadowMode.ts';
import { detectDrift } from './driftDetector.ts';
import { importHar } from './harImport.ts';

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

type BusEvent = { type: 'trace'; data: TraceEvent } | { type: 'reset' } | { type: 'build'; data: BuildInfo } | { type: 'real'; data: unknown } | { type: 'shadow'; data: unknown } | { type: 'shadow-event'; data: ShadowEvent } | { type: 'parity'; data: { id: string; buildId: string; summary: ParityReport['summary']; mutation: string | null } };

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
  const shadow = new ShadowMode({
    getBuild: (id) => {
      const b = builds.get(id);
      return b && !b.info.mutation ? { id: b.info.id, dir: b.info.dir, resources: b.info.resources } : undefined;
    },
    snapshot: () => engine.snapshot(),
    scratchDir: options.dataDir ? join(resolve(options.dataDir), 'shadow') : undefined,
    onEvent: (e) => emit({ type: 'shadow-event', data: e }),
    onStatus: () => emit({ type: 'shadow', data: shadow.status() }),
  });

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
    let seedFile: string | undefined;
    if (migrate) {
      // Copy the emulator's data as it is right now into a fresh database (not the snapshot taken at generate time).
      rmSync(realData, { recursive: true, force: true });
      mkdirSync(realData, { recursive: true });
      seedFile = join(dataDir, 'real-data', `${buildId}.seed.json`);
      writeFileSync(seedFile, renderSeed(engine.snapshot(), build.info.resources, new Date().toISOString()).content);
    }
    try {
      const started = await startGeneratedBackend({
        dir: build.info.dir,
        dataDir: realData,
        port: realPort,
        seedFile,
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
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

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
  /** The one path every emulated request takes (live traffic and HAR imports): engine, trace, shadow mirror. */
  const processApi = (method: string, target: string, raw: string | undefined, headers: Record<string, string | string[] | undefined>) => {
    const started = performance.now();
    const url = new URL(target, 'http://phantom.local');
    const result = engine.handle(method, url.pathname, raw, url.searchParams);
    if (recordTraces) {
      recorder.record({
        method,
        path: url.pathname,
        query: url.search.slice(1),
        route: result.route,
        resource: result.resource,
        status: result.status,
        durationMs: performance.now() - started,
        headers,
        rawRequestBody: raw,
        responseBody: result.body as JsonValue | undefined,
      });
    }
    if (shadow.isActive) {
      const wrote = method !== 'GET' && result.status >= 200 && result.status < 300;
      shadow.mirror({
        method,
        target: url.pathname + url.search,
        rawBody: raw,
        resource: result.resource,
        emulatorStatus: result.status,
        emulatorBody: result.body as JsonValue | undefined,
        afterWrite: wrote ? engine.snapshot() : undefined,
      });
    }
    return result;
  };

  const handleApi = async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = typeof req.body === 'string' ? req.body : undefined;
    const result = processApi(req.method, req.url, raw, req.headers);
    reply.header('x-phantom-engine', 'emulator');
    for (const [k, v] of Object.entries(result.headers ?? {})) reply.header(k, v);
    reply.code(result.status);
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
    shadow: shadow.status(),
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

  async function parityFor(build: StoredBuild, mutation?: Mutation, fuzz?: { seed: number; steps: number }): Promise<ParityReport> {
    const target = mutation ? createBuild(build.traces, mutation, false) : build;
    const emuCtx = await createPhantom({ recordTraces: false });
    const emuAddress = await emuCtx.app.listen({ port: 0, host: '127.0.0.1' });
    const genData = mkdtempSync(join(tmpdir(), 'phantom-parity-db-'));
    let generated: RunningBackend | undefined;
    try {
      generated = await startGeneratedBackend({ dir: target.info.dir, dataDir: genData, port: 0 });
      const report = await runParity({
        buildId: build.info.id,
        traces: fuzz ? generateFuzzTraces(inferContract(build.traces), fuzz.seed, fuzz.steps) : build.traces,
        caseSource: fuzz ? 'fuzz' : 'trace',
        fuzz,
        resources: target.info.resources,
        emulator: { base: emuAddress, stop: () => emuCtx.shutdown() },
        generated: { base: generated.base, stop: generated.stop },
        mutation,
      });
      if (fuzz) {
        const firstFailure = report.cases.find((c) => !c.pass && c.source === 'fuzz')?.n ?? null;
        const reqBody = { fuzz, ...(mutation ? { mutation } : {}) };
        report.reproduction = {
          seed: fuzz.seed,
          steps: fuzz.steps,
          buildId: build.info.id,
          firstFailureCase: firstFailure,
          command: `curl -s -X POST http://127.0.0.1:8787/__phantom/builds/${build.info.id}/parity -H 'content-type: application/json' -d '${JSON.stringify(reqBody)}'`,
          note: 'The session is generated from the build contract and the seed, so the same seed against the same build replays the identical operations.',
        };
      }
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
    const body = jsonBody<{ mutation?: string; fuzz?: { seed?: number; steps?: number } }>(req);
    const mutation = body.mutation || undefined;
    if (mutation !== undefined && mutation !== 'patch-ignores-body') throw httpError(400, 'invalid_mutation', 'Supported mutation: patch-ignores-body');
    let fuzz: { seed: number; steps: number } | undefined;
    if (body.fuzz !== undefined) {
      const seed = Number(body.fuzz.seed ?? 1);
      const steps = Number(body.fuzz.steps ?? 200);
      if (!Number.isInteger(seed) || !Number.isInteger(steps) || steps < 1 || steps > 1000) throw httpError(400, 'invalid_fuzz', 'fuzz needs an integer seed and steps between 1 and 1000');
      if (generateFuzzTraces(inferContract(b.traces), seed, 1).length === 0) throw httpError(409, 'nothing_to_fuzz', 'Fuzzing needs at least one recorded create request');
      fuzz = { seed, steps };
    }
    return parityFor(b, mutation as Mutation | undefined, fuzz);
  });

  app.get('/__phantom/parity', async () => parityReports);

  /* ---- drift: traffic recorded after the build was generated vs the contract the build was generated from ---- */
  app.get('/__phantom/builds/:id/drift', async (req) => {
    const b = getBuild((req.params as { id: string }).id);
    const fresh = recorder.all().filter((t) => t.timestamp > b.info.createdAt);
    return detectDrift(b.traces, fresh, b.info.id);
  });

  /* ---- live shadow mode ---- */
  app.get('/__phantom/shadow', async () => shadow.status());
  app.post('/__phantom/shadow/start', async (req) => {
    const buildId = jsonBody<{ buildId?: string }>(req).buildId ?? latestBuild()?.info.id;
    if (!buildId) throw httpError(409, 'no_build', 'Generate a backend first');
    if (!builds.has(buildId) || builds.get(buildId)!.info.mutation) throw httpError(404, 'build_not_found', 'Unknown build');
    await shadow.start(buildId);
    const status = shadow.status();
    if (status.error) throw httpError(502, 'shadow_failed', status.error);
    return status;
  });
  app.post('/__phantom/shadow/stop', async () => {
    await shadow.stop();
    return shadow.status();
  });
  app.post('/__phantom/shadow/resync', async () => {
    if (!shadow.isActive) throw httpError(409, 'not_running', 'Shadow mode is not running');
    await shadow.resync();
    return shadow.status();
  });

  /* ---- HAR import: learn from traffic captured elsewhere ---- */
  app.post('/__phantom/import/har', { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    let har: unknown;
    try {
      har = JSON.parse(typeof req.body === 'string' ? req.body : '');
    } catch {
      throw httpError(400, 'invalid_har', 'The file is not valid JSON');
    }
    try {
      return importHar(har, (method, target, raw, headers) => processApi(method, target, raw, headers));
    } catch (e) {
      throw httpError(400, 'invalid_har', (e as Error).message);
    }
  });

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
    await shadow.stop();
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
