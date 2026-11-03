/** Starts a generated backend as an independent OS process and waits until /health answers. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export interface RunningBackend {
  port: number;
  pid: number;
  base: string;
  child: ChildProcess;
  logs: string[];
  health: unknown;
  stop: () => Promise<void>;
}

export interface StartOptions {
  dir: string;
  dataDir: string;
  port: number;
  seedFile?: string;
  corsOrigins?: string;
  timeoutMs?: number;
}

export async function startGeneratedBackend(opts: StartOptions): Promise<RunningBackend> {
  mkdirSync(opts.dataDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PORT: String(opts.port),
    HOST: '127.0.0.1',
    DATA_DIR: opts.dataDir,
    SEED_FILE: opts.seedFile ?? '',
  };
  if (opts.corsOrigins) env.CORS_ORIGINS = opts.corsOrigins;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
    cwd: opts.dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  const push = (d: Buffer) => {
    for (const line of d.toString().split('\n')) if (line.trim()) logs.push(line.slice(0, 500));
    if (logs.length > 80) logs.splice(0, logs.length - 80);
  };
  child.stderr!.on('data', push);

  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`generated backend did not start within ${opts.timeoutMs ?? 10000}ms: ${logs.slice(-5).join(' | ')}`));
    }, opts.timeoutMs ?? 10000);
    child.stdout!.on('data', (d: Buffer) => {
      push(d);
      out += d.toString();
      const m = /PHANTOM_GENERATED_LISTENING port=(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`generated backend exited (${code ?? signal}): ${logs.slice(-5).join(' | ')}`));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const health = await (await fetch(`${base}/health`)).json();
  let exited = child.exitCode !== null;
  child.once('exit', () => (exited = true));
  return {
    port,
    pid: child.pid!,
    base,
    child,
    logs,
    health,
    stop: () =>
      new Promise<void>((resolve) => {
        if (exited) return resolve();
        const t = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}
