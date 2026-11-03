// Two HTTP clients: the control plane (always PHANTOM) and the data API (PHANTOM emulator or the REAL generated backend).

// Production builds are served by PHANTOM itself (same origin). The Vite dev server talks to PHANTOM on :8787.
export const CONTROL_BASE: string =
  import.meta.env.VITE_PHANTOM_URL ?? (import.meta.env.DEV ? `http://${location.hostname === 'localhost' ? 'localhost' : '127.0.0.1'}:8787` : '');

export const PHANTOM_API_BASE: string = CONTROL_BASE || location.origin;

export type Mode = 'phantom' | 'real';

export interface Task {
  id: number;
  title: string;
  description?: string;
  status: Status;
  createdAt: string;
  updatedAt: string;
}
export type Status = 'todo' | 'doing' | 'done';

export interface Note {
  id: number;
  title: string;
  content: string;
  createdAt: string;
}

export interface CallRecord {
  id: number;
  method: string;
  url: string;
  status: number | 'network error';
  ms: number;
  at: number;
}

export interface TraceEvent {
  seq: number;
  timestamp: string;
  method: string;
  path: string;
  query: string;
  route: string;
  resource?: string;
  status: number;
  durationMs: number;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  requestBodyRaw?: boolean;
  responseBody?: unknown;
}

export interface FieldNode {
  types: string[];
  seen: number;
  properties?: Record<string, FieldNode>;
  items?: { types: string[] };
  observedValues?: (string | number | boolean)[];
  manyValues?: boolean;
}

export interface ResourceContract {
  name: string;
  collectionPath: string;
  itemPath: string;
  fields: Record<string, FieldNode>;
  required: string[];
  createCount: number;
  operations: { method: string; route: string; count: number; statuses: Record<string, number> }[];
  firstSeen: string;
}

export interface Contract {
  generatedAt: string;
  traceCount: number;
  resources: ResourceContract[];
}

export interface BuildInfo {
  id: string;
  createdAt: string;
  resources: string[];
  traceCount: number;
  seedRecords: number;
  files: { path: string; bytes: number; sha256: string }[];
}

export interface RealStatus {
  running: boolean;
  port: number;
  url: string;
  buildId?: string;
  pid?: number;
  startedAt?: string;
  dataDir?: string;
  migrated?: boolean;
  health?: { status: string; pid: number; database: string; records: Record<string, number>; buildId: string };
  logs: string[];
  error?: string;
}

export interface EngineStatus {
  resources: string[];
  traceCount: number;
  latestBuild?: BuildInfo;
  real: RealStatus;
}

export interface ParityCase {
  n: number;
  source: 'trace' | 'synthetic' | 'final-state';
  traceSeq?: number;
  label: string;
  method: string;
  emulatorPath: string;
  generatedPath: string;
  recordedStatus?: number;
  emulatorStatus: number;
  generatedStatus: number;
  pass: boolean;
  diffs: { path: string; emulator: unknown; generated: unknown }[];
}

export interface ParityReport {
  id: string;
  buildId: string;
  mutation: string | null;
  startedAt: string;
  durationMs: number;
  emulatorBase: string;
  generatedBase: string;
  replayedTraces: number;
  summary: { total: number; passed: number; failed: number };
  cases: ParityCase[];
  normalization: string[];
  notCovered: string[];
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, body?.message ?? `HTTP ${res.status}`);
  return body as T;
}

export async function control<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${CONTROL_BASE}/__phantom${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return parse<T>(res);
}

let callId = 0;
type CallListener = (c: CallRecord) => void;
const callListeners = new Set<CallListener>();
export const onCall = (l: CallListener) => {
  callListeners.add(l);
  return () => void callListeners.delete(l);
};

/** Data client used by the TaskBoard. Every operation is a real HTTP request to `base`. */
export async function data<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const url = `${base}${path}`;
  const started = performance.now();
  const record = (status: CallRecord['status']) =>
    callListeners.forEach((l) => l({ id: ++callId, method, url, status, ms: Math.round(performance.now() - started), at: Date.now() }));
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    record('network error');
    throw new ApiError(0, `Could not reach ${base}. Is that server running?`);
  }
  record(res.status);
  return parse<T>(res);
}
