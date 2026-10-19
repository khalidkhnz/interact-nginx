import net from 'node:net';
import { detectNginx, findManagedTarget, readConf } from './platform.js';
import { mkcertStatus } from './certs.js';
import { nginxStatus } from './nginx.js';
import { loadState } from './store.js';
import { serverNamesInConf } from './apply.js';

export interface Check {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
  fix?: 'install-mkcert' | 'trust-ca' | 'add-include' | 'start-nginx' | 'import';
}

export function probe(host: string, port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function upstreamUp(upstream: string): Promise<boolean> {
  const url = new URL(upstream);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port);
  if (host === 'localhost') return (await probe('127.0.0.1', port)) || probe('::1', port);
  return probe(host, port);
}

export async function runDoctor(): Promise<Check[]> {
  const checks: Check[] = [];
  const info = await detectNginx(true);
  if (!info) {
    checks.push({ id: 'nginx', label: 'nginx binary', status: 'error', detail: 'nginx not found. Install it (brew install nginx / apt install nginx / nginx.org for Windows) or set INX_NGINX_BIN.' });
  } else {
    checks.push({ id: 'nginx', label: 'nginx binary', status: 'ok', detail: `${info.bin} (v${info.version})` });
    try {
      const conf = await readConf(info);
      checks.push({ id: 'conf', label: 'nginx.conf', status: 'ok', detail: info.confPath });
      const target = findManagedTarget(conf, info.confDir);
      checks.push(
        target.include
          ? { id: 'include', label: 'Config include', status: 'ok', detail: `Managed files go to ${target.dir} (via "include ${target.include}")` }
          : { id: 'include', label: 'Config include', status: 'warn', detail: 'nginx.conf has no include for managed files. The first apply will add one.', fix: 'add-include' },
      );
      const state = await loadState();
      const declared = new Set(serverNamesInConf(conf));
      const conflicts = state.proxies.flatMap((p) => [p.domain, ...p.aliases]).filter((d) => declared.has(d));
      if (conflicts.length) {
        checks.push({ id: 'conflicts', label: 'Duplicate server_name', status: 'warn', detail: `${conflicts.join(', ')} also defined in nginx.conf, and that block wins. Import it to manage it here.`, fix: 'import' });
      }
    } catch (err) {
      checks.push({ id: 'conf', label: 'nginx.conf', status: 'error', detail: (err as Error).message });
    }
    const status = await nginxStatus(info);
    checks.push(
      status.running
        ? { id: 'running', label: 'nginx process', status: 'ok', detail: `running (pid ${status.pid}${status.user ? `, user ${status.user}` : ''})` }
        : { id: 'running', label: 'nginx process', status: 'warn', detail: 'not running', fix: 'start-nginx' },
    );
    if (!status.running) {
      for (const port of [80, 443]) {
        if (await probe('127.0.0.1', port, 300)) {
          checks.push({ id: `port-${port}`, label: `Port ${port}`, status: 'error', detail: `Something else is listening on ${port}; nginx won't be able to bind it.` });
        }
      }
    }
  }

  const mk = await mkcertStatus();
  if (!mk.bin) checks.push({ id: 'mkcert', label: 'mkcert', status: 'error', detail: 'mkcert not found. It is needed to issue trusted local certificates.', fix: 'install-mkcert' });
  else {
    checks.push({ id: 'mkcert', label: 'mkcert', status: 'ok', detail: mk.bin });
    if (mk.trusted === false) checks.push({ id: 'ca', label: 'Local CA trusted', status: 'warn', detail: 'The mkcert CA is not in the system trust store, so browsers will warn.', fix: 'trust-ca' });
    else if (mk.trusted === null) checks.push({ id: 'ca', label: 'Local CA trusted', status: 'warn', detail: `Can't verify trust on this OS. Run "Trust CA" if browsers show warnings.`, fix: 'trust-ca' });
    else checks.push({ id: 'ca', label: 'Local CA trusted', status: 'ok', detail: mk.caroot ?? '' });
  }

  const state = await loadState();
  for (const p of state.proxies.filter((x) => x.enabled)) {
    const up = await upstreamUp(p.upstream);
    checks.push({ id: `up-${p.id}`, label: `Upstream ${p.upstream}`, status: up ? 'ok' : 'warn', detail: up ? `reachable (for ${p.domain})` : `nothing listening (for ${p.domain})` });
  }
  return checks;
}
