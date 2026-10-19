import { useState } from 'react';
import type { Proxy } from '../api';
import { Chip, Dot, Switch } from './ui';
import { ProxyForm, type ProxyDraft } from './ProxyForm';

export function ProxyList({
  proxies,
  busy,
  onToggle,
  onSave,
  onDelete,
}: {
  proxies: Proxy[];
  busy: boolean;
  onToggle: (p: Proxy, enabled: boolean) => void;
  onSave: (id: string | null, draft: ProxyDraft, applyNow: boolean) => Promise<void>;
  onDelete: (p: Proxy) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const showAdd = adding || proxies.length === 0;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Proxies <span className="muted font-normal">{proxies.length}</span>
        </h2>
        {!showAdd && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            + Add proxy
          </button>
        )}
      </div>

      {showAdd && (
        <ProxyForm
          busy={busy}
          onCancel={proxies.length ? () => setAdding(false) : undefined}
          onSubmit={async (draft, applyNow) => {
            await onSave(null, draft, applyNow);
            setAdding(false);
          }}
        />
      )}

      <ul className="space-y-2">
        {proxies.map((p) =>
          editing === p.id ? (
            <li key={p.id}>
              <ProxyForm
                initial={p}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSubmit={async (draft, applyNow) => {
                  await onSave(p.id, draft, applyNow);
                  setEditing(null);
                }}
              />
            </li>
          ) : (
            <li key={p.id} className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center" style={{ opacity: p.enabled ? 1 : 0.6 }}>
              <Switch label={`Enable ${p.domain}`} checked={p.enabled} disabled={busy} onChange={(v) => onToggle(p, v)} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <a href={`https://${p.domain}`} target="_blank" rel="noreferrer" className="mono truncate text-[14px] font-semibold hover:underline" style={{ color: 'var(--accent-text)' }}>
                    https://{p.domain}
                  </a>
                  <span className="muted">→</span>
                  <span className="mono text-[13px]">{p.upstream}</span>
                  <span className="flex items-center gap-1.5 text-[12px]" title={p.upstreamUp ? 'Something is listening on the upstream port' : 'Nothing is listening on the upstream port'}>
                    <Dot tone={p.upstreamUp ? 'ok' : 'off'} />
                    <span className="muted">{p.upstreamUp ? 'up' : 'down'}</span>
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {p.aliases.map((a) => (
                    <Chip key={a}>{a}</Chip>
                  ))}
                  {p.websocket && <Chip>websocket</Chip>}
                  {p.httpRedirect && <Chip>http→https</Chip>}
                  {p.certPath && <Chip>imported cert</Chip>}
                </div>
              </div>
              <div className="flex gap-1">
                <button className="btn btn-ghost" onClick={() => setEditing(p.id)} disabled={busy}>
                  Edit
                </button>
                <button className="btn btn-ghost btn-danger" onClick={() => onDelete(p)} disabled={busy}>
                  Delete
                </button>
              </div>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
