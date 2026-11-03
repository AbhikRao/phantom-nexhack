import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { data, onCall } from '../api.ts';
import type { CallRecord, Note, Status, Task } from '../api.ts';
import { Button, ErrorNote, Method, StatusCode } from './ui.tsx';

const COLUMNS: { id: Status; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'In progress' },
  { id: 'done', label: 'Done' },
];

/**
 * The demo client app. It has no local data store: every view is the result of an HTTP response from `apiBase`.
 */
export function TaskBoard({ apiBase, reloadKey }: { apiBase: string; reloadKey: number }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<Status>('todo');
  const [editing, setEditing] = useState<number | null>(null);
  const [calls, setCalls] = useState<CallRecord[]>([]);

  useEffect(() => onCall((c) => setCalls((prev) => [c, ...prev].slice(0, 4))), []);

  const load = useCallback(async () => {
    try {
      setTasks(await data<Task[]>(apiBase, 'GET', '/api/tasks'));
      setError(null);
    } catch (e) {
      setTasks(null);
      setError((e as Error).message);
    }
  }, [apiBase]);

  useEffect(() => {
    setTasks(null);
    void load();
  }, [load, reloadKey]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    void run(async () => {
      await data(apiBase, 'POST', '/api/tasks', { title: title.trim(), description: description.trim(), status });
      setTitle('');
      setDescription('');
    });
  };

  const move = (t: Task, dir: -1 | 1) => {
    const i = COLUMNS.findIndex((c) => c.id === t.status);
    const next = COLUMNS[i + dir];
    if (next) void run(() => data(apiBase, 'PATCH', `/api/tasks/${t.id}`, { status: next.id }));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-paper-ink">
      <form onSubmit={create} className="grid gap-2 border-b border-[#dfe2ef] p-3 sm:grid-cols-[1fr_auto]" aria-label="Create task">
        <div className="grid gap-2">
          <label className="sr-only" htmlFor="task-title">Task name</label>
          <input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" maxLength={120} className="rounded-lg border border-[#d4d8ea] bg-white px-3 py-2 text-sm outline-none placeholder:text-[#8a90ad] focus:border-indigo" />
          <label className="sr-only" htmlFor="task-desc">Description</label>
          <input id="task-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" maxLength={400} className="rounded-lg border border-[#d4d8ea] bg-white px-3 py-2 text-sm outline-none placeholder:text-[#8a90ad] focus:border-indigo" />
        </div>
        <div className="flex gap-2 sm:flex-col">
          <label className="sr-only" htmlFor="task-status">Status</label>
          <select id="task-status" value={status} onChange={(e) => setStatus(e.target.value as Status)} className="flex-1 rounded-lg border border-[#d4d8ea] bg-white px-2 py-2 text-sm">
            {COLUMNS.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
          <button type="submit" disabled={!title.trim() || busy} className="flex-1 rounded-lg bg-paper-ink px-4 py-2 text-sm font-semibold text-white hover:bg-[#2c3670] disabled:opacity-40">
            Add task
          </button>
        </div>
      </form>

      {error && (
        <div className="p-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="scroll-thin grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-auto p-3 sm:grid-cols-3">
        {COLUMNS.map((col, ci) => {
          const items = tasks?.filter((t) => t.status === col.id) ?? [];
          return (
            <div key={col.id} className="flex min-w-0 flex-col gap-2 rounded-lg bg-[#e9ebf5] p-2">
              <h3 className="flex items-center justify-between px-1 text-xs font-semibold text-[#4a5280]">
                {col.label}
                <span className="rounded-full bg-white px-2 text-[11px] text-[#4a5280]">{items.length}</span>
              </h3>
              {tasks === null && !error && <div className="h-14 animate-pulse rounded-md bg-white/70" />}
              {items.map((t) => (
                <article key={t.id} className="group rounded-md border border-[#dfe2ef] bg-white p-2.5 shadow-[0_1px_0_#d4d8ea]">
                  {editing === t.id ? (
                    <EditTask
                      task={t}
                      onCancel={() => setEditing(null)}
                      onSave={(patch) => {
                        setEditing(null);
                        void run(() => data(apiBase, 'PATCH', `/api/tasks/${t.id}`, patch));
                      }}
                    />
                  ) : (
                    <>
                      <p className="break-words text-sm font-semibold leading-snug">{t.title}</p>
                      {t.description && <p className="mt-0.5 break-words text-xs leading-relaxed text-[#5b6288]">{t.description}</p>}
                      <div className="mt-2 flex items-center gap-1 text-[#4a5280]">
                        <span className="mr-auto font-mono text-[10px] text-[#8a90ad]">#{t.id}</span>
                        <IconBtn label={`Move "${t.title}" left`} disabled={ci === 0 || busy} onClick={() => move(t, -1)}>‹</IconBtn>
                        <IconBtn label={`Move "${t.title}" right`} disabled={ci === COLUMNS.length - 1 || busy} onClick={() => move(t, 1)}>›</IconBtn>
                        <IconBtn label={`Edit "${t.title}"`} disabled={busy} onClick={() => setEditing(t.id)}>✎</IconBtn>
                        <IconBtn label={`Delete "${t.title}"`} disabled={busy} onClick={() => void run(() => data(apiBase, 'DELETE', `/api/tasks/${t.id}`))} danger>×</IconBtn>
                      </div>
                    </>
                  )}
                </article>
              ))}
              {tasks !== null && items.length === 0 && <p className="px-1 py-3 text-center text-xs text-[#8a90ad]">Nothing here</p>}
            </div>
          );
        })}
      </div>

      <NotesStrip apiBase={apiBase} reloadKey={reloadKey} />

      <div className="border-t border-[#dfe2ef] bg-[#eceef7] px-3 py-2" aria-live="polite">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-semibold text-[#4a5280]">Requests this page sent</span>
          <button onClick={() => void load()} className="rounded px-1.5 text-[11px] font-semibold text-[#4a5280] hover:bg-white">Refresh</button>
        </div>
        {calls.length === 0 ? (
          <p className="text-[11px] text-[#8a90ad]">None yet</p>
        ) : (
          <ul className="space-y-0.5">
            {calls.map((c) => (
              <li key={c.id} className="flex items-center gap-2 overflow-hidden rounded bg-paper-ink px-2 py-0.5 font-mono text-[11px] text-white">
                <Method m={c.method} />
                <span className="truncate">{c.url}</span>
                <span className="ml-auto flex shrink-0 gap-2">
                  <StatusCode s={c.status} />
                  <span className="text-[#9aa2c8]">{c.ms}ms</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function IconBtn({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: string }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className={`grid size-7 place-items-center rounded-md text-base leading-none hover:bg-[#eceef7] disabled:opacity-30 ${danger ? 'hover:text-[#d23a57]' : ''}`}>
      {children}
    </button>
  );
}

function EditTask({ task, onSave, onCancel }: { task: Task; onSave: (p: { title: string; description: string }) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  return (
    <form
      className="grid gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onSave({ title: title.trim(), description: description.trim() });
      }}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <input aria-label="Task name" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className="rounded border border-[#d4d8ea] px-2 py-1 text-sm" />
      <textarea aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="resize-none rounded border border-[#d4d8ea] px-2 py-1 text-xs" />
      <div className="flex justify-end gap-1">
        <button type="button" onClick={onCancel} className="rounded px-2 py-1 text-xs text-[#4a5280] hover:bg-[#eceef7]">Cancel</button>
        <button type="submit" className="rounded bg-paper-ink px-2 py-1 text-xs font-semibold text-white">Save</button>
      </div>
    </form>
  );
}

/** A second, never-declared resource (/api/notes) to show that PHANTOM discovers collections from first use. */
function NotesStrip({ apiBase, reloadKey }: { apiBase: string; reloadKey: number }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setNotes(await data<Note[]>(apiBase, 'GET', '/api/notes'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [apiBase]);
  useEffect(() => {
    if (open) void load();
  }, [open, load, reloadKey]);
  return (
    <div className="border-t border-[#dfe2ef] px-3 py-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-xs font-semibold text-[#4a5280]">
        <span>Notes <span className="font-normal text-[#8a90ad]">(a second collection at /api/notes)</span></span>
        <span aria-hidden>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="mt-2 grid gap-2">
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!text.trim()) return;
              try {
                await data(apiBase, 'POST', '/api/notes', { title: text.trim().slice(0, 60), content: text.trim() });
                setText('');
                await load();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <label htmlFor="note-text" className="sr-only">Note</label>
            <input id="note-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Jot a note" className="min-w-0 flex-1 rounded border border-[#d4d8ea] bg-white px-2 py-1 text-xs" />
            <button type="submit" disabled={!text.trim()} className="rounded bg-paper-ink px-2 text-xs font-semibold text-white disabled:opacity-40">Save note</button>
          </form>
          {error && <p className="text-xs text-[#d23a57]">{error}</p>}
          <ul className="scroll-thin max-h-24 space-y-1 overflow-auto">
            {notes.map((n) => (
              <li key={n.id} className="flex items-start gap-2 rounded bg-white px-2 py-1 text-xs">
                <span className="min-w-0 flex-1 break-words">{n.content}</span>
                <button aria-label={`Delete note ${n.id}`} onClick={async () => { await data(apiBase, 'DELETE', `/api/notes/${n.id}`).catch((e) => setError(e.message)); await load(); }} className="text-[#8a90ad] hover:text-[#d23a57]">×</button>
              </li>
            ))}
            {notes.length === 0 && !error && <li className="text-xs text-[#8a90ad]">No notes yet. Saving one creates /api/notes on first use.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
