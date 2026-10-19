import fs from 'node:fs/promises';
import path from 'node:path';
import { appPaths } from './paths.js';
import { proxyKey } from './render.js';
import type { NginxInfo } from './platform.js';
import type { Proxy } from './store.js';

export interface LogSource {
  id: string;
  label: string;
  path: string;
}

export function logSources(info: NginxInfo | null, proxies: Proxy[]): LogSource[] {
  const out: LogSource[] = [];
  if (info) {
    out.push({ id: 'nginx-error', label: 'nginx error.log', path: info.errorLog });
    out.push({ id: 'nginx-access', label: 'nginx access.log', path: info.accessLog });
  }
  for (const p of proxies) {
    const key = proxyKey(p);
    out.push({ id: `${p.id}:access`, label: `${p.domain} · access`, path: path.join(appPaths.logs(), `${key}.access.log`) });
    out.push({ id: `${p.id}:error`, label: `${p.domain} · error`, path: path.join(appPaths.logs(), `${key}.error.log`) });
  }
  return out;
}

async function readTail(file: string, maxBytes: number): Promise<{ text: string; size: number }> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, size };
  } finally {
    await fh.close();
  }
}

/** Polls a file and emits new lines; survives rotation/truncation and files that don't exist yet. */
export function tailFile(file: string, onLines: (lines: string[]) => void, signal: AbortSignal, initialLines = 200): void {
  let offset = -1;
  let partial = '';
  let lastError = '';

  const emit = (text: string) => {
    const lines = (partial + text).split('\n');
    partial = lines.pop() ?? '';
    if (lines.length) onLines(lines);
  };

  const tick = async () => {
    if (signal.aborted) return;
    try {
      if (offset < 0) {
        const { text, size } = await readTail(file, 256 * 1024);
        offset = size;
        emit(text.split('\n').slice(-initialLines - 1).join('\n'));
      } else {
        const { size } = await fs.stat(file);
        if (size < offset) offset = 0;
        if (size > offset) {
          const fh = await fs.open(file, 'r');
          try {
            const len = Math.min(size - offset, 1024 * 1024);
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, offset);
            offset += len;
            emit(buf.toString('utf8'));
          } finally {
            await fh.close();
          }
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (offset < 0) offset = 0;
      } else if (message !== lastError) {
        onLines([`[interact-nginx] cannot read ${file}: ${message}`]);
      }
      lastError = message;
    }
    if (!signal.aborted) setTimeout(tick, 700);
  };
  void tick();
}
