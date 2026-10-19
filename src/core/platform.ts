import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { run, which } from './exec.js';
import { parseConf, find, findOne } from './parser.js';
import { APP_NAME, FILE_PREFIX } from './paths.js';

export interface NginxInfo {
  bin: string;
  version: string;
  prefix: string;
  confPath: string;
  confDir: string;
  errorLog: string;
  accessLog: string;
  pidPath: string;
}

const CANDIDATES =
  process.platform === 'win32'
    ? ['C:\\nginx\\nginx.exe', 'C:\\tools\\nginx\\nginx.exe']
    : ['/opt/homebrew/bin/nginx', '/usr/local/bin/nginx', '/usr/sbin/nginx', '/usr/bin/nginx', '/usr/local/nginx/sbin/nginx', '/opt/local/sbin/nginx'];

async function findBinary(): Promise<string | null> {
  if (process.env.INX_NGINX_BIN) return process.env.INX_NGINX_BIN;
  const onPath = await which('nginx');
  if (onPath) return onPath;
  return CANDIDATES.find((c) => existsSync(c)) ?? null;
}

function flag(output: string, name: string): string | undefined {
  return output.match(new RegExp(`--${name}=(\\S+)`))?.[1];
}

let cached: NginxInfo | null | undefined;

export async function detectNginx(refresh = false): Promise<NginxInfo | null> {
  if (cached !== undefined && !refresh) return cached;
  const bin = await findBinary();
  if (!bin) return (cached = null);
  const res = await run(bin, ['-V']);
  if (res.code !== 0 && !res.output.includes('nginx version')) return (cached = null);

  const out = res.output;
  const prefix = flag(out, 'prefix') ?? path.dirname(bin);
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(prefix, p));
  const confPath = process.env.INX_NGINX_CONF ?? abs(flag(out, 'conf-path') ?? 'conf/nginx.conf');
  cached = {
    bin,
    version: out.match(/nginx version: nginx\/(\S+)/)?.[1] ?? 'unknown',
    prefix,
    confPath,
    confDir: path.dirname(confPath),
    errorLog: abs(flag(out, 'error-log-path') ?? 'logs/error.log'),
    accessLog: abs(flag(out, 'http-log-path') ?? 'logs/access.log'),
    pidPath: process.env.INX_NGINX_PID ?? abs(flag(out, 'pid-path') ?? 'logs/nginx.pid'),
  };
  return cached;
}

export interface ManagedTarget {
  /** Directory our inx-*.conf files are written to. */
  dir: string;
  /** The include directive in nginx.conf that loads them, or null if one must be added. */
  include: string | null;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export const OWN_INCLUDE = `${APP_NAME}/*.conf`;

/** Finds a glob include inside `http {}` that would load files named inx-*.conf. */
export function findManagedTarget(confText: string, confDir: string): ManagedTarget {
  const http = findOne(parseConf(confText), 'http');
  for (const inc of find(http?.block, 'include')) {
    const pattern = inc.args[0];
    if (!pattern || !pattern.includes('*')) continue;
    const dirPart = path.dirname(pattern);
    if (dirPart.includes('*')) continue;
    if (!globToRegExp(path.basename(pattern)).test(`${FILE_PREFIX}example.conf`)) continue;
    return { dir: path.resolve(confDir, dirPart), include: pattern };
  }
  return { dir: path.join(confDir, APP_NAME), include: null };
}

export function addOwnInclude(confText: string): string {
  const http = findOne(parseConf(confText), 'http');
  if (!http || http.bodyEnd === undefined) throw new Error('nginx.conf has no http {} block');
  const before = confText.slice(0, http.bodyEnd).replace(/[ \t]*$/, '');
  const sep = before.endsWith('\n') ? '' : '\n';
  return `${before}${sep}    include ${OWN_INCLUDE};\n${confText.slice(http.bodyEnd)}`;
}

export async function readConf(info: NginxInfo): Promise<string> {
  return fs.readFile(info.confPath, 'utf8');
}
