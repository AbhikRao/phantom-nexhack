/**
 * contractInference — deterministic schema + OpenAPI inference from recorded traces.
 * No ML: we merge the JSON types actually observed in request bodies and responses.
 */
import type { JsonValue } from './resourceEngine.ts';
import { RESOURCE_NAME, SERVER_FIELDS } from './resourceEngine.ts';
import type { TraceEvent } from './traceRecorder.ts';

export type PrimitiveType = 'string' | 'integer' | 'number' | 'boolean' | 'null' | 'object' | 'array';

export interface TypeNode {
  types: PrimitiveType[];
  /** Present when "object" is among types. */
  properties?: Record<string, FieldNode>;
  /** Present when "array" is among types: merged element type (types: [] when only empty arrays were seen). */
  items?: TypeNode;
}

export interface FieldNode extends TypeNode {
  /** How many observed writes contained this field. */
  seen: number;
  /** Up to 6 distinct observed scalar values (informational only, not enforced). */
  observedValues?: (string | number | boolean)[];
  /** True when the observed scalar values exceeded the cap. */
  manyValues?: boolean;
}

export interface OperationStats {
  method: string;
  route: string;
  count: number;
  statuses: Record<string, number>;
}

export interface ResourceContract {
  name: string;
  collectionPath: string;
  itemPath: string;
  /** Client-writable fields observed in POST/PUT/PATCH bodies that succeeded. */
  fields: Record<string, FieldNode>;
  /** Fields present in every successful POST body (empty when no POST was observed). */
  required: string[];
  createCount: number;
  operations: OperationStats[];
  /** Example record taken from a real response. */
  example?: JsonValue;
  firstSeen: string;
  lastSeen: string;
}

export interface InferredContract {
  generatedAt: string;
  traceCount: number;
  resources: ResourceContract[];
}

const MAX_OBSERVED_VALUES = 6;

export function typeOf(v: JsonValue): PrimitiveType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v as 'string' | 'boolean' | 'object';
}

function addType(types: PrimitiveType[], t: PrimitiveType): void {
  if (types.includes(t)) return;
  if (t === 'integer' && types.includes('number')) return;
  if (t === 'number') {
    const i = types.indexOf('integer');
    if (i >= 0) types.splice(i, 1);
  }
  types.push(t);
}

/** Merge a JSON value into a type node in place. */
export function mergeValue(node: TypeNode, value: JsonValue, depth = 0): void {
  const t = typeOf(value);
  addType(node.types, t);
  if (depth > 8) return;
  if (t === 'object') {
    node.properties ??= {};
    for (const [k, v] of Object.entries(value as Record<string, JsonValue>)) {
      if (!isSafeFieldName(k)) continue;
      const field = (node.properties[k] ??= { types: [], seen: 0 });
      field.seen++;
      mergeValue(field, v, depth + 1);
      trackValue(field, v);
    }
  } else if (t === 'array') {
    node.items ??= { types: [] };
    for (const item of value as JsonValue[]) mergeValue(node.items, item, depth + 1);
  }
}

function trackValue(field: FieldNode, v: JsonValue): void {
  if (v === null || typeof v === 'object') return;
  if (typeof v === 'string' && v.length > 40) {
    field.manyValues = true;
    return;
  }
  field.observedValues ??= [];
  if (field.observedValues.includes(v)) return;
  if (field.observedValues.length >= MAX_OBSERVED_VALUES) field.manyValues = true;
  else field.observedValues.push(v);
}

/** Field names that are safe to place in generated JSON/docs (no prototype pollution, sane length). */
export function isSafeFieldName(k: string): boolean {
  return k.length > 0 && k.length <= 64 && k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
}

export function inferContract(traces: TraceEvent[]): InferredContract {
  const byResource = new Map<string, ResourceContract & { root: TypeNode; postBodies: Record<string, unknown>[] }>();
  for (const t of traces) {
    if (!t.resource || !RESOURCE_NAME.test(t.resource)) continue;
    let r = byResource.get(t.resource);
    if (!r) {
      r = {
        name: t.resource,
        collectionPath: `/api/${t.resource}`,
        itemPath: `/api/${t.resource}/{id}`,
        fields: {},
        required: [],
        createCount: 0,
        operations: [],
        firstSeen: t.timestamp,
        lastSeen: t.timestamp,
        root: { types: [], properties: {} },
        postBodies: [],
      };
      byResource.set(t.resource, r);
    }
    r.lastSeen = t.timestamp;
    let op = r.operations.find((o) => o.method === t.method && o.route === t.route);
    if (!op) {
      op = { method: t.method, route: t.route, count: 0, statuses: {} };
      r.operations.push(op);
    }
    op.count++;
    op.statuses[t.status] = (op.statuses[t.status] ?? 0) + 1;

    const ok = t.status >= 200 && t.status < 300;
    const isWrite = t.method === 'POST' || t.method === 'PUT' || t.method === 'PATCH';
    if (ok && isWrite && !t.requestBodyRaw && t.requestBody && typeof t.requestBody === 'object' && !Array.isArray(t.requestBody)) {
      const userFields: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(t.requestBody)) if (!SERVER_FIELDS.has(k)) userFields[k] = v;
      mergeValue(r.root, userFields);
      if (t.method === 'POST') {
        r.createCount++;
        r.postBodies.push(userFields);
      }
    }
    if (ok && t.responseBody && typeof t.responseBody === 'object' && !Array.isArray(t.responseBody) && 'id' in t.responseBody) {
      r.example = t.responseBody;
    } else if (ok && !r.example && Array.isArray(t.responseBody) && t.responseBody.length > 0) {
      r.example = t.responseBody[0];
    }
  }

  const resources: ResourceContract[] = [];
  for (const r of [...byResource.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const fields = (r.root.properties ?? {}) as Record<string, FieldNode>;
    const required =
      r.postBodies.length === 0 ? [] : Object.keys(fields).filter((k) => r.postBodies.every((b) => Object.hasOwn(b, k))).sort();
    r.operations.sort((a, b) => (a.route + a.method).localeCompare(b.route + b.method));
    const { root: _root, postBodies: _p, ...rest } = r;
    resources.push({ ...rest, fields, required });
  }
  return { generatedAt: new Date().toISOString(), traceCount: traces.length, resources };
}

/* ------------------------------------------------------------------ OpenAPI ----------------------------------------------------------------- */

type Schema = Record<string, unknown>;

export function typeNodeToSchema(node: TypeNode): Schema {
  const types = node.types.length ? node.types : [];
  const schema: Schema = {};
  if (types.length === 1) schema.type = types[0];
  else if (types.length > 1) schema.type = [...types];
  if (node.properties && types.includes('object')) {
    schema.properties = Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, typeNodeToSchema(v)]));
  }
  if (node.items && types.includes('array')) schema.items = node.items.types.length ? typeNodeToSchema(node.items) : {};
  const f = node as FieldNode;
  if (f.observedValues && !f.manyValues && f.observedValues.length > 0) schema.examples = [...f.observedValues];
  return schema;
}

function pascal(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}

export function schemaNames(resource: string): { record: string; create: string; patch: string } {
  const base = pascal(resource);
  return { record: `${base}Record`, create: `${base}Create`, patch: `${base}Patch` };
}

const ERROR_SCHEMA = {
  type: 'object',
  required: ['error', 'message'],
  properties: { error: { type: 'string' }, message: { type: 'string' } },
};

export function buildOpenApi(contract: InferredContract, options: { serverUrl?: string; title?: string } = {}): Schema {
  const components: Record<string, Schema> = { Error: ERROR_SCHEMA };
  const paths: Record<string, Schema> = {};
  for (const r of contract.resources) {
    const names = schemaNames(r.name);
    const userProps = Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, typeNodeToSchema(v)]));
    components[names.create] = {
      type: 'object',
      description: `Inferred from ${r.createCount} observed create request(s). Additional properties are accepted.`,
      properties: userProps,
      required: r.required,
      additionalProperties: true,
    };
    components[names.patch] = { type: 'object', properties: userProps, additionalProperties: true };
    components[names.record] = {
      allOf: [
        { $ref: `#/components/schemas/${names.create}` },
        {
          type: 'object',
          required: ['id', 'createdAt', 'updatedAt'],
          properties: {
            id: { type: 'integer', minimum: 1 },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
      ],
    };
    const observed = (method: string, route: string) => r.operations.find((o) => o.method === method && o.route === route)?.count ?? 0;
    const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
    const json = (schema: Schema, example?: unknown) => ({
      'application/json': example === undefined ? { schema } : { schema, example },
    });
    const errorResponse = (description: string) => ({ description, content: json(ref('Error')) });
    const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } };
    const tag = [r.name];
    const scalarFilters = Object.entries(r.fields)
      .filter(([, f]) => f.types.some((t) => t === 'string' || t === 'integer' || t === 'number' || t === 'boolean'))
      .map(([k]) => ({ name: k, in: 'query', required: false, description: 'Exact-match filter', schema: { type: 'string' } }));

    paths[r.collectionPath] = {
      get: {
        tags: tag,
        operationId: `list${pascal(r.name)}`,
        summary: `List ${r.name}`,
        parameters: scalarFilters,
        'x-phantom-observed-count': observed('GET', r.collectionPath),
        responses: { '200': { description: 'All records, ascending id', content: json({ type: 'array', items: ref(names.record) }) } },
      },
      post: {
        tags: tag,
        operationId: `create${pascal(r.name)}`,
        summary: `Create a ${r.name} record`,
        'x-phantom-observed-count': observed('POST', r.collectionPath),
        requestBody: { required: true, content: json(ref(names.create)) },
        responses: {
          '201': { description: 'Created', content: json(ref(names.record), r.example) },
          '400': errorResponse('Invalid JSON or body does not match the inferred contract'),
        },
      },
    };
    paths[r.itemPath] = {
      parameters: [idParam],
      get: {
        tags: tag,
        operationId: `get${pascal(r.name)}`,
        'x-phantom-observed-count': observed('GET', r.itemPath),
        responses: { '200': { description: 'Record', content: json(ref(names.record)) }, '404': errorResponse('Not found') },
      },
      patch: {
        tags: tag,
        operationId: `update${pascal(r.name)}`,
        summary: 'Shallow-merge fields into the record',
        'x-phantom-observed-count': observed('PATCH', r.itemPath),
        requestBody: { required: true, content: json(ref(names.patch)) },
        responses: {
          '200': { description: 'Updated record', content: json(ref(names.record)) },
          '400': errorResponse('Invalid body'),
          '404': errorResponse('Not found'),
        },
      },
      put: {
        tags: tag,
        operationId: `replace${pascal(r.name)}`,
        summary: 'Replace all client fields (id and createdAt are preserved)',
        'x-phantom-observed-count': observed('PUT', r.itemPath),
        requestBody: { required: true, content: json(ref(names.create)) },
        responses: {
          '200': { description: 'Replaced record', content: json(ref(names.record)) },
          '400': errorResponse('Invalid body'),
          '404': errorResponse('Not found'),
        },
      },
      delete: {
        tags: tag,
        operationId: `delete${pascal(r.name)}`,
        'x-phantom-observed-count': observed('DELETE', r.itemPath),
        responses: { '204': { description: 'Deleted' }, '404': errorResponse('Not found') },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: options.title ?? 'Phantom inferred API',
      version: '0.1.0',
      description:
        `Inferred deterministically by PHANTOM from ${contract.traceCount} recorded HTTP interactions at ${contract.generatedAt}. ` +
        'Field types and required fields come from observed traffic only; business rules are not inferred. ' +
        'x-phantom-observed-count shows how often each operation was actually seen.',
    },
    servers: [{ url: options.serverUrl ?? 'http://127.0.0.1:8788' }],
    paths,
    components: { schemas: components },
  };
}
