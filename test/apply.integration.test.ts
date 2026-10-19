import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const has = (bin: string) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// Exercises the real apply transaction against a throwaway nginx.conf, hosts file and app home.
describe.skipIf(!has('nginx') || !has('mkcert'))('apply (sandboxed, real nginx -t + mkcert)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inx-test-'));
  const confDir = path.join(root, 'etc');
  const hosts = path.join(root, 'hosts');

  beforeAll(() => {
    fs.mkdirSync(confDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'bare-nginx.conf'), path.join(confDir, 'nginx.conf'));
    const mime = execFileSync('sh', ['-c', 'nginx -V 2>&1 | sed -n "s/.*--conf-path=\\([^ ]*\\).*/\\1/p"']).toString().trim();
    fs.copyFileSync(path.join(path.dirname(mime), 'mime.types'), path.join(confDir, 'mime.types'));
    fs.writeFileSync(hosts, '127.0.0.1 localhost\n');
    process.env.INX_HOME = path.join(root, 'home');
    process.env.INX_NGINX_CONF = path.join(confDir, 'nginx.conf');
    process.env.INX_NGINX_PID = path.join(root, 'nginx.pid');
    process.env.INX_HOSTS = hosts;
  });

  it('refuses to edit nginx.conf without consent, then applies, toggles and removes', async () => {
    const { addProxy, updateProxy, removeProxy } = await import('../src/core/store.js');
    const { apply, computePlan, isPending } = await import('../src/core/apply.js');

    const p = await addProxy({ domain: 'app.inx.test', aliases: ['api.inx.test'], upstream: '3000' });
    const denied = await apply();
    expect(denied.ok).toBe(false);

    const res = await apply({ allowConfEdit: true });
    expect(res.steps.filter((s) => !s.ok)).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.prompted).toBe(false);
    expect(fs.readFileSync(path.join(confDir, 'nginx.conf'), 'utf8')).toContain('include interact-nginx/*.conf;');
    const files = fs.readdirSync(path.join(confDir, 'interact-nginx')).sort();
    expect(files).toEqual(['inx-00-common.conf', `inx-app-inx-test-${p.id.slice(0, 6)}.conf`]);
    expect(fs.readFileSync(hosts, 'utf8')).toContain('127.0.0.1\tapi.inx.test');
    expect(isPending(await computePlan())).toBe(false);

    await updateProxy(p.id, { enabled: false });
    expect((await apply()).ok).toBe(true);
    expect(fs.readdirSync(path.join(confDir, 'interact-nginx'))).toEqual([]);
    expect(fs.readFileSync(hosts, 'utf8')).toBe('127.0.0.1 localhost\n');

    await removeProxy(p.id);
    expect((await apply()).steps.at(-1)?.name).toBe('Nothing to apply');
  });

  it('rolls back when nginx -t fails', async () => {
    const { addProxy } = await import('../src/core/store.js');
    const { apply } = await import('../src/core/apply.js');
    const certDir = path.join(root, 'bad');
    fs.mkdirSync(certDir);
    fs.writeFileSync(path.join(certDir, 'c.pem'), 'not a cert');
    fs.writeFileSync(path.join(certDir, 'k.pem'), 'not a key');
    await addProxy({ domain: 'broken.inx.test', upstream: '3001', certPath: path.join(certDir, 'c.pem'), keyPath: path.join(certDir, 'k.pem') });
    const res = await apply();
    expect(res.ok).toBe(false);
    expect(res.steps.at(-1)?.name).toMatch(/rolled back/);
    expect(fs.readdirSync(path.join(confDir, 'interact-nginx'))).toEqual([]);
    expect(fs.readFileSync(hosts, 'utf8')).toBe('127.0.0.1 localhost\n');
  });
});
