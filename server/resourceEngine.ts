/**
 * resourceEngine — a deterministic, stateful in-memory REST collection store.
 *
 * Semantics (mirrored *independently* by the generated backend template):
 *   GET    /api/:resource        -> 200 JSON array (unknown resource -> [] and the resource is discovered)
 *   POST   /api/:resource        -> 201 created record { id, ...body, createdAt, updatedAt }
 *   GET    /api/:resource/:id    -> 200 record | 404
 *   PATCH  /api/:resource/:id    -> 200 merged record | 404
 *   PUT    /api/:resource/:id    -> 200 replaced record (id/createdAt preserved) | 404
 *   DELETE /api/:resource/:id    -> 204 | 404
 * Ids are per-collection positive integers that are never reused (deterministic for replay).
 * Server-managed fields (id, createdAt, updatedAt) in request bodies are ignored.
 * GET collection supports exact-match filters on top-level scalar fields (?status=done).
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type ResourceRecord = JsonObject & { id: number; createdAt: string; updatedAt: string };

export interface EngineResponse {
  status: number;
  body: JsonValue | undefined;
  headers?: Record<string, string>;
  /** The route pattern that handled the request, e.g. "/api/tasks/{id}". */
  route: string;
  resource?: string;
}

export interface EngineSnapshot {
  collections: Record<string, { nextId: number; records: ResourceRecord[] }>;
}

export const RESOURCE_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
export const SERVER_FIELDS = new Set(['id', 'createdAt', 'updatedAt']);
const MAX_COLLECTIONS = 32;
const MAX_RECORDS_PER_COLLECTION = 5000;

export function errorBody(error: string, message: string): JsonObject {
  return { error, message };
}

interface Collection {
  nextId: number;
  records: Map<number, ResourceRecord>;
}

export interface ResourceEngineOptions {
  now?: () => string;
}

export class ResourceEngine {
  private collections = new Map<string, Collection>();
  private now: () => string;
  /** Monotonic change counter so callers can debounce persistence. */
  version = 0;

  constructor(options: ResourceEngineOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  listResources(): string[] {
    return [...this.collections.keys()].sort();
  }

  snapshot(): EngineSnapshot {
    const collections: EngineSnapshot['collections'] = {};
    for (const [name, c] of this.collections) {
      collections[name] = { nextId: c.nextId, records: [...c.records.values()].map((r) => structuredClone(r)) };
    }
    return { collections };
  }

  restore(snapshot: EngineSnapshot): void {
    this.collections.clear();
    for (const [name, c] of Object.entries(snapshot.collections ?? {})) {
      if (!RESOURCE_NAME.test(name)) continue;
      const records = new Map<number, ResourceRecord>();
      for (const r of c.records ?? []) if (Number.isInteger(r.id) && r.id > 0) records.set(r.id, r);
      const maxId = Math.max(0, ...records.keys());
      this.collections.set(name, { nextId: Math.max(c.nextId ?? 1, maxId + 1), records });
    }
    this.version++;
  }

  reset(): void {
    this.collections.clear();
    this.version++;
  }

  /**
   * Handle one REST request. `path` is the URL pathname, `rawBody` the unparsed request body (or undefined),
   * `query` the decoded query parameters.
   */
  handle(method: string, path: string, rawBody: string | undefined, query: URLSearchParams = new URLSearchParams()): EngineResponse {
    const parsed = parseApiPath(path);
    if (!parsed.ok) {
      return { status: 404, route: '/api/*', body: errorBody('unsupported_route', parsed.message) };
    }
    const { resource, id } = parsed;
    const route = id === undefined ? `/api/${resource}` : `/api/${resource}/{id}`;
    method = method.toUpperCase();

    if (id === undefined) {
      if (method === 'GET') {
        const c = this.discover(resource);
        if (!c) return tooMany(route, resource);
        return { status: 200, route, resource, body: filterRecords([...c.records.values()], query) };
      }
      if (method === 'POST') {
        const body = parseObjectBody(rawBody);
        if (!body.ok) return { status: 400, route, resource, body: errorBody(body.error, body.message) };
        const c = this.discover(resource);
        if (!c) return tooMany(route, resource);
        if (c.records.size >= MAX_RECORDS_PER_COLLECTION) {
          return { status: 507, route, resource, body: errorBody('capacity', `Collection ${resource} is full`) };
        }
        const ts = this.now();
        const record: ResourceRecord = { id: c.nextId++, ...stripServerFields(body.value), createdAt: ts, updatedAt: ts };
        c.records.set(record.id, record);
        this.version++;
        return { status: 201, route, resource, body: record, headers: { location: `/api/${resource}/${record.id}` } };
      }
      return methodNotAllowed(route, resource, 'GET, POST');
    }

    if (!['GET', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
      return methodNotAllowed(route, resource, 'GET, PATCH, PUT, DELETE');
    }
    // Validate the body before existence so malformed writes are always 400 (same order in the generated backend).
    let body: JsonObject | undefined;
    if (method === 'PATCH' || method === 'PUT') {
      const b = parseObjectBody(rawBody);
      if (!b.ok) return { status: 400, route, resource, body: errorBody(b.error, b.message) };
      body = b.value;
    }
    const c = this.discover(resource);
    if (!c) return tooMany(route, resource);
    const existing = id === null ? undefined : c.records.get(id);
    if (!existing) {
      return { status: 404, route, resource, body: errorBody('not_found', `${resource} record not found`) };
    }
    if (method === 'GET') return { status: 200, route, resource, body: existing };
    if (method === 'DELETE') {
      c.records.delete(existing.id);
      this.version++;
      return { status: 204, route, resource, body: undefined };
    }
    const fields = stripServerFields(body!);
    const updated: ResourceRecord =
      method === 'PATCH'
        ? { ...existing, ...fields, id: existing.id, createdAt: existing.createdAt, updatedAt: this.now() }
        : { id: existing.id, ...fields, createdAt: existing.createdAt, updatedAt: this.now() };
    c.records.set(existing.id, updated);
    this.version++;
    return { status: 200, route, resource, body: updated };
  }

  private discover(resource: string): Collection | undefined {
    let c = this.collections.get(resource);
    if (!c) {
      if (this.collections.size >= MAX_COLLECTIONS) return undefined;
      c = { nextId: 1, records: new Map() };
      this.collections.set(resource, c);
      this.version++;
    }
    return c;
  }
}

type ParsedPath = { ok: true; resource: string; id?: number | null } | { ok: false; message: string };

/** id === null means "an id segment was present but is not a valid positive integer" (always 404). */
export function parseApiPath(path: string): ParsedPath {
  const segments = path.replace(/\/+$/, '').split('/').slice(1);
  if (segments[0] !== 'api' || segments.length < 2 || segments.length > 3) {
    return { ok: false, message: 'Phantom emulates /api/:resource and /api/:resource/:id only' };
  }
  const resource = segments[1];
  if (!RESOURCE_NAME.test(resource)) {
    return { ok: false, message: 'Resource names must match ^[a-z][a-z0-9_-]{0,39}$' };
  }
  if (segments.length === 2) return { ok: true, resource };
  const raw = segments[2];
  const id = /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null;
  return { ok: true, resource, id };
}

type BodyResult = { ok: true; value: JsonObject } | { ok: false; error: string; message: string };

export function parseObjectBody(raw: string | undefined): BodyResult {
  if (raw === undefined || raw.trim() === '') return { ok: false, error: 'invalid_body', message: 'Request body must be a JSON object' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid_json', message: 'Request body is not valid JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'invalid_body', message: 'Request body must be a JSON object' };
  }
  return { ok: true, value: value as JsonObject };
}

function stripServerFields(body: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(body)) if (!SERVER_FIELDS.has(k) && k !== '__proto__') out[k] = v;
  return out;
}

export function filterRecords(records: ResourceRecord[], query: URLSearchParams): ResourceRecord[] {
  const sorted = records.sort((a, b) => a.id - b.id);
  const filters = [...query.entries()];
  if (filters.length === 0) return sorted;
  return sorted.filter((r) =>
    filters.every(([k, v]) => {
      const field = Object.hasOwn(r, k) ? r[k] : undefined;
      if (field === undefined) return false;
      if (field === null) return v === 'null';
      if (typeof field === 'object') return false;
      return String(field) === v;
    }),
  );
}

function methodNotAllowed(route: string, resource: string, allow: string): EngineResponse {
  return { status: 405, route, resource, headers: { allow }, body: errorBody('method_not_allowed', `Allowed methods: ${allow}`) };
}

function tooMany(route: string, resource: string): EngineResponse {
  return { status: 507, route, resource, body: errorBody('capacity', `At most ${MAX_COLLECTIONS} collections are emulated`) };
}
