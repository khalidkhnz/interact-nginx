import fs from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import path from 'node:path';
import { appPaths, FILE_PREFIX, hostsPath } from './paths.js';
import { detectNginx, findManagedTarget, addOwnInclude, readConf, type NginxInfo, type ManagedTarget } from './platform.js';
import { loadState } from './store.js';
import { renderCommon, renderProxy, proxyFileName, COMMON_FILE } from './render.js';
import { renderHosts } from './hosts.js';
import { certPathsFor, ensureCert } from './certs.js';
import { Script, runElevated } from './elevate.js';
import { nginxStatus, reload, testArgs, testConfig } from './nginx.js';
import { parseConf, find, findOne } from './parser.js';

export interface Plan {
  info: NginxInfo;
  target: ManagedTarget;
  confText: string;
  writes: Map<string, string>;
  removes: string[];
  hostsCurrent: string;
  hostsDesired: string;
  hostsChanged: boolean;
  /** Managed domains also declared by server blocks in nginx.conf (those win, since they load first). */
  conflicts: string[];
}

export async function requireNginx(): Promise<NginxInfo> {
  const info = await detectNginx();
  if (!info) throw new Error('nginx not found. Install it (e.g. `brew install nginx`) or set INX_NGINX_BIN.');
  return info;
}

async function listManaged(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith('.conf'));
}

export function serverNamesInConf(confText: string): string[] {
  const http = findOne(parseConf(confText), 'http');
  return find(http?.block, 'server').flatMap((s) => find(s.block, 'server_name').flatMap((d) => d.args));
}

export async function computePlan(): Promise<Plan> {
  const info = await requireNginx();
  const confText = await readConf(info);
  const target = findManagedTarget(confText, info.confDir);
  const state = await loadState();
  const enabled = state.proxies.filter((p) => p.enabled);

  const desired = new Map<string, string>();
  if (enabled.length) {
    desired.set(COMMON_FILE, renderCommon());
    for (const p of enabled) desired.set(proxyFileName(p), renderProxy(p, { ...certPathsFor(p), logDir: appPaths.logs() }));
  }

  const existing = await listManaged(target.dir);
  const writes = new Map<string, string>();
  for (const [name, content] of desired) {
    const current = await fs.readFile(path.join(target.dir, name), 'utf8').catch(() => null);
    if (current !== content) writes.set(name, content);
  }
  const removes = existing.filter((f) => !desired.has(f));

  const hostsCurrent = await fs.readFile(hostsPath(), 'utf8').catch(() => '');
  const hostsDesired = renderHosts(hostsCurrent, enabled.flatMap((p) => [p.domain, ...p.aliases]));

  const declared = new Set(serverNamesInConf(confText));
  const conflicts = enabled.flatMap((p) => [p.domain, ...p.aliases]).filter((d) => declared.has(d));

  return { info, target, confText, writes, removes, hostsCurrent, hostsDesired, hostsChanged: hostsCurrent !== hostsDesired, conflicts };
}

export const isPending = (plan: Plan) => plan.writes.size > 0 || plan.removes.length > 0 || plan.hostsChanged;

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

export interface ApplyOptions {
  /** Allow adding `include interact-nginx/*.conf;` to nginx.conf when no suitable include exists. */
  allowConfEdit?: boolean;
  /** Replacement nginx.conf content (used by import), applied in the same transaction. */
  mainConf?: string;
}

async function writable(target: string): Promise<boolean> {
  let p = target;
  while (!existsSync(p)) {
    const parent = path.dirname(p);
    if (parent === p) return false;
    p = parent;
  }
  return fs.access(p, constants.W_OK).then(
    () => true,
    () => false,
  );
}

export async function apply(opts: ApplyOptions = {}): Promise<ApplyResult> {
  const steps: ApplyStep[] = [];
  const fail = (name: string, output: string): ApplyResult => ({ ok: false, steps: [...steps, { name, ok: false, output }], prompted: false });

  const state = await loadState();
  for (const p of state.proxies.filter((x) => x.enabled)) {
    try {
      const cert = await ensureCert(p);
      if (cert.issued) steps.push({ name: `Issued certificate for ${[p.domain, ...p.aliases].join(', ')}`, ok: true });
    } catch (err) {
      return fail(`Certificate for ${p.domain}`, (err as Error).message);
    }
  }

  const plan = await computePlan();
  const { info, target } = plan;
  let mainConf = opts.mainConf;
  if (!target.include) {
    if (!opts.allowConfEdit && !mainConf) {
      return fail('nginx.conf include', `nginx.conf has no include that loads ${target.dir}. Confirm adding "include interact-nginx/*.conf;" to the http block.`);
    }
    mainConf = addOwnInclude(mainConf ?? plan.confText);
    steps.push({ name: 'Added include interact-nginx/*.conf to nginx.conf', ok: true });
  }

  if (!isPending(plan) && mainConf === undefined) {
    return { ok: true, steps: [...steps, { name: 'Nothing to apply', ok: true }], prompted: false };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stageDir = path.join(appPaths.staging(), stamp);
  const backupDir = path.join(appPaths.backups(), stamp);
  await fs.mkdir(stageDir, { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });
  await fs.mkdir(appPaths.logs(), { recursive: true });

  const touched = [...plan.writes.keys(), ...plan.removes];
  const backedUp = new Set<string>();
  for (const name of touched) {
    const src = path.join(target.dir, name);
    if (existsSync(src)) {
      await fs.copyFile(src, path.join(backupDir, name));
      backedUp.add(name);
    }
  }
  for (const [name, content] of plan.writes) await fs.writeFile(path.join(stageDir, name), content);
  const confBackup = path.join(backupDir, 'nginx.conf');
  const confStaged = path.join(stageDir, 'nginx.conf');
  if (mainConf !== undefined) {
    await fs.copyFile(info.confPath, confBackup);
    await fs.writeFile(confStaged, mainConf);
    // Keep a copy next to nginx.conf too, where people look for it.
    await fs.copyFile(info.confPath, `${info.confPath}.inx-${stamp}.bak`).catch(() => {});
  }

  const script = new Script();
  const rollback = new Script();
  for (const name of plan.writes.keys()) {
    const dest = path.join(target.dir, name);
    if (backedUp.has(name)) rollback.copy(path.join(backupDir, name), dest);
    else rollback.remove(dest);
  }
  for (const name of plan.removes) rollback.copy(path.join(backupDir, name), path.join(target.dir, name));
  if (mainConf !== undefined) rollback.copy(confBackup, info.confPath);

  const canWriteFiles = (await writable(target.dir)) && (mainConf === undefined || (await writable(info.confPath)));
  let testInScript = false;

  if (canWriteFiles) {
    await fs.mkdir(target.dir, { recursive: true });
    for (const name of plan.writes.keys()) await fs.copyFile(path.join(stageDir, name), path.join(target.dir, name));
    for (const name of plan.removes) await fs.rm(path.join(target.dir, name), { force: true });
    if (mainConf !== undefined) await fs.writeFile(info.confPath, mainConf);

    const test = await testConfig(info);
    if (test.code !== 0 && !test.permissionIssue) {
      for (const name of plan.writes.keys()) {
        const dest = path.join(target.dir, name);
        if (backedUp.has(name)) await fs.copyFile(path.join(backupDir, name), dest);
        else await fs.rm(dest, { force: true });
      }
      for (const name of plan.removes) await fs.copyFile(path.join(backupDir, name), path.join(target.dir, name));
      if (mainConf !== undefined) await fs.copyFile(confBackup, info.confPath);
      return fail('nginx -t (changes rolled back)', test.output);
    }
    if (test.permissionIssue) testInScript = true;
    else steps.push({ name: `Wrote ${touched.length} config file(s); nginx -t passed`, ok: true, output: test.output });
  } else {
    script.echo('write nginx config').mkdir(target.dir);
    for (const name of plan.writes.keys()) script.copy(path.join(stageDir, name), path.join(target.dir, name));
    for (const name of plan.removes) script.remove(path.join(target.dir, name));
    if (mainConf !== undefined) script.copy(confStaged, info.confPath);
    testInScript = true;
  }
  if (testInScript) script.echo('nginx -t').guard(info.bin, testArgs(info), rollback, info.prefix);

  if (plan.hostsChanged) {
    const stagedHosts = path.join(stageDir, 'hosts');
    await fs.writeFile(stagedHosts, plan.hostsDesired);
    await fs.copyFile(hostsPath(), path.join(backupDir, 'hosts')).catch(() => {});
    if (await writable(hostsPath()).then((w) => w && existsSync(hostsPath()))) {
      await fs.writeFile(hostsPath(), plan.hostsDesired);
      steps.push({ name: `Updated ${hostsPath()}`, ok: true });
    } else {
      script.echo(`update ${hostsPath()}`).copy(stagedHosts, hostsPath());
    }
  }

  const status = await nginxStatus(info);
  const reloadInScript = status.running && status.needsElevation;
  if (reloadInScript) script.echo('nginx -s reload').exec(info.bin, ['-s', 'reload', '-c', info.confPath], info.prefix);

  let prompted = false;
  if (!script.empty) {
    prompted = true;
    const res = await runElevated(script);
    if (res.code === 3) return { ...fail('nginx -t (changes rolled back)', res.output), prompted };
    if (res.code !== 0) {
      const cancelled = res.code === 126;
      return { ...fail(cancelled ? 'Admin permission was not granted' : 'Privileged step failed', res.output), prompted };
    }
    steps.push({ name: 'Applied privileged changes', ok: true, output: res.output });
  }

  if (status.running && !reloadInScript) {
    const res = await reload(info);
    if (res.code !== 0) return { ...fail('nginx -s reload', res.output), prompted };
    steps.push({ name: 'Reloaded nginx', ok: true });
  } else if (reloadInScript) {
    steps.push({ name: 'Reloaded nginx', ok: true });
  } else {
    steps.push({ name: 'nginx is not running. Start it to serve these proxies.', ok: true });
  }

  await fs.rm(stageDir, { recursive: true, force: true });
  return { ok: true, steps, prompted };
}
