// Shadow mode, drift detection, HAR import and reproducible fuzz reports, end to end over real HTTP and child processes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPhantom } from '../server/app.ts';
import type { PhantomContext } from '../server/app.ts';
import type { BuildInfo } from '../server/backendGenerator.ts';
import type { ParityReport } from '../server/parityVerifier.ts';
import type { DriftReport } from '../server/driftDetector.ts';
import type { ShadowStatus } from '../server/shadowMode.ts';

let ctx: PhantomContext;
let base: string;
let dataDir: string;
let build: BuildInfo;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function until<T>(fn: () => Promise<T | undefined | false>, label: string, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const shadowAfter = (n: number) => until(async () => {
  const s = (await api('GET', '/__phantom/shadow')).body as ShadowStatus;
  return s.mirrored >= n && !s.starting ? s : undefined;
}, `shadow to have mirrored ${n}`);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'phantom-shadow-'));
  ctx = await createPhantom({ dataDir, realPort: 0 });
  base = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  await api('POST', '/api/tasks', { title: 'one', description: 'a', status: 'todo' });
  await api('POST', '/api/tasks', { title: 'two', description: 'b', status: 'doing' });
  await api('PATCH', '/api/tasks/1', { status: 'done' });
  await new Promise((r) => setTimeout(r, 20)); // trace timestamps must be strictly before the build timestamp
  build = (await api('POST', '/__phantom/builds')).body;
  await new Promise((r) => setTimeout(r, 20));
});

afterAll(async () => {
  await ctx.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('drift detection', () => {
  it('reports nothing while traffic still matches the generated contract', async () => {
    const drift = (await api('GET', `/__phantom/builds/${build.id}/drift`)).body as DriftReport;
    expect(drift.findings).toEqual([]);
    expect(drift.baselineResources).toEqual(['tasks']);
  });
});

describe('live shadow mode', () => {
  let shadowUrl: string;

  it('mirrors live requests to an isolated generated backend and finds no difference on conforming traffic', async () => {
    const started = (await api('POST', '/__phantom/shadow/start', { buildId: build.id })).body as ShadowStatus;
    expect(started.active).toBe(true);
    shadowUrl = started.url!;
    expect(shadowUrl).not.toBe(base);
    // Seeded from the emulator's current data, not empty:
    expect(((await (await fetch(`${shadowUrl}/api/tasks`)).json()) as { title: string }[]).map((t) => t.title)).toEqual(['one', 'two']);

    await api('POST', '/api/tasks', { title: 'three', description: 'c', status: 'todo' });
    await api('PATCH', '/api/tasks/3', { status: 'done' });
    await api('GET', '/api/tasks?status=done');
    await api('DELETE', '/api/tasks/2');
    const s = await shadowAfter(4);
    expect(s.differed).toBe(0);
    expect(s.matched).toBe(4);
    expect(s.events.every((e) => e.pass && e.generatedStatus !== null)).toBe(true);
  });

  it('flags a request the generated backend would reject, then resyncs so later diffs are not cascades', async () => {
    const res = await api('POST', '/api/tasks', { title: 12345, description: 'wrong type', status: 'todo' });
    expect(res.status).toBe(201); // the emulator accepts anything
    const s = await shadowAfter(5);
    const bad = s.events.at(-1)!;
    expect(bad.pass).toBe(false);
    expect(bad.emulatorStatus).toBe(201);
    expect(bad.generatedStatus).toBe(400);
    expect(bad.diffs[0]).toEqual({ path: 'status', emulator: 201, generated: 400 });
    expect(bad.resynced).toBe(true);

    // After the resync, shadow and emulator agree again, including ids.
    const ok = await api('POST', '/api/tasks', { title: 'after', description: '', status: 'todo' });
    const s2 = await shadowAfter(6);
    expect(s2.events.at(-1)!.pass).toBe(true);
    expect(s2.events.at(-1)!.emulatorStatus).toBe(201);
    expect(ok.body.id).toBeGreaterThan(res.body.id);
    expect(s2.resyncs).toBe(1);
  });

  it('shows a brand-new endpoint as a difference without rebuilding the shadow', async () => {
    expect((await api('POST', '/api/projects', { name: 'new' })).status).toBe(201);
    const s = await shadowAfter(7);
    const e = s.events.at(-1)!;
    expect(e.pass).toBe(false);
    expect(e.generatedStatus).toBe(404);
    expect(e.resynced).toBe(false);
  });

  it('keeps demo and production data untouched', async () => {
    // The REAL backend was never started, and the shadow database lives in its own scratch directory.
    const status = (await api('GET', '/__phantom/status')).body;
    expect(status.real.running).toBe(false);
    const s = (await api('GET', '/__phantom/shadow')).body as ShadowStatus;
    expect(s.dataDir).toContain(join(dataDir, 'shadow'));
    expect(s.dataDir).not.toContain('real-data');
    // Emulator state is exactly what the requests above produced (ids 1,3,4,5; task 2 deleted).
    const tasks = (await api('GET', '/api/tasks')).body as { id: number; title: unknown }[];
    expect(tasks.map((t) => t.id)).toEqual([1, 3, 4, 5]);
    expect(tasks.find((t) => t.id === 4)!.title).toBe(12345);
  });

  it('feeds drift detection with the same requests, including evidence', async () => {
    await api('POST', '/api/tasks', { description: 'no title', status: 'todo', priority: 'high' });
    const drift = (await api('GET', `/__phantom/builds/${build.id}/drift`)).body as DriftReport;
    const kinds = new Map(drift.findings.map((f) => [`${f.kind}:${f.resource}:${f.field ?? ''}`, f]));
    expect(kinds.get('incompatible_type:tasks:title')).toMatchObject({ severity: 'breaking', expected: 'string', observed: 'integer' });
    expect(kinds.get('new_endpoint:projects:')).toMatchObject({ severity: 'breaking' });
    expect(kinds.get('unexpected_field:tasks:priority')).toMatchObject({ severity: 'warning', observed: 'string' });
    expect(kinds.get('missing_required:tasks:title')).toMatchObject({ severity: 'breaking' });
    expect(kinds.get('new_operation:tasks:POST:/api/tasks')).toBeUndefined(); // POST was seen before generation
    const typeFinding = kinds.get('incompatible_type:tasks:title')!;
    expect(typeFinding.evidence[0]).toMatchObject({ method: 'POST', path: '/api/tasks', status: 201 });
    expect(typeFinding.evidence[0].body).toMatchObject({ title: 12345 });
    expect(drift.findings[0].severity).toBe('breaking'); // breaking findings sort first
    expect(drift.summary.total).toBe(drift.findings.length);

    // Regenerating moves the baseline forward: the same traffic is no longer drift.
    const rebuilt = (await api('POST', '/__phantom/builds')).body as BuildInfo;
    expect(((await api('GET', `/__phantom/builds/${rebuilt.id}/drift`)).body as DriftReport).findings).toEqual([]);
  });

  it('stops cleanly and removes its scratch database', async () => {
    // Earlier tests' requests (including GETs) are mirrored too: wait for the queue to drain before reading the counter.
    await shadowAfter(9);
    const before = (await api('GET', '/__phantom/shadow')).body as ShadowStatus;
    expect(before.mirrored).toBe(9);
    const stopped = (await api('POST', '/__phantom/shadow/stop')).body as ShadowStatus;
    expect(stopped.active).toBe(false);
    expect(existsSync(before.dataDir!)).toBe(false);
    await expect(fetch(`${before.url}/health`)).rejects.toThrow();
    // Requests after stop are no longer mirrored.
    await api('GET', '/api/tasks');
    expect(((await api('GET', '/__phantom/shadow')).body as ShadowStatus).mirrored).toBe(before.mirrored);
  });
});

describe('reproducible fuzz failure reports', () => {
  it('fails the same operations for the same seed and ships a reproduction command', async () => {
    const run = async (seed: number) =>
      (await api('POST', `/__phantom/builds/${build.id}/parity`, { fuzz: { seed, steps: 150 }, mutation: 'patch-ignores-body' })).body as ParityReport;
    const a = await run(11);
    const b = await run(11);
    const c = await run(12);
    const failing = (r: ParityReport) => r.cases.filter((x) => !x.pass).map((x) => `${x.n}:${x.label}:${x.emulatorPath}`);
    expect(failing(a).length).toBeGreaterThan(0);
    expect(failing(a)).toEqual(failing(b));
    expect(c.cases.map((x) => x.emulatorPath)).not.toEqual(a.cases.map((x) => x.emulatorPath));
    expect(a.reproduction).toMatchObject({ seed: 11, steps: 150, buildId: build.id });
    expect(a.reproduction!.firstFailureCase).toBe(a.cases.find((x) => !x.pass)!.n);
    expect(a.reproduction!.command).toContain(`/__phantom/builds/${build.id}/parity`);
    const failed = a.cases.find((x) => !x.pass && x.method === 'PATCH')!;
    expect(failed.requestBody).toBeDefined(); // the report is self-contained
  });
});

describe('HAR import', () => {
  it('replays /api traffic from a HAR file, remaps ids and reports what it skipped', async () => {
    const entry = (method: string, url: string, req?: unknown, status = 200, resp?: unknown) => ({
      request: { method, url, headers: [{ name: 'Authorization', value: 'Bearer har-secret' }], postData: req === undefined ? undefined : { text: JSON.stringify(req) } },
      response: { status, content: { text: resp === undefined ? '' : JSON.stringify(resp) } },
    });
    const har = {
      log: {
        entries: [
          entry('POST', 'https://app.example.com/api/invoices', { number: 'INV-1', total: 12.5, paid: false }, 201, { id: 900 }),
          entry('PATCH', 'https://app.example.com/api/invoices/900', { paid: true }),
          entry('GET', 'https://app.example.com/api/invoices/900'),
          entry('GET', 'https://app.example.com/assets/logo.png'),
        ],
      },
    };
    const res = await api('POST', '/__phantom/import/har', har);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 4, imported: 3, skippedCount: 1, statusMismatches: 0, resources: ['invoices'] });
    const items = (await api('GET', '/api/invoices')).body as { id: number; paid: boolean; total: number }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 1, paid: true, total: 12.5 }); // HAR id 900 was remapped to the emulator's id 1
    const contract = (await api('GET', '/__phantom/contract')).body;
    const invoices = contract.resources.find((r: { name: string }) => r.name === 'invoices');
    expect(invoices.fields.total.types).toEqual(['number']);
    const traces = JSON.stringify((await api('GET', '/__phantom/traces')).body);
    expect(traces).not.toContain('har-secret');
    expect((await api('POST', '/__phantom/import/har', { nope: true })).status).toBe(400);
  });
});
