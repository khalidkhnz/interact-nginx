import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type LogSource } from '../api';

const MAX_LINES = 3000;

function lineTone(line: string): string | undefined {
  if (/\[(emerg|alert|crit|error)\]/.test(line) || /" 5\d\d /.test(line)) return 'var(--err)';
  if (/\[warn\]/.test(line) || /" 4\d\d /.test(line)) return 'var(--warn)';
  return undefined;
}

export function Logs() {
  const [sources, setSources] = useState<LogSource[]>([]);
  const [source, setSource] = useState('');
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const pausedRef = useRef(paused);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  pausedRef.current = paused;

  useEffect(() => {
    api.logSources().then(({ sources }) => {
      setSources(sources);
      setSource((s) => s || sources[0]?.id || '');
    });
  }, []);

  useEffect(() => {
    if (!source) return;
    setLines([]);
    const es = new EventSource(api.logStreamUrl(source));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      if (pausedRef.current) return;
      const incoming = JSON.parse(e.data) as string[];
      setLines((prev) => {
        const next = prev.concat(incoming);
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    };
    return () => es.close();
  }, [source]);

  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  const visible = useMemo(() => (filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines), [lines, filter]);
  const current = sources.find((s) => s.id === source);

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <select className="input sm:w-72" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Log source">
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <input className="input sm:flex-1" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="flex gap-2">
          <button className="btn" onClick={() => setPaused((p) => !p)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button className="btn" onClick={() => setLines([])}>
            Clear
          </button>
        </div>
      </div>
      <div className="muted mono flex items-center gap-2 truncate text-[11.5px]">
        <span className="inline-block size-1.5 rounded-full" style={{ background: connected && !paused ? 'var(--ok)' : 'var(--muted)' }} />
        {current?.path}
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="panel mono h-[60vh] overflow-auto p-3 text-[12px] leading-[1.6]"
      >
        {visible.length === 0 ? (
          <div className="muted">Waiting for log lines…</div>
        ) : (
          visible.map((l, i) => (
            <div key={i} className="break-all whitespace-pre-wrap" style={{ color: lineTone(l) }}>
              {l}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
