const BEGIN = '# >>> interact-nginx (managed, do not edit) >>>';
const END = '# <<< interact-nginx <<<';

/** Returns hosts content with our managed block replaced; lines outside the block are left untouched. */
export function renderHosts(current: string, domains: string[]): string {
  if (!domains.length && !current.includes(BEGIN)) return current;
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const lines = current.split(/\r?\n/);
  const kept: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === BEGIN) inBlock = true;
    else if (line.trim() === END) inBlock = false;
    else if (!inBlock) kept.push(line);
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();

  const unique = [...new Set(domains)].sort();
  if (unique.length) {
    kept.push('', BEGIN, ...unique.map((d) => `127.0.0.1\t${d}`), END);
  }
  return kept.join(eol) + eol;
}

export function managedHostsDomains(content: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === BEGIN) inBlock = true;
    else if (line.trim() === END) inBlock = false;
    else if (inBlock) {
      const name = line.trim().split(/\s+/)[1];
      if (name) out.push(name);
    }
  }
  return out;
}
