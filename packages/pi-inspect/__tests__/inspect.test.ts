import { parseArgs } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
const writeSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock
}));

vi.mock('node:fs', () => ({
  writeSync: writeSyncMock
}));

const {
  default: dumpSystemPrompt,
  writeAllSync,
  needsSyntheticTurn,
  buildSyntheticArgs,
  formatTools
} = await import('../src/inspect.js');

/** Runs extension setup with the given argv and returns the pi mock plus the exit code seen. */
function runSetup(
  argv: string[],
  env: Record<string, string | undefined> = {},
  pi: Record<string, unknown> = { getFlag: vi.fn(() => false), on: vi.fn(), registerFlag: vi.fn() }
) {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);

  process.argv = ['node', '/usr/local/bin/pi', ...argv];
  delete process.env.PI_INSPECT_SYNTHETIC_DUMP;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    dumpSystemPrompt(pi as never);
    return { pi, exit: undefined as string | undefined };
  } catch (error) {
    return { pi, exit: (error as Error).message };
  } finally {
    process.argv = originalArgv;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    exitSpy.mockRestore();
  }
}

describe('dumpSystemPrompt setup', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    writeSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
  });

  it.each(['--dump-system-prompt', '--dump-tools'])(
    'runs a synthetic no-session turn for %s without a prompt, then exits',
    (flag) => {
      const { exit } = runSetup([flag]);

      expect(exit).toBe('exit:0');
      expect(spawnSyncMock).toHaveBeenCalledWith(
        process.execPath,
        ['/usr/local/bin/pi', flag, '--no-session', '-p', 'dump'],
        expect.objectContaining({
          env: expect.objectContaining({ PI_INSPECT_SYNTHETIC_DUMP: '1' })
        })
      );
    }
  );

  it('propagates a non-zero exit status from the synthetic child', () => {
    spawnSyncMock.mockReturnValue({ status: 3 });

    expect(runSetup(['--dump-tools']).exit).toBe('exit:3');
  });

  it('does not spawn again inside the synthetic child', () => {
    const { exit, pi } = runSetup(['--dump-tools', '-p', 'dump'], {
      PI_INSPECT_SYNTHETIC_DUMP: '1'
    });

    expect(exit).toBeUndefined();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(pi.on).toHaveBeenCalledWith('context', expect.any(Function));
  });

  it('does not spawn when the user passes -p with a prompt', () => {
    const { exit } = runSetup(['--dump-tools', '-p', 'hello']);

    expect(exit).toBeUndefined();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('spawns when a flag value follows a dump flag (not a prompt)', () => {
    const { exit } = runSetup(['--dump-tools', '--thinking', 'high']);

    expect(exit).toBe('exit:0');
    expect(spawnSyncMock.mock.calls[0][1]).toEqual([
      '/usr/local/bin/pi',
      '--dump-tools',
      '--thinking',
      'high',
      '--no-session',
      '-p',
      'dump'
    ]);
  });

  it('does nothing when no dump flag is present', () => {
    const { exit } = runSetup(['--model', 'gpt-4o']);

    expect(exit).toBeUndefined();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

describe('needsSyntheticTurn', () => {
  const needs = (argv: string[], stdinIsTTY = true) =>
    needsSyntheticTurn(parseArgs(argv), stdinIsTTY);

  it('is true when only a dump flag is present', () => {
    expect(needs(['--dump-system-prompt'])).toBe(true);
    expect(needs(['--dump-tools'])).toBe(true);
  });

  it('is false without a dump flag', () => {
    expect(needs([])).toBe(false);
    expect(needs(['--model', 'gpt-4o'])).toBe(false);
  });

  it('is false when -p carries a prompt', () => {
    expect(needs(['--dump-tools', '-p', 'hello'])).toBe(false);
  });

  it('is false for an @file argument', () => {
    expect(needs(['--dump-tools', '@context.md'])).toBe(false);
  });

  it('is false for a positional prompt before the dump flag', () => {
    expect(needs(['hello', '--dump-tools'])).toBe(false);
    expect(needs(['--model', 'gpt-4o', 'hello', '--dump-tools'])).toBe(false);
  });

  it('is false for a positional prompt after a `--` separator', () => {
    expect(needs(['--model', 'gpt-4o', '--dump-tools', '--', 'hello'])).toBe(false);
    expect(needs(['--dump-tools', '--', 'hello'])).toBe(false);
  });

  it('is true when a word after the dump flag is swallowed as its value, not a prompt', () => {
    // Pi's parser reads `--dump-tools hello` as flag `dump-tools` with value "hello".
    expect(needs(['--dump-tools', 'hello'])).toBe(true);
  });

  it('is true when other flags take values that look like prompts', () => {
    expect(needs(['--dump-tools', '--thinking', 'high'])).toBe(true);
    expect(needs(['--dump-tools', '--name', 'my session'])).toBe(true);
    expect(needs(['--dump-tools', '--exclude-tools', 'bash'])).toBe(true);
  });

  it('treats --dump-tools=false as on, like Pi does for boolean flags', () => {
    expect(needs(['--dump-tools=false'])).toBe(true);
  });

  it('is false when -p reads a piped prompt from stdin', () => {
    expect(needs(['--dump-tools', '-p'], false)).toBe(false);
    expect(needs(['--dump-tools', '-p'], true)).toBe(true);
  });

  it('is false when Pi handles the invocation itself', () => {
    expect(needs(['--dump-tools', '--help'])).toBe(false);
    expect(needs(['--dump-tools', '--list-models'])).toBe(false);
    expect(needs(['--dump-tools', '--export', 'session.jsonl'])).toBe(false);
  });

  it('is false in RPC mode, which ignores -p', () => {
    expect(needs(['--dump-tools', '--mode', 'rpc'])).toBe(false);
    expect(needs(['--dump-tools', '--mode', 'json'])).toBe(true);
  });
});

describe('buildSyntheticArgs', () => {
  const build = (argv: string[]) => buildSyntheticArgs(argv, parseArgs(argv));

  it('appends --no-session and -p dump', () => {
    expect(build(['--dump-tools'])).toEqual(['--dump-tools', '--no-session', '-p', 'dump']);
  });

  it.each([['-c'], ['--continue'], ['-r'], ['--resume'], ['--session', 'abc'], ['--fork', 'abc']])(
    'keeps the selected session when %s is passed',
    (...sessionArgs) => {
      expect(build(['--dump-tools', ...sessionArgs])).toEqual([
        '--dump-tools',
        ...sessionArgs,
        '-p',
        'dump'
      ]);
    }
  );

  it('does not duplicate --no-session', () => {
    expect(build(['--dump-tools', '--no-session'])).toEqual([
      '--dump-tools',
      '--no-session',
      '-p',
      'dump'
    ]);
  });

  it('keeps a trailing -p from consuming the appended flags', () => {
    const args = ['--dump-tools', '-p'];
    expect(build(args)).toEqual(['--dump-tools', '-p', '--no-session', '-p', 'dump']);
    // The appended args must still parse as an empty-prompt `-p` followed by the real `-p dump`.
    const parsed = parseArgs(build(args));
    expect(parsed.noSession).toBe(true);
    expect(parsed.messages).toEqual(['dump']);
  });

  it('drops a trailing bare -- so appended flags are not read as messages', () => {
    expect(build(['--dump-tools', '--'])).toEqual(['--dump-tools', '--no-session', '-p', 'dump']);
  });
});

describe('writeAllSync', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    writeSyncMock.mockReset();
  });

  it('continues writing until all bytes are written', () => {
    writeSyncMock.mockImplementation(
      (_fd: number, _buffer: Buffer, _offset: number, length: number) => Math.min(3, length)
    );

    writeAllSync(1, 'abcdefg');

    expect(writeSyncMock).toHaveBeenCalledTimes(3);
    expect(writeSyncMock).toHaveBeenNthCalledWith(1, 1, expect.any(Buffer), 0, 7);
    expect(writeSyncMock).toHaveBeenNthCalledWith(2, 1, expect.any(Buffer), 3, 4);
    expect(writeSyncMock).toHaveBeenNthCalledWith(3, 1, expect.any(Buffer), 6, 1);
  });

  it('retries transient nonblocking write errors', () => {
    const error = new Error('resource temporarily unavailable') as NodeJS.ErrnoException;
    error.code = 'EAGAIN';
    writeSyncMock
      .mockImplementationOnce(() => 2)
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockImplementationOnce(() => 2)
      .mockImplementationOnce(() => 1);

    writeAllSync(1, 'abcde');

    expect(writeSyncMock).toHaveBeenCalledTimes(4);
    expect(writeSyncMock).toHaveBeenNthCalledWith(1, 1, expect.any(Buffer), 0, 5);
    expect(writeSyncMock).toHaveBeenNthCalledWith(2, 1, expect.any(Buffer), 2, 3);
    expect(writeSyncMock).toHaveBeenNthCalledWith(3, 1, expect.any(Buffer), 2, 3);
    expect(writeSyncMock).toHaveBeenNthCalledWith(4, 1, expect.any(Buffer), 4, 1);
  });

  it('throws if writeSync makes no progress', () => {
    writeSyncMock.mockReturnValue(0);

    expect(() => writeAllSync(1, 'abc')).toThrow('writeSync wrote 0 bytes');
  });
});

function makeTool(name: string, source: string, description = '', parameters: object = {}) {
  return {
    name,
    description,
    parameters,
    sourceInfo: { path: '', source, scope: 'user', origin: 'package' }
  };
}

function makePi(tools: ReturnType<typeof makeTool>[], activeNames?: string[]) {
  const active = activeNames ?? tools.map((t) => t.name);
  return {
    getAllTools: () => tools,
    getActiveTools: () => active
  } as never;
}

describe('formatTools', () => {
  it('lists all active tools with name, source, and description', () => {
    const pi = makePi([
      makeTool('bash', 'builtin', 'Execute a bash command'),
      makeTool('read', 'builtin', 'Read a file')
    ]);

    const output = formatTools(pi);

    expect(output).toContain('Tools: 2 active');
    expect(output).toContain('bash [builtin]');
    expect(output).toContain('  Execute a bash command');
    expect(output).toContain('read [builtin]');
    expect(output).toContain('  Read a file');
  });

  it('separates inactive tools under a divider', () => {
    const pi = makePi(
      [
        makeTool('bash', 'builtin', 'Execute a bash command'),
        makeTool('some_tool', 'my-extension', 'Inactive tool')
      ],
      ['bash']
    );

    const output = formatTools(pi);

    expect(output).toContain('Tools: 1 active, 1 inactive (2 total)');
    expect(output).toContain('bash [builtin]');
    expect(output).toContain('--- inactive ---');
    expect(output).toContain('some_tool [my-extension]');
  });

  it('omits the inactive section when all tools are active', () => {
    const pi = makePi([makeTool('bash', 'builtin', 'Execute a bash command')]);

    const output = formatTools(pi);

    expect(output).not.toContain('inactive');
    expect(output).not.toContain('---');
  });

  it('handles tools without a description', () => {
    const pi = makePi([makeTool('silent_tool', 'builtin')]);

    const output = formatTools(pi);

    expect(output).toContain('silent_tool [builtin]');
    // No indented blank description line anywhere in the output
    expect(output).not.toMatch(/^\s+$/m);
  });

  it('prints the JSON parameter schema indented under each tool', () => {
    const parameters = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    };
    const pi = makePi([makeTool('read', 'builtin', 'Read a file', parameters)]);

    const output = formatTools(pi);

    expect(output).toContain('  parameters:\n');
    const schema = output.split('  parameters:\n')[1];
    expect(JSON.parse(schema)).toEqual(parameters);
    expect(schema.split('\n').every((line) => line.startsWith('    '))).toBe(true);
  });

  it('prints schemas for inactive tools too', () => {
    const pi = makePi([makeTool('bash', 'builtin', 'Run', { type: 'object' })], []);

    expect(formatTools(pi)).toContain('"type": "object"');
  });

  it('indents every line of a multi-line description', () => {
    const pi = makePi([makeTool('multi', 'builtin', 'First line\n\nThird line')], ['multi']);

    expect(formatTools(pi)).toContain('multi [builtin]\n  First line\n\n  Third line');
  });
});

describe('dumpSystemPrompt context hook', () => {
  type ContextHandler = (event: unknown, ctx: { getSystemPrompt: () => string }) => void;

  /** Registers the extension inside a synthetic child and returns its `context` handler. */
  function setup(flags: Record<string, boolean>) {
    const tools = [makeTool('read', 'builtin', 'Read a file')];
    const pi = {
      ...(makePi(tools) as object),
      getFlag: vi.fn((name: string) => flags[name] ?? false),
      on: vi.fn(),
      registerFlag: vi.fn()
    };
    expect(runSetup([], { PI_INSPECT_SYNTHETIC_DUMP: '1' }, pi).exit).toBeUndefined();

    const call = pi.on.mock.calls.find(([event]) => event === 'context');
    return call?.[1] as ContextHandler;
  }

  const ctx = { getSystemPrompt: () => 'SYSTEM PROMPT' };
  const written = () => writeSyncMock.mock.calls.map(([, buffer]) => buffer.toString()).join('');

  /** Fires the `context` hook with `process.exit` stubbed out; returns the exit spy. */
  function fire(flags: Record<string, boolean>) {
    // Install the exit stub after setup(): runSetup restores process.exit when it finishes.
    const handler = setup(flags);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    handler({}, ctx);
    return exitSpy;
  }

  beforeEach(() => {
    spawnSyncMock.mockReset();
    writeSyncMock.mockReset();
    writeSyncMock.mockImplementation(
      (_fd: number, _buffer: Buffer, _offset: number, length: number) => length
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the system prompt to fd 1 and exits 0', () => {
    const exitSpy = fire({ 'dump-system-prompt': true });

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.any(Buffer), 0, expect.any(Number));
    expect(written()).toBe('SYSTEM PROMPT\n');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints the tool list when only --dump-tools is set', () => {
    const exitSpy = fire({ 'dump-tools': true });

    expect(written()).toContain('read [builtin]');
    expect(written()).not.toContain('SYSTEM PROMPT');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints only the system prompt when both flags are set', () => {
    fire({ 'dump-system-prompt': true, 'dump-tools': true });

    expect(written()).toBe('SYSTEM PROMPT\n');
  });

  it('does nothing when no dump flag is set', () => {
    const exitSpy = fire({});

    expect(writeSyncMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
