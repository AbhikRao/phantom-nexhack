/**
 * shadowMode — mirrors live emulator traffic to an isolated copy of a generated backend and reports behavioural differences.
 *
 * Isolation: the shadow is its own OS process with its own SQLite database in a scratch directory. It is seeded from a
 * snapshot of the emulator, never touches the REAL backend's database, and nothing it returns is shown to the app.
 * Consistency: mirrored operations are applied strictly in arrival order. When the generated backend disagrees with the
 * emulator on a *write*, the shadow is rebuilt from the emulator's post-write state so every later difference is
 * attributable to a single request instead of cascading from an earlier one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineSnapshot, JsonValue } from './resourceEngine.ts';
import { renderSeed } from './backendGenerator.ts';
import { deepDiff } from './parityVerifier.ts';
import type { Diff } from './parityVerifier.ts';
import { startGeneratedBackend } from './processManager.ts';
import type { RunningBackend } from './processManager.ts';

export interface ShadowEvent {
  seq: number;
  at: string;
  method: string;
  path: string;
  requestBody?: string;
  emulatorStatus: number;
  generatedStatus: number | null;
  pass: boolean;
  diffs: Diff[];
  /** The shadow was rebuilt from emulator state right after this request (it had diverged). */
  resynced: boolean;
  error?: string;
}

export interface ShadowStatus {
  active: boolean;
  starting: boolean;
  buildId?: string;
  pid?: number;
  url?: string;
  dataDir?: string;
  startedAt?: string;
  mirrored: number;
  matched: number;
  differed: number;
  resyncs: number;
  events: ShadowEvent[];
  error?: string;
}

export interface MirrorOp {
  method: string;
  /** Path including query string. */
  target: string;
  rawBody?: string;
  resource?: string;
  emulatorStatus: number;
  emulatorBody: JsonValue | undefined;
  /** Emulator state right after this request, only for successful writes (used to resync after a mismatch). */
  afterWrite?: EngineSnapshot;
}

export interface ShadowBuild {
  id: string;
  dir: string;
  resources: string[];
}

export interface ShadowDeps {
  getBuild: (id: string) => ShadowBuild | undefined;
  snapshot: () => EngineSnapshot;
  scratchDir?: string;
  onEvent: (e: ShadowEvent) => void;
  onStatus: () => void;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Timestamps are the only nondeterministic values: replace valid ISO createdAt/updatedAt with a placeholder. */
export function normalizeTimestamps(v: JsonValue | undefined): JsonValue | undefined {
  if (v === undefined || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => normalizeTimestamps(x) as JsonValue);
  const out: Record<string, JsonValue> = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = (k === 'createdAt' || k === 'updatedAt') && typeof x === 'string' && ISO.test(x) ? '<timestamp>' : (normalizeTimestamps(x) as JsonValue);
  }
  return out;
}

export class ShadowMode {
  private deps: ShadowDeps;
  private backend?: RunningBackend;
  private build?: ShadowBuild;
  private dataDir?: string;
  private queue: Promise<void> = Promise.resolve();
  private active = false;
  private starting = false;
  private seq = 0;
  private startedAt?: string;
  private error?: string;
  private events: ShadowEvent[] = [];
  private counters = { mirrored: 0, matched: 0, differed: 0, resyncs: 0 };

  constructor(deps: ShadowDeps) {
    this.deps = deps;
  }

  status(): ShadowStatus {
    return {
      active: this.active,
      starting: this.starting,
      buildId: this.build?.id,
      pid: this.backend?.pid,
      url: this.backend?.base,
      dataDir: this.dataDir,
      startedAt: this.startedAt,
      ...this.counters,
      events: this.events.slice(-100),
      error: this.error,
    };
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Begin shadowing. State captured now is the baseline; every request after this call is queued behind the boot. */
  start(buildId: string): Promise<void> {
    const build = this.deps.getBuild(buildId);
    if (!build) throw new Error('Unknown build');
    const baseline = this.deps.snapshot();
    this.active = true;
    this.starting = true;
    this.error = undefined;
    this.build = build;
    this.events = [];
    this.counters = { mirrored: 0, matched: 0, differed: 0, resyncs: 0 };
    this.queue = this.queue.then(async () => {
      await this.teardown();
      try {
        await this.boot(baseline);
        this.startedAt = new Date().toISOString();
      } catch (e) {
        this.error = (e as Error).message;
        this.active = false;
      } finally {
        this.starting = false;
        this.deps.onStatus();
      }
    });
    return this.queue;
  }

  stop(): Promise<void> {
    this.active = false;
    this.queue = this.queue.then(async () => {
      await this.teardown();
      this.build = undefined;
      this.deps.onStatus();
    });
    return this.queue;
  }

  /** Rebuild the shadow from the emulator's current state (used by the "Resync" button). */
  resync(): Promise<void> {
    if (!this.active || !this.build) throw new Error('Shadow mode is not running');
    const baseline = this.deps.snapshot();
    this.queue = this.queue.then(async () => {
      if (!this.active) return;
      await this.rebuild(baseline);
      this.deps.onStatus();
    });
    return this.queue;
  }

  mirror(op: MirrorOp): void {
    if (!this.active) return;
    this.queue = this.queue.then(() => this.process(op)).catch(() => {});
  }

  private async boot(snapshot: EngineSnapshot): Promise<void> {
    const build = this.build!;
    const root = this.deps.scratchDir ?? tmpdir();
    mkdirSync(root, { recursive: true });
    this.dataDir = mkdtempSync(join(root, 'shadow-'));
    const seedFile = join(this.dataDir, 'seed.json');
    writeFileSync(seedFile, renderSeed(snapshot, build.resources, new Date().toISOString()).content);
    this.backend = await startGeneratedBackend({ dir: build.dir, dataDir: join(this.dataDir, 'db'), port: 0, seedFile });
  }

  private async teardown(): Promise<void> {
    const backend = this.backend;
    this.backend = undefined;
    await backend?.stop();
    if (this.dataDir) rmSync(this.dataDir, { recursive: true, force: true });
    this.dataDir = undefined;
  }

  private async rebuild(snapshot: EngineSnapshot): Promise<void> {
    await this.teardown();
    try {
      await this.boot(snapshot);
      this.counters.resyncs++;
      this.error = undefined;
    } catch (e) {
      this.error = (e as Error).message;
      this.active = false;
    }
  }

  private async process(op: MirrorOp): Promise<void> {
    if (!this.active || !this.backend) return;
    const event: ShadowEvent = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      method: op.method,
      path: op.target,
      requestBody: op.rawBody === undefined ? undefined : op.rawBody.slice(0, 400),
      emulatorStatus: op.emulatorStatus,
      generatedStatus: null,
      pass: false,
      diffs: [],
      resynced: false,
    };
    try {
      const res = await fetch(this.backend.base + op.target, {
        method: op.method,
        headers: op.rawBody === undefined ? {} : { 'content-type': 'application/json' },
        body: op.rawBody,
      });
      const text = await res.text();
      let body: JsonValue | undefined;
      if (text) {
        try {
          body = JSON.parse(text) as JsonValue;
        } catch {
          body = `<non-JSON body: ${text.slice(0, 120)}>`;
        }
      }
      event.generatedStatus = res.status;
      if (res.status !== op.emulatorStatus) event.diffs.push({ path: 'status', emulator: op.emulatorStatus, generated: res.status });
      deepDiff(normalizeTimestamps(op.emulatorBody), normalizeTimestamps(body), 'body', event.diffs);
    } catch (e) {
      event.error = `Shadow backend unreachable: ${(e as Error).message}`;
      event.diffs.push({ path: 'request', emulator: op.emulatorStatus, generated: 'no response' });
    }
    event.pass = event.diffs.length === 0;
    const inBuild = !!op.resource && !!this.build?.resources.includes(op.resource);
    if (!event.pass && op.afterWrite && inBuild) {
      await this.rebuild(op.afterWrite);
      event.resynced = true;
    }
    // Counters and the event become visible together, only after any resync has finished.
    this.counters.mirrored++;
    if (event.pass) this.counters.matched++;
    else this.counters.differed++;
    this.events.push(event);
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    this.deps.onEvent(event);
    this.deps.onStatus();
  }
}
