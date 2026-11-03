import { useEffect, useState } from 'react';
import { CONTROL_BASE, control } from '../api.ts';
import type { BuildInfo, Mode, ParityReport, RealStatus } from '../api.ts';
import { Button, Empty, ErrorNote, Json, Panel, StatusCode } from './ui.tsx';

export function BuildPanel({ build, onBuilt, canBuild }: { build?: BuildInfo; onBuilt: (b: BuildInfo) => void; canBuild: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<string>('src/resources.ts');
  const [content, setContent] = useState<string>('');

  useEffect(() => {
    if (!build) return;
    let cancelled = false;
    control<{ content: string }>(`/builds/${build.id}/file?path=${encodeURIComponent(file)}`).then(
      (r) => !cancelled && setContent(r.content),
      (e) => !cancelled && setContent(`Could not load file: ${e.message}`),
    );
    return () => {
      cancelled = true;
    };
  }, [build, file]);

  const generate = async () => {
    setBusy(true);
    setError(null);
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
      id="generate"
      title="Generate the backend"
      aside={
        <Button tone="primary" onClick={generate} busy={busy} disabled={!canBuild}>
          {build ? 'Regenerate' : 'Generate backend'}
        </Button>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        {!build ? (
          <Empty>{canBuild ? 'Turns the recorded contract into a standalone TypeScript + SQLite server you can download and run.' : 'Use the TaskBoard first. There is nothing to generate from yet.'}</Empty>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              <span className="font-mono text-ink">{build.id}</span>
              <span>{build.resources.map((r) => `/api/${r}`).join(', ')}</span>
              <span>from {build.traceCount} requests</span>
              <span>{build.seedRecords} records exported</span>
            </div>
            <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[180px_1fr]">
              <ul className="scroll-thin max-h-72 overflow-auto rounded-lg border border-line p-1 text-xs" aria-label="Generated files">
                {build.files.map((f) => (
                  <li key={f.path}>
                    <button onClick={() => setFile(f.path)} aria-current={file === f.path} className={`flex w-full justify-between gap-2 rounded px-2 py-1 text-left font-mono ${file === f.path ? 'bg-raised text-ink' : 'text-muted hover:bg-raised/60'}`}>
                      <span className="truncate">{f.path}</span>
                      <span className="shrink-0 text-faint">{(f.bytes / 1024).toFixed(1)}k</span>
                    </button>
                  </li>
                ))}
              </ul>
              <Json value={content || 'Loading…'} className="max-h-72 min-w-0" />
            </div>
            <a href={`${CONTROL_BASE}/__phantom/builds/${build.id}/download`} download className="inline-flex w-fit items-center gap-2 rounded-lg bg-raised px-3 py-1.5 text-sm text-ink hover:bg-line">
              Download ZIP
            </a>
          </>
        )}
      </div>
    </Panel>
  );
}

export function ParityPanel({ build, reports, onReport }: { build?: BuildInfo; reports: ParityReport[]; onReport: (r: ParityReport) => void }) {
  const [busy, setBusy] = useState<'normal' | 'mutant' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const report = reports[0];

  const verify = async (mutation?: string) => {
    if (!build) return;
    setBusy(mutation ? 'mutant' : 'normal');
    setError(null);
    try {
      onReport(await control<ParityReport>(`/builds/${build.id}/parity`, { method: 'POST', body: mutation ? { mutation } : {} }));
      setOpen(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const failedFirst = report ? [...report.cases].sort((a, b) => Number(a.pass) - Number(b.pass) || a.n - b.n) : [];
  return (
    <Panel
      id="verify"
      title="Verify behaviour"
      aside={
        <>
          <Button tone="teal" onClick={() => verify()} busy={busy === 'normal'} disabled={!build || !!busy}>Run parity check</Button>
          <Button onClick={() => verify('patch-ignores-body')} busy={busy === 'mutant'} disabled={!build || !!busy} title="Generates a copy whose PATCH handler ignores the request body, then runs the same check">
            Test a broken build
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        {!report ? (
          <Empty>
            {build
              ? 'Replays every recorded request against a fresh emulator and a fresh copy of the generated server, then compares status codes, bodies and final data.'
              : 'Generate a backend first.'}
          </Empty>
        ) : (
          <>
            <div className={`rounded-lg border px-3 py-2 ${report.summary.failed === 0 ? 'border-teal/40 bg-teal/10' : 'border-rose/40 bg-rose/10'}`} role="status">
              <p className={`text-sm font-semibold ${report.summary.failed === 0 ? 'text-teal' : 'text-rose'}`}>
                {report.mutation
                  ? report.summary.failed > 0
                    ? `Broken build caught: ${report.summary.failed} of ${report.summary.total} checks fail`
                    : 'Broken build NOT caught: the recorded traffic never exercises PATCH'
                  : report.summary.failed === 0
                    ? `${report.summary.passed} of ${report.summary.total} checks match`
                    : `${report.summary.failed} of ${report.summary.total} checks differ`}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {report.replayedTraces} recorded requests replayed in {report.durationMs}ms. Emulator {report.emulatorBase.replace('http://', '')}, generated server {report.generatedBase.replace('http://', '')}
                {report.mutation ? ` (sabotaged: ${report.mutation})` : ''}.
              </p>
            </div>
            <ol className="scroll-thin max-h-72 min-h-0 space-y-1 overflow-auto text-xs" aria-label="Parity checks">
              {failedFirst.map((c) => (
                <li key={c.n} className="rounded-md border border-line/70">
                  <button onClick={() => setOpen(open === c.n ? null : c.n)} aria-expanded={open === c.n} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-raised">
                    <span className={`w-9 shrink-0 font-semibold ${c.pass ? 'text-teal' : 'text-rose'}`}>{c.pass ? 'Pass' : 'Fail'}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-ink">{c.label}</span>
                    <span className="shrink-0 text-faint">{c.source === 'trace' ? `trace #${c.traceSeq}` : c.source === 'synthetic' ? 'edge case' : 'final data'}</span>
                    <StatusCode s={c.emulatorStatus} />
                    <span className="text-faint">/</span>
                    <StatusCode s={c.generatedStatus} />
                  </button>
                  {open === c.n && (
                    <div className="space-y-2 border-t border-line/70 p-2.5">
                      <p className="font-mono text-muted">emulator {c.method} {c.emulatorPath}<br />generated {c.method} {c.generatedPath}</p>
                      {c.diffs.length === 0 ? (
                        <p className="text-teal">Identical after normalising ids and timestamps.</p>
                      ) : (
                        <table className="w-full table-fixed text-left">
                          <thead className="text-faint"><tr><th className="w-1/3 font-medium">Where</th><th className="font-medium">Emulator</th><th className="font-medium">Generated</th></tr></thead>
                          <tbody>
                            {c.diffs.map((d, i) => (
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
            <details className="text-xs text-muted">
              <summary className="cursor-pointer text-ink">What is and isn't compared</summary>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {[...report.normalization, ...report.notCovered].map((s) => <li key={s}>{s}</li>)}
              </ul>
            </details>
          </>
        )}
      </div>
    </Panel>
  );
}

export function RealPanel({ build, real, mode, setMode, onReal }: { build?: BuildInfo; real?: RealStatus; mode: Mode; setMode: (m: Mode) => void; onReal: (r: RealStatus) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [migrate, setMigrate] = useState(true);

  const act = async (name: string, path: string, body?: unknown) => {
    setBusy(name);
    setError(null);
    try {
      const status = await control<RealStatus>(path, { method: 'POST', body });
      onReal(status);
      return status;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const running = !!real?.running;
  const stale = running && build && real?.buildId !== build.id;
  return (
    <Panel id="real" title="Switch to the real backend">
      <div className="flex flex-1 flex-col gap-3 p-4 text-sm">
        {error && <ErrorNote>{error}</ErrorNote>}
        {!build ? (
          <Empty>Generate a backend first, then run it here as its own process.</Empty>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button tone={running ? 'ghost' : 'primary'} busy={busy === 'launch'} disabled={!!busy} onClick={() => act('launch', '/real/launch', { buildId: build.id, migrate })}>
                {running ? 'Relaunch latest build' : 'Start generated backend'}
              </Button>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={migrate} onChange={(e) => setMigrate(e.target.checked)} className="accent-teal" />
                Copy current tasks into it
              </label>
            </div>
            {running && real && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-navy/60 p-3 text-xs">
                <dt className="text-faint">Address</dt>
                <dd className="font-mono text-teal">{real.url}</dd>
                <dt className="text-faint">Process</dt>
                <dd className="font-mono">pid {real.pid}, started {real.startedAt ? new Date(real.startedAt).toLocaleTimeString() : '—'}</dd>
                <dt className="text-faint">Build</dt>
                <dd className="font-mono">{real.buildId}{stale ? ' (older than latest build)' : ''}</dd>
                <dt className="text-faint">Database</dt>
                <dd className="break-all font-mono">{real.health?.database}</dd>
                <dt className="text-faint">Records at start</dt>
                <dd className="font-mono">{real.health ? Object.entries(real.health.records).map(([k, v]) => `${k} ${v}`).join(', ') : '—'}</dd>
              </dl>
            )}
            {!running && real?.error && <ErrorNote>{real.error}</ErrorNote>}
            <div className="flex flex-wrap gap-2">
              {mode === 'phantom' ? (
                <Button tone="teal" disabled={!running} onClick={() => setMode('real')}>Point TaskBoard at {real?.url.replace('http://', '') ?? '127.0.0.1:8788'}</Button>
              ) : (
                <Button onClick={() => setMode('phantom')}>Point TaskBoard back at PHANTOM</Button>
              )}
              <Button disabled={!running || !!busy} busy={busy === 'restart'} onClick={() => act('restart', '/real/restart')} title="Stops the process and starts it again on the same database">
                Restart process
              </Button>
              <Button tone="danger" disabled={!running || !!busy} busy={busy === 'stop'} onClick={async () => { await act('stop', '/real/stop'); setMode('phantom'); }}>
                Stop
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted">
              Restart kills the process and starts a new one on the same SQLite file. Reload the page afterwards: tasks you added in REAL mode are still there.
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}
