import { z } from 'zod';

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
// Everything here ends up in nginx config, the hosts file or an elevated shell script.
const SAFE_PATH_RE = /^[^\t\n\r\f\v;'"`{}$\\#\0]+$/;

export function isHostname(value: string): boolean {
  return HOSTNAME_RE.test(value);
}

export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isHostname, 'Invalid domain (letters, digits, dots and dashes only)');

/** Accepts "3000", "localhost:3000" or "http://host:port" and returns "http://host:port". */
export function normalizeUpstream(input: string): string {
  let raw = input.trim();
  if (/^\d+$/.test(raw)) raw = `http://localhost:${raw}`;
  else if (!/^[a-z]+:\/\//i.test(raw)) raw = `http://${raw}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid upstream "${input}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Upstream must be http or https');
  if (url.username || url.password) throw new Error('Upstream must not contain credentials');
  if (url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('Upstream must be scheme://host:port without a path');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const isIpv6 = host.includes(':');
  if (!isHostname(host) && !IPV4_RE.test(host) && !(isIpv6 && /^[0-9a-f:.]+$/i.test(host))) {
    throw new Error(`Invalid upstream host "${host}"`);
  }
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol}//${isIpv6 ? `[${host}]` : host}:${port}`;
}

export const upstreamSchema = z.string().transform((value, ctx) => {
  try {
    return normalizeUpstream(value);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message });
    return z.NEVER;
  }
});

export const safePathSchema = z
  .string()
  .transform((p) => p.replace(/\\/g, '/'))
  .refine((p) => SAFE_PATH_RE.test(p) && (p.startsWith('/') || /^[a-z]:\//i.test(p)), 'Path must be absolute without special characters');

export const proxyInputSchema = z.object({
  domain: domainSchema,
  aliases: z.array(domainSchema).max(20).default([]),
  upstream: upstreamSchema,
  enabled: z.boolean().default(true),
  websocket: z.boolean().default(true),
  httpRedirect: z.boolean().default(true),
  certPath: safePathSchema.optional(),
  keyPath: safePathSchema.optional(),
});

export type ProxyInput = z.input<typeof proxyInputSchema>;
export type ProxyFields = z.output<typeof proxyInputSchema>;

/** nginx accepts forward slashes on Windows too, which keeps backslashes out of configs and scripts. */
export function toNginxPath(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  if (!SAFE_PATH_RE.test(normalized)) throw new Error(`Refusing unsafe path: ${p}`);
  return normalized;
}

/** Paths written into elevated scripts. Backslashes are fine here (Windows), quotes and control chars are not. */
export function assertSafePath(p: string): string {
  if (/[\t\n\r\f\v'"`$\0%]/.test(p)) throw new Error(`Refusing unsafe path: ${p}`);
  return p;
}
