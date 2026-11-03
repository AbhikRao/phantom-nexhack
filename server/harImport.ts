/**
 * harImport — replays HTTP Archive (HAR) entries through the emulator so PHANTOM can learn from traffic captured elsewhere
 * (for example a browser DevTools export of an existing app). Only entries under /api/<collection>[/<id>] with JSON
 * bodies are replayed; everything else is skipped and reported. Record ids in later requests are remapped to the ids the
 * emulator assigned, because the emulator allocates its own ids.
 */
import { parseApiPath } from './resourceEngine.ts';

export interface HarApply {
  (method: string, target: string, rawBody: string | undefined, headers: Record<string, string>): { status: number; body: unknown };
}

export interface HarImportResult {
  total: number;
  imported: number;
  skipped: { index: number; reason: string }[];
  skippedCount: number;
  /** Replayed entries whose emulator status differs from the status recorded in the HAR. */
  statusMismatches: number;
  resources: string[];
}

const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const MAX_ENTRIES = 2000;

interface HarEntry {
  request?: { method?: string; url?: string; headers?: { name?: string; value?: string }[]; postData?: { text?: string } };
  response?: { status?: number; content?: { text?: string } };
}

export function importHar(har: unknown, apply: HarApply): HarImportResult {
  const entries = (har as { log?: { entries?: HarEntry[] } } | null)?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('Not a HAR file: expected log.entries');
  const result: HarImportResult = { total: entries.length, imported: 0, skipped: [], skippedCount: 0, statusMismatches: 0, resources: [] };
  const skip = (index: number, reason: string) => {
    result.skippedCount++;
    if (result.skipped.length < 20) result.skipped.push({ index, reason });
  };
  const idMap = new Map<string, Map<number, number>>();
  const resources = new Set<string>();

  entries.slice(0, MAX_ENTRIES).forEach((entry, index) => {
    const req = entry.request;
    const method = String(req?.method ?? '').toUpperCase();
    if (!req?.url || !METHODS.has(method)) return skip(index, `unsupported method ${method || '(none)'}`);
    let url: URL;
    try {
      url = new URL(req.url, 'http://har.local');
    } catch {
      return skip(index, 'unparseable URL');
    }
    const parsed = parseApiPath(url.pathname);
    if (!parsed.ok) return skip(index, `not an /api/<collection> route (${url.pathname})`);
    let path = url.pathname.replace(/\/+$/, '');
    if (parsed.id !== undefined && parsed.id !== null) {
      const mapped = idMap.get(parsed.resource)?.get(parsed.id);
      if (mapped !== undefined) path = `/api/${parsed.resource}/${mapped}`;
    }
    const raw = req.postData?.text;
    if (raw !== undefined && raw !== '') {
      try {
        JSON.parse(raw);
      } catch {
        return skip(index, 'request body is not JSON');
      }
    }
    const headers: Record<string, string> = {};
    for (const h of req.headers ?? []) if (h.name && h.value !== undefined) headers[h.name.toLowerCase()] = h.value;
    const res = apply(method, path + url.search, raw === '' ? undefined : raw, headers);
    result.imported++;
    resources.add(parsed.resource);
    if (entry.response?.status !== undefined && entry.response.status !== res.status) result.statusMismatches++;
    if (method === 'POST' && res.status === 201) {
      let harId: unknown;
      try {
        harId = JSON.parse(entry.response?.content?.text ?? 'null')?.id;
      } catch {
        harId = undefined;
      }
      const newId = (res.body as { id?: unknown } | undefined)?.id;
      if (typeof harId === 'number' && typeof newId === 'number') {
        if (!idMap.has(parsed.resource)) idMap.set(parsed.resource, new Map());
        idMap.get(parsed.resource)!.set(harId, newId);
      }
    }
  });
  if (entries.length > MAX_ENTRIES) result.skippedCount += entries.length - MAX_ENTRIES;
  result.resources = [...resources].sort();
  return result;
}
