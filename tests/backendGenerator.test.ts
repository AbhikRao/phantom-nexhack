import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import { TraceRecorder } from '../server/traceRecorder.ts';
import { inferContract } from '../server/contractInference.ts';
import { generateProject, writeProject, zipProject, PATCH_MERGE_LINE } from '../server/backendGenerator.ts';

function contractWith(body: Record<string, unknown>) {
  const r = new TraceRecorder();
  r.record({ method: 'POST', path: '/api/tasks', query: '', route: '/api/tasks', resource: 'tasks', status: 201, durationMs: 1, headers: {}, rawRequestBody: JSON.stringify(body), responseBody: { id: 1 } });
  return inferContract(r.all());
}

describe('backend generator', () => {
  it('produces a complete standalone project that never references PHANTOM runtime code', () => {
    const files = generateProject(contractWith({ title: 'x' }), { buildId: 'build-test' });
    const paths = files.map((f) => f.path);
    for (const p of ['package.json', 'README.md', 'openapi.json', 'seed.json', 'src/server.ts', 'src/store.ts', 'src/validate.ts', 'src/resources.ts', 'test/crud.test.ts', 'PHANTOM_MANIFEST.json']) expect(paths).toContain(p);
    for (const f of files.filter((f) => f.path.endsWith('.ts'))) {
      const imports = [...f.content.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const i of imports) expect(i.startsWith('node:') || i.startsWith('./') || i.startsWith('../src/')).toBe(true);
    }
    const pkg = JSON.parse(files.find((f) => f.path === 'package.json')!.content);
    expect(pkg.dependencies).toBeUndefined();
  });

  it('keeps hostile field names inside JSON string literals (no code injection)', () => {
    const evil = "x'); process.exit(1); //";
    const files = generateProject(contractWith({ [evil]: 'v', 'a"b': 1, __proto__x: 2 }), { buildId: 'build-evil' });
    const src = files.find((f) => f.path === 'src/resources.ts')!.content;
    expect(src).toContain(JSON.stringify(evil));
    expect(src).not.toMatch(/^\s*process\.exit/m);
    // The schema object literal must round-trip as JSON.
    const literal = src.slice(src.indexOf('= {', src.indexOf('RESOURCES')) + 2, src.lastIndexOf('};') + 1);
    expect(Object.keys(JSON.parse(literal).tasks.fields)).toContain(evil);
  });

  it('applies the mutation only when asked and refuses path traversal on write', () => {
    const normal = generateProject(contractWith({ a: 1 }), { buildId: 'b1' }).find((f) => f.path === 'src/server.ts')!.content;
    const mutant = generateProject(contractWith({ a: 1 }), { buildId: 'b2', mutation: 'patch-ignores-body' }).find((f) => f.path === 'src/server.ts')!.content;
    expect(normal).toContain(PATCH_MERGE_LINE);
    expect(mutant).not.toContain(PATCH_MERGE_LINE);
    expect(mutant).toContain('MUTANT');
    const dir = mkdtempSync(join(tmpdir(), 'phantom-gen-'));
    try {
      expect(() => writeProject(dir, [{ path: '../escape.txt', content: 'x' }])).toThrow(/refusing/);
      expect(() => writeProject(dir, [{ path: '/etc/passwd', content: 'x' }])).toThrow(/refusing/);
      writeProject(dir, [{ path: 'ok/file.txt', content: 'fine' }]);
      expect(readFileSync(join(dir, 'ok/file.txt'), 'utf8')).toBe('fine');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(() => generateProject(contractWith({ a: 1 }), { buildId: '../x' })).toThrow();
  });

  it('zips every file under one folder', () => {
    const files = generateProject(contractWith({ a: 1 }), { buildId: 'b3' });
    const entries = unzipSync(zipProject(files, 'proj'));
    expect(Object.keys(entries).sort()).toEqual(files.map((f) => `proj/${f.path}`).sort());
    expect(strFromU8(entries['proj/package.json'])).toContain('phantom-generated-backend');
  });
});
