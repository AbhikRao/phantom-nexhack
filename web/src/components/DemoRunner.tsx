import { useState } from 'react';
import { PHANTOM_API_BASE, control, data } from '../api.ts';
import type { BuildInfo, Mode, ParityReport, RealStatus, Task } from '../api.ts';
import { Button } from './ui.tsx';

type StepState = { label: string; target: string; status: 'pending' | 'running' | 'done' | 'failed'; detail?: string };

const STEPS: Omit<StepState, 'status'>[] = [
  { label: 'Clear the emulator', target: 'board' },
  { label: 'Use the TaskBoard: create, move and delete tasks, add a note', target: 'board' },
  { label: 'Generate the backend', target: 'generate' },
  { label: 'Replay the recorded traffic against both servers', target: 'verify' },
  { label: 'Fuzz both servers with 200 seeded operations', target: 'verify' },
  { label: 'Check that a sabotaged build is caught', target: 'verify' },
  { label: 'Start the generated backend and switch to it', target: 'real' },
  { label: 'Create a task on the real port (the emulator must not see it)', target: 'board' },
  { label: 'Restart the process and read the task back from SQLite', target: 'real' },
];

const pause = (ms = 700) => new Promise((r) => setTimeout(r, ms));

/**
 * Drives the real product flow with real HTTP calls and control-plane actions, one visible step at a time.
 * It only automates what a person would click; every result shown comes from a response, and a failed step stops the run.
 */
export function DemoRunner(props: {
  setMode: (m: Mode) => void;
  onBuilt: (b: BuildInfo) => void;
  onReport: (r: ParityReport) => void;
  onReal: (r: RealStatus) => void;
  bump: () => void;
}) {
  const [steps, setSteps] = useState<StepState[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (!confirm('Run the scripted demo? This clears the emulator data and traces first. Existing builds are kept.')) return;
    const state: StepState[] = STEPS.map((s) => ({ ...s, status: 'pending' }));
    setSteps([...state]);
    setRunning(true);
    const update = (i: number, patch: Partial<StepState>) => {
      state[i] = { ...state[i], ...patch };
      setSteps([...state]);
    };
    let i = 0;
    const step = async (fn: () => Promise<string>) => {
      update(i, { status: 'running' });
      document.getElementById(STEPS[i].target)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      const detail = await fn();
      update(i, { status: 'done', detail });
      i++;
      await pause();
    };
    const expect = (cond: boolean, msg: string) => {
      if (!cond) throw new Error(msg);
    };

    try {
      const P = PHANTOM_API_BASE;
      let build!: BuildInfo;
      let real!: RealStatus;
      await step(async () => {
        await control('/reset', { method: 'POST' });
        props.setMode('phantom');
        props.bump();
        return 'Emulator and traces are empty';
      });
      await step(async () => {
        const a = await data<Task>(P, 'POST', '/api/tasks', { title: 'Write the pitch', description: '90 seconds, no slides', status: 'todo' });
        const b = await data<Task>(P, 'POST', '/api/tasks', { title: 'Record the demo', description: '', status: 'todo' });
        await data<Task>(P, 'POST', '/api/tasks', { title: 'Book the venue', description: 'not needed', status: 'doing' });
        await data(P, 'PATCH', `/api/tasks/${a.id}`, { status: 'doing' });
        await data(P, 'PATCH', `/api/tasks/${b.id}`, { status: 'done' });
        await data(P, 'DELETE', '/api/tasks/3');
        await data(P, 'POST', '/api/notes', { title: 'Demo note', content: 'a collection nobody declared' });
        props.bump();
        return '3 creates, 2 moves, 1 delete on /api/tasks, plus /api/notes discovered';
      });
      await step(async () => {
        build = await control<BuildInfo>('/builds', { method: 'POST' });
        props.onBuilt(build);
        return `${build.id}: ${build.files.length} files for ${build.resources.map((r) => '/api/' + r).join(', ')}`;
      });
      await step(async () => {
        const r = await control<ParityReport>(`/builds/${build.id}/parity`, { method: 'POST', body: {} });
        props.onReport(r);
        expect(r.summary.failed === 0, `Parity failed: ${r.summary.failed} of ${r.summary.total} checks differ`);
        return `${r.summary.passed} of ${r.summary.total} checks match`;
      });
      await step(async () => {
        const r = await control<ParityReport>(`/builds/${build.id}/parity`, { method: 'POST', body: { fuzz: { seed: 7, steps: 200 } } });
        props.onReport(r);
        expect(r.summary.failed === 0, `Fuzz parity failed: ${r.summary.failed} of ${r.summary.total} checks differ`);
        return `${r.summary.passed} of ${r.summary.total} checks match (seed 7)`;
      });
      await step(async () => {
        const r = await control<ParityReport>(`/builds/${build.id}/parity`, { method: 'POST', body: { mutation: 'patch-ignores-body' } });
        props.onReport(r);
        expect(r.summary.failed > 0, 'The sabotaged build was NOT caught, so this run proves nothing');
        return `Caught: ${r.summary.failed} of ${r.summary.total} checks fail`;
      });
      await step(async () => {
        real = await control<RealStatus>('/real/launch', { method: 'POST', body: { buildId: build.id, migrate: true } });
        props.onReal(real);
        expect(real.running, 'The generated backend did not start');
        props.setMode('real');
        const tasks = await data<Task[]>(real.url, 'GET', '/api/tasks');
        return `pid ${real.pid} on ${real.url.replace('http://', '')}, ${tasks.length} migrated tasks`;
      });
      let createdId = 0;
      await step(async () => {
        const t = await data<Task>(real.url, 'POST', '/api/tasks', { title: 'Saved in SQLite', description: 'lives on the real port', status: 'todo' });
        createdId = t.id;
        const emu = await data<Task[]>(P, 'GET', '/api/tasks');
        expect(!emu.some((x) => x.title === 'Saved in SQLite'), 'The emulator received a REAL-mode request');
        props.bump();
        return `Task #${t.id} created at ${real.url.replace('http://', '')}; the emulator has no such task`;
      });
      await step(async () => {
        const restarted = await control<RealStatus>('/real/restart', { method: 'POST' });
        props.onReal(restarted);
        expect(restarted.pid !== real.pid, 'The process did not restart');
        const back = await data<Task>(restarted.url, 'GET', `/api/tasks/${createdId}`);
        props.bump();
        return `New pid ${restarted.pid}; "${back.title}" read back from the database`;
      });
    } catch (e) {
      update(i, { status: 'failed', detail: (e as Error).message });
    } finally {
      setRunning(false);
    }
  };

  const failed = steps?.some((s) => s.status === 'failed');
  const done = steps?.every((s) => s.status === 'done');
  return (
    <>
      <Button tone="teal" onClick={run} busy={running} disabled={running} className="text-xs">
        Run the whole demo
      </Button>
      {steps && (
        <div className="fixed inset-x-3 bottom-3 z-20 max-h-[60vh] overflow-auto rounded-xl border border-line bg-panel p-4 shadow-xl sm:inset-x-auto sm:right-4 sm:w-[440px]" role="status" aria-live="polite" aria-label="Demo progress">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{done ? 'Demo finished, every step passed' : failed ? 'Demo stopped' : 'Running the demo'}</h2>
            {!running && <button onClick={() => setSteps(null)} className="rounded px-2 text-xs text-muted hover:bg-raised">Close</button>}
          </div>
          <ol className="space-y-1.5 text-xs">
            {steps.map((s) => (
              <li key={s.label} className="flex gap-2">
                <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold ${s.status === 'done' ? 'bg-teal text-navy' : s.status === 'failed' ? 'bg-rose text-navy' : s.status === 'running' ? 'bg-indigo text-navy motion-safe:animate-pulse' : 'bg-raised text-faint'}`} aria-hidden>
                  {s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : ''}
                </span>
                <span className={s.status === 'pending' ? 'text-faint' : 'text-ink'}>
                  {s.label}
                  {s.detail && <span className={`block ${s.status === 'failed' ? 'text-rose' : 'text-muted'}`}>{s.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}
