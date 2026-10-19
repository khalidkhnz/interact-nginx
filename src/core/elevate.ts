import fs from 'node:fs/promises';
import path from 'node:path';
import sudo from '@vscode/sudo-prompt';
import { run, type RunResult } from './exec.js';
import { appPaths } from './paths.js';
import { assertSafePath } from './validate.js';

const isWin = process.platform === 'win32';

function quote(arg: string): string {
  if (isWin) {
    // cmd.exe expands %VAR% even inside quotes.
    if (/["%]/.test(arg)) throw new Error(`Refusing to quote argument for cmd.exe: ${arg}`);
    return `"${arg}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Builds one shell script so a whole apply costs a single password prompt. */
export class Script {
  private lines: string[] = [];

  get empty(): boolean {
    return this.lines.length === 0;
  }

  echo(text: string): this {
    this.lines.push(`echo ${quote(`== ${text}`)}`);
    return this;
  }

  mkdir(dir: string): this {
    assertSafePath(dir);
    this.lines.push(isWin ? `if not exist ${quote(dir)} mkdir ${quote(dir)}` : `mkdir -p ${quote(dir)} || exit 1`);
    return this;
  }

  copy(from: string, to: string): this {
    assertSafePath(from);
    assertSafePath(to);
    // cat > keeps the target's owner and mode, which matters for /etc/hosts.
    this.lines.push(isWin ? `copy /Y ${quote(from)} ${quote(to)} >nul || exit /b 1` : `cat ${quote(from)} > ${quote(to)} || exit 1`);
    return this;
  }

  remove(file: string): this {
    assertSafePath(file);
    this.lines.push(isWin ? `if exist ${quote(file)} del /F /Q ${quote(file)}` : `rm -f ${quote(file)} || exit 1`);
    return this;
  }

  exec(cmd: string, args: string[], cwd?: string): this {
    const line = [cmd, ...args].map(quote).join(' ');
    const withCwd = cwd ? (isWin ? `cd /d ${quote(cwd)} && ${line}` : `(cd ${quote(cwd)} && ${line})`) : line;
    this.lines.push(isWin ? `${withCwd} 2>&1 || exit /b 1` : `${withCwd} 2>&1 || exit 1`);
    return this;
  }

  /** Runs a command; if it fails, runs `onFail` and exits with code 3. */
  guard(cmd: string, args: string[], onFail: Script, cwd?: string): this {
    const line = [cmd, ...args].map(quote).join(' ');
    const withCwd = cwd ? (isWin ? `cd /d ${quote(cwd)} && ${line}` : `(cd ${quote(cwd)} && ${line})`) : line;
    if (isWin) {
      this.lines.push(`${withCwd} 2>&1`, 'if errorlevel 1 (', ...onFail.lines.map((l) => `  ${l}`), '  exit /b 3', ')');
    } else {
      this.lines.push(`if ! ${withCwd} 2>&1; then`, ...onFail.lines.map((l) => `  ${l}`), '  exit 3', 'fi');
    }
    return this;
  }

  append(other: Script): this {
    this.lines.push(...other.lines);
    return this;
  }

  render(): string {
    return isWin ? `@echo off\r\n${this.lines.join('\r\n')}\r\nexit /b 0\r\n` : `#!/bin/sh\n${this.lines.join('\n')}\nexit 0\n`;
  }
}

function sudoPrompt(cmd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    sudo.exec(cmd, { name: 'interact nginx' }, (err, stdout, stderr) => {
      const out = String(stdout ?? '');
      const errOut = String(stderr ?? '');
      const code = err ? (/did not grant permission|User did not grant/i.test(err.message) ? 126 : Number((err as { code?: number }).code) || 1) : 0;
      const message = err && !errOut ? err.message : errOut;
      resolve({ code, stdout: out, stderr: message, output: `${out}${message}`.trim() });
    });
  });
}

export function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** Runs the script as root/admin: directly if already root, via cached sudo if available, else an OS password prompt. */
export async function runElevated(script: Script): Promise<RunResult> {
  if (script.empty) return { code: 0, stdout: '', stderr: '', output: '' };
  const dir = appPaths.staging();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `elevated-${Date.now()}.${isWin ? 'cmd' : 'sh'}`);
  await fs.writeFile(file, script.render(), { mode: 0o700 });
  try {
    if (isWin) return await sudoPrompt(`cmd /c ${quote(file)}`);
    if (isRoot()) return await run('/bin/sh', [file], { timeoutMs: 120_000 });
    if ((await run('sudo', ['-n', 'true'], { timeoutMs: 5_000 })).code === 0) {
      return await run('sudo', ['-n', '/bin/sh', file], { timeoutMs: 120_000 });
    }
    return await sudoPrompt(`/bin/sh ${quote(file)}`);
  } finally {
    await fs.rm(file, { force: true });
  }
}
