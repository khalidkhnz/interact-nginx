import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { run, which } from './exec.js';
import { appPaths } from './paths.js';
import { Script, runElevated } from './elevate.js';
import { proxyKey } from './render.js';
import type { Proxy } from './store.js';

const isWin = process.platform === 'win32';
// With JAVA_HOME set, mkcert also probes the Java keystore and aborts if keytool fails (common with brew openjdk).
function mkcertEnv(): NodeJS.ProcessEnv {
  const { JAVA_HOME: _ignored, ...env } = process.env;
  return env;
}

const localBin = () => path.join(appPaths.bin(), isWin ? 'mkcert.exe' : 'mkcert');

export async function findMkcert(): Promise<string | null> {
  if (process.env.INX_MKCERT_BIN) return process.env.INX_MKCERT_BIN;
  return (await which('mkcert')) ?? (existsSync(localBin()) ? localBin() : null);
}

export async function mkcertStatus(): Promise<{ bin: string | null; caroot: string | null; caExists: boolean; trusted: boolean | null }> {
  const bin = await findMkcert();
  if (!bin) return { bin: null, caroot: null, caExists: false, trusted: false };
  const caroot = (await run(bin, ['-CAROOT'], { env: mkcertEnv() })).stdout.trim() || null;
  const rootPem = caroot ? path.join(caroot, 'rootCA.pem') : null;
  const caExists = !!rootPem && existsSync(rootPem);
  let trusted: boolean | null = null;
  if (caExists && process.platform === 'darwin') {
    trusted = (await run('security', ['verify-cert', '-c', rootPem!])).code === 0;
  } else if (!caExists) {
    trusted = false;
  }
  return { bin, caroot, caExists, trusted };
}

/** Downloads the official mkcert binary for this OS/arch into ~/.interact-nginx/bin. */
export async function installMkcert(): Promise<string> {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform as string];
  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm' }[process.arch as string];
  if (!os || !arch) throw new Error(`No mkcert build for ${process.platform}/${process.arch}`);
  const res = await fetch(`https://dl.filippo.io/mkcert/latest?for=${os}/${arch}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`mkcert download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(appPaths.bin(), { recursive: true });
  await fs.writeFile(localBin(), buf, { mode: 0o755 });
  return localBin();
}

/** Adds the mkcert CA to the system trust store. Needs admin rights, so it goes through the elevation prompt. */
export async function trustCa(): Promise<{ ok: boolean; output: string }> {
  const status = await mkcertStatus();
  if (!status.bin || !status.caroot) throw new Error('mkcert is not installed');
  if (!status.caExists) {
    // Create the CA as the current user first, so root doesn't end up owning the key in our home dir.
    const tmp = path.join(appPaths.staging(), 'ca-bootstrap');
    await fs.mkdir(tmp, { recursive: true });
    await run(status.bin, ['-cert-file', path.join(tmp, 'c.pem'), '-key-file', path.join(tmp, 'k.pem'), 'localhost'], { env: mkcertEnv() });
    await fs.rm(tmp, { recursive: true, force: true });
  }
  const script = new Script().echo('trust mkcert CA');
  if (isWin) script.exec(status.bin, ['-install']);
  else script.exec('/usr/bin/env', ['-u', 'JAVA_HOME', `CAROOT=${status.caroot}`, status.bin, '-install']);
  const res = await runElevated(script);
  return { ok: res.code === 0, output: res.output };
}

export interface CertPaths {
  certPath: string;
  keyPath: string;
}

export function certPathsFor(p: Proxy): CertPaths {
  if (p.certPath && p.keyPath) return { certPath: p.certPath, keyPath: p.keyPath };
  const base = path.join(appPaths.certs(), proxyKey(p));
  return { certPath: `${base}.pem`, keyPath: `${base}-key.pem` };
}

/** Issues (or reuses) an mkcert cert covering the proxy's domain and aliases. */
export async function ensureCert(p: Proxy): Promise<CertPaths & { issued: boolean }> {
  const paths = certPathsFor(p);
  if (p.certPath && p.keyPath) {
    if (!existsSync(paths.certPath) || !existsSync(paths.keyPath)) throw new Error(`Certificate files for ${p.domain} are missing`);
    return { ...paths, issued: false };
  }
  const names = [p.domain, ...p.aliases];
  const namesFile = paths.certPath.replace(/\.pem$/, '.names');
  const wanted = names.join(' ');
  if (existsSync(paths.certPath) && existsSync(paths.keyPath)) {
    const have = await fs.readFile(namesFile, 'utf8').catch(() => '');
    if (have.trim() === wanted) return { ...paths, issued: false };
  }
  const bin = await findMkcert();
  if (!bin) throw new Error('mkcert is not installed. Install it from the Doctor tab.');
  await fs.mkdir(appPaths.certs(), { recursive: true });
  const res = await run(bin, ['-cert-file', paths.certPath, '-key-file', paths.keyPath, ...names], { env: mkcertEnv() });
  if (res.code !== 0) throw new Error(`mkcert failed for ${p.domain}:\n${res.output}`);
  await fs.writeFile(namesFile, wanted + '\n');
  return { ...paths, issued: true };
}

export async function removeCert(p: Proxy): Promise<void> {
  if (p.certPath) return;
  const { certPath, keyPath } = certPathsFor(p);
  await Promise.all([certPath, keyPath, certPath.replace(/\.pem$/, '.names')].map((f) => fs.rm(f, { force: true })));
}
