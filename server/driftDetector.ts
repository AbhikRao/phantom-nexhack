/**
 * driftDetector — compares traffic recorded AFTER a backend was generated with the contract that backend was built from.
 *
 * Findings are evidence-backed: each one lists real recorded requests. Severity reflects what the generated server would
 * actually do with that traffic (the validation rules in templates/backend/src/validate.ts):
 *   breaking: the generated server rejects it (404 unknown_resource, 400 type mismatch / missing required field)
 *   warning:  accepted, but the field/shape is not in the generated contract or OpenAPI document
 *   info:     handled by the generated server but never verified by parity
 */
import type { FieldNode, InferredContract, ResourceContract, TypeNode } from './contractInference.ts';
import { inferContract, typeOf } from './contractInference.ts';
import type { JsonValue } from './resourceEngine.ts';
import { SERVER_FIELDS } from './resourceEngine.ts';
import type { TraceEvent } from './traceRecorder.ts';

export type DriftKind = 'new_endpoint' | 'new_operation' | 'unexpected_field' | 'incompatible_type' | 'missing_required';
export type DriftSeverity = 'breaking' | 'warning' | 'info';

export interface DriftEvidence {
  seq: number;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  body?: JsonValue;
}

export interface DriftFinding {
  id: string;
  kind: DriftKind;
  severity: DriftSeverity;
  resource: string;
  field?: string;
  summary: string;
  expected?: string;
  observed?: string;
  count: number;
  evidence: DriftEvidence[];
  action: string;
}

export interface DriftReport {
  buildId?: string;
  baselineTraceCount: number;
  baselineResources: string[];
  newTraceCount: number;
  findings: DriftFinding[];
  summary: { breaking: number; warning: number; info: number; total: number };
}

const SEVERITY_ORDER: Record<DriftSeverity, number> = { breaking: 0, warning: 1, info: 2 };

function accepts(node: TypeNode, t: string): boolean {
  if (node.types.length === 0) return true;
  return node.types.includes(t as never) || (t === 'integer' && node.types.includes('number'));
}

/** Returns the first type mismatch found in `value` against `node`, with the dotted path where it occurs. */
function firstMismatch(node: TypeNode, value: JsonValue, path: string, depth = 0): { path: string; observed: string; expected: string } | undefined {
  const t = typeOf(value);
  if (!accepts(node, t)) return { path, observed: t, expected: node.types.join(' | ') };
  if (depth > 6) return undefined;
  if (t === 'object' && node.properties) {
    for (const [k, v] of Object.entries(value as Record<string, JsonValue>)) {
      const child = Object.hasOwn(node.properties, k) ? node.properties[k] : undefined;
      if (child) {
        const m = firstMismatch(child, v, `${path}.${k}`, depth + 1);
        if (m) return m;
      }
    }
  } else if (t === 'array' && node.items && node.items.types.length) {
    for (const [i, item] of (value as JsonValue[]).entries()) {
      const m = firstMismatch(node.items, item, `${path}[${i}]`, depth + 1);
      if (m) return m;
    }
  }
  return undefined;
}

export function detectDrift(baselineTraces: TraceEvent[], newTraces: TraceEvent[], buildId?: string): DriftReport {
  const baseline = inferContract(baselineTraces);
  const byName = new Map<string, ResourceContract>(baseline.resources.map((r) => [r.name, r]));
  const groups = new Map<string, DriftFinding>();

  const add = (key: string, base: Omit<DriftFinding, 'id' | 'count' | 'evidence'>, t: TraceEvent) => {
    let f = groups.get(key);
    if (!f) {
      f = { ...base, id: key, count: 0, evidence: [] };
      groups.set(key, f);
    }
    f.count++;
    if (f.evidence.length < 3) {
      f.evidence.push({ seq: t.seq, timestamp: t.timestamp, method: t.method, path: t.path + (t.query ? `?${t.query}` : ''), status: t.status, body: t.requestBody });
    }
  };

  let considered = 0;
  for (const t of newTraces) {
    if (!t.resource || t.status >= 400) continue;
    considered++;
    const r = byName.get(t.resource);
    if (!r) {
      add(`new_endpoint:${t.resource}`, {
        kind: 'new_endpoint',
        severity: 'breaking',
        resource: t.resource,
        summary: `/api/${t.resource} was never part of the generated backend`,
        observed: `${t.method} ${t.route}`,
        action: `The generated server answers 404 unknown_resource for /api/${t.resource}. Regenerate the backend to include it.`,
      }, t);
      continue;
    }
    if (!r.operations.some((o) => o.method === t.method && o.route === t.route)) {
      add(`new_operation:${t.resource}:${t.method}:${t.route}`, {
        kind: 'new_operation',
        severity: 'info',
        resource: t.resource,
        summary: `${t.method} ${t.route} was not seen before generation`,
        observed: `${t.method} ${t.route}`,
        action: 'The generated server implements all CRUD methods, but parity never verified this one. Regenerate and re-run the parity check.',
      }, t);
    }
    const isWrite = t.method === 'POST' || t.method === 'PUT' || t.method === 'PATCH';
    const body = t.requestBody;
    if (!isWrite || t.requestBodyRaw || !body || typeof body !== 'object' || Array.isArray(body)) continue;
    for (const [k, v] of Object.entries(body)) {
      if (SERVER_FIELDS.has(k)) continue;
      const field = Object.hasOwn(r.fields, k) ? (r.fields[k] as FieldNode) : undefined;
      if (!field) {
        add(`unexpected_field:${t.resource}:${k}`, {
          kind: 'unexpected_field',
          severity: 'warning',
          resource: t.resource,
          field: k,
          summary: `"${k}" is sent to /api/${t.resource} but is not in the generated contract`,
          observed: typeOf(v),
          action: 'The generated server stores it without type checks and it is missing from openapi.json and the generated types. Regenerate to include it.',
        }, t);
        continue;
      }
      const m = firstMismatch(field, v, k);
      if (m) {
        add(`incompatible_type:${t.resource}:${m.path}:${m.observed}`, {
          kind: 'incompatible_type',
          severity: 'breaking',
          resource: t.resource,
          field: m.path,
          summary: `"${m.path}" in /api/${t.resource} is now ${m.observed}, the contract says ${m.expected}`,
          expected: m.expected,
          observed: m.observed,
          action: 'The generated server rejects this with 400 validation_failed. Fix the client, or regenerate so the contract allows both types.',
        }, t);
      }
    }
    if (t.method === 'POST' || t.method === 'PUT') {
      for (const req of r.required) {
        if (!Object.hasOwn(body, req)) {
          add(`missing_required:${t.resource}:${req}`, {
            kind: 'missing_required',
            severity: 'breaking',
            resource: t.resource,
            field: req,
            summary: `${t.method} /api/${t.resource} no longer sends "${req}", which every earlier create included`,
            expected: 'present',
            observed: 'missing',
            action: `The generated server rejects this with 400 ("${req}" is required). Make the client send it, or regenerate so it becomes optional.`,
          }, t);
        }
      }
    }
  }

  const findings = [...groups.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count || a.id.localeCompare(b.id));
  const summary = { breaking: 0, warning: 0, info: 0, total: findings.length };
  for (const f of findings) summary[f.severity]++;
  return {
    buildId,
    baselineTraceCount: baselineTraces.length,
    baselineResources: baseline.resources.map((r) => r.name),
    newTraceCount: considered,
    findings,
    summary,
  };
}

export type { InferredContract };
