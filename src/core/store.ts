import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { appPaths } from './paths.js';
import { proxyInputSchema, type ProxyInput, type ProxyFields } from './validate.js';

export interface Proxy extends ProxyFields {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface State {
  version: 1;
  proxies: Proxy[];
}

const EMPTY: State = { version: 1, proxies: [] };

export async function writeFileAtomic(file: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, { mode });
  await fs.rename(tmp, file);
}

export async function loadState(): Promise<State> {
  try {
    const raw = JSON.parse(await fs.readFile(appPaths.state(), 'utf8')) as State;
    return { version: 1, proxies: raw.proxies ?? [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY);
    throw err;
  }
}

export async function saveState(state: State): Promise<void> {
  await writeFileAtomic(appPaths.state(), JSON.stringify(state, null, 2) + '\n');
}

export function slugOf(domain: string): string {
  return domain.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function assertUniqueNames(state: State, candidate: ProxyFields, ignoreId?: string): void {
  const taken = new Map<string, string>();
  for (const p of state.proxies) {
    if (p.id === ignoreId) continue;
    for (const name of [p.domain, ...p.aliases]) taken.set(name, p.domain);
  }
  for (const name of [candidate.domain, ...candidate.aliases]) {
    const owner = taken.get(name);
    if (owner) throw new Error(`"${name}" is already used by proxy ${owner}`);
  }
}

export async function addProxy(input: ProxyInput): Promise<Proxy> {
  const fields = proxyInputSchema.parse(input);
  const state = await loadState();
  assertUniqueNames(state, fields);
  const now = new Date().toISOString();
  const proxy: Proxy = { ...fields, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
  state.proxies.push(proxy);
  await saveState(state);
  return proxy;
}

export async function updateProxy(id: string, patch: Partial<ProxyInput>): Promise<Proxy> {
  const state = await loadState();
  const idx = state.proxies.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('Proxy not found');
  const current = state.proxies[idx]!;
  const fields = proxyInputSchema.parse({ ...current, ...patch });
  assertUniqueNames(state, fields, id);
  const next: Proxy = { ...current, ...fields, updatedAt: new Date().toISOString() };
  state.proxies[idx] = next;
  await saveState(state);
  return next;
}

export async function removeProxy(id: string): Promise<void> {
  const state = await loadState();
  const next = state.proxies.filter((p) => p.id !== id);
  if (next.length === state.proxies.length) throw new Error('Proxy not found');
  await saveState({ ...state, proxies: next });
}

export function findProxy(state: State, ref: string): Proxy | undefined {
  return state.proxies.find((p) => p.id === ref || p.domain === ref);
}
