/**
 * Browser smoke test (Playwright driving the locally installed Chrome; no browser download).
 * Starts an isolated PHANTOM on :8794 (REAL backend on :8795) and walks the guided demo through the real UI:
 * create/move task -> contract shows fields -> generate -> parity -> start REAL -> switch -> create -> restart -> reload.
 * Requires `npm run build` first. Writes screenshots to artifacts/screenshots/.
 * Usage: node scripts/browser_smoke.mjs   (CHROME_PATH=/path/to/chrome to override)
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8794;
const REAL = 8795;
const BASE = `http://127.0.0.1:${PORT}`;
const shots = join(root, 'artifacts/screenshots');
mkdirSync(shots, { recursive: true });
if (!existsSync(join(root, 'web/dist/index.html'))) {
  console.error('Run `npm run build` first.');
  process.exit(1);
}

const data = mkdtempSync(join(tmpdir(), 'phantom-smoke-'));
const phantom = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.ts'], {
  cwd: root,
  env: { ...process.env, PHANTOM_PORT: String(PORT), REAL_PORT: String(REAL), PHANTOM_DATA_DIR: data, PHANTOM_ALLOWED_ORIGINS: BASE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
phantom.stdout.on('data', (d) => (log += d));
phantom.stderr.on('data', (d) => (log += d));

const checks = [];
const check = (name, ok) => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) throw new Error(name);
};

let browser;
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/__phantom/status`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  const apiCalls = [];
  page.on('request', (r) => r.url().includes('/api/') && apiCalls.push(`${r.method()} ${r.url()}`));

  await page.goto(BASE);
  await page.getByPlaceholder('What needs doing?').fill('Smoke task');
  await page.getByPlaceholder('Description (optional)').fill('created by Playwright');
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.locator('#board').getByText('Smoke task', { exact: true }).waitFor();
  check('task created through the UI appears on the board', true);
  await page.getByRole('button', { name: 'Move "Smoke task" right' }).click();
  await page.locator('#board').getByText('In progress').locator('..').getByText('Smoke task').waitFor().catch(() => {});
  await page.locator('#traffic tbody tr').filter({ hasText: 'PATCH' }).first().waitFor();
  check('PATCH request is visible in the live trace stream', true);
  await page.locator('#contract').getByText('/api/tasks').first().waitFor();
  await page.locator('#contract').getByRole('cell', { name: /^description/ }).first().waitFor({ timeout: 5000 });
  check('contract panel shows discovered /api/tasks with inferred fields', true);
  await page.screenshot({ path: join(shots, 'desktop-phantom.png'), fullPage: true });

  await page.getByRole('button', { name: 'Generate backend' }).click();
  await page.locator('#generate').getByText('Download ZIP').waitFor();
  check('backend generated with downloadable ZIP', true);
  await page.getByRole('button', { name: 'Run parity check' }).click();
  await page.locator('#verify').getByText(/checks match/).waitFor({ timeout: 30000 });
  check('parity check reports all checks matching', true);
  await page.getByRole('button', { name: 'Fuzz 200 steps' }).click();
  await page.locator('#verify').getByText(/Fuzz session \(seed 7, \d+ random operations\)/).waitFor({ timeout: 30000 });
  check('seeded fuzz session matches on both servers', (await page.locator('#verify [role=status]').textContent()).includes('checks match'));
  await page.getByRole('button', { name: 'Test a broken build' }).click();
  await page.locator('#verify').getByText(/Broken build caught/).waitFor({ timeout: 30000 });
  check('sabotaged build is caught by the verifier', true);

  // Shadow mode through the UI: start, use the TaskBoard, see matches and no differences, stop.
  await page.getByRole('button', { name: 'Start shadow mode' }).click();
  await page.locator('#shadow').getByText('Shadowing', { exact: true }).waitFor({ timeout: 20000 });
  await page.getByPlaceholder('What needs doing?').fill('Mirrored task');
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.locator('#shadow').getByText(/^[1-9]\d* matched$/).waitFor({ timeout: 15000 });
  check('shadow mode mirrors TaskBoard traffic with no differences', (await page.locator('#shadow [aria-label="Shadow totals"]').textContent()).includes('0 differ'));
  await page.getByRole('button', { name: 'Stop shadow' }).click();
  await page.locator('#shadow').getByText('Stopped', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Start generated backend' }).click();
  await page.locator('#real').getByText(`http://127.0.0.1:${REAL}`).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: /Point TaskBoard at/ }).click();
  await page.locator('#board').getByText('REAL', { exact: true }).waitFor();
  await page.locator('#board').getByText('Smoke task', { exact: true }).waitFor();
  check('migrated task visible from the REAL backend', apiCalls.some((c) => c.includes(`:${REAL}/api/tasks`)));
  await page.getByPlaceholder('What needs doing?').fill('Persisted in SQLite');
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.locator('#board').getByText('Persisted in SQLite', { exact: true }).waitFor();
  check('task POSTed to the REAL port', apiCalls.some((c) => c.startsWith('POST') && c.includes(`:${REAL}/api/tasks`)));
  const emulatorTasks = await (await fetch(`${BASE}/api/tasks`)).json();
  check('emulator never received the REAL-mode task', !emulatorTasks.some((t) => t.title === 'Persisted in SQLite'));

  await page.getByRole('button', { name: 'Restart process' }).click();
  await page.waitForTimeout(1500);
  await page.reload();
  await page.locator('#board').getByText('Persisted in SQLite', { exact: true }).waitFor({ timeout: 10000 });
  check('after process restart + page reload the task is still there', true);
  await page.locator('#contract').getByText('/api/tasks').first().waitFor({ timeout: 5000 }).catch(() => {});
  check('contract panel still populated after reload', (await page.locator('#contract').textContent()).includes('/api/tasks'));
  await page.screenshot({ path: join(shots, 'desktop-real.png'), fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await page.locator('#board').getByText('Persisted in SQLite', { exact: true }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) {
    const offenders = await page.evaluate(() => {
      const W = document.documentElement.clientWidth;
      return [...document.querySelectorAll('body *')]
        .filter((e) => e.getBoundingClientRect().right > W + 1)
        .slice(0, 8)
        .map((e) => `${e.tagName}.${String(e.className).slice(0, 60)} right=${Math.round(e.getBoundingClientRect().right)}`);
    });
    console.log('overflowing elements:', offenders);
  }
  check('mobile layout has no horizontal scroll', overflow <= 0);
  await page.screenshot({ path: join(shots, 'mobile.png'), fullPage: false });
  // Whole-demo runner, from a desktop viewport, with the confirm dialog accepted.
  await page.setViewportSize({ width: 1500, height: 1000 });
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Run the whole demo' }).click();
  await page.getByText('Demo finished, every step passed').waitFor({ timeout: 90000 });
  const demoText = await page.getByLabel('Demo progress').textContent();
  check('one-click demo ran every step', /Caught: \d+ of \d+ checks fail/.test(demoText) && /read back from the database/.test(demoText) && /the emulator has no such task/.test(demoText));
  await page.screenshot({ path: join(shots, 'demo-finished.png'), fullPage: false });
  await page.getByLabel('Demo progress').getByRole('button', { name: 'Close' }).click();
  check('shadow panel lists the contract-breaking requests as differences', (await page.locator('#shadow').textContent()).includes('Differ'));
  await page.locator('#drift').getByText(/\d+ breaking/).waitFor({ timeout: 10000 });
  check('drift panel reports breaking findings with evidence', (await page.locator('#drift').textContent()).includes('Breaking'));
  await page.locator('#drift').getByRole('button', { name: /is now integer/ }).first().click();
  check('drift evidence expands to the recorded request', (await page.locator('#drift').textContent()).includes('trace #'));
  await page.screenshot({ path: join(shots, 'shadow-drift.png'), fullPage: true });

  // HAR import through the file input.
  const har = { log: { entries: [
    { request: { method: 'POST', url: 'https://x.example/api/invoices', headers: [], postData: { text: '{"number":"INV-1","total":9.5}' } }, response: { status: 201, content: { text: '{"id":77}' } } },
    { request: { method: 'GET', url: 'https://x.example/api/invoices/77', headers: [] }, response: { status: 200, content: { text: '' } } },
    { request: { method: 'GET', url: 'https://x.example/logo.png', headers: [] }, response: { status: 200, content: { text: '' } } },
  ] } };
  await page.locator('input[aria-label="Import a HAR file"]').setInputFiles({ name: 'capture.har', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(har)) });
  await page.locator('#traffic').getByText(/Imported 2 of 3 requests into \/api\/invoices/).waitFor({ timeout: 10000 });
  await page.locator('#contract').getByText('/api/invoices').first().waitFor();
  check('HAR import teaches PHANTOM a new collection', true);
  check('no console errors', consoleErrors.length === 0 || (console.log(consoleErrors), false));
} catch (e) {
  console.error('ERROR', e.message);
  console.error(log.slice(-1500));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fetch(`${BASE}/__phantom/real/stop`, { method: 'POST' }).catch(() => {});
  phantom.kill('SIGTERM');
  await new Promise((r) => phantom.once('exit', r));
  rmSync(data, { recursive: true, force: true });
  console.log(`\n${checks.filter(Boolean).length}/${checks.length} browser smoke checks passed`);
}
