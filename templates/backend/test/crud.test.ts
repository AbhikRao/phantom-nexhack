// Self-contained smoke test for the generated backend: starts the server on an ephemeral port with a throwaway database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESOURCES } from '../src/resources.ts';

async function start(dataDir: string): Promise<{ base: string; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, SEED_FILE: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /PHANTOM_GENERATED_LISTENING port=(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill('SIGTERM'); }),
  };
}

function sampleFor(resource: string): Record<string, unknown> {
  const schema = RESOURCES[resource];
  const body: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(schema.fields)) {
    const t = node.types[0];
    body[name] = t === 'integer' || t === 'number' ? 1 : t === 'boolean' ? true : t === 'null' ? null : t === 'array' ? [] : t === 'object' ? {} : 'sample';
  }
  return body;
}

test('CRUD lifecycle and persistence across restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'phantom-generated-test-'));
  try {
    for (const resource of Object.keys(RESOURCES)) {
      let server = await start(dataDir);
      const created = await fetch(`${server.base}/api/${resource}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sampleFor(resource)),
      });
      assert.equal(created.status, 201);
      const record = (await created.json()) as { id: number };
      assert.ok(Number.isInteger(record.id));
      await server.stop();

      server = await start(dataDir);
      const fetched = await fetch(`${server.base}/api/${resource}/${record.id}`);
      assert.equal(fetched.status, 200, 'record survives a restart');
      const del = await fetch(`${server.base}/api/${resource}/${record.id}`, { method: 'DELETE' });
      assert.equal(del.status, 204);
      const gone = await fetch(`${server.base}/api/${resource}/${record.id}`);
      assert.equal(gone.status, 404);
      await server.stop();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
