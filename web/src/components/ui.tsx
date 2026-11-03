import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Panel({ title, aside, children, className = '', id }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`flex min-h-0 flex-col rounded-xl border border-line bg-panel ${className}`} aria-labelledby={id ? `${id}-title` : undefined}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-3">
        <h2 id={id ? `${id}-title` : undefined} className="text-[15px] font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {aside && <div className="flex flex-wrap items-center gap-2">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

type Tone = 'primary' | 'ghost' | 'danger' | 'teal';
export function Button({ tone = 'ghost', className = '', busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; busy?: boolean }) {
  const tones: Record<Tone, string> = {
    primary: 'bg-indigo text-navy hover:bg-[#9298ff] font-semibold',
    teal: 'bg-teal text-navy hover:bg-[#52d6c4] font-semibold',
    ghost: 'border border-line text-ink hover:border-faint hover:bg-raised',
    danger: 'border border-line text-rose hover:border-rose/60 hover:bg-rose/10',
  };
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]} ${className}`}
    >
      {busy && <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-[#8fb7ff]',
  POST: 'text-teal',
  PATCH: 'text-amber',
  PUT: 'text-amber',
  DELETE: 'text-rose',
};
export function Method({ m }: { m: string }) {
  return <span className={`font-mono text-xs font-medium ${METHOD_COLOR[m] ?? 'text-muted'}`}>{m}</span>;
}

export function StatusCode({ s }: { s: number | string }) {
  const n = typeof s === 'number' ? s : 0;
  const c = n >= 500 || n === 0 ? 'text-rose' : n >= 400 ? 'text-amber' : 'text-teal';
  return <span className={`font-mono text-xs ${c}`}>{s}</span>;
}

export function Json({ value, className = '' }: { value: unknown; className?: string }) {
  if (value === undefined) return <p className="text-xs text-faint">No body</p>;
  return (
    <pre className={`scroll-thin overflow-auto rounded-lg bg-navy p-3 font-mono text-[12px] leading-relaxed text-ink ${className}`}>
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-8 text-center text-sm text-muted">{children}</div>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-rose/40 bg-rose/10 px-3 py-2 text-sm text-rose">
      {children}
    </p>
  );
}
