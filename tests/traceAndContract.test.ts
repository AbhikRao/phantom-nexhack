import { describe, expect, it } from 'vitest';
import { TraceRecorder, REDACTED } from '../server/traceRecorder.ts';
import { buildOpenApi, inferContract } from '../server/contractInference.ts';

function rec(r: TraceRecorder, method: string, path: string, status: number, body?: unknown, response?: unknown) {
  const resource = path.split('/')[2];
  return r.record({
    method,
    path,
    query: '',
    route: path.split('/').length > 3 ? `/api/${resource}/{id}` : `/api/${resource}`,
    resource,
    status,
    durationMs: 1,
    headers: { authorization: 'Bearer abc', cookie: 's=1', 'x-api-key': 'k', 'content-type': 'application/json' },
    rawRequestBody: body === undefined ? undefined : JSON.stringify(body),
    responseBody: response as never,
  });
}

describe('TraceRecorder', () => {
  it('redacts sensitive headers and body keys', () => {
    const r = new TraceRecorder();
    const e = rec(r, 'POST', '/api/users', 201, { name: 'a', password: 'p', nested: { apiKey: 'z' } }, { id: 1, token: 't' });
    expect(e.requestHeaders).toEqual({ authorization: REDACTED, cookie: REDACTED, 'x-api-key': REDACTED, 'content-type': 'application/json' });
    expect(e.requestBody).toEqual({ name: 'a', password: REDACTED, nested: { apiKey: REDACTED } });
    expect(e.responseBody).toEqual({ id: 1, token: REDACTED });
    expect(JSON.stringify(r.all())).not.toMatch(/Bearer abc|"p"|"z"/);
  });

  it('keeps raw invalid bodies as text and caps history', () => {
    const r = new TraceRecorder(3);
    for (let i = 0; i < 5; i++) r.record({ method: 'POST', path: '/api/x', query: '', route: '/api/x', status: 400, durationMs: 0, headers: {}, rawRequestBody: '{nope' });
    expect(r.all()).toHaveLength(3);
    expect(r.all()[0]).toMatchObject({ seq: 3, requestBody: '{nope', requestBodyRaw: true });
  });
});

describe('contract inference', () => {
  it('merges types, optional fields, arrays and required fields from observed traffic', () => {
    const r = new TraceRecorder();
    rec(r, 'POST', '/api/tasks', 201, { title: 'a', points: 1, tags: ['x'] }, { id: 1, title: 'a' });
    rec(r, 'POST', '/api/tasks', 201, { title: 'b', points: 2.5, due: null, tags: [] }, { id: 2, title: 'b' });
    rec(r, 'PATCH', '/api/tasks/1', 200, { status: 'done' }, { id: 1 });
    rec(r, 'POST', '/api/tasks', 400, { title: 5 });
    const c = inferContract(r.all());
    const tasks = c.resources[0];
    expect(tasks.name).toBe('tasks');
    expect(tasks.required).toEqual(['points', 'tags', 'title']);
    expect(tasks.fields.points.types).toEqual(['number']);
    expect(tasks.fields.title.types).toEqual(['string']);
    expect(tasks.fields.due.types).toEqual(['null']);
    expect(tasks.fields.tags.items?.types).toEqual(['string']);
    expect(tasks.fields.status.types).toEqual(['string']);
    expect(tasks.createCount).toBe(2);
    expect(tasks.operations.map((o) => `${o.method} ${o.route} ${o.count}`)).toContain('POST /api/tasks 3');

    const doc = buildOpenApi(c) as { openapi: string; paths: Record<string, Record<string, { 'x-phantom-observed-count'?: number }>>; components: { schemas: Record<string, { required?: string[] }> } };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(['/api/tasks', '/api/tasks/{id}']);
    expect(doc.paths['/api/tasks'].post['x-phantom-observed-count']).toBe(3);
    expect(doc.paths['/api/tasks/{id}'].patch['x-phantom-observed-count']).toBe(1);
    expect(doc.components.schemas.TasksCreate.required).toEqual(['points', 'tags', 'title']);
  });
});
