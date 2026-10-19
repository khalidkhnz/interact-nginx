export interface Proxy {
  id: string;
  domain: string;
  aliases: string[];
  upstream: string;
  enabled: boolean;
  websocket: boolean;
  httpRedirect: boolean;
  certPath?: string;
  keyPath?: string;
  upstreamUp?: boolean;
}

export interface Status {
  version: string;
  platform: string;
  hostsPath: string;
  home: string;
  nginx: { bin: string; version: string; confPath: string; confDir: string; errorLog: string } | null;
  process: { running: boolean; pid: number | null; user: string | null; needsElevation: boolean } | null;
  mkcert: { bin: string | null; caroot: string | null; caExists: boolean; trusted: boolean | null };
  plan: {
    pending: boolean;
    writes: string[];
    removes: string[];
    hostsChanged: boolean;
    managedDir: string;
    include: string | null;
    conflicts: string[];
  } | null;
  planError: string | null;
}

export interface ApplyStep {
  name: string;
  ok: boolean;
  output?: string;
}

export interface ApplyResult {
  ok: boolean;
  steps: ApplyStep[];
  prompted: boolean;
}

export interface Check {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
  fix?: 'install-mkcert' | 'trust-ca' | 'add-include' | 'start-nginx' | 'import';
}

export interface ImportCandidate {
  domain: string;
  aliases: string[];
  upstream: string;
  websocket: boolean;
  httpRedirect: boolean;
  certPath?: string;
  keyPath?: string;
  error?: string;
  snippet: string;
}

export interface LogSource {
  id: string;
  label: string;
  path: string;
}

const KEY = 'inx-token';

function initToken(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('t');
  if (fromUrl) {
    try {
      localStorage.setItem(KEY, fromUrl);
    } catch {}
    url.searchParams.delete('t');
    window.history.replaceState(null, '', url.toString());
    return fromUrl;
  }
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export const token = initToken();

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-inx-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? res.statusText, res.status);
  return data as T;
}

export const api = {
  status: () => request<Status>('GET', '/api/status'),
  proxies: () => request<{ proxies: Proxy[] }>('GET', '/api/proxies'),
  addProxy: (p: Partial<Proxy>) => request<{ proxy: Proxy }>('POST', '/api/proxies', p),
  updateProxy: (id: string, p: Partial<Proxy>) => request<{ proxy: Proxy }>('PUT', `/api/proxies/${id}`, p),
  deleteProxy: (id: string) => request<{ ok: true }>('DELETE', `/api/proxies/${id}`),
  apply: (allowConfEdit = false) => request<ApplyResult>('POST', '/api/apply', { allowConfEdit }),
  nginx: (action: 'start' | 'stop' | 'reload' | 'test') => request<{ ok: boolean; output: string }>('POST', `/api/nginx/${action}`),
  setup: (action: 'install-mkcert' | 'trust-ca') => request<{ ok: boolean; output: string }>('POST', `/api/setup/${action}`),
  doctor: () => request<{ checks: Check[] }>('GET', '/api/doctor'),
  importPreview: () => request<{ confPath: string; candidates: ImportCandidate[] }>('GET', '/api/import'),
  runImport: (domains: string[]) => request<ApplyResult & { imported: string[] }>('POST', '/api/import', { domains }),
  logSources: () => request<{ sources: LogSource[] }>('GET', '/api/logs'),
  logStreamUrl: (source: string) => `/api/logs/stream?source=${encodeURIComponent(source)}&t=${encodeURIComponent(token)}`,
};
