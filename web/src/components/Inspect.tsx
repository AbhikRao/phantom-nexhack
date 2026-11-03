import { useEffect, useRef, useState } from 'react';
import { CONTROL_BASE } from '../api.ts';
import type { Contract, FieldNode, Mode, TraceEvent } from '../api.ts';
import { Empty, Json, Method, Panel, StatusCode } from './ui.tsx';

export function TracePanel({ traces, mode }: { traces: TraceEvent[]; mode: Mode }) {
  const [selected, setSelected] = useState<number | null>(null);
  // Only rows that arrive after the first render get the arrival highlight.
  const initialMax = useRef<number | null>(null);
  if (initialMax.current === null && traces.length > 0) initialMax.current = traces[traces.length - 1].seq;
  if (initialMax.current !== null && traces.length > 0 && traces[traces.length - 1].seq < initialMax.current) initialMax.current = 0; // after "Start over"

  const sel = traces.find((t) => t.seq === selected);
  const rows = [...traces].reverse().slice(0, 200);
  return (
    <Panel id="traffic" title="Live traffic" aside={<span className="text-xs text-muted">{traces.length} recorded</span>} className="min-h-[320px]">
      {mode === 'real' && (
        <p className="border-b border-line bg-teal/10 px-4 py-2 text-xs leading-relaxed text-teal">
          The TaskBoard is talking to the generated backend, so PHANTOM no longer sees its requests. New rows here would mean something is still routed through the emulator.
        </p>
      )}
      {rows.length === 0 ? (
        <Empty>No requests yet. Add a task and its HTTP call appears here.</Empty>
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-auto">
          <table className="w-full table-fixed text-left text-xs">
            <caption className="sr-only">Recorded API requests, newest first</caption>
            <thead className="sticky top-0 bg-panel text-[11px] text-faint">
              <tr>
                <th scope="col" className="w-14 px-4 py-2 font-medium">Method</th>
                <th scope="col" className="px-2 py-2 font-medium">Path</th>
                <th scope="col" className="w-12 px-2 py-2 font-medium">Status</th>
                <th scope="col" className="w-16 px-4 py-2 text-right font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr
                  key={t.seq}
                  tabIndex={0}
                  aria-selected={selected === t.seq}
                  onClick={() => setSelected(selected === t.seq ? null : t.seq)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSelected(selected === t.seq ? null : t.seq))}
                  className={`${initialMax.current !== null && t.seq > initialMax.current ? 'arrive' : ''} cursor-pointer border-t border-line/60 hover:bg-raised ${selected === t.seq ? 'bg-raised' : ''}`}
                >
                  <td className="px-4 py-1.5"><Method m={t.method} /></td>
                  <td className="truncate px-2 py-1.5 font-mono text-ink">{t.path}{t.query ? `?${t.query}` : ''}</td>
                  <td className="px-2 py-1.5"><StatusCode s={t.status} /></td>
                  <td className="px-4 py-1.5 text-right font-mono text-faint">{t.durationMs.toFixed(1)}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sel && (
        <div className="scroll-thin max-h-[45%] overflow-auto border-t border-line p-4 text-xs">
          <div className="mb-2 flex items-center gap-2">
            <Method m={sel.method} />
            <span className="font-mono">{sel.path}</span>
            <StatusCode s={sel.status} />
            <span className="ml-auto text-faint">#{sel.seq} at {new Date(sel.timestamp).toLocaleTimeString()}</span>
          </div>
          <p className="mb-1 text-muted">Headers (secrets redacted before storage)</p>
          <Json value={sel.requestHeaders} className="mb-2 max-h-28" />
          <p className="mb-1 text-muted">Request body</p>
          <Json value={sel.requestBody} className="mb-2 max-h-32" />
          <p className="mb-1 text-muted">Response body</p>
          <Json value={sel.responseBody} className="max-h-40" />
        </div>
      )}
    </Panel>
  );
}

function typeLabel(f: FieldNode): string {
  return f.types
    .map((t) => (t === 'array' && f.items?.types.length ? `${f.items.types.join('|')}[]` : t))
    .join(' | ');
}

export function ContractPanel({ contract }: { contract: Contract | null }) {
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const known = useRef<Set<string> | null>(null);
  const [showDoc, setShowDoc] = useState(false);
  const [doc, setDoc] = useState<unknown>(null);

  useEffect(() => {
    if (!contract) return;
    const names = new Set(contract.resources.map((r) => r.name));
    const previous = known.current;
    known.current = names;
    const added = previous ? [...names].filter((n) => !previous.has(n)) : [];
    if (added.length) {
      setFresh(new Set(added));
      setTimeout(() => setFresh(new Set()), 2500);
    }
  }, [contract]);

  useEffect(() => {
    if (!showDoc) return;
    fetch(`${CONTROL_BASE}/__phantom/openapi.json`).then((r) => r.json()).then(setDoc, () => setDoc({ error: 'Could not load OpenAPI document' }));
  }, [showDoc, contract]);

  const resources = contract?.resources ?? [];
  return (
    <Panel
      id="contract"
      title="What PHANTOM has learned"
      aside={
        <>
          <button onClick={() => setShowDoc(!showDoc)} aria-expanded={showDoc} className="rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-raised">
            {showDoc ? 'Hide OpenAPI' : 'View OpenAPI'}
          </button>
          <a href={`${CONTROL_BASE}/__phantom/openapi.json?download=1`} download="phantom-openapi.json" className="rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-raised">
            Download
          </a>
        </>
      }
      className="min-h-[320px]"
    >
      {showDoc && <Json value={doc ?? 'Loading…'} className="m-3 max-h-80" />}
      {resources.length === 0 ? (
        <Empty>Nothing yet. Endpoints, fields and types appear here the first time the app uses them.</Empty>
      ) : (
        <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-auto p-3">
          {resources.map((r) => (
            <article key={r.name} className={`rounded-lg border border-line bg-navy/60 ${fresh.has(r.name) ? 'discovered' : ''}`}>
              <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 pt-3">
                <h3 className="font-mono text-sm font-medium text-ink">/api/{r.name}</h3>
                <span className="text-xs text-muted">first used {new Date(r.firstSeen).toLocaleTimeString()}</span>
              </header>
              <ul className="flex flex-wrap gap-1.5 px-3 pt-2" aria-label="Observed operations">
                {r.operations.map((o) => (
                  <li key={o.method + o.route} className="flex items-center gap-1.5 rounded-md bg-raised px-2 py-0.5 text-xs">
                    <Method m={o.method} />
                    <span className="font-mono text-muted">{o.route.endsWith('{id}') ? '/:id' : '/'}</span>
                    <span className="text-ink tabular-nums">×{o.count}</span>
                  </li>
                ))}
              </ul>
              {Object.keys(r.fields).length === 0 ? (
                <p className="px-3 py-3 text-xs text-faint">No request bodies observed yet, so no fields are known.</p>
              ) : (
                <table className="mt-2 w-full text-left text-xs">
                  <caption className="sr-only">Inferred fields for {r.name}</caption>
                  <thead className="text-[11px] text-faint">
                    <tr>
                      <th scope="col" className="px-3 py-1 font-medium">Field</th>
                      <th scope="col" className="px-2 py-1 font-medium">Type</th>
                      <th scope="col" className="hidden px-3 py-1 font-medium sm:table-cell">Seen values</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(r.fields).map(([name, f]) => (
                      <tr key={name} className="border-t border-line/60 align-top">
                        <td className="px-3 py-1.5 font-mono text-ink">
                          {name}
                          {r.required.includes(name) && <span className="ml-1 text-teal" title="Present in every create request">required</span>}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-indigo">{typeLabel(f)}</td>
                        <td className="hidden max-w-0 truncate px-3 py-1.5 text-muted sm:table-cell">
                          {f.observedValues?.length ? f.observedValues.map((v) => (v === '' ? '(empty)' : String(v))).join(', ') + (f.manyValues ? ', …' : '') : f.manyValues ? 'many distinct' : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="px-3 pb-3 pt-2 text-[11px] text-faint">
                From {r.createCount} create request{r.createCount === 1 ? '' : 's'}. Server adds id, createdAt and updatedAt.
              </p>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}
