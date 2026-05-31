export type GraphifyCommand =
  | { kind: 'status' }
  | { kind: 'query'; question: string }
  | { kind: 'explain'; concept: string }
  | { kind: 'path'; from: string; to: string }
  | { kind: 'update'; path: string }
  | { kind: 'extract'; path: string }
  | { kind: 'report' }
  | { kind: 'open' }
  | { kind: 'unknown'; subcommand: string };

export function parseGraphifyCommand(input: string): GraphifyCommand {
  const tokens = splitArgs(input);
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === 'status')) {
    return { kind: 'status' };
  }

  const [subcommand = '', ...rest] = tokens;
  const tail = rest.join(' ').trim();

  if (subcommand === 'query') return { kind: 'query', question: tail };
  if (subcommand === 'explain') return { kind: 'explain', concept: tail };
  if (subcommand === 'path') {
    return { kind: 'path', from: rest[0] ?? '', to: rest.slice(1).join(' ').trim() };
  }
  if (subcommand === 'update') return { kind: 'update', path: rest[0] || '.' };
  if (subcommand === 'extract') return { kind: 'extract', path: rest[0] || '.' };
  if (subcommand === 'report') return { kind: 'report' };
  if (subcommand === 'open') return { kind: 'open' };
  return { kind: 'unknown', subcommand };
}

export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\' && quote === '"') {
      escaping = true;
      continue;
    }

    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = undefined;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += '\\';
  if (current) args.push(current);
  return args;
}
