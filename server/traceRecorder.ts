/**
 * traceRecorder — stores sanitized request/response events for every emulated /api call.
 * Secrets are redacted before anything is stored, streamed or persisted.
 */
import type { JsonValue } from './resourceEngine.ts';

export interface TraceEvent {
  seq: number;
  timestamp: string;
  method: string;
  /** Concrete path as requested, e.g. /api/tasks/3 */
  path: string;
  /** Raw query string without "?" ('' when absent). */
  query: string;
  /** Route pattern, e.g. /api/tasks/{id} */
  route: string;
  resource?: string;
  status: number;
  durationMs: number;
  requestHeaders: Record<string, string>;
  /** Parsed JSON request body; a string when the body was not valid JSON; undefined when empty. */
  requestBody?: JsonValue;
  /** True when requestBody holds the raw (unparseable) text rather than JSON. */
  requestBodyRaw?: boolean;
  responseBody?: JsonValue;
}

export const REDACTED = '[REDACTED]';
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token)$|token|secret|session|api[-_]?key/i;
const SENSITIVE_KEY = /password|passwd|secret|token|api[-_]?key|authorization|cookie|ssn|credit[-_]?card|cvv/i;
const KEPT_HEADERS = new Set(['content-type', 'accept', 'origin', 'user-agent', 'content-length']);

export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (SENSITIVE_HEADER.test(lower)) out[lower] = REDACTED;
    else if (KEPT_HEADERS.has(lower)) out[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export function redactBody(value: JsonValue | undefined, depth = 0): JsonValue | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (depth > 20) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactBody(v, depth + 1) as JsonValue);
  const out: { [k: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : (redactBody(v, depth + 1) as JsonValue);
  }
  return out;
}

export interface TraceInput {
  method: string;
  path: string;
  query: string;
  route: string;
  resource?: string;
  status: number;
  durationMs: number;
  headers: Record<string, string | string[] | undefined>;
  rawRequestBody?: string;
  responseBody?: JsonValue;
}

export class TraceRecorder {
  private events: TraceEvent[] = [];
  private seq = 0;
  private listeners = new Set<(e: TraceEvent) => void>();
  private readonly limit: number;
  constructor(limit = 5000) {
    this.limit = limit;
  }

  record(input: TraceInput): TraceEvent {
    let requestBody: JsonValue | undefined;
    let requestBodyRaw: boolean | undefined;
    if (input.rawRequestBody !== undefined && input.rawRequestBody !== '') {
      try {
        requestBody = redactBody(JSON.parse(input.rawRequestBody) as JsonValue);
      } catch {
        requestBody = input.rawRequestBody.slice(0, 2000);
        requestBodyRaw = true;
      }
    }
    const event: TraceEvent = {
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
      method: input.method.toUpperCase(),
      path: input.path,
      query: input.query,
      route: input.route,
      resource: input.resource,
      status: input.status,
      durationMs: Math.round(input.durationMs * 100) / 100,
      requestHeaders: redactHeaders(input.headers),
      requestBody,
      requestBodyRaw,
      responseBody: redactBody(input.responseBody),
    };
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    for (const l of this.listeners) l(event);
    return event;
  }

  all(): TraceEvent[] {
    return this.events;
  }

  load(events: TraceEvent[]): void {
    this.events = events.slice(-this.limit);
    this.seq = Math.max(0, ...this.events.map((e) => e.seq));
  }

  clear(): void {
    this.events = [];
    this.seq = 0;
  }

  subscribe(listener: (e: TraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
