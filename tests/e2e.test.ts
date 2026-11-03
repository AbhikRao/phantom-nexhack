// End-to-end: real HTTP traffic -> traces -> build -> independent generated process -> parity (pass + induced failure) -> REAL restart persistence.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPhantom } from '../server/app.ts';
import type { PhantomContext } from '../server/app.ts';
import type { BuildInfo } from '../server/backendGenerator.ts';
import type { ParityReport } from '../server/parityVerifier.ts';

let ctx: PhantomContext;
let base: string;
let dataDir: string;

async function api(method: string, path: string, body?: unknown, root = base) {
  const res = await fetch(root + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json', authorization: 'Bearer top-secret' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'phantom-e2e-'));
  ctx = await createPhantom({ dataDir, realPort: 0 });
  base = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await ctx.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('PHANTOM end to end', () => {
  let build: BuildInfo;

  it('emulates a task lifecycle and records sanitized traces', async () => {
    expect((await api('GET', '/api/tasks')).body).toEqual([]);
    const a = await api('POST', '/api/tasks', { title: 'Write pitch', description: 'two minutes', status: 'todo' });
    expect(a.status).toBe(201);
    const b = await api('POST', '/api/tasks', { title: 'Record demo', description: '', status: 'doing' });
    expect((await api('PATCH', `/api/tasks/${a.body.id}`, { status: 'done' })).body.status).toBe('done');
    expect((await api('DELETE', `/api/tasks/${b.body.id}`)).status).toBe(204);
    expect((await api('GET', `/api/tasks/${b.body.id}`)).status).toBe(404);
    expect((await api('POST', '/api/notes', { title: 'n1', content: 'c' })).status).toBe(201);

    const traces = (await api('GET', '/__phantom/traces')).body as { method: string; requestHeaders: Record<string, string> }[];
    expect(traces.map((t) => t.method)).toEqual(['GET', 'POST', 'POST', 'PATCH', 'DELETE', 'GET', 'POST']);
    expect(JSON.stringify(traces)).not.toContain('top-secret');
    const contract = (await api('GET', '/__phantom/contract')).body;
    expect(contract.resources.map((r: { name: string }) => r.name)).toEqual(['notes', 'tasks']);
    const openapi = (await api('GET', '/__phantom/openapi.json')).body;
    expect(Object.keys(openapi.paths)).toEqual(['/api/notes', '/api/notes/{id}', '/api/tasks', '/api/tasks/{id}']);
  });

  it('rejects control-plane calls from foreign origins', async () => {
    const res = await fetch(base + '/__phantom/reset', { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('generates a build and verifies parity against an independent process', async () => {
    const res = await api('POST', '/__phantom/builds');
    expect(res.status).toBe(200);
    build = res.body;
    expect(build.resources).toEqual(['notes', 'tasks']);
    const zip = await fetch(`${base}/__phantom/builds/${build.id}/download`);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect((await zip.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    const report = (await api('POST', `/__phantom/builds/${build.id}/parity`)).body as ParityReport;
    expect(report.summary.failed).toBe(0);
    expect(report.cases.filter((c) => c.source === 'trace')).toHaveLength(7);
    expect(report.generatedBase).not.toBe(report.emulatorBase);
  });

  it('detects an intentionally broken backend with a meaningful diff', async () => {
    const report = (await api('POST', `/__phantom/builds/${build.id}/parity`, { mutation: 'patch-ignores-body' })).body as ParityReport;
    expect(report.mutation).toBe('patch-ignores-body');
    expect(report.summary.failed).toBeGreaterThan(0);
    const patchCase = report.cases.find((c) => c.label === 'PATCH /api/tasks/{id}')!;
    expect(patchCase.pass).toBe(false);
    expect(patchCase.diffs).toContainEqual({ path: 'body.status', emulator: 'done', generated: 'todo' });
  });

  it('launches the REAL backend with migrated data that survives a restart', async () => {
    // Created AFTER the build was generated: migration must copy the emulator's data at launch time.
    expect((await api('POST', '/api/tasks', { title: 'Added after generate', description: '', status: 'todo' })).body.id).toBe(3);
    const launched = (await api('POST', '/__phantom/real/launch', { buildId: build.id, migrate: true })).body;
    expect(launched.running).toBe(true);
    const realBase = launched.url as string;
    expect(realBase).not.toBe(base);
    const migrated = (await api('GET', '/api/tasks', undefined, realBase)).body as { title: string }[];
    expect(migrated.map((t) => t.title)).toEqual(['Write pitch', 'Added after generate']);
    const created = await api('POST', '/api/tasks', { title: 'Only in REAL', description: 'sqlite', status: 'todo' }, realBase);
    expect(created.status).toBe(201);
    expect(created.body.id).toBe(4); // continues the emulator's id sequence; deleted id 2 is never reused
    expect(created.headers.get('x-phantom-generated-build')).toBe(build.id);
    // The emulator never saw it: the REAL backend is a separate implementation with its own storage.
    expect(((await api('GET', '/api/tasks')).body as { title: string }[]).some((t) => t.title === 'Only in REAL')).toBe(false);

    const restarted = (await api('POST', '/__phantom/real/restart')).body;
    expect(restarted.pid).not.toBe(launched.pid);
    const after = (await api('GET', '/api/tasks', undefined, restarted.url)).body as { title: string }[];
    expect(after.map((t) => t.title)).toEqual(['Write pitch', 'Added after generate', 'Only in REAL']);
    const bad = await api('POST', '/api/tasks', { title: 42 }, restarted.url);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('validation_failed');
    await api('POST', '/__phantom/real/stop');
  });
});
