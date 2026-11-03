import { describe, expect, it } from 'vitest';
import { generateFuzzTraces } from '../server/fuzzGenerator.ts';
import { inferContract } from '../server/contractInference.ts';
import { TraceRecorder } from '../server/traceRecorder.ts';

function contract() {
  const r = new TraceRecorder();
  r.record({ method: 'POST', path: '/api/tasks', query: '', route: '/api/tasks', resource: 'tasks', status: 201, durationMs: 0, headers: {}, rawRequestBody: JSON.stringify({ title: 'a', done: false, tags: ['x'] }), responseBody: { id: 1 } });
  return inferContract(r.all());
}

describe('fuzz generator', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const c = contract();
    const a = generateFuzzTraces(c, 42, 100);
    expect(generateFuzzTraces(c, 42, 100)).toEqual(a);
    expect(generateFuzzTraces(c, 43, 100)).not.toEqual(a);
  });

  it('only refers to ids that its own simulation allocated, and only emits contract-conforming bodies', () => {
    const traces = generateFuzzTraces(contract(), 5, 400);
    const live = new Set<number>();
    let next = 1;
    for (const t of traces) {
      const id = Number(t.path.split('/')[3]);
      if (t.method === 'POST') {
        expect(t.responseBody).toEqual({ id: next });
        live.add(next++);
        expect(typeof (t.requestBody as { title: unknown }).title).toBe('string');
      } else if (t.status === 404) expect(live.has(id)).toBe(false);
      else if (Number.isFinite(id)) expect(live.has(id)).toBe(true);
      if (t.method === 'DELETE') live.delete(id);
    }
    expect(traces.some((t) => t.method === 'PATCH')).toBe(true);
  });

  it('returns nothing when no create was ever observed', () => {
    expect(generateFuzzTraces({ generatedAt: '', traceCount: 0, resources: [] }, 1, 10)).toEqual([]);
  });
});
