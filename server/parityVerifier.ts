/**
 * parityVerifier — replays recorded interactions against a clean emulator and a clean generated backend over real HTTP,
 * then compares status codes, response bodies and final persisted collection state.
 *
 * Normalization (the ONLY values not compared literally):
 *   - `id` of records: each side's ids are mapped to creation ordinals per resource ("<tasks#1>") so referential
 *     integrity is still checked (the n-th created record must be referred to consistently).
 *   - `createdAt` / `updatedAt` of records: replaced by "<timestamp>" only when they are valid ISO-8601 strings.
 */
import type { JsonValue } from './resourceEngine.ts';
import { parseApiPath } from './resourceEngine.ts';
import type { TraceEvent } from './traceRecorder.ts';

export interface Endpoint {
  base: string;
  stop: () => Promise<void>;
}

export interface Diff {
  path: string;
  emulator: unknown;
  generated: unknown;
}

export interface ParityCase {
  n: number;
  source: 'trace' | 'synthetic' | 'final-state';
  traceSeq?: number;
  label: string;
  method: string;
  emulatorPath: string;
  generatedPath: string;
  recordedStatus?: number;
  emulatorStatus: number;
  generatedStatus: number;
  pass: boolean;
  diffs: Diff[];
}

export interface ParityReport {
  id: string;
  buildId: string;
  mutation: string | null;
  startedAt: string;
  durationMs: number;
  emulatorBase: string;
  generatedBase: string;
  replayedTraces: number;
  skippedTraces: number;
  summary: { total: number; passed: number; failed: number };
  cases: ParityCase[];
  normalization: string[];
  notCovered: string[];
}

export const NORMALIZATION_RULES = [
  'Record `id` values are mapped to per-resource creation ordinals (<tasks#1>, <tasks#2>, ...) on each side independently, so referential integrity is still verified.',
  '`createdAt` / `updatedAt` on records are replaced by <timestamp> only if they are valid ISO-8601 date-times.',
  'Recorded request paths are rewritten so original ids point to the ids each side actually assigned.',
];

export const NOT_COVERED = [
  'Only operations present in the recorded traces (plus a few labelled synthetic edge cases) are checked.',
  'Contract validation (400 on type mismatch) exists only in the generated backend; the emulator is intentionally permissive, so it is not part of parity.',
  'Unknown collections: the emulator discovers them, the generated backend returns 404. Replay only touches collections in the contract.',
  'Authentication, authorization, relations and business rules are not inferred or verified.',
];

interface SideState {
  /** resource -> original recorded id -> id assigned on this side */
  idMap: Map<string, Map<number, number>>;
  /** resource -> side id -> creation ordinal */
  ordinals: Map<string, Map<number, number>>;
}

const newSide = (): SideState => ({ idMap: new Map(), ordinals: new Map() });

function rewritePath(path: string, resource: string, side: SideState): string {
  const parsed = parseApiPath(path);
  if (!parsed.ok || parsed.id === undefined || parsed.id === null) return path;
  const mapped = side.idMap.get(resource)?.get(parsed.id);
  return mapped === undefined ? path : `/api/${resource}/${mapped}`;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function normalizeRecord(value: JsonValue, resource: string, side: SideState): JsonValue {
  if (Array.isArray(value)) return value.map((v) => normalizeRecord(v, resource, side));
  if (!value || typeof value !== 'object' || !('id' in value)) return value;
  const out: Record<string, JsonValue> = { ...value };
  if (typeof out.id === 'number') {
    const ord = side.ordinals.get(resource)?.get(out.id);
    out.id = ord === undefined ? `<unmapped id ${out.id}>` : `<${resource}#${ord}>`;
  }
  for (const k of ['createdAt', 'updatedAt']) {
    if (typeof out[k] === 'string' && ISO.test(out[k] as string) && !Number.isNaN(Date.parse(out[k] as string))) out[k] = '<timestamp>';
  }
  return out;
}

export function deepDiff(a: unknown, b: unknown, path = '$', out: Diff[] = [], limit = 25): Diff[] {
  if (out.length >= limit) return out;
  if (Object.is(a, b)) return out;
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
  if (ta !== tb || (ta !== 'object' && ta !== 'array')) {
    out.push({ path, emulator: a, generated: b });
    return out;
  }
  if (ta === 'array') {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) out.push({ path: `${path}.length`, emulator: aa.length, generated: bb.length });
    for (let i = 0; i < Math.min(aa.length, bb.length); i++) deepDiff(aa[i], bb[i], `${path}[${i}]`, out, limit);
    return out;
  }
  const oa = a as Record<string, unknown>;
  const ob = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(oa), ...Object.keys(ob)])) {
    if (!Object.hasOwn(ob, k)) out.push({ path: `${path}.${k}`, emulator: oa[k], generated: '<missing>' });
    else if (!Object.hasOwn(oa, k)) out.push({ path: `${path}.${k}`, emulator: '<missing>', generated: ob[k] });
    else deepDiff(oa[k], ob[k], `${path}.${k}`, out, limit);
  }
  return out;
}

async function call(base: string, method: string, path: string, body?: string): Promise<{ status: number; body: JsonValue | undefined }> {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body,
  });
  const text = await res.text();
  let parsed: JsonValue | undefined;
  if (text) {
    try {
      parsed = JSON.parse(text) as JsonValue;
    } catch {
      parsed = `<non-JSON body: ${text.slice(0, 120)}>`;
    }
  }
  return { status: res.status, body: parsed };
}

function recordCreation(side: SideState, resource: string, originalId: number | undefined, created: JsonValue | undefined): void {
  if (!created || typeof created !== 'object' || Array.isArray(created) || typeof created.id !== 'number') return;
  const ord = (side.ordinals.get(resource) ?? side.ordinals.set(resource, new Map()).get(resource)!);
  ord.set(created.id, ord.size + 1);
  if (originalId !== undefined) (side.idMap.get(resource) ?? side.idMap.set(resource, new Map()).get(resource)!).set(originalId, created.id);
}

const REPLAYABLE = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const MAX_REPLAY = 1000;

export async function runParity(args: {
  buildId: string;
  traces: TraceEvent[];
  resources: string[];
  emulator: Endpoint;
  generated: Endpoint;
  mutation?: string;
}): Promise<ParityReport> {
  const started = Date.now();
  const cases: ParityCase[] = [];
  const emu = newSide();
  const gen = newSide();
  const resources = new Set(args.resources);
  const replayable = args.traces.filter((t) => t.resource && resources.has(t.resource) && REPLAYABLE.has(t.method)).slice(0, MAX_REPLAY);

  for (const t of replayable) {
    const resource = t.resource!;
    const body = t.requestBody === undefined ? undefined : t.requestBodyRaw ? String(t.requestBody) : JSON.stringify(t.requestBody);
    const qs = t.query ? `?${t.query}` : '';
    const emuPath = rewritePath(t.path, resource, emu) + qs;
    const genPath = rewritePath(t.path, resource, gen) + qs;
    const [e, g] = await Promise.all([call(args.emulator.base, t.method, emuPath, body), call(args.generated.base, t.method, genPath, body)]);
    if (t.method === 'POST' && t.status === 201) {
      const originalId = t.responseBody && typeof t.responseBody === 'object' && !Array.isArray(t.responseBody) && typeof t.responseBody.id === 'number' ? t.responseBody.id : undefined;
      if (e.status === 201) recordCreation(emu, resource, originalId, e.body);
      if (g.status === 201) recordCreation(gen, resource, originalId, g.body);
    }
    const diffs: Diff[] = [];
    if (e.status !== g.status) diffs.push({ path: 'status', emulator: e.status, generated: g.status });
    deepDiff(
      e.body === undefined ? undefined : normalizeRecord(e.body, resource, emu),
      g.body === undefined ? undefined : normalizeRecord(g.body, resource, gen),
      'body',
      diffs,
    );
    cases.push({
      n: cases.length + 1,
      source: 'trace',
      traceSeq: t.seq,
      label: `${t.method} ${t.route}`,
      method: t.method,
      emulatorPath: emuPath,
      generatedPath: genPath,
      recordedStatus: t.status,
      emulatorStatus: e.status,
      generatedStatus: g.status,
      pass: diffs.length === 0,
      diffs,
    });
  }

  // Labelled synthetic edge cases: deterministic error semantics both implementations must share.
  for (const resource of [...resources].sort()) {
    const synthetic: [string, string, string | undefined, string][] = [
      ['GET', `/api/${resource}/999999`, undefined, 'missing record -> 404'],
      ['PATCH', `/api/${resource}/999999`, '{}', 'patch missing record -> 404'],
      ['DELETE', `/api/${resource}/999999`, undefined, 'delete missing record -> 404'],
      ['POST', `/api/${resource}`, '{"broken": ', 'malformed JSON -> 400'],
      ['POST', `/api/${resource}`, '[1,2]', 'array body -> 400'],
    ];
    for (const [method, path, body, label] of synthetic) {
      const [e, g] = await Promise.all([call(args.emulator.base, method, path, body), call(args.generated.base, method, path, body)]);
      const diffs: Diff[] = [];
      if (e.status !== g.status) diffs.push({ path: 'status', emulator: e.status, generated: g.status });
      deepDiff(e.body, g.body, 'body', diffs);
      cases.push({ n: cases.length + 1, source: 'synthetic', label: `${method} /api/${resource}/… ${label}`, method, emulatorPath: path, generatedPath: path, emulatorStatus: e.status, generatedStatus: g.status, pass: diffs.length === 0, diffs });
    }
  }

  // Final persisted state of every collection.
  for (const resource of [...resources].sort()) {
    const path = `/api/${resource}`;
    const [e, g] = await Promise.all([call(args.emulator.base, 'GET', path), call(args.generated.base, 'GET', path)]);
    const diffs: Diff[] = [];
    if (e.status !== g.status) diffs.push({ path: 'status', emulator: e.status, generated: g.status });
    deepDiff(normalizeRecord(e.body ?? null, resource, emu), normalizeRecord(g.body ?? null, resource, gen), 'state', diffs);
    cases.push({ n: cases.length + 1, source: 'final-state', label: `final state of /api/${resource}`, method: 'GET', emulatorPath: path, generatedPath: path, emulatorStatus: e.status, generatedStatus: g.status, pass: diffs.length === 0, diffs });
  }

  const passed = cases.filter((c) => c.pass).length;
  return {
    id: `parity-${started.toString(36)}`,
    buildId: args.buildId,
    mutation: args.mutation ?? null,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    emulatorBase: args.emulator.base,
    generatedBase: args.generated.base,
    replayedTraces: replayable.length,
    skippedTraces: args.traces.length - replayable.length,
    summary: { total: cases.length, passed, failed: cases.length - passed },
    cases,
    normalization: NORMALIZATION_RULES,
    notCovered: NOT_COVERED,
  };
}
