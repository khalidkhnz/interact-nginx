import type { ReactNode } from 'react';
import type { ApplyStep } from '../api';

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'err' | 'off' }) {
  const color = { ok: 'var(--ok)', warn: 'var(--warn)', err: 'var(--err)', off: 'var(--muted)' }[tone];
  return <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: color, boxShadow: tone === 'ok' ? `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)` : undefined }} />;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50"
      style={{ background: checked ? 'var(--color-accent)' : 'var(--line)' }}
    >
      <span className="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform" style={{ transform: checked ? 'translateX(16px)' : undefined }} />
    </button>
  );
}

export function Banner({ tone, children, action }: { tone: 'info' | 'warn' | 'err'; children: ReactNode; action?: ReactNode }) {
  const color = { info: 'var(--accent-text)', warn: 'var(--warn)', err: 'var(--err)' }[tone];
  return (
    <div
      className="flex flex-col gap-3 rounded-xl px-4 py-3 text-[13px] sm:flex-row sm:items-center"
      style={{ border: `1px solid color-mix(in srgb, ${color} 35%, var(--line))`, background: `color-mix(in srgb, ${color} 7%, var(--panel))` }}
    >
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
      {action && <div className="flex shrink-0 gap-2">{action}</div>}
    </div>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md px-1.5 py-0.5 text-[11px] font-medium" style={{ background: 'var(--soft)', color: 'var(--muted)' }}>
      {children}
    </span>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="mono rounded px-1 py-px text-[12px]" style={{ background: 'var(--soft)' }}>
      {children}
    </code>
  );
}

export interface ResultView {
  title: string;
  ok: boolean;
  steps: ApplyStep[];
}

export function ResultPanel({ result, onClose }: { result: ResultView; onClose: () => void }) {
  return (
    <div className="panel fixed right-4 bottom-4 left-4 z-20 max-h-[60vh] overflow-auto p-4 shadow-2xl sm:left-auto sm:w-[460px]" role="status">
      <div className="mb-3 flex items-center gap-2">
        <Dot tone={result.ok ? 'ok' : 'err'} />
        <div className="flex-1 text-sm font-semibold">{result.title}</div>
        <button className="btn btn-ghost h-7 px-2" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <ul className="space-y-2">
        {result.steps.map((s, i) => (
          <li key={i} className="text-[13px]">
            <div className="flex gap-2">
              <span style={{ color: s.ok ? 'var(--ok)' : 'var(--err)' }}>{s.ok ? '✓' : '✕'}</span>
              <span>{s.name}</span>
            </div>
            {s.output && (!s.ok || s.output.includes('warn')) && (
              <pre className="mono mt-1.5 ml-5 overflow-x-auto rounded-lg p-2 text-[11.5px] leading-relaxed whitespace-pre-wrap" style={{ background: 'var(--soft)' }}>
                {s.output}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
