import { useEffect, useState } from 'react';
import { api, type ImportCandidate } from '../api';
import { Banner, Chip, Code } from './ui';

export function ImportView({ busy, onImport }: { busy: boolean; onImport: (domains: string[]) => Promise<void> }) {
  const [data, setData] = useState<{ confPath: string; candidates: ImportCandidate[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = () =>
    api
      .importPreview()
      .then((d) => {
        setData(d);
        setSelected(new Set(d.candidates.filter((c) => !c.error).map((c) => c.domain)));
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  if (error) return <Banner tone="err">{error}</Banner>;
  if (!data) return <div className="muted text-sm">Scanning nginx.conf…</div>;

  const toggle = (d: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });

  return (
    <section className="space-y-3">
      <p className="muted text-[13px] leading-relaxed">
        Finds HTTPS reverse-proxy <Code>server</Code> blocks in <Code>{data.confPath}</Code> and moves them under interact-nginx. Imported blocks are removed from nginx.conf after a
        backup is saved next to it. Existing certificate files are reused.
      </p>
      {data.candidates.length === 0 ? (
        <div className="panel muted p-6 text-center text-sm">No proxy server blocks found in nginx.conf.</div>
      ) : (
        <ul className="space-y-2">
          {data.candidates.map((c) => (
            <li key={c.domain} className="panel p-4">
              <label className="flex items-start gap-3">
                <input type="checkbox" className="mt-1 accent-[var(--color-accent)]" disabled={!!c.error} checked={selected.has(c.domain)} onChange={() => toggle(c.domain)} />
                <div className="min-w-0 flex-1">
                  <div className="mono text-[14px] font-semibold">
                    https://{c.domain} <span className="muted font-normal">→</span> {c.upstream || '?'}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {c.aliases.map((a) => (
                      <Chip key={a}>{a}</Chip>
                    ))}
                    {c.websocket && <Chip>websocket</Chip>}
                    {c.httpRedirect && <Chip>http→https</Chip>}
                    {c.certPath && <Chip>cert: {c.certPath.split('/').pop()}</Chip>}
                  </div>
                  {c.error && (
                    <p className="mt-2 text-[13px]" style={{ color: 'var(--warn)' }}>
                      {c.error}
                    </p>
                  )}
                  <details className="mt-2">
                    <summary className="muted cursor-pointer text-[12px]">Blocks that will be removed from nginx.conf</summary>
                    <pre className="mono mt-2 overflow-x-auto rounded-lg p-3 text-[11.5px] leading-relaxed" style={{ background: 'var(--soft)' }}>
                      {c.snippet}
                    </pre>
                  </details>
                </div>
              </label>
            </li>
          ))}
        </ul>
      )}
      {data.candidates.length > 0 && (
        <div className="flex justify-end">
          <button className="btn btn-primary" disabled={busy || selected.size === 0} onClick={() => onImport([...selected]).then(load)}>
            Import {selected.size} &amp; edit nginx.conf
          </button>
        </div>
      )}
    </section>
  );
}
