/** PHANTOM entry point. Binds to localhost only by default. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPhantom, DEFAULT_ORIGINS } from './app.ts';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const port = Number(process.env.PHANTOM_PORT ?? 8787);
const host = process.env.PHANTOM_HOST ?? '127.0.0.1';
const extraOrigins = (process.env.PHANTOM_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const phantom = await createPhantom({
  dataDir: process.env.PHANTOM_DATA_DIR ?? resolve(root, '.phantom'),
  webDist: resolve(root, 'web/dist'),
  realPort: Number(process.env.REAL_PORT ?? 8788),
  allowedOrigins: [...DEFAULT_ORIGINS, ...extraOrigins],
});

await phantom.app.listen({ port, host });
console.log(`PHANTOM engine  http://${host}:${port}   (emulated API under /api/*, control plane under /__phantom/*)`);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await phantom.shutdown();
    process.exit(0);
  });
}
