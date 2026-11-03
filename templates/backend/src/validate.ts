// Contract validation for the generated backend. Field types come from the schema PHANTOM inferred from observed traffic.

export type PrimitiveType = 'string' | 'integer' | 'number' | 'boolean' | 'null' | 'object' | 'array';

export interface TypeNode {
  types: PrimitiveType[];
  properties?: Record<string, TypeNode>;
  items?: TypeNode;
}

export interface ResourceSchema {
  /** Client-writable fields and their observed JSON types. Unknown extra fields are accepted. */
  fields: Record<string, TypeNode>;
  /** Fields that were present in every observed create request. */
  required: string[];
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

function typeOf(v: JsonValue): PrimitiveType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v as 'string' | 'boolean' | 'object';
}

function accepts(node: TypeNode, t: PrimitiveType): boolean {
  if (node.types.length === 0) return true;
  if (node.types.includes(t)) return true;
  return t === 'integer' && node.types.includes('number');
}

function checkValue(value: JsonValue, node: TypeNode, path: string, errors: string[], depth: number): void {
  const t = typeOf(value);
  if (!accepts(node, t)) {
    errors.push(`${path} must be ${node.types.join(' | ')} (got ${t})`);
    return;
  }
  if (depth > 8) return;
  if (t === 'object' && node.properties) {
    for (const [k, v] of Object.entries(value as JsonObject)) {
      const child = Object.hasOwn(node.properties, k) ? node.properties[k] : undefined;
      if (child) checkValue(v, child, `${path}.${k}`, errors, depth + 1);
    }
  } else if (t === 'array' && node.items && node.items.types.length > 0) {
    (value as JsonValue[]).forEach((item, i) => checkValue(item, node.items!, `${path}[${i}]`, errors, depth + 1));
  }
}

export function validateBody(body: JsonObject, schema: ResourceSchema, mode: 'create' | 'replace' | 'patch'): string[] {
  const errors: string[] = [];
  if (mode !== 'patch') {
    for (const field of schema.required) if (!Object.hasOwn(body, field)) errors.push(`${field} is required`);
  }
  for (const [k, v] of Object.entries(body)) {
    const node = Object.hasOwn(schema.fields, k) ? schema.fields[k] : undefined;
    if (node) checkValue(v, node, k, errors, 0);
  }
  return errors;
}
