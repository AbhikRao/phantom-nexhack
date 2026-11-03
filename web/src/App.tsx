import { useCallback, useEffect, useRef, useState } from 'react';
import { CONTROL_BASE, PHANTOM_API_BASE, control } from './api.ts';
import type { BuildInfo, Contract, EngineStatus, Mode, ParityReport, RealStatus, TraceEvent } from './api.ts';
import { TaskBoard } from './components/TaskBoard.tsx';
import { ContractPanel, TracePanel } from './components/Inspect.tsx';
import { BuildPanel, ParityPanel, RealPanel } from './components/Ship.tsx';
import { Button } from './components/ui.tsx';

// The mode is a per-viewer UI preference only; task data always comes from an HTTP server.
const readMode = (): Mode => {
  try {
    return localStorage.getItem('phantom.mode') === 'real' ? 'real' : 'phantom';
  } catch {
    return 'phantom';
  }
};

export function App() {
  const [mode, setModeState] = useState<Mode>(readMode);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [engineDown, setEngineDown] = useState(false);
  const [traces, setTraces] = useState<TraceEvent[]>([]);
  const [contract, setContract] = useState<Contract | null>(null);
  const [build, setBuild] = useState<BuildInfo | undefined>();
  const [reports, setReports] = useState<ParityReport[]>([]);
  const [real, setReal] = useState<RealStatus | undefined>();
  const [reloadKey, setReloadKey] = useState(0);
  const contractTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const realUrl = real?.url ?? 'http://127.0.0.1:8788';
  // In REAL mode wait for the engine to report where the generated process actually listens before sending anything.
  const apiBase: string | undefined = mode === 'real' ? real?.url : PHANTOM_API_BASE;

  const setMode = (m: Mode) => {
    try {
      localStorage.setItem('phantom.mode', m);
    } catch {
      /* preference only */
    }
    setModeState(m);
  };

  const refreshContract = useCallback(() => {
    clearTimeout(contractTimer.current);
    contractTimer.current = setTimeout(() => control<Contract>('/contract').then(setContract, () => {}), 150);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const [s, t, p] = await Promise.all([control<EngineStatus>('/status'), control<TraceEvent[]>('/traces?limit=500'), control<ParityReport[]>('/parity')]);
      setStatus(s);
      setTraces(t);
      setBuild(s.latestBuild);
      setReal(s.real);
      setReports(p);
      setEngineDown(false);
      refreshContract();
    } catch {
      setEngineDown(true);
    }
  }, [refreshContract]);

  useEffect(() => {
    void refreshAll();
    const es = new EventSource(`${CONTROL_BASE}/__phantom/events`);
    es.addEventListener('trace', (e) => {
      const t = JSON.parse((e as MessageEvent).data) as TraceEvent;
      setTraces((prev) => (prev.some((x) => x.seq === t.seq) ? prev : [...prev, t].slice(-2000)));
      refreshContract();
    });
    es.addEventListener('reset', () => void refreshAll());
    es.addEventListener('build', (e) => setBuild(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('real', (e) => setReal(JSON.parse((e as MessageEvent).data)));
    es.onopen = () => setEngineDown(false);
    es.onerror = () => setEngineDown(true);
    return () => es.close();
  }, [refreshAll, refreshContract]);

  // If REAL mode was remembered but the generated process is gone, say so instead of silently pretending.
  const realMissing = mode === 'real' && real !== undefined && !real.running;

  const steps = [
    { label: 'Add a task', done: traces.some((t) => t.method === 'POST' && t.resource === 'tasks' && t.status === 201), target: 'board' },
    { label: 'Move or delete it', done: traces.some((t) => (t.method === 'PATCH' || t.method === 'DELETE') && t.resource === 'tasks' && t.status < 300), target: 'board' },
    { label: 'Generate the backend', done: !!build, target: 'generate' },
    { label: 'Verify behaviour', done: reports.some((r) => !r.mutation && r.buildId === build?.id && r.summary.failed === 0), target: 'verify' },
    { label: 'Switch to real', done: mode === 'real' && !!real?.running, target: 'real' },
  ];

  const reset = async () => {
    if (!confirm('Clear all emulated data and recorded traffic? Generated builds and the REAL backend are kept.')) return;
    await control('/reset', { method: 'POST' });
    setMode('phantom');
    setReloadKey((k) => k + 1);
    await refreshAll();
  };

  return (
    <div className="min-h-screen">
      <a href="#board" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded focus:bg-teal focus:px-3 focus:py-1 focus:text-navy">Skip to TaskBoard</a>
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-5 px-4 py-5 lg:flex-row lg:items-end lg:justify-between lg:px-6">
          <div className="max-w-2xl">
            <p className="flex items-center gap-2 text-sm font-semibold text-muted">
              <svg viewBox="0 0 32 32" className="size-5" aria-hidden><rect width="32" height="32" rx="8" fill="#1a2550" /><path d="M9 24V8h8a5 5 0 0 1 0 10h-8" fill="none" stroke="#34c6b3" strokeWidth="3" /></svg>
              PHANTOM
            </p>
            <h1 className="mt-2 font-display text-[clamp(1.6rem,3.2vw,2.5rem)] font-extrabold leading-[1.05] tracking-tight text-ink">
              The TaskBoard below calls an API nobody has written.
            </h1>
            <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-muted">
              PHANTOM answers those requests, learns the contract from them, then generates a standalone backend and proves it behaves the same.
            </p>
          </div>
          <RouteStrip mode={mode} apiBase={apiBase ?? realUrl} realUrl={realUrl} realRunning={!!real?.running} />
        </div>
        <nav aria-label="Guided demo" className="mx-auto max-w-[1600px] px-4 pb-4 lg:px-6">
          <ol className="flex flex-wrap gap-2">
            {steps.map((s, i) => (
              <li key={s.label}>
                <a href={`#${s.target}`} className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors ${s.done ? 'border-teal/50 bg-teal/10 text-teal' : 'border-line text-muted hover:text-ink'}`}>
                  <span className={`grid size-4 place-items-center rounded-full text-[10px] font-bold ${s.done ? 'bg-teal text-navy' : 'bg-raised text-muted'}`} aria-hidden>{s.done ? '✓' : i + 1}</span>
                  {s.label}
                  <span className="sr-only">{s.done ? '(done)' : '(not done yet)'}</span>
                </a>
              </li>
            ))}
            <li className="ml-auto">
              <Button onClick={reset} className="text-xs">Start over</Button>
            </li>
          </ol>
        </nav>
      </header>

      {engineDown && (
        <p role="alert" className="mx-auto mt-4 max-w-[1600px] rounded-lg border border-rose/40 bg-rose/10 px-4 py-2 text-sm text-rose lg:mx-6">
          Can't reach the PHANTOM engine at {CONTROL_BASE || location.origin}. Start it with <code className="font-mono">npm start</code>, then reload.
        </p>
      )}
      {realMissing && (
        <p role="alert" className="mx-auto mt-4 flex max-w-[1600px] flex-wrap items-center gap-3 rounded-lg border border-amber/40 bg-amber/10 px-4 py-2 text-sm text-amber lg:mx-6">
          The TaskBoard is set to the real backend, but it isn't running.
          <Button onClick={() => setMode('phantom')} className="text-xs">Use PHANTOM instead</Button>
        </p>
      )}

      <main className="mx-auto grid max-w-[1600px] grid-cols-[minmax(0,1fr)] gap-4 p-4 lg:p-6">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(460px,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <section id="board" aria-label="TaskBoard demo app" className="flex min-h-[560px] flex-col overflow-hidden rounded-xl border border-line bg-paper">
            <header className="flex items-center gap-3 border-b border-[#dfe2ef] bg-white px-4 py-3 text-paper-ink">
              <h2 className="text-[15px] font-bold">TaskBoard</h2>
              <span className="text-xs text-[#6a7196]">demo app, no backend code</span>
              <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold ${mode === 'real' ? 'bg-teal/20 text-[#0f7466]' : 'bg-indigo/15 text-[#4048c9]'}`}>
                {mode === 'real' ? 'REAL' : 'PHANTOM'}
              </span>
            </header>
            {apiBase ? (
              <TaskBoard apiBase={apiBase} reloadKey={reloadKey + (mode === 'real' ? 1000 : 0)} />
            ) : (
              <p className="p-6 text-sm text-[#5b6288]">{engineDown ? 'Waiting for the PHANTOM engine…' : 'Looking up the real backend address…'}</p>
            )}
          </section>
          <ContractPanel contract={contract} />
          <TracePanel traces={traces} mode={mode} />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2 2xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
          <BuildPanel build={build} onBuilt={setBuild} canBuild={(status?.resources.length ?? 0) > 0 || traces.length > 0} />
          <ParityPanel build={build} reports={reports} onReport={(r) => setReports((prev) => [r, ...prev])} />
          <RealPanel build={build} real={real} mode={mode} setMode={setMode} onReal={setReal} />
        </div>
        <footer className="pb-6 pt-2 text-xs leading-relaxed text-faint">
          Inference is deterministic: field types and required fields come only from recorded traffic. Business rules, auth and relations are not inferred.
        </footer>
      </main>
    </div>
  );
}

function RouteStrip({ mode, apiBase, realUrl, realRunning }: { mode: Mode; apiBase: string; realUrl: string; realRunning: boolean }) {
  const host = (u: string) => u.replace(/^https?:\/\//, '');
  const port = (u: string) => `:${new URL(u).port || '80'}`;
  return (
    <figure className="w-full max-w-xl rounded-xl border border-line bg-panel p-3 lg:w-auto lg:min-w-[440px]" aria-label="Where TaskBoard requests go">
      <figcaption className="mb-2 flex items-center justify-between text-xs text-muted">
        <span>TaskBoard requests go to</span>
        <code className="font-mono text-ink">{host(apiBase)}/api</code>
      </figcaption>
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 text-xs">
        <span className="rounded-md bg-paper px-2 py-1 font-semibold text-paper-ink">TaskBoard</span>
        <div className="relative h-px bg-line" aria-hidden>
          <span className={`absolute -top-[3px] size-[7px] rounded-full ${mode === 'real' ? 'bg-teal' : 'bg-indigo'} motion-safe:animate-[ping_2s_ease-in-out_infinite]`} style={{ left: '50%' }} />
        </div>
        <div className="grid gap-1">
          <span className={`rounded-md border px-2 py-1 ${mode === 'phantom' ? 'border-indigo bg-indigo/15 text-ink' : 'border-line text-faint line-through decoration-faint/60'}`}>
            PHANTOM emulator <span className="font-mono">{port(PHANTOM_API_BASE)}</span>
          </span>
          <span className={`rounded-md border px-2 py-1 ${mode === 'real' ? 'border-teal bg-teal/15 text-ink' : 'border-line text-faint'}`}>
            Generated server <span className="font-mono">{port(realUrl)}</span> {realRunning ? '' : '(stopped)'}
          </span>
        </div>
      </div>
    </figure>
  );
}
