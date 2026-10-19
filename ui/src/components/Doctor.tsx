import { useEffect, useState } from 'react';
import { api, type Check } from '../api';
import { Dot } from './ui';

export function Doctor({ busy, onFix }: { busy: boolean; onFix: (fix: NonNullable<Check['fix']>) => Promise<void> }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const load = () => api.doctor().then((d) => setChecks(d.checks));

  useEffect(() => {
    void load();
  }, []);

  const fixLabel: Record<NonNullable<Check['fix']>, string> = {
    'install-mkcert': 'Install mkcert',
    'trust-ca': 'Trust CA',
    'add-include': 'Apply',
    'start-nginx': 'Start nginx',
    import: 'Go to Import',
  };

  return (
    <section className="space-y-3">
      <div className="flex justify-end">
        <button className="btn" onClick={() => void load()} disabled={busy}>
          Re-run checks
        </button>
      </div>
      {!checks ? (
        <div className="muted text-sm">Running checks…</div>
      ) : (
        <ul className="panel divide-y" style={{ borderColor: 'var(--line)' }}>
          {checks.map((c) => (
            <li key={c.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center" style={{ borderColor: 'var(--line)' }}>
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <span className="pt-1.5">
                  <Dot tone={c.status === 'ok' ? 'ok' : c.status === 'warn' ? 'warn' : 'err'} />
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">{c.label}</div>
                  <div className="muted mono text-[12px] break-all">{c.detail}</div>
                </div>
              </div>
              {c.fix && (
                <button className="btn" disabled={busy} onClick={() => onFix(c.fix!).then(load)}>
                  {fixLabel[c.fix]}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
