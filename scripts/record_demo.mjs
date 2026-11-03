/**
 * Records a screen capture of PHANTOM's guided demo with Playwright (installed Chrome, no download).
 * Starts an isolated PHANTOM on :8796 (generated backend on :8797), types a few tasks by hand through the real UI,
 * then lets "Run the whole demo" drive the rest. Output: artifacts/demo.webm (not committed; see .gitignore).
 * Requires `npm run build` first, and Playwright's ffmpeg once: `npx playwright install ffmpeg` (a small download that
 * this repo does not do for you). Usage: npm run record
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const data = mkdtempSync(join(tmpdir(), 'phantom-rec-'));
const videoDir = mkdtempSync(join(tmpdir(), 'phantom-rec-video-'));
const phantom = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.ts'], {
  cwd: root,
  env: { ...process.env, PHANTOM_PORT: String(PORT), REAL_PORT: '8797', PHANTOM_DATA_DIR: data, PHANTOM_ALLOWED_ORIGINS: BASE },
  stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/__phantom/status`)).ok) break;
    } catch {}
    await sleep(200);
  }
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } });
  const page = await context.newPage();
  await page.goto(BASE);
  await sleep(2500);
  for (const [title, desc] of [['Write the pitch', '90 seconds, no slides'], ['Record the demo', 'screen capture']]) {
    await page.getByPlaceholder('What needs doing?').fill(title);
    await page.getByPlaceholder('Description (optional)').fill(desc);
    await page.getByRole('button', { name: 'Add task' }).click();
    await sleep(1200);
  }
  await page.getByRole('button', { name: 'Move "Write the pitch" right' }).click();
  await sleep(2500);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Run the whole demo' }).click();
  await page.getByText('Demo finished, every step passed').waitFor({ timeout: 120000 });
  await sleep(4000);
  await context.close();
  const file = readdirSync(videoDir).find((f) => f.endsWith('.webm'));
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  renameSync(join(videoDir, file), join(root, 'artifacts/demo.webm'));
  console.log('Wrote artifacts/demo.webm');
} catch (e) {
  console.error('ERROR', e.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fetch(`${BASE}/__phantom/real/stop`, { method: 'POST' }).catch(() => {});
  phantom.kill('SIGTERM');
  await new Promise((r) => phantom.once('exit', r));
  rmSync(data, { recursive: true, force: true });
  rmSync(videoDir, { recursive: true, force: true });
}
