// Portable verification report: built from real parity runs, never from estimates.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPhantom } from '../server/app.ts';
import type { PhantomContext } from '../server/app.ts';
import type { VerificationReport } from '../server/verificationReport.ts';
import { contractFingerprint } from '../server/verificationReport.ts';
import { inferContract } from '../server/contractInference.ts';
import { TraceRecorder } from '../server/traceRecorder.ts';

let ctx: PhantomContext, base: string, dataDir: string, buildId: string;
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, type: res.headers.get('content-type') ?? '', csp: res.headers.get('content-security-policy'), json: () => JSON.parse(text) };
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'phantom-report-'));
  ctx = await createPhantom({ dataDir, realPort: 0 });
  base = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  await api('POST', '/api/tasks', { title: '<script>alert(1)</script>', description: 'xss probe', status: 'todo' });
  await api('POST', '/api/tasks', { title: 'two', description: '', status: 'doing' });
  await api('PATCH', '/api/tasks/1', { status: 'done' });
  buildId = (await api('POST', '/__phantom/builds')).json().id;
});
afterAll(async () => {
  await ctx.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('verification report', () => {
  it('says "not verified" and claims nothing for a build nobody checked', async () => {
    const r = (await api('GET', `/__phantom/builds/${buildId}/report.json`)).json() as VerificationReport;
    expect(r.schema).toBe('phantom.verification-report/1');
    expect(r.verification.status).toBe('not verified');
    expect(r.verification.runs).toEqual([]);
    expect(r.build.manifest.length).toBe(r.build.files);
  });

  it('records real replay, fuzz and detection runs with mismatch evidence and a reproduction command', async () => {
    await api('POST', `/__phantom/builds/${buildId}/parity`, {});
    await api('POST', `/__phantom/builds/${buildId}/parity`, { fuzz: { seed: 5, steps: 80 } });
    await api('POST', `/__phantom/builds/${buildId}/parity`, { mutation: 'patch-ignores-body' });
    const r = (await api('GET', `/__phantom/builds/${buildId}/report.json`)).json() as VerificationReport;
    expect(r.verification.status).toBe('verified, all runs match');
    expect(r.verification.runs.map((x) => x.kind).sort()).toEqual(['fuzz', 'replay']);
    expect(r.verification.runs.every((x) => x.failed === 0 && x.passed === x.total)).toBe(true);
    const fuzz = r.verification.runs.find((x) => x.kind === 'fuzz')!;
    expect(fuzz).toMatchObject({ seed: 5, steps: 80 });
    expect(fuzz.reproduce).toContain(`/builds/${buildId}/parity`);
    // The sabotaged run is evidence that the check can fail, and does not pollute the build's verdict.
    expect(r.verification.detectionTests).toHaveLength(1);
    const det = r.verification.detectionTests[0];
    expect(det.failed).toBeGreaterThan(0);
    expect(det.mismatches[0].diffs[0]).toMatchObject({ path: 'body.status' });
    expect(r.verification.runs.some((x) => x.sabotaged)).toBe(false);
    expect(r.limitations.join(' ')).toMatch(/reference implementation/);
  });

  it('serves a standalone, escaped HTML page with no scripts and a locked-down CSP', async () => {
    const res = await api('GET', `/__phantom/builds/${buildId}/report.html`);
    expect(res.type).toContain('text/html');
    expect(res.csp).toContain("default-src 'none'");
    expect(res.text).not.toMatch(/<script/i);
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain(buildId);
    expect(res.text).toContain('verified, all runs match');
    expect(res.text).toContain('Mismatch evidence');
  });

  it('fingerprints the contract structure, not its timestamps or counts', () => {
    const make = (n: number) => {
      const r = new TraceRecorder();
      for (let i = 0; i < n; i++) r.record({ method: 'POST', path: '/api/a', query: '', route: '/api/a', resource: 'a', status: 201, durationMs: 1, headers: {}, rawRequestBody: JSON.stringify({ x: 'v' + i, y: 1 }), responseBody: { id: i + 1 } });
      return contractFingerprint(inferContract(r.all())).fingerprint;
    };
    expect(make(1)).toBe(make(1));
    expect(make(1)).toBe(make(3)); // same structure, more observations
    const r2 = new TraceRecorder();
    r2.record({ method: 'POST', path: '/api/a', query: '', route: '/api/a', resource: 'a', status: 201, durationMs: 1, headers: {}, rawRequestBody: JSON.stringify({ x: 'v', y: 'now text' }), responseBody: { id: 1 } });
    expect(contractFingerprint(inferContract(r2.all())).fingerprint).not.toBe(make(1)); // a type change changes it
  });

  it('404s for an unknown build', async () => {
    expect((await api('GET', '/__phantom/builds/nope/report.json')).status).toBe(404);
  });
});
