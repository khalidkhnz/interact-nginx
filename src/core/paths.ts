import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'interact-nginx';
export const FILE_PREFIX = 'inx-';

export function appHome(): string {
  return process.env.INX_HOME ?? path.join(os.homedir(), '.interact-nginx');
}

export const appPaths = {
  state: () => path.join(appHome(), 'state.json'),
  token: () => path.join(appHome(), 'token'),
  certs: () => path.join(appHome(), 'certs'),
  logs: () => path.join(appHome(), 'logs'),
  bin: () => path.join(appHome(), 'bin'),
  staging: () => path.join(appHome(), 'staging'),
  backups: () => path.join(appHome(), 'backups'),
};

export function hostsPath(): string {
  if (process.env.INX_HOSTS) return process.env.INX_HOSTS;
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  }
  return '/etc/hosts';
}
