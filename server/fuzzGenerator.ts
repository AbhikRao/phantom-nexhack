/**
 * fuzzGenerator — builds a deterministic pseudo-random CRUD session from the inferred contract.
 *
 * It simulates the id allocation the emulator guarantees (per-collection counter, never reused) so each synthetic
 * request refers to ids that exist (or deliberately don't). Bodies always conform to the inferred contract, because the
 * emulator is permissive by design and parity is only meaningful for traffic the generated server must accept.
 * The same seed always yields the same session.
 */
import type { FieldNode, InferredContract, ResourceContract } from './contractInference.ts';
import type { JsonValue } from './resourceEngine.ts';
import type { TraceEvent } from './traceRecorder.ts';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'ship it', 'write docs', 'fix bug', ''];

interface Node {
  types: string[];
  properties?: Record<string, Node>;
  items?: Node;
  observedValues?: (string | number | boolean)[];
}

function valueFor(node: Node, rnd: () => number, depth = 0): JsonValue {
  const types = node.types.length ? node.types : ['string'];
  const t = types[Math.floor(rnd() * types.length)];
  switch (t) {
    case 'string':
      if (node.observedValues?.length && rnd() < 0.6) {
        const v = node.observedValues.filter((x) => typeof x === 'string');
        if (v.length) return v[Math.floor(rnd() * v.length)] as string;
      }
      return WORDS[Math.floor(rnd() * WORDS.length)];
    case 'integer':
      return Math.floor(rnd() * 100);
    case 'number':
      return Math.round(rnd() * 10000) / 100 + 0.5;
    case 'boolean':
      return rnd() < 0.5;
    case 'null':
      return null;
    case 'array': {
      if (depth > 3 || !node.items?.types.length) return [];
      return Array.from({ length: Math.floor(rnd() * 3) }, () => valueFor(node.items!, rnd, depth + 1));
    }
    case 'object': {
      const out: Record<string, JsonValue> = {};
      if (depth > 3) return out;
      for (const [k, v] of Object.entries(node.properties ?? {})) if (rnd() < 0.6) out[k] = valueFor(v, rnd, depth + 1);
      return out;
    }
  }
  return null;
}

function bodyFor(r: ResourceContract, rnd: () => number, mode: 'create' | 'patch' | 'replace'): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  const names = Object.keys(r.fields);
  for (const name of names) {
    const required = r.required.includes(name);
    const include = mode === 'patch' ? rnd() < 0.5 : required || rnd() < 0.5;
    if (include) out[name] = valueFor(r.fields[name] as FieldNode, rnd);
  }
  if (mode === 'patch' && names.length > 0 && Object.keys(out).length === 0) {
    const name = names[Math.floor(rnd() * names.length)];
    out[name] = valueFor(r.fields[name] as FieldNode, rnd);
  }
  return out;
}

export function generateFuzzTraces(contract: InferredContract, seed: number, steps: number): TraceEvent[] {
  // Only collections whose contract is meaningful to fuzz: at least one create was observed, so required fields are known.
  const resources = contract.resources.filter((r) => r.createCount > 0);
  if (resources.length === 0) return [];
  const rnd = mulberry32(seed);
  const live = new Map<string, number[]>();
  const nextId = new Map<string, number>();
  const traces: TraceEvent[] = [];
  const ts = new Date(0).toISOString();
  let seq = 0;

  const push = (method: string, resource: string, id: number | undefined, status: number, body?: unknown, response?: unknown, query = '') => {
    traces.push({
      seq: ++seq,
      timestamp: ts,
      method,
      path: id === undefined ? `/api/${resource}` : `/api/${resource}/${id}`,
      query,
      route: id === undefined ? `/api/${resource}` : `/api/${resource}/{id}`,
      resource,
      status,
      durationMs: 0,
      requestHeaders: {},
      requestBody: body as JsonValue | undefined,
      responseBody: response as JsonValue | undefined,
    });
  };

  for (let i = 0; i < steps; i++) {
    const r = resources[Math.floor(rnd() * resources.length)];
    const ids = live.get(r.name) ?? [];
    const pick = () => ids[Math.floor(rnd() * ids.length)];
    const roll = rnd();
    if (ids.length === 0 || roll < 0.3) {
      const id = nextId.get(r.name) ?? 1;
      nextId.set(r.name, id + 1);
      ids.push(id);
      live.set(r.name, ids);
      push('POST', r.name, undefined, 201, bodyFor(r, rnd, 'create'), { id });
    } else if (roll < 0.5) push('GET', r.name, pick(), 200);
    else if (roll < 0.65) push('PATCH', r.name, pick(), 200, bodyFor(r, rnd, 'patch'));
    else if (roll < 0.72) push('PUT', r.name, pick(), 200, bodyFor(r, rnd, 'replace'));
    else if (roll < 0.82) {
      const id = pick();
      live.set(r.name, ids.filter((x) => x !== id));
      push('DELETE', r.name, id, 204);
    } else if (roll < 0.9) {
      const stringFields = Object.entries(r.fields).filter(([, f]) => f.types.includes('string') && f.observedValues?.length);
      if (stringFields.length) {
        const [name, f] = stringFields[Math.floor(rnd() * stringFields.length)];
        const v = f.observedValues!.find((x) => typeof x === 'string') as string | undefined;
        push('GET', r.name, undefined, 200, undefined, undefined, `${name}=${encodeURIComponent(v ?? 'x')}`);
      } else push('GET', r.name, undefined, 200);
    } else if (roll < 0.95) {
      // A deleted or never-assigned id: both implementations must answer 404 the same way.
      push('GET', r.name, (nextId.get(r.name) ?? 1) + 50, 404);
    } else push('GET', r.name, undefined, 200);
  }
  return traces;
}
