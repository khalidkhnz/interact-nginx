import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseConf, findOne, find } from '../src/core/parser.js';
import { normalizeUpstream, proxyInputSchema, toNginxPath } from '../src/core/validate.js';
import { renderHosts, managedHostsDomains } from '../src/core/hosts.js';
import { findManagedTarget, addOwnInclude } from '../src/core/platform.js';
import { findCandidates, removeRanges } from '../src/core/import.js';
import { renderProxy, proxyFileName } from '../src/core/render.js';
import type { Proxy } from '../src/core/store.js';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const proxy = (over: Partial<Proxy> = {}): Proxy => ({
  id: 'abcdef12-0000-0000-0000-000000000000',
  domain: 'app.example.test',
  aliases: [],
  upstream: 'http://localhost:3000',
  enabled: true,
  websocket: true,
  httpRedirect: true,
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('parser', () => {
  it('parses nested blocks with offsets', () => {
    const src = 'http { server { listen 443 ssl; server_name "a.test" b.test; } }';
    const http = findOne(parseConf(src), 'http')!;
    const server = findOne(http.block, 'server')!;
    expect(findOne(server.block, 'server_name')!.args).toEqual(['a.test', 'b.test']);
    expect(src.slice(server.start, server.end)).toBe('server { listen 443 ssl; server_name "a.test" b.test; }');
  });

  it('ignores comments and keeps regex args', () => {
    const http = findOne(parseConf(fixture('brew-nginx.conf')), 'http')!;
    const servers = find(http.block, 'server');
    expect(servers).toHaveLength(3);
    const locs = find(servers[2]!.block, 'location');
    expect(locs[1]!.args).toEqual(['~*', '\\.(js|css|json|woff|woff2|ttf|eot|svg|png|jpg|jpeg|gif|ico|webp)$']);
  });

  it('rejects unbalanced braces', () => {
    expect(() => parseConf('http { server {')).toThrow();
    expect(() => parseConf('}')).toThrow();
  });
});

describe('validate', () => {
  it('normalizes upstream shorthands', () => {
    expect(normalizeUpstream('3000')).toBe('http://localhost:3000');
    expect(normalizeUpstream('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeUpstream('https://api.local')).toBe('https://api.local:443');
    expect(normalizeUpstream('http://[::1]:5173/')).toBe('http://[::1]:5173');
  });

  it('rejects injection attempts', () => {
    expect(() => normalizeUpstream('http://a.com/x;evil')).toThrow();
    expect(() => normalizeUpstream('ftp://a.com')).toThrow();
    expect(() => normalizeUpstream('http://user:pw@a.com')).toThrow();
    const bad = ['a.com; evil', 'a.com\nb.com', 'a com', '-a.com', 'a..com', '$host', 'a.com}'];
    for (const domain of bad) expect(proxyInputSchema.safeParse({ domain, upstream: '3000' }).success, domain).toBe(false);
    expect(() => toNginxPath('/tmp/a";b')).toThrow();
  });

  it('lowercases domains', () => {
    expect(proxyInputSchema.parse({ domain: 'App.Local.Test', upstream: '3000' }).domain).toBe('app.local.test');
  });
});

describe('hosts', () => {
  const base = '127.0.0.1\tlocalhost\n::1 localhost\n';

  it('adds, replaces and removes a managed block idempotently', () => {
    const once = renderHosts(base, ['b.test', 'a.test']);
    expect(renderHosts(once, ['b.test', 'a.test'])).toBe(once);
    expect(managedHostsDomains(once)).toEqual(['a.test', 'b.test']);
    expect(once.startsWith(base.trimEnd())).toBe(true);
    const removed = renderHosts(once, []);
    expect(removed).toBe(base);
  });

  it('leaves untouched files alone and keeps CRLF', () => {
    expect(renderHosts('weird\n\n\n', [])).toBe('weird\n\n\n');
    expect(renderHosts('127.0.0.1 localhost\r\n', ['x.test'])).toContain('\r\n127.0.0.1\tx.test\r\n');
  });
});

describe('managed target', () => {
  it('uses brew servers/* include', () => {
    expect(findManagedTarget(fixture('brew-nginx.conf'), '/opt/homebrew/etc/nginx')).toEqual({
      dir: '/opt/homebrew/etc/nginx/servers',
      include: 'servers/*',
    });
  });

  it('uses conf.d inside http, not modules-enabled in main context', () => {
    expect(findManagedTarget(fixture('debian-nginx.conf'), '/etc/nginx')).toEqual({
      dir: '/etc/nginx/conf.d',
      include: '/etc/nginx/conf.d/*.conf',
    });
  });

  it('adds own include when none fits', () => {
    const conf = fixture('bare-nginx.conf');
    expect(findManagedTarget(conf, '/x').include).toBeNull();
    const next = addOwnInclude(conf);
    expect(findManagedTarget(next, '/x')).toEqual({ dir: '/x/interact-nginx', include: 'interact-nginx/*.conf' });
    expect(() => parseConf(next)).not.toThrow();
  });
});

describe('import', () => {
  it('finds the existing proxy and its redirect', () => {
    const [c, ...rest] = findCandidates(fixture('brew-nginx.conf'), '/opt/homebrew/etc/nginx');
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({
      domain: 'app.example.test',
      aliases: ['login.example.test'],
      upstream: 'http://localhost:3000',
      websocket: true,
      httpRedirect: true,
      certPath: '/opt/homebrew/etc/nginx/ssl/app.example.test+1.pem',
      keyPath: '/opt/homebrew/etc/nginx/ssl/app.example.test+1-key.pem',
    });
    expect(c!.error).toBeUndefined();
    expect(c!.ranges).toHaveLength(2);
  });

  it('removes only the imported blocks and keeps the conf valid', () => {
    const conf = fixture('brew-nginx.conf');
    const [c] = findCandidates(conf, '/opt/homebrew/etc/nginx');
    const next = removeRanges(conf, c!.ranges, 'moved');
    const http = findOne(parseConf(next), 'http')!;
    const servers = find(http.block, 'server');
    expect(servers).toHaveLength(1);
    expect(findOne(servers[0]!.block, 'listen')!.args).toEqual(['8080']);
    expect(next).toContain('include servers/*;');
    expect(next).toContain('proxy_cache_path');
    expect(next).not.toContain('HTTPS server');
  });
});

describe('render', () => {
  it('renders a proxy with redirect and websocket', () => {
    const out = renderProxy(proxy({ aliases: ['x.example.test'] }), { certPath: '/c/a.pem', keyPath: '/c/a-key.pem', logDir: '/logs' });
    expect(out).toContain('server_name app.example.test x.example.test;');
    expect(out).toContain('return 301 https://$host$request_uri;');
    expect(out).toContain('proxy_pass http://localhost:3000;');
    expect(out).toContain('proxy_set_header Connection $inx_connection_upgrade;');
    expect(out).toContain('ssl_certificate     "/c/a.pem";');
    expect(() => parseConf(out)).not.toThrow();
    expect(proxyFileName(proxy())).toBe('inx-app-example-test-abcdef.conf');
  });

  it('omits optional parts', () => {
    const out = renderProxy(proxy({ websocket: false, httpRedirect: false }), { certPath: '/c', keyPath: '/k', logDir: '/l' });
    expect(out).not.toContain('listen 80');
    expect(out).not.toContain('Upgrade');
  });
});
