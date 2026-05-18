import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  hasInitialPrompt,
  formatTools
} = await import('../src/inspect.js');

describe('dumpSystemPrompt', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    writeSyncMock.mockReset();
  });

  it('runs the synthetic no-prompt dump during extension setup before flag values are available', () => {
    const originalArgv = process.argv;
    const originalSyntheticDump = process.env.PI_INSPECT_SYNTHETIC_DUMP;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: number | string | null
    ) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    process.argv = ['node', '/usr/local/bin/pi', '--dump-system-prompt'];
    delete process.env.PI_INSPECT_SYNTHETIC_DUMP;
    spawnSyncMock.mockReturnValue({ status: 0 });

    const pi = {
      getFlag: vi.fn(() => false),
      on: vi.fn(),
      registerFlag: vi.fn()
    };

    try {
      expect(() => dumpSystemPrompt(pi as never)).toThrow('exit:0');
    } finally {
      process.argv = originalArgv;
      if (originalSyntheticDump === undefined) {
        delete process.env.PI_INSPECT_SYNTHETIC_DUMP;
      } else {
        process.env.PI_INSPECT_SYNTHETIC_DUMP = originalSyntheticDump;
      }
      exitSpy.mockRestore();
    }

    expect(spawnSyncMock).toHaveBeenCalledWith(
      process.execPath,
      ['/usr/local/bin/pi', '--dump-system-prompt', '-p', 'dump'],
      expect.objectContaining({
        env: expect.objectContaining({ PI_INSPECT_SYNTHETIC_DUMP: '1' })
      })
    );
    expect(pi.on).not.toHaveBeenCalledWith('session_start', expect.any(Function));
  });
});

describe('dumpSystemPrompt --dump-tools synthetic turn', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    writeSyncMock.mockReset();
  });

  it('runs the synthetic turn when --dump-tools is present without an initial prompt', () => {
    const originalArgv = process.argv;
    const originalSyntheticDump = process.env.PI_INSPECT_SYNTHETIC_DUMP;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: number | string | null
    ) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    process.argv = ['node', '/usr/local/bin/pi', '--dump-tools'];
    delete process.env.PI_INSPECT_SYNTHETIC_DUMP;
    spawnSyncMock.mockReturnValue({ status: 0 });

    const pi = { getFlag: vi.fn(() => false), on: vi.fn(), registerFlag: vi.fn() };

    try {
      expect(() => dumpSystemPrompt(pi as never)).toThrow('exit:0');
    } finally {
      process.argv = originalArgv;
      if (originalSyntheticDump === undefined) delete process.env.PI_INSPECT_SYNTHETIC_DUMP;
      else process.env.PI_INSPECT_SYNTHETIC_DUMP = originalSyntheticDump;
      exitSpy.mockRestore();
    }

    expect(spawnSyncMock).toHaveBeenCalledWith(
      process.execPath,
      ['/usr/local/bin/pi', '--dump-tools', '-p', 'dump'],
      expect.objectContaining({
        env: expect.objectContaining({ PI_INSPECT_SYNTHETIC_DUMP: '1' })
      })
    );
  });
});

describe('hasInitialPrompt', () => {
  it('returns false when only --dump-system-prompt is present', () => {
    expect(hasInitialPrompt(['--dump-system-prompt'], true)).toBe(false);
  });

  it('returns false when only --dump-tools is present', () => {
    expect(hasInitialPrompt(['--dump-tools'], true)).toBe(false);
  });

  it('returns true for a bare positional prompt argument', () => {
    expect(hasInitialPrompt(['--dump-system-prompt', 'hello'], true)).toBe(true);
  });

  it('returns true for an @file argument', () => {
    expect(hasInitialPrompt(['@context.md'], true)).toBe(true);
  });

  it('skips flag-value pairs and still detects a following positional prompt', () => {
    expect(hasInitialPrompt(['--model', 'gpt-4o', 'hello'], true)).toBe(true);
  });

  it('does not treat --flag=value as a positional prompt', () => {
    expect(hasInitialPrompt(['--dump-system-prompt', '--model=gpt-4o'], true)).toBe(false);
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

function makeTool(name: string, source: string, description = '') {
  return {
    name,
    description,
    parameters: {},
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

  it('ends with a newline when written via dumpAndExit', () => {
    const pi = makePi([makeTool('bash', 'builtin', 'Execute a bash command')]);
    const output = formatTools(pi);
    // writeAllSync appends \n if missing — verify output itself doesn't double-newline
    expect(output).not.toMatch(/\n\n$/);
  });
});
