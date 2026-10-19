export interface Directive {
  name: string;
  args: string[];
  /** Offset of the directive name in the source. */
  start: number;
  /** Offset just past the terminating `;` or closing `}`. */
  end: number;
  block?: Directive[];
  /** For blocks: offset just past `{` and of the closing `}`. */
  bodyStart?: number;
  bodyEnd?: number;
}

interface Token {
  value: string;
  start: number;
  end: number;
  quoted: boolean;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (ch === '{' || ch === '}' || ch === ';') {
      tokens.push({ value: ch, start: i, end: i + 1, quoted: false });
      i++;
    } else if (ch === '"' || ch === "'") {
      const start = i++;
      let value = '';
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\' && i + 1 < src.length) i++;
        value += src[i++];
      }
      if (i >= src.length) throw new Error(`Unterminated quote at offset ${start}`);
      i++;
      tokens.push({ value, start, end: i, quoted: true });
    } else {
      const start = i;
      let value = '';
      while (i < src.length && !/[\s{};]/.test(src[i]!)) {
        if (src[i] === '\\' && i + 1 < src.length) value += src[i++];
        value += src[i++];
      }
      tokens.push({ value, start, end: i, quoted: false });
    }
  }
  return tokens;
}

export function parseConf(src: string): Directive[] {
  const tokens = tokenize(src);
  let pos = 0;

  function parseBlock(depth: number): Directive[] {
    const out: Directive[] = [];
    while (pos < tokens.length) {
      const tok = tokens[pos]!;
      if (!tok.quoted && tok.value === '}') {
        if (depth === 0) throw new Error(`Unexpected "}" at offset ${tok.start}`);
        return out;
      }
      if (!tok.quoted && (tok.value === '{' || tok.value === ';')) {
        throw new Error(`Unexpected "${tok.value}" at offset ${tok.start}`);
      }
      const directive: Directive = { name: tok.value, args: [], start: tok.start, end: tok.end };
      pos++;
      while (pos < tokens.length) {
        const t = tokens[pos]!;
        if (!t.quoted && t.value === ';') {
          directive.end = t.end;
          pos++;
          break;
        }
        if (!t.quoted && t.value === '{') {
          directive.bodyStart = t.end;
          pos++;
          directive.block = parseBlock(depth + 1);
          const close = tokens[pos];
          if (!close || close.value !== '}') throw new Error(`Unclosed block "${directive.name}"`);
          directive.bodyEnd = close.start;
          directive.end = close.end;
          pos++;
          break;
        }
        if (!t.quoted && t.value === '}') throw new Error(`Missing ";" after "${directive.name}"`);
        directive.args.push(t.value);
        pos++;
      }
      out.push(directive);
    }
    if (depth > 0) throw new Error('Unexpected end of file inside block');
    return out;
  }

  return parseBlock(0);
}

export function find(directives: Directive[] | undefined, name: string): Directive[] {
  return (directives ?? []).filter((d) => d.name === name);
}

export function findOne(directives: Directive[] | undefined, name: string): Directive | undefined {
  return directives?.find((d) => d.name === name);
}
