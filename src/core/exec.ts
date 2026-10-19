import { execFile } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr, which is what nginx output usually needs. */
  output: string;
}

export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, env: opts.env ?? process.env, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const code = e ? (typeof e.code === 'number' ? e.code : 127) : 0;
        const errText = e && typeof e.code !== 'number' ? `${stderr}${e.message}` : stderr;
        resolve({ code, stdout, stderr: errText, output: `${stdout}${errText}`.trim() });
      },
    );
  });
}

export async function which(bin: string): Promise<string | null> {
  const res = process.platform === 'win32' ? await run('where', [bin]) : await run('/bin/sh', ['-c', 'command -v "$1"', 'sh', bin]);
  if (res.code !== 0) return null;
  return res.stdout.split(/\r?\n/)[0]?.trim() || null;
}
