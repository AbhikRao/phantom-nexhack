/**
 * Acceptance C/E, black-box: record traffic in PHANTOM, download the generated ZIP, STOP PHANTOM, then
 * extract into a clean temp folder outside the repo, npm install, typecheck, run its own tests, start it on a
 * separate port, run the contract probe against it and verify persistence across a process restart.
 * Usage: node scripts/acceptance_generated.mjs   (needs network for `npm install` of the TypeScript dev dependency)
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PHANTOM_PORT = 8797;
const GEN_PORT = 8798;
const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}`);
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

function startProc(cmd, args, opts) {
  // detached => own process group, so stopping `npm start` also stops the node server it launched.
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...opts });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  return {
    child,
    log: () => log,
    stop: () =>
      new Promise((r) => {
        if (child.exitCode !== null || child.signalCode !== null) return r();
        child.once('exit', () => setTimeout(r, 200));
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }),
  };
}

const work = mkdtempSync(join(tmpdir(), 'phantom-acceptance-'));
let phantom, gen;
try {
  // 1. PHANTOM with an isolated data dir.
  phantom = startProc(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.ts'], {
    cwd: root,
    env: { ...process.env, PHANTOM_PORT: String(PHANTOM_PORT), PHANTOM_DATA_DIR: join(work, 'phantom-data'), REAL_PORT: '8796' },
  });
  await waitFor(`http://127.0.0.1:${PHANTOM_PORT}/__phantom/status`);
  const P = `http://127.0.0.1:${PHANTOM_PORT}`;
  const probe1 = run(process.execPath, ['scripts/contract_probe.mjs'], { cwd: root, env: { ...process.env, PHANTOM_API: P } });
  step('contract probe against PHANTOM emulator', probe1.ok, probe1.out.trim().split('\n').at(-1));
  for (const t of [
    { title: 'Seeded task', description: 'migrated from PHANTOM', status: 'doing' },
    { title: 'Second task', description: '', status: 'todo' },
  ]) {
    await fetch(`${P}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) });
  }
  const build = await (await fetch(`${P}/__phantom/builds`, { method: 'POST' })).json();
  step('generate build', !!build.id, `${build.id}: ${build.files.length} files, resources ${build.resources.join(', ')}`);
  const zipBytes = new Uint8Array(await (await fetch(`${P}/__phantom/builds/${build.id}/download`)).arrayBuffer());
  writeFileSync(join(work, 'backend.zip'), zipBytes);
  step('download ZIP', zipBytes.length > 1000, `${zipBytes.length} bytes`);

  // 2. Stop PHANTOM entirely before touching the generated backend.
  await phantom.stop();
  let phantomDown = false;
  try {
    await fetch(`${P}/__phantom/status`);
  } catch {
    phantomDown = true;
  }
  step('PHANTOM stopped (port refuses connections)', phantomDown);

  // 3. Extract into a clean folder outside the repo.
  const dest = join(work, 'extracted');
  for (const [name, data] of Object.entries(unzipSync(zipBytes))) {
    const target = resolve(dest, name);
    if (!target.startsWith(dest + '/')) throw new Error(`zip entry escapes: ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  const projectDir = join(dest, readdirSync(dest)[0]);
  step('extract ZIP to clean temp folder', true, projectDir);

  const install = run('npm', ['install', '--no-audit', '--no-fund'], { cwd: projectDir });
  step('npm install in extracted project', install.ok, install.out.trim().split('\n').at(-1));
  const typecheck = run('npm', ['run', 'typecheck'], { cwd: projectDir });
  step('npm run typecheck (generated TypeScript)', typecheck.ok, typecheck.ok ? 'tsc clean' : typecheck.out.slice(-800));
  const ownTests = run('npm', ['test'], { cwd: projectDir });
  step("generated project's own npm test", ownTests.ok, (ownTests.out.match(/# pass \d+/) || [''])[0]);

  // 4. Run it standalone on a separate port.
  const env = { ...process.env, PORT: String(GEN_PORT), DATA_DIR: join(projectDir, 'data'), SEED_FILE: 'seed.json' };
  gen = startProc('npm', ['start'], { cwd: projectDir, env });
  const G = `http://127.0.0.1:${GEN_PORT}`;
  const health = await (await waitFor(`${G}/health`)).json();
  step('generated backend health check', health.status === 'ok', `pid ${health.pid}, storage ${health.storage}, records ${JSON.stringify(health.records)}`);
  const seeded = await (await fetch(`${G}/api/tasks`)).json();
  step('migrated dataset imported from seed.json', seeded.some((t) => t.title === 'Seeded task'), `${seeded.length} task(s)`);
  const probe2 = run(process.execPath, ['scripts/contract_probe.mjs'], { cwd: root, env: { ...process.env, PHANTOM_API: G } });
  step('contract probe against GENERATED backend (PHANTOM stopped)', probe2.ok, probe2.out.trim().split('\n').at(-1));

  const created = await (await fetch(`${G}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Survives restart', description: 'sqlite', status: 'todo' }) })).json();
  await gen.stop();
  gen = startProc('npm', ['start'], { cwd: projectDir, env });
  const health2 = await (await waitFor(`${G}/health`)).json();
  const again = await fetch(`${G}/api/tasks/${created.id}`);
  step('record persists across process restart', again.status === 200 && health2.pid !== health.pid, `pid ${health.pid} -> ${health2.pid}`);
} catch (e) {
  if (!results.some((r) => !r.ok)) console.error('ERROR', e.message);
  if (phantom) console.error(phantom.log().slice(-1500));
  if (gen) console.error(gen.log().slice(-1500));
  process.exitCode = 1;
} finally {
  await gen?.stop();
  await phantom?.stop();
  rmSync(work, { recursive: true, force: true });
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} generated-backend acceptance steps passed`);
}
