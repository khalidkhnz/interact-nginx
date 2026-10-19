import path from 'node:path';
import { FILE_PREFIX } from './paths.js';
import { slugOf, type Proxy } from './store.js';
import { toNginxPath } from './validate.js';

export const COMMON_FILE = `${FILE_PREFIX}00-common.conf`;
const HEADER = '# Managed by interact-nginx. Edits here are overwritten on the next apply.';

export function proxyKey(p: Pick<Proxy, 'id' | 'domain'>): string {
  return `${slugOf(p.domain)}-${p.id.slice(0, 6)}`;
}

export function proxyFileName(p: Pick<Proxy, 'id' | 'domain'>): string {
  return `${FILE_PREFIX}${proxyKey(p)}.conf`;
}

export interface RenderContext {
  certPath: string;
  keyPath: string;
  logDir: string;
}

const q = (p: string) => `"${toNginxPath(p)}"`;

export function renderCommon(): string {
  return `${HEADER}
map $http_upgrade $inx_connection_upgrade {
    default upgrade;
    ''      close;
}
`;
}

export function renderProxy(p: Proxy, ctx: RenderContext): string {
  const names = [p.domain, ...p.aliases].join(' ');
  const key = proxyKey(p);
  const accessLog = path.join(ctx.logDir, `${key}.access.log`);
  const errorLog = path.join(ctx.logDir, `${key}.error.log`);
  const out: string[] = [`${HEADER}`, `# proxy ${p.id}: https://${p.domain} -> ${p.upstream}`, ''];

  if (p.httpRedirect) {
    out.push(
      'server {',
      '    listen 80;',
      `    server_name ${names};`,
      `    access_log ${q(accessLog)};`,
      '    return 301 https://$host$request_uri;',
      '}',
      '',
    );
  }

  out.push(
    'server {',
    '    listen 443 ssl;',
    `    server_name ${names};`,
    '',
    `    ssl_certificate     ${q(ctx.certPath)};`,
    `    ssl_certificate_key ${q(ctx.keyPath)};`,
    '    ssl_session_cache   shared:INX_SSL:1m;',
    '    ssl_session_timeout 5m;',
    '    ssl_protocols       TLSv1.2 TLSv1.3;',
    '    ssl_ciphers         HIGH:!aNULL:!MD5;',
    '',
    `    access_log ${q(accessLog)};`,
    `    error_log  ${q(errorLog)};`,
    '    client_max_body_size 100m;',
    '',
    '    location / {',
    `        proxy_pass ${p.upstream};`,
    '        proxy_http_version 1.1;',
  );
  if (p.websocket) {
    out.push(
      '        proxy_set_header Upgrade $http_upgrade;',
      '        proxy_set_header Connection $inx_connection_upgrade;',
    );
  }
  out.push(
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '        proxy_set_header X-Forwarded-Host $host;',
    // Dev servers stream (HMR, SSE) and buffering caused content-length mismatches on static assets.
    '        proxy_buffering off;',
    '        proxy_read_timeout 300s;',
    '        proxy_connect_timeout 60s;',
    '    }',
    '}',
    '',
  );
  return out.join('\n');
}
