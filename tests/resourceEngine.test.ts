import { describe, expect, it } from 'vitest';
import { ResourceEngine, parseApiPath } from '../server/resourceEngine.ts';

const json = (v: unknown) => JSON.stringify(v);

describe('ResourceEngine', () => {
  it('runs a full CRUD lifecycle on an undeclared collection', () => {
    const e = new ResourceEngine();
    expect(e.handle('GET', '/api/tasks', undefined)).toMatchObject({ status: 200, body: [] });
    const created = e.handle('POST', '/api/tasks', json({ title: 'A', status: 'todo' }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 1, title: 'A', status: 'todo' });
    expect(created.headers?.location).toBe('/api/tasks/1');
    expect(e.handle('PATCH', '/api/tasks/1', json({ status: 'done' })).body).toMatchObject({ id: 1, title: 'A', status: 'done' });
    expect(e.handle('PUT', '/api/tasks/1', json({ title: 'B' })).body).not.toHaveProperty('status');
    expect(e.handle('DELETE', '/api/tasks/1', undefined)).toMatchObject({ status: 204, body: undefined });
    expect(e.handle('GET', '/api/tasks/1', undefined).status).toBe(404);
  });

  it('never reuses ids and ignores server-managed fields in bodies', () => {
    const e = new ResourceEngine();
    e.handle('POST', '/api/notes', json({ t: 1 }));
    e.handle('DELETE', '/api/notes/1', undefined);
    const r = e.handle('POST', '/api/notes', json({ id: 99, createdAt: 'x', t: 2 }));
    expect(r.body).toMatchObject({ id: 2, t: 2 });
    expect((r.body as { createdAt: string }).createdAt).not.toBe('x');
  });

  it('returns coherent 400 / 404 / 405 errors', () => {
    const e = new ResourceEngine();
    expect(e.handle('POST', '/api/tasks', '{bad')).toMatchObject({ status: 400, body: { error: 'invalid_json' } });
    expect(e.handle('POST', '/api/tasks', '[1]')).toMatchObject({ status: 400, body: { error: 'invalid_body' } });
    expect(e.handle('POST', '/api/tasks', undefined).status).toBe(400);
    expect(e.handle('GET', '/api/tasks/abc', undefined).status).toBe(404);
    expect(e.handle('PATCH', '/api/tasks/5', '{}').status).toBe(404);
    expect(e.handle('POST', '/api/tasks/1', '{}')).toMatchObject({ status: 405, headers: { allow: 'GET, PATCH, PUT, DELETE' } });
    expect(e.handle('GET', '/api/a/1/b', undefined).status).toBe(404);
    expect(e.handle('GET', '/api/BAD', undefined).status).toBe(404);
  });

  it('supports exact-match query filters on scalar fields', () => {
    const e = new ResourceEngine();
    e.handle('POST', '/api/tasks', json({ status: 'todo', done: false }));
    e.handle('POST', '/api/tasks', json({ status: 'done', done: true }));
    const r = e.handle('GET', '/api/tasks', undefined, new URLSearchParams('status=done'));
    expect((r.body as unknown[]).length).toBe(1);
    expect((e.handle('GET', '/api/tasks', undefined, new URLSearchParams('done=false')).body as unknown[]).length).toBe(1);
    expect((e.handle('GET', '/api/tasks', undefined, new URLSearchParams('missing=x')).body as unknown[]).length).toBe(0);
  });

  it('snapshots and restores state', () => {
    const e = new ResourceEngine();
    e.handle('POST', '/api/tasks', json({ a: 1 }));
    const copy = new ResourceEngine();
    copy.restore(e.snapshot());
    expect(copy.handle('GET', '/api/tasks/1', undefined).status).toBe(200);
    expect(copy.handle('POST', '/api/tasks', json({ a: 2 })).body).toMatchObject({ id: 2 });
  });

  it('parses only the supported path shapes', () => {
    expect(parseApiPath('/api/tasks/')).toEqual({ ok: true, resource: 'tasks' });
    expect(parseApiPath('/api/tasks/7')).toEqual({ ok: true, resource: 'tasks', id: 7 });
    expect(parseApiPath('/api/tasks/..%2F')).toEqual({ ok: true, resource: 'tasks', id: null });
    expect(parseApiPath('/other/tasks').ok).toBe(false);
  });
});
