// Durable SQLite persistence (node:sqlite, built into Node >= 22.13). One table per resource; client fields stored as JSON.
import { DatabaseSync } from 'node:sqlite';
import type { JsonObject } from './validate.ts';

const RESOURCE_NAME = /^[a-z][a-z0-9_-]{0,39}$/;

export interface StoredRecord extends JsonObject {
  id: number;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: number;
  data: string;
  created_at: string;
  updated_at: string;
}

function table(resource: string): string {
  // Resource names are validated against a strict identifier pattern, so quoting cannot be escaped.
  if (!RESOURCE_NAME.test(resource)) throw new Error(`Invalid resource name: ${resource}`);
  return `"res_${resource}"`;
}

function toRecord(row: Row): StoredRecord {
  const data = JSON.parse(row.data) as JsonObject;
  return { id: row.id, ...data, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class Store {
  readonly db: DatabaseSync;
  readonly file: string;

  constructor(file: string, resources: readonly string[]) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    for (const r of resources) {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table(r)} (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      );
    }
  }

  list(resource: string): StoredRecord[] {
    const rows = this.db.prepare(`SELECT id, data, created_at, updated_at FROM ${table(resource)} ORDER BY id ASC`).all() as unknown as Row[];
    return rows.map(toRecord);
  }

  get(resource: string, id: number): StoredRecord | undefined {
    const row = this.db.prepare(`SELECT id, data, created_at, updated_at FROM ${table(resource)} WHERE id = ?`).get(id) as unknown as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  count(resource: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table(resource)}`).get() as { n: number };
    return Number(row.n);
  }

  insert(resource: string, data: JsonObject, now: string): StoredRecord {
    const result = this.db
      .prepare(`INSERT INTO ${table(resource)} (data, created_at, updated_at) VALUES (?, ?, ?)`)
      .run(JSON.stringify(data), now, now);
    return this.get(resource, Number(result.lastInsertRowid))!;
  }

  /** Insert with an explicit id (used only to import an exported dataset). */
  importRecord(resource: string, record: StoredRecord): void {
    const { id, createdAt, updatedAt, ...data } = record;
    this.db
      .prepare(`INSERT OR REPLACE INTO ${table(resource)} (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(id, JSON.stringify(data), String(createdAt), String(updatedAt));
  }

  update(resource: string, id: number, data: JsonObject, now: string): StoredRecord | undefined {
    const result = this.db.prepare(`UPDATE ${table(resource)} SET data = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(data), now, id);
    return Number(result.changes) > 0 ? this.get(resource, id) : undefined;
  }

  delete(resource: string, id: number): boolean {
    const result = this.db.prepare(`DELETE FROM ${table(resource)} WHERE id = ?`).run(id);
    return Number(result.changes) > 0;
  }

  transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
