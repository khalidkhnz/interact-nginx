import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { appPaths, hostsPath } from '../core/paths.js';
import { writeFileAtomic, loadState, addProxy, updateProxy, removeProxy } from '../core/store.js';
import { detectNginx } from '../core/platform.js';
import { computePlan, isPending, apply } from '../core/apply.js';
import { nginxStatus, start, stop, reload, testConfig } from '../core/nginx.js';
import { mkcertStatus, installMkcert, trustCa, removeCert } from '../core/certs.js';
import { runDoctor, upstreamUp } from '../core/doctor.js';
import { previewImport, runImport } from '../core/import.js';
import { logSources, tailFile } from '../core/logs.js';

export const VERSION = '0.1.0';

export async function loadToken(): Promise<string> {
  const file = appPaths.token();
  const existing = await fs.readFile(file, 'utf8').catch(() => '');
  if (/^[a-f0-9]{48}$/.test(existing.trim())) return existing.trim();
  const token = crypto.randomBytes(24).toString('hex');
  await writeFileAtomic(file, token, 0o600);
  return token;
}

function uiDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, 'ui'), path.join(here, '..', '..', 'dist', 'ui')]) {
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return path.join(here, 'ui');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const errorMessage = (err: unknown) => {
  if (err instanceof z.ZodError) return err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
  return err instanceof Error ? err.message : String(err);
};

export function createApp(opts: { token: string; port: number }) {
  const app = new Hono();
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  if (process.env.INX_DEV_ORIGIN) {
    allowedOrigins.add(process.env.INX_DEV_ORIGIN);
    allowedHosts.add(new URL(process.env.INX_DEV_ORIGIN).host);
  }

  app.onError((err, c) => c.json({ error: errorMessage(err) }, 400));

  // DNS-rebinding and cross-site protection: this API can trigger root-level changes.
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!allowedHosts.has(host)) return c.text('Forbidden host', 403);
    const origin = c.req.header('origin');
    if (origin && !allowedOrigins.has(origin)) return c.text('Forbidden origin', 403);
    await next();
  });

  app.get('/api/ping', (c) => c.json({ app: 'interact-nginx', version: VERSION }));

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/ping') return next();
    const given = c.req.header('x-inx-token') ?? c.req.query('t') ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(opts.token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.get('/api/status', async (c) => {
    const info = await detectNginx();
    const [state, mkcert] = await Promise.all([loadState(), mkcertStatus()]);
    let plan = null;
    let planError: string | null = null;
    if (info) {
      try {
        const p = await computePlan();
        plan = {
          pending: isPending(p),
          writes: [...p.writes.keys()],
          removes: p.removes,
          hostsChanged: p.hostsChanged,
          managedDir: p.target.dir,
          include: p.target.include,
          conflicts: p.conflicts,
        };
      } catch (err) {
        planError = errorMessage(err);
      }
    }
    return c.json({
      version: VERSION,
      platform: process.platform,
      hostsPath: hostsPath(),
      home: path.dirname(appPaths.state()),
      nginx: info,
      process: info ? await nginxStatus(info) : null,
      mkcert,
      plan,
      planError,
      proxyCount: state.proxies.length,
    });
  });

  app.get('/api/proxies', async (c) => {
    const state = await loadState();
    const proxies = await Promise.all(state.proxies.map(async (p) => ({ ...p, upstreamUp: await upstreamUp(p.upstream) })));
    return c.json({ proxies });
  });

  app.post('/api/proxies', async (c) => c.json({ proxy: await addProxy(await c.req.json()) }, 201));

  app.put('/api/proxies/:id', async (c) => c.json({ proxy: await updateProxy(c.req.param('id'), await c.req.json()) }));

  app.delete('/api/proxies/:id', async (c) => {
    const state = await loadState();
    const proxy = state.proxies.find((p) => p.id === c.req.param('id'));
    await removeProxy(c.req.param('id'));
    if (proxy) await removeCert(proxy);
    return c.json({ ok: true });
  });

  app.post('/api/apply', async (c) => {
    const body = z.object({ allowConfEdit: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await apply(body));
  });

  app.post('/api/nginx/:action', async (c) => {
    const info = await detectNginx();
    if (!info) return c.json({ error: 'nginx not found' }, 404);
    const action = c.req.param('action');
    const res =
      action === 'start' ? await start(info)
      : action === 'stop' ? await stop(info)
      : action === 'reload' ? await reload(info)
      : action === 'test' ? await testConfig(info)
      : null;
    if (!res) return c.json({ error: `Unknown action ${action}` }, 400);
    return c.json({ ok: res.code === 0, output: res.output });
  });

  app.post('/api/setup/:action', async (c) => {
    const action = c.req.param('action');
    if (action === 'install-mkcert') return c.json({ ok: true, output: `Installed ${await installMkcert()}` });
    if (action === 'trust-ca') return c.json(await trustCa());
    return c.json({ error: `Unknown action ${action}` }, 400);
  });

  app.get('/api/doctor', async (c) => c.json({ checks: await runDoctor() }));

  app.get('/api/import', async (c) => c.json(await previewImport()));

  app.post('/api/import', async (c) => {
    const { domains } = z.object({ domains: z.array(z.string()).min(1) }).parse(await c.req.json());
    return c.json(await runImport(domains));
  });

  app.get('/api/logs', async (c) => {
    const [info, state] = await Promise.all([detectNginx(), loadState()]);
    return c.json({ sources: logSources(info, state.proxies) });
  });

  app.get('/api/logs/stream', async (c) => {
    const [info, state] = await Promise.all([detectNginx(), loadState()]);
    const source = logSources(info, state.proxies).find((s) => s.id === c.req.query('source'));
    if (!source) return c.json({ error: 'Unknown log source' }, 404);
    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());
      tailFile(source.path, (lines) => void stream.writeSSE({ data: JSON.stringify(lines) }), ac.signal);
      while (!ac.signal.aborted) {
        await stream.sleep(15_000);
        if (!ac.signal.aborted) await stream.writeSSE({ event: 'ping', data: '' });
      }
    });
  });

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  const root = uiDir();
  app.get('*', async (c: Context) => {
    const rel = path.normalize(decodeURIComponent(c.req.path)).replace(/^([/\\])+/, '');
    let file = path.join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || (await fs.stat(file)).isDirectory()) file = path.join(root, 'index.html');
    if (!existsSync(file)) return c.text('UI not built. Run `npm run build`.', 500);
    const body = await fs.readFile(file);
    const cache = file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
    return c.body(body, 200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': cache });
  });

  return app;
}

export function startServer(opts: { token: string; port: number; host: string }): Promise<void> {
  const app = createApp(opts);
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, () => resolve());
    server.once('error', reject);
  });
}
