import { Command } from 'commander';
import { ZodError } from 'zod';
import open from 'open';
import { startServer, loadToken, VERSION } from './server/index.js';
import { loadState, addProxy, removeProxy, findProxy } from './core/store.js';
import { apply } from './core/apply.js';
import { runDoctor } from './core/doctor.js';
import { removeCert } from './core/certs.js';

const program = new Command();
const icon = { ok: '\x1b[32m✔\x1b[0m', warn: '\x1b[33m!\x1b[0m', error: '\x1b[31m✖\x1b[0m' };

async function alreadyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
    return ((await res.json()) as { app?: string }).app === 'interact-nginx';
  } catch {
    return false;
  }
}

async function printApply(allowConfEdit: boolean) {
  const res = await apply({ allowConfEdit });
  for (const s of res.steps) {
    console.log(`${s.ok ? icon.ok : icon.error} ${s.name}`);
    if (!s.ok && s.output) console.log(s.output.replace(/^/gm, '    '));
  }
  if (!res.ok) process.exitCode = 1;
}

program
  .name('interact-nginx')
  .description('Web UI for local nginx: map https://dev.domain to localhost ports with trusted certs')
  .version(VERSION)
  .option('-p, --port <port>', 'UI port', '7878')
  .option('--no-open', "don't open the browser")
  .action(async (opts: { port: string; open: boolean }) => {
    const port = Number(opts.port);
    const token = await loadToken();
    const url = `http://127.0.0.1:${port}/?t=${token}`;
    if (await alreadyRunning(port)) {
      console.log(`interact-nginx is already running: ${url}`);
      if (opts.open) await open(url);
      return;
    }
    await startServer({ token, port, host: '127.0.0.1' });
    console.log(`\n  interact-nginx v${VERSION}\n  UI: \x1b[36m${url}\x1b[0m\n\n  Ctrl+C to stop. Your proxies keep running in nginx.\n`);
    if (opts.open) await open(url).catch(() => {});
  });

program
  .command('ls')
  .description('list proxies')
  .action(async () => {
    const { proxies } = await loadState();
    if (!proxies.length) return console.log('No proxies yet. Add one with: interact-nginx add my.dev.test 3000');
    for (const p of proxies) {
      console.log(`${p.enabled ? icon.ok : icon.warn} https://${p.domain}${p.aliases.length ? ` (+${p.aliases.join(', ')})` : ''} -> ${p.upstream}`);
    }
  });

program
  .command('add <domain> <upstream>')
  .description('add a proxy, e.g. `add app.local.test 3000`')
  .option('-a, --alias <name...>', 'extra server names')
  .option('--no-redirect', "don't redirect http:// to https://")
  .option('--no-websocket', 'disable WebSocket upgrade headers')
  .option('--apply', 'apply immediately')
  .action(async (domain: string, upstream: string, opts: { alias?: string[]; redirect: boolean; websocket: boolean; apply?: boolean }) => {
    const p = await addProxy({ domain, upstream, aliases: opts.alias ?? [], httpRedirect: opts.redirect, websocket: opts.websocket });
    console.log(`${icon.ok} Added https://${p.domain} -> ${p.upstream}`);
    if (opts.apply) await printApply(false);
    else console.log('Run `interact-nginx apply` to activate it.');
  });

program
  .command('rm <domain>')
  .description('remove a proxy')
  .option('--apply', 'apply immediately')
  .action(async (domain: string, opts: { apply?: boolean }) => {
    const p = findProxy(await loadState(), domain);
    if (!p) throw new Error(`No proxy for ${domain}`);
    await removeProxy(p.id);
    await removeCert(p);
    console.log(`${icon.ok} Removed ${p.domain}`);
    if (opts.apply) await printApply(false);
  });

program
  .command('apply')
  .description('write nginx config, certificates and hosts entries, then reload nginx')
  .option('--allow-conf-edit', 'allow adding an include line to nginx.conf if needed')
  .action(async (opts: { allowConfEdit?: boolean }) => printApply(!!opts.allowConfEdit));

program
  .command('doctor')
  .description('check nginx, mkcert, ports and upstreams')
  .action(async () => {
    for (const c of await runDoctor()) console.log(`${icon[c.status]} ${c.label}: ${c.detail}`);
  });

program.parseAsync().catch((err: Error) => {
  const message = err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('\n  ') : err.message;
  console.error(`${icon.error} ${message}`);
  process.exit(1);
});
