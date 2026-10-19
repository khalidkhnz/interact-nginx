import { useState, type FormEvent } from 'react';
import type { Proxy } from '../api';

export interface ProxyDraft {
  domain: string;
  upstream: string;
  aliases: string[];
  websocket: boolean;
  httpRedirect: boolean;
}

export function ProxyForm({
  initial,
  onSubmit,
  onCancel,
  busy,
}: {
  initial?: Proxy;
  onSubmit: (draft: ProxyDraft, applyNow: boolean) => Promise<void>;
  onCancel?: () => void;
  busy: boolean;
}) {
  const [domain, setDomain] = useState(initial?.domain ?? '');
  const [upstream, setUpstream] = useState(initial ? initial.upstream.replace(/^http:\/\/localhost:(\d+)$/, '$1') : '');
  const [aliases, setAliases] = useState(initial?.aliases.join(', ') ?? '');
  const [websocket, setWebsocket] = useState(initial?.websocket ?? true);
  const [httpRedirect, setHttpRedirect] = useState(initial?.httpRedirect ?? true);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent, applyNow: boolean) => {
    e.preventDefault();
    setError(null);
    try {
      await onSubmit({ domain, upstream, aliases: aliases.split(/[\s,]+/).filter(Boolean), websocket, httpRedirect }, applyNow);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="panel p-4" onSubmit={(e) => submit(e, false)}>
      <div className="grid gap-3 sm:grid-cols-[1.4fr_auto_1fr] sm:items-end">
        <label className="block">
          <span className="label">Domain</span>
          <div className="mt-1 flex items-center">
            <span className="mono muted mr-1 text-[13px]">https://</span>
            <input className="input mono" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="app.local.test" required autoFocus={!initial} />
          </div>
        </label>
        <div className="muted hidden pb-2 text-center sm:block">→</div>
        <label className="block">
          <span className="label">Upstream</span>
          <input className="input mono mt-1" value={upstream} onChange={(e) => setUpstream(e.target.value)} placeholder="3000 or http://localhost:3000" required />
        </label>
      </div>
      <label className="mt-3 block">
        <span className="label">Extra names (optional, comma separated)</span>
        <input className="input mono mt-1" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="api.local.test, admin.local.test" />
      </label>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={websocket} onChange={(e) => setWebsocket(e.target.checked)} className="accent-[var(--color-accent)]" />
          WebSocket / HMR
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={httpRedirect} onChange={(e) => setHttpRedirect(e.target.checked)} className="accent-[var(--color-accent)]" />
          Redirect http → https
        </label>
      </div>
      {error && (
        <p className="mt-3 text-[13px]" style={{ color: 'var(--err)' }}>
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn" disabled={busy}>
          Save
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={(e) => submit(e, true)}>
          Save &amp; apply
        </button>
      </div>
    </form>
  );
}
