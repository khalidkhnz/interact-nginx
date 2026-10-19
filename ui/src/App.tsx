import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, token, type ApplyResult, type Check, type Proxy, type Status } from './api';
import { Banner, Code, Dot, ResultPanel, type ResultView } from './components/ui';
import { ProxyList } from './components/ProxyList';
import { Logs } from './components/Logs';
import { ImportView } from './components/ImportView';
import { Doctor } from './components/Doctor';
import type { ProxyDraft } from './components/ProxyForm';

type Tab = 'proxies' | 'logs' | 'import' | 'doctor';
const TABS: Array<[Tab, string]> = [
  ['proxies', 'Proxies'],
  ['logs', 'Logs'],
  ['import', 'Import'],
  ['doctor', 'Doctor'],
];

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [tab, setTab] = useState<Tab>('proxies');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResultView | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.status(), api.proxies()]);
      setStatus(s);
      setProxies(p.proxies);
      setFatal(null);
    } catch (err) {
      setFatal(err instanceof ApiError && err.status === 401 ? 'unauthorized' : (err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const run = async (title: string, fn: () => Promise<ApplyResult | { ok: boolean; output: string } | void>) => {
    setBusy(true);
    try {
      const res = await fn();
      if (res && 'steps' in res) setResult({ title: res.ok ? `${title}: done` : `${title}: failed`, ok: res.ok, steps: res.steps });
      else if (res) setResult({ title, ok: res.ok, steps: [{ name: res.ok ? 'Done' : 'Failed', ok: res.ok, output: res.output }] });
    } catch (err) {
      setResult({ title, ok: false, steps: [{ name: (err as Error).message, ok: false }] });
      throw err;
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const plan = status?.plan;
  const needsInclude = !!plan && plan.include === null;
  const applyNow = () => run('Apply', () => api.apply(needsInclude)).catch(() => {});

  const saveProxy = async (id: string | null, draft: ProxyDraft, andApply: boolean) => {
    if (id) await api.updateProxy(id, draft);
    else await api.addProxy(draft);
    await refresh();
    if (andApply) await applyNow();
  };

  const onFix = async (fix: NonNullable<Check['fix']>) => {
    if (fix === 'import') return setTab('import');
    if (fix === 'start-nginx') return run('Start nginx', () => api.nginx('start')).catch(() => {});
    if (fix === 'add-include') return applyNow();
    return run(fix === 'trust-ca' ? 'Trust local CA' : 'Install mkcert', () => api.setup(fix)).catch(() => {});
  };

  if (fatal === 'unauthorized' || (!token && !status)) {
    return (
      <Shell>
        <Banner tone="warn">
          This tab isn't authorized. Open the link printed by <Code>npx interact-nginx</Code> in your terminal (it includes a one-time token).
        </Banner>
      </Shell>
    );
  }

  const proc = status?.process;
  const nginxMissing = status && !status.nginx;

  return (
    <Shell
      header={
        status?.nginx && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px]" style={{ background: 'var(--soft)' }}>
              <Dot tone={proc?.running ? 'ok' : 'off'} />
              <span className="font-medium">{proc?.running ? 'nginx running' : 'nginx stopped'}</span>
              <span className="muted hidden sm:inline">
                v{status.nginx.version}
                {proc?.running && ` · pid ${proc.pid}${proc.user ? ` · ${proc.user}` : ''}`}
              </span>
            </div>
            {proc?.running ? (
              <>
                <button className="btn" disabled={busy} onClick={() => run('Reload nginx', () => api.nginx('reload')).catch(() => {})}>
                  Reload
                </button>
                <button className="btn" disabled={busy} onClick={() => run('Stop nginx', () => api.nginx('stop')).catch(() => {})}>
                  Stop
                </button>
              </>
            ) : (
              <button className="btn btn-primary" disabled={busy} onClick={() => run('Start nginx', () => api.nginx('start')).catch(() => {})}>
                Start
              </button>
            )}
            <button className="btn" disabled={busy} onClick={() => run('nginx -t', () => api.nginx('test')).catch(() => {})}>
              Test config
            </button>
          </div>
        )
      }
    >
      {fatal && <Banner tone="err">Can't reach the interact-nginx server: {fatal}. Is the CLI still running?</Banner>}
      {nginxMissing && (
        <Banner tone="err">
          nginx was not found. Install it (<Code>brew install nginx</Code>, <Code>sudo apt install nginx</Code>, or nginx.org on Windows) and reload this page.
        </Banner>
      )}
      {status?.planError && <Banner tone="err">Can't read nginx config: {status.planError}</Banner>}

      {plan?.pending && (
        <Banner
          tone="info"
          action={
            <button className="btn btn-primary" disabled={busy} onClick={applyNow}>
              {busy ? 'Applying…' : needsInclude ? 'Apply & edit nginx.conf' : 'Apply changes'}
            </button>
          }
        >
          <div className="font-medium">You have changes that aren't applied yet.</div>
          <div className="muted">
            {[plan.writes.length && `${plan.writes.length} config file(s) to write`, plan.removes.length && `${plan.removes.length} to remove`, plan.hostsChanged && `${status?.hostsPath} entries`]
              .filter(Boolean)
              .join(' · ')}
            {plan.hostsChanged && '. Your OS will ask for an admin password to edit the hosts file.'}
          </div>
          {needsInclude && (
            <div className="muted mt-1">
              Your nginx.conf doesn't load extra config files yet. Apply adds <Code>include interact-nginx/*.conf;</Code> to its <Code>http</Code> block and saves a backup first.
            </div>
          )}
        </Banner>
      )}

      {plan && plan.conflicts.length > 0 && (
        <Banner tone="warn" action={<button className="btn" onClick={() => setTab('import')}>Open Import</button>}>
          <Code>{plan.conflicts.join(', ')}</Code> is also defined in nginx.conf, and that block wins. Import it so interact-nginx manages it.
        </Banner>
      )}

      {status && status.mkcert.bin === null && (
        <Banner tone="warn" action={<button className="btn" disabled={busy} onClick={() => onFix('install-mkcert')}>Install mkcert</button>}>
          mkcert is needed to issue trusted local HTTPS certificates.
        </Banner>
      )}
      {status && status.mkcert.bin && status.mkcert.trusted === false && (
        <Banner tone="warn" action={<button className="btn" disabled={busy} onClick={() => onFix('trust-ca')}>Trust CA</button>}>
          The local certificate authority isn't trusted yet, so browsers will show warnings. Trusting it needs your admin password once.
        </Banner>
      )}
      {status?.nginx && !proc?.running && proxies.some((p) => p.enabled) && !plan?.pending && (
        <Banner tone="warn" action={<button className="btn btn-primary" disabled={busy} onClick={() => onFix('start-nginx')}>Start nginx</button>}>
          nginx is stopped, so your proxies aren't being served.
        </Banner>
      )}

      <nav className="flex gap-1 overflow-x-auto border-b" style={{ borderColor: 'var(--line)' }}>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors"
            style={{ borderColor: tab === id ? 'var(--color-accent)' : 'transparent', color: tab === id ? 'var(--text)' : 'var(--muted)' }}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'proxies' && !status && !fatal && <div className="muted text-sm">Loading…</div>}
      {tab === 'proxies' && status && (
        <ProxyList
          proxies={proxies}
          busy={busy}
          onSave={saveProxy}
          onToggle={async (p, enabled) => {
            await api.updateProxy(p.id, { enabled });
            await refresh();
          }}
          onDelete={async (p) => {
            if (!confirm(`Delete https://${p.domain}? Apply afterwards to remove it from nginx.`)) return;
            await api.deleteProxy(p.id);
            await refresh();
          }}
        />
      )}
      {tab === 'logs' && <Logs />}
      {tab === 'import' && <ImportView busy={busy} onImport={(domains) => run('Import', () => api.runImport(domains)).then(() => setTab('proxies'))} />}
      {tab === 'doctor' && <Doctor busy={busy} onFix={onFix} />}

      {status?.nginx && (
        <footer className="muted mono space-y-0.5 pt-6 text-[11px]">
          <div>conf: {status.nginx.confPath}</div>
          {plan && <div>managed: {plan.managedDir}</div>}
          <div>state: {status.home}</div>
        </footer>
      )}

      {result && <ResultPanel result={result} onClose={() => setResult(null)} />}
    </Shell>
  );
}

function Shell({ header, children }: { header?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-8" />
          <div>
            <h1 className="text-[15px] leading-tight font-semibold">interact-nginx</h1>
            <p className="muted text-[12px]">Local HTTPS domains for your dev servers</p>
          </div>
        </div>
        {header}
      </header>
      <main className="space-y-4">{children}</main>
    </div>
  );
}
