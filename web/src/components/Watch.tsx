import { useEffect, useRef, useState } from 'react';
import { control } from '../api.ts';
import type { BuildInfo, DriftFinding, DriftReport, ShadowStatus } from '../api.ts';
import { Button, Empty, ErrorNote, Json, Method, Panel, StatusCode } from './ui.tsx';

export function ShadowPanel({ build, shadow, onShadow }: { build?: BuildInfo; shadow: ShadowStatus | null; onShadow: (s: ShadowStatus) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [onlyDiffs, setOnlyDiffs] = useState(false);

  const act = async (name: string, path: string, body?: unknown) => {
    setBusy(name);
    setError(null);
    try {
      onShadow(await control<ShadowStatus>(path, { method: 'POST', body: body ?? {} }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const active = !!shadow?.active;
  const events = [...(shadow?.events ?? [])].reverse().filter((e) => !onlyDiffs || !e.pass);
  return (
    <Panel
      id="shadow"
      title="Live shadow"
      aside={
        active ? (
          <>
            <Button onClick={() => act('resync', '/shadow/resync')} busy={busy === 'resync'} disabled={!!busy} title="Rebuild the shadow database from PHANTOM's current data">Resync</Button>
            <Button tone="danger" onClick={() => act('stop', '/shadow/stop')} busy={busy === 'stop'} disabled={!!busy}>Stop shadow</Button>
          </>
        ) : (
          <Button tone="teal" onClick={() => act('start', '/shadow/start', build ? { buildId: build.id } : {})} busy={busy === 'start' || !!shadow?.starting} disabled={!build || !!busy}>
            Start shadow mode
          </Button>
        )
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        {shadow?.error && !active && <ErrorNote>{shadow.error}</ErrorNote>}
        <p className="text-xs leading-relaxed text-muted">
          Every request PHANTOM answers is also sent to a private copy of the generated backend. It has its own process and its own scratch database, so your
          demo data and the real backend are never touched. Differences appear here as they happen.
        </p>
        {!build && <Empty>Generate a backend first. Shadow mode compares against it.</Empty>}
        {build && !active && !shadow?.events.length && <Empty>Start shadow mode, then use the TaskBoard in PHANTOM mode.</Empty>}
        {(active || (shadow?.events.length ?? 0) > 0) && shadow && (
          <>
            <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-label="Shadow totals">
              <div className="flex items-center gap-1.5"><dt className="sr-only">Status</dt><dd className={`rounded-full px-2 py-0.5 font-semibold ${active ? 'bg-teal/15 text-teal' : 'bg-raised text-muted'}`}>{shadow.starting ? 'Starting' : active ? 'Shadowing' : 'Stopped'}</dd></div>
              <div><dt className="sr-only">Mirrored</dt><dd><span className="font-mono text-ink">{shadow.mirrored}</span> mirrored</dd></div>
              <div><dt className="sr-only">Matched</dt><dd><span className="font-mono text-teal">{shadow.matched}</span> matched</dd></div>
              <div><dt className="sr-only">Differences</dt><dd><span className={`font-mono ${shadow.differed ? 'text-rose' : 'text-ink'}`}>{shadow.differed}</span> differ</dd></div>
              <div><dt className="sr-only">Resyncs</dt><dd><span className="font-mono text-ink">{shadow.resyncs}</span> resyncs</dd></div>
              {active && shadow.url && <div className="font-mono text-faint">{shadow.url.replace('http://', '')}, pid {shadow.pid}</div>}
            </dl>
            <label className="flex w-fit items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={onlyDiffs} onChange={(e) => setOnlyDiffs(e.target.checked)} className="accent-teal" />
              Show differences only
            </label>
            <ol className="scroll-thin max-h-72 min-h-0 space-y-1 overflow-auto text-xs" aria-label="Mirrored requests, newest first">
              {events.length === 0 && <li className="px-2 py-3 text-faint">{onlyDiffs ? 'No differences so far.' : 'Waiting for traffic.'}</li>}
              {events.map((e) => (
                <li key={e.seq} className={`rounded-md border ${e.pass ? 'border-line/70' : 'border-rose/40'}`}>
                  <button onClick={() => setOpen(open === e.seq ? null : e.seq)} aria-expanded={open === e.seq} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-raised">
                    <span className={`w-10 shrink-0 font-semibold ${e.pass ? 'text-teal' : 'text-rose'}`}>{e.pass ? 'Match' : 'Differ'}</span>
                    <Method m={e.method} />
                    <span className="min-w-0 flex-1 truncate font-mono text-ink">{e.path}</span>
                    <StatusCode s={e.emulatorStatus} />
                    <span className="text-faint">/</span>
                    <StatusCode s={e.generatedStatus ?? 'none'} />
                  </button>
                  {open === e.seq && (
                    <div className="space-y-2 border-t border-line/70 p-2.5">
                      <p className="text-muted">Left is PHANTOM's answer, right is the shadow backend's.{e.resynced ? ' The shadow was rebuilt from PHANTOM\'s data after this request.' : ''}</p>
                      {e.requestBody && <Json value={e.requestBody} className="max-h-24" />}
                      {e.error && <ErrorNote>{e.error}</ErrorNote>}
                      {e.diffs.length > 0 && (
                        <table className="w-full table-fixed text-left">
                          <thead className="text-faint"><tr><th className="w-1/3 font-medium">Where</th><th className="font-medium">PHANTOM</th><th className="font-medium">Shadow</th></tr></thead>
                          <tbody>
                            {e.diffs.map((d, i) => (
                              <tr key={i} className="align-top font-mono">
                                <td className="truncate pr-2 text-ink">{d.path}</td>
                                <td className="truncate pr-2 text-teal">{JSON.stringify(d.emulator)}</td>
                                <td className="truncate text-rose">{JSON.stringify(d.generated)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
        <p className="text-[11px] leading-relaxed text-faint">Shadow mode sees what PHANTOM receives. In REAL mode the TaskBoard bypasses PHANTOM, so nothing is mirrored.</p>
      </div>
    </Panel>
  );
}

const SEVERITY: Record<DriftFinding['severity'], { label: string; tone: string }> = {
  breaking: { label: 'Breaking', tone: 'border-rose/50 bg-rose/10 text-rose' },
  warning: { label: 'Warning', tone: 'border-amber/50 bg-amber/10 text-amber' },
  info: { label: 'Info', tone: 'border-line bg-raised text-muted' },
};

export function DriftPanel({ build, traceCount, onBuilt }: { build?: BuildInfo; traceCount: number; onBuilt: (b: BuildInfo) => void }) {
  const [drift, setDrift] = useState<DriftReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!build) {
      setDrift(null);
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      control<DriftReport>(`/builds/${build.id}/drift`).then(
        (d) => {
          setDrift(d);
          setError(null);
        },
        (e) => setError((e as Error).message),
      );
    }, 200);
    return () => clearTimeout(timer.current);
  }, [build, traceCount]);

  const regenerate = async () => {
    setBusy(true);
    try {
      onBuilt(await control<BuildInfo>('/builds', { method: 'POST' }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      id="drift"
      title="Contract drift"
      aside={
        <Button tone="primary" onClick={regenerate} busy={busy} disabled={!build || !drift?.findings.length} title="Generate a new backend from all traffic so far">
          Regenerate to absorb
        </Button>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        <p className="text-xs leading-relaxed text-muted">
          Compares traffic recorded after the backend was generated with the contract it was generated from, and says what the generated server would do with it.
        </p>
        {!build ? (
          <Empty>Generate a backend first. Drift is measured against it.</Empty>
        ) : !drift ? (
          <Empty>Checking…</Empty>
        ) : (
          <>
            <p className="text-xs text-muted" role="status">
              <span className="font-mono text-ink">{drift.newTraceCount}</span> successful requests since <span className="font-mono text-ink">{build.id}</span>:{' '}
              {drift.summary.total === 0 ? (
                <span className="font-semibold text-teal">no drift, everything fits the generated contract</span>
              ) : (
                <>
                  <span className="font-semibold text-rose">{drift.summary.breaking} breaking</span>, <span className="font-semibold text-amber">{drift.summary.warning} warnings</span>, {drift.summary.info} info
                </>
              )}
            </p>
            <ul className="scroll-thin max-h-80 min-h-0 space-y-2 overflow-auto text-xs" aria-label="Drift findings">
              {drift.findings.map((f) => (
                <li key={f.id} className="rounded-lg border border-line bg-navy/50">
                  <button onClick={() => setOpen(open === f.id ? null : f.id)} aria-expanded={open === f.id} className="flex w-full items-start gap-2 p-2.5 text-left hover:bg-raised/60">
                    <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 font-semibold ${SEVERITY[f.severity].tone}`}>{SEVERITY[f.severity].label}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-ink">{f.summary}</span>
                      {(f.expected || f.observed) && (
                        <span className="mt-0.5 block font-mono text-muted">
                          {f.expected && <>expected {f.expected}</>}{f.expected && f.observed && ', '}{f.observed && <>saw {f.observed}</>}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-faint">×{f.count}</span>
                  </button>
                  {open === f.id && (
                    <div className="space-y-2 border-t border-line p-2.5">
                      <p className="text-ink"><span className="font-semibold">What to do: </span>{f.action}</p>
                      <p className="text-muted">Evidence from recorded requests</p>
                      {f.evidence.map((ev) => (
                        <div key={ev.seq} className="rounded bg-navy p-2">
                          <p className="flex items-center gap-2 font-mono">
                            <Method m={ev.method} />
                            <span className="truncate text-ink">{ev.path}</span>
                            <StatusCode s={ev.status} />
                            <span className="ml-auto text-faint">trace #{ev.seq}</span>
                          </p>
                          {ev.body !== undefined && <pre className="mt-1 overflow-auto font-mono text-muted">{JSON.stringify(ev.body)}</pre>}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Panel>
  );
}
