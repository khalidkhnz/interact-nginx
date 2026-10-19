import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { run, type RunResult } from './exec.js';
import { Script, runElevated } from './elevate.js';
import type { NginxInfo } from './platform.js';

const isWin = process.platform === 'win32';

export interface NginxStatus {
  running: boolean;
  pid: number | null;
  user: string | null;
  /** True when the master runs as another user (usually root) so signals need elevation. */
  needsElevation: boolean;
}

async function readPid(info: NginxInfo): Promise<number | null> {
  const raw = await fs.readFile(info.pidPath, 'utf8').catch(() => '');
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

async function masterFromPs(): Promise<number | null> {
  const res = await run('ps', ['-axo', 'pid=,command=']);
  const line = res.stdout.split('\n').find((l) => /nginx: master process/.test(l));
  return line ? Number.parseInt(line.trim(), 10) : null;
}

export async function nginxStatus(info: NginxInfo): Promise<NginxStatus> {
  if (isWin) {
    const res = await run('tasklist', ['/FI', 'IMAGENAME eq nginx.exe', '/FO', 'CSV', '/NH']);
    const running = /nginx\.exe/i.test(res.stdout);
    return { running, pid: running ? await readPid(info) : null, user: null, needsElevation: false };
  }
  let pid = await readPid(info);
  if (pid) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') pid = null;
    }
  }
  if (!process.env.INX_NGINX_PID) pid ??= await masterFromPs();
  if (!pid) return { running: false, pid: null, user: null, needsElevation: false };
  const user = (await run('ps', ['-o', 'user=', '-p', String(pid)])).stdout.trim() || null;
  return { running: true, pid, user, needsElevation: !!user && user !== os.userInfo().username };
}

const PERMISSION_RE = /Permission denied|Operation not permitted|\(13:|\(1:/;

function atLeast(version: string, min: [number, number, number]): boolean {
  const v = version.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i]!;
  return true;
}

/** `-e stderr` (nginx >= 1.19.5) keeps tests out of the real error log, which may not be writable. */
export function testArgs(info: NginxInfo): string[] {
  return [...(atLeast(info.version, [1, 19, 5]) ? ['-e', 'stderr'] : []), '-t', '-c', info.confPath];
}

export async function testConfig(info: NginxInfo): Promise<RunResult & { permissionIssue: boolean }> {
  const res = await run(info.bin, testArgs(info), { cwd: info.prefix });
  return { ...res, permissionIssue: res.code !== 0 && PERMISSION_RE.test(res.output) };
}

async function signal(info: NginxInfo, sig: 'reload' | 'quit' | 'stop' | 'reopen'): Promise<RunResult> {
  const status = await nginxStatus(info);
  const args = ['-s', sig, '-c', info.confPath];
  if (status.needsElevation) return runElevated(new Script().echo(`nginx -s ${sig}`).exec(info.bin, args, info.prefix));
  return run(info.bin, args, { cwd: info.prefix });
}

export const reload = (info: NginxInfo) => signal(info, 'reload');
export const stop = (info: NginxInfo) => signal(info, 'quit');

export async function start(info: NginxInfo, opts: { elevated?: boolean } = {}): Promise<RunResult> {
  const status = await nginxStatus(info);
  if (status.running) return { code: 0, stdout: '', stderr: '', output: `nginx already running (pid ${status.pid})` };
  if (isWin) {
    // nginx.exe does not daemonize; detach it so it outlives this process.
    spawn(info.bin, ['-c', info.confPath], { cwd: info.prefix, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    await new Promise((r) => setTimeout(r, 800));
    const after = await nginxStatus(info);
    return { code: after.running ? 0 : 1, stdout: '', stderr: '', output: after.running ? 'nginx started' : 'nginx did not start; check the error log' };
  }
  if (!opts.elevated) {
    const res = await run(info.bin, ['-c', info.confPath], { cwd: info.prefix });
    // Binding :80/:443 as a normal user works on macOS but not on Linux.
    if (res.code === 0 || !PERMISSION_RE.test(res.output)) return res;
  }
  return runElevated(new Script().echo('start nginx').exec(info.bin, ['-c', info.confPath], info.prefix));
}
