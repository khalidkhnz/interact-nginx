import path from 'node:path';
import { parseConf, find, findOne, type Directive } from './parser.js';
import { isHostname, normalizeUpstream } from './validate.js';
import { loadState, saveState, addProxy } from './store.js';
import { readConf } from './platform.js';
import { apply, requireNginx, type ApplyResult } from './apply.js';

export interface ImportCandidate {
  domain: string;
  aliases: string[];
  upstream: string;
  websocket: boolean;
  httpRedirect: boolean;
  certPath?: string;
  keyPath?: string;
  /** Source ranges [start, end) in nginx.conf removed on import. */
  ranges: Array<[number, number]>;
  error?: string;
}

const isSslListen = (d: Directive) => d.args.some((a) => a === 'ssl') || d.args.some((a) => /(^|:)443$/.test(a));
const listensOn80 = (server: Directive) => {
  const listens = find(server.block, 'listen');
  return listens.length === 0 || listens.some((l) => /(^|:)80$/.test(l.args[0] ?? ''));
};

function proxyPassOf(server: Directive): { value?: string; location?: Directive } {
  const root = find(server.block, 'location').find((l) => l.args.length === 1 && l.args[0] === '/');
  const pass = findOne(root?.block, 'proxy_pass') ?? findOne(server.block, 'proxy_pass');
  return { value: pass?.args[0], location: root };
}

export function findCandidates(confText: string, confDir: string): ImportCandidate[] {
  const http = findOne(parseConf(confText), 'http');
  const servers = find(http?.block, 'server');
  const candidates: ImportCandidate[] = [];

  for (const server of servers) {
    const listens = find(server.block, 'listen');
    if (!listens.some(isSslListen)) continue;
    const names = find(server.block, 'server_name').flatMap((d) => d.args).filter((n) => n !== '_' && n !== '');
    if (!names.length) continue;

    const { value: pass, location } = proxyPassOf(server);
    const cand: ImportCandidate = {
      domain: names[0]!,
      aliases: names.slice(1),
      upstream: '',
      websocket: find(location?.block, 'proxy_set_header').some((h) => h.args[0]?.toLowerCase() === 'upgrade'),
      httpRedirect: false,
      ranges: [[server.start, server.end]],
    };
    const resolve = (p?: string) => (p ? path.resolve(confDir, p) : undefined);
    cand.certPath = resolve(findOne(server.block, 'ssl_certificate')?.args[0]);
    cand.keyPath = resolve(findOne(server.block, 'ssl_certificate_key')?.args[0]);

    const bad = names.find((n) => !isHostname(n));
    if (bad) cand.error = `Unsupported server_name "${bad}" (wildcards and regexes are not supported)`;
    else if (!listens.some((l) => /(^|:)443$/.test(l.args[0] ?? '') || l.args[0] === 'ssl')) cand.error = 'Only port 443 is supported';
    else if (!pass) cand.error = 'No proxy_pass in location /';
    else {
      try {
        cand.upstream = normalizeUpstream(pass);
      } catch (err) {
        cand.error = (err as Error).message;
      }
    }
    if (!cand.certPath || !cand.keyPath) {
      cand.certPath = undefined;
      cand.keyPath = undefined;
    }
    candidates.push(cand);
  }

  // Attach plain-HTTP redirect servers whose names all belong to one candidate.
  for (const server of servers) {
    if (!listensOn80(server) || find(server.block, 'listen').some(isSslListen)) continue;
    const ret = findOne(server.block, 'return');
    if (!ret || !/^30[12178]$/.test(ret.args[0] ?? '') || !(ret.args[1] ?? '').startsWith('https://')) continue;
    const names = find(server.block, 'server_name').flatMap((d) => d.args);
    const owner = candidates.find((c) => names.length > 0 && names.every((n) => n === c.domain || c.aliases.includes(n)));
    if (owner) {
      owner.httpRedirect = true;
      owner.ranges.push([server.start, server.end]);
    }
  }
  return candidates;
}

/** Cuts the given ranges out of the config, including a directly preceding comment block. */
export function removeRanges(text: string, ranges: Array<[number, number]>, note: string): string {
  const sorted = [...ranges].sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [start, end] of sorted) {
    let s = out.lastIndexOf('\n', start - 1) + 1;
    const indent = out.slice(s, start);
    // Swallow comment lines immediately above the block (they describe it).
    for (;;) {
      const prevEnd = s - 1;
      if (prevEnd < 0) break;
      const prevStart = out.lastIndexOf('\n', prevEnd - 1) + 1;
      if (!/^\s*#/.test(out.slice(prevStart, prevEnd))) break;
      s = prevStart;
    }
    let e = end;
    const nl = out.indexOf('\n', e);
    if (nl >= 0 && out.slice(e, nl).trim() === '') e = nl + 1;
    out = `${out.slice(0, s)}${indent}# ${note}\n${out.slice(e)}`;
  }
  return out;
}

export async function previewImport(): Promise<{ confPath: string; candidates: Array<ImportCandidate & { snippet: string }> }> {
  const info = await requireNginx();
  const text = await readConf(info);
  const candidates = findCandidates(text, info.confDir).map((c) => ({
    ...c,
    snippet: c.ranges.map(([s, e]) => text.slice(s, e)).join('\n\n'),
  }));
  return { confPath: info.confPath, candidates };
}

export async function runImport(domains: string[]): Promise<ApplyResult & { imported: string[]; newConf?: string }> {
  const info = await requireNginx();
  const confText = await readConf(info);
  const selected = findCandidates(confText, info.confDir).filter((c) => domains.includes(c.domain) && !c.error);
  if (!selected.length) throw new Error('Nothing selected to import');

  const before = await loadState();
  const taken = new Set(before.proxies.flatMap((p) => [p.domain, ...p.aliases]));
  const clash = selected.flatMap((c) => [c.domain, ...c.aliases]).find((n) => taken.has(n));
  if (clash) throw new Error(`"${clash}" is already managed by interact-nginx`);

  const newConf = removeRanges(
    confText,
    selected.flatMap((c) => c.ranges),
    'moved to interact-nginx (see ~/.interact-nginx/state.json)',
  );
  for (const c of selected) {
    await addProxy({
      domain: c.domain,
      aliases: c.aliases,
      upstream: c.upstream,
      websocket: c.websocket,
      httpRedirect: c.httpRedirect,
      certPath: c.certPath,
      keyPath: c.keyPath,
    });
  }
  const result = await apply({ mainConf: newConf });
  if (!result.ok) await saveState(before);
  return { ...result, imported: result.ok ? selected.map((c) => c.domain) : [], newConf };
}
