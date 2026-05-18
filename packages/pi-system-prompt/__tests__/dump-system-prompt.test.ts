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
  hasInitialPrompt
} = await import('../src/dump-system-prompt.js');

describe('dumpSystemPrompt', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    writeSyncMock.mockReset();
  });

  it('runs the synthetic no-prompt dump during extension setup before flag values are available', () => {
    const originalArgv = process.argv;
    const originalSyntheticDump = process.env.PI_SYSTEM_PROMPT_SYNTHETIC_DUMP;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: number | string | null
    ) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    process.argv = ['node', '/usr/local/bin/pi', '--dump-system-prompt'];
    delete process.env.PI_SYSTEM_PROMPT_SYNTHETIC_DUMP;
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
        delete process.env.PI_SYSTEM_PROMPT_SYNTHETIC_DUMP;
      } else {
        process.env.PI_SYSTEM_PROMPT_SYNTHETIC_DUMP = originalSyntheticDump;
      }
      exitSpy.mockRestore();
    }

    expect(spawnSyncMock).toHaveBeenCalledWith(
      process.execPath,
      ['/usr/local/bin/pi', '--dump-system-prompt', '-p', 'dump'],
      expect.objectContaining({
        env: expect.objectContaining({ PI_SYSTEM_PROMPT_SYNTHETIC_DUMP: '1' })
      })
    );
    expect(pi.on).not.toHaveBeenCalledWith('session_start', expect.any(Function));
  });
});

describe('hasInitialPrompt', () => {
  it('returns false when only --dump-system-prompt is present', () => {
    expect(hasInitialPrompt(['--dump-system-prompt'], true)).toBe(false);
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
