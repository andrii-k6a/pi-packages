import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test, vi } from 'vitest';
import caffeinate, {
  commandCompletions,
  formatMode,
  parseCommand,
  selectInhibitor,
  splitCommand,
  windowsInhibitorScript
} from '../src/caffeinate.js';
import type { ScreenSaverClient, ScreenSaverFactory } from '../src/dbus-inhibit.js';
import { type ProcessStarter, stopInhibitorProcess } from '../src/inhibitor-process.js';
import type { InhibitorCommand } from '../src/inhibitors.js';
import { normalizeCaffeinateSettings, saveSettings } from '../src/settings.js';

type Handler = (event: unknown, ctx: FakeContext) => Promise<void> | void;
type CommandHandler = (args: string, ctx: FakeContext) => Promise<void>;

class FakeContext {
  readonly notifications: Array<{ message: string; type: string }> = [];
  readonly statuses = new Map<string, string | undefined>();
  readonly statusCalls: Array<{ key: string; value: string | undefined }> = [];
  selectCalls = 0;

  constructor(
    readonly hasUI = true,
    private readonly selections: Array<string | undefined> = []
  ) {}

  readonly ui = {
    notify: (message: string, type = 'info') => this.notifications.push({ message, type }),
    setStatus: (key: string, value: string | undefined) => {
      this.statusCalls.push({ key, value });
      this.statuses.set(key, value);
    },
    select: async (_title: string, _options: string[]) => {
      this.selectCalls += 1;
      return this.selections.shift();
    }
  };
}

function createPi() {
  const events = new Map<string, Handler[]>();
  const commands = new Map<string, CommandHandler>();
  return {
    events,
    commands,
    pi: {
      on(name: string, handler: Handler) {
        const handlers = events.get(name) ?? [];
        handlers.push(handler);
        events.set(name, handlers);
      },
      registerCommand(name: string, command: { handler: CommandHandler }) {
        commands.set(name, command.handler);
      }
    }
  };
}

async function emit(
  harness: ReturnType<typeof createPi>,
  event: string,
  ctx: FakeContext
): Promise<void> {
  for (const handler of harness.events.get(event) ?? []) await handler({}, ctx);
}

class FakeChild extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalls: Array<NodeJS.Signals | undefined> = [];
  stdin = {
    destroyed: false,
    end: () => {
      this.stdin.destroyed = true;
    }
  };

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.signalCode = signal ?? 'SIGTERM';
    this.killCalls.push(signal);
    return true;
  }

  fail(code = 7): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

class FakeScreenSaver implements ScreenSaverClient {
  readonly inhibitCalls: string[] = [];
  inhibitSignal: AbortSignal | undefined;
  uninhibitCalls = 0;
  closeCalls = 0;
  #failure: ((error: Error) => void) | undefined;

  constructor(private readonly gate: Promise<void> = Promise.resolve()) {}

  setFailureHandler(handler: ((error: Error) => void) | undefined): void {
    this.#failure = handler;
  }

  async inhibit(reason: string, signal?: AbortSignal): Promise<void> {
    this.inhibitCalls.push(reason);
    this.inhibitSignal = signal;
    await this.gate;
  }

  async uninhibit(): Promise<void> {
    this.uninhibitCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  fail(message: string): void {
    this.#failure?.(new Error(message));
  }
}

function fakeStarter(children: FakeChild[]): ProcessStarter {
  return (_command, onError, onExit) => {
    const child = new FakeChild();
    child.once('error', onError);
    child.once('exit', (code, signal) =>
      onExit(signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`)
    );
    children.push(child);
    return child as never;
  };
}

function fakeDbus(clients: FakeScreenSaver[], gate?: Promise<void>): ScreenSaverFactory {
  return async () => {
    const client = new FakeScreenSaver(gate);
    clients.push(client);
    return client;
  };
}

async function withAgentDir<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-caffeinate-'));
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    return await fn(directory);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function asLinux<T>(fn: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    return await fn();
  } finally {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor);
  }
}

test('parses commands, completions, custom commands, and platform inhibitor choices', () => {
  assert.equal(parseCommand(''), 'menu');
  assert.equal(parseCommand(' system '), 'sleep');
  assert.equal(parseCommand('screen'), 'display');
  assert.equal(parseCommand('off'), 'stop');
  assert.equal(parseCommand('bad'), 'unknown');
  assert.deepEqual(commandCompletions('sta'), [
    { value: 'status', label: 'status', description: 'Show keep-awake status' }
  ]);
  assert.equal(commandCompletions('status now'), null);
  assert.deepEqual(splitCommand(`runner --name 'two words' "quoted" a\\ b`), [
    'runner',
    '--name',
    'two words',
    'quoted',
    'a b'
  ]);
  assert.deepEqual(splitCommand('"C:\\Program Files\\Pi\\inhibitor.exe" --flag'), [
    'C:\\Program Files\\Pi\\inhibitor.exe',
    '--flag'
  ]);

  const custom = selectInhibitor('sleep', {
    platform: 'linux',
    environment: { PI_CAFFEINATE_COMMAND: `runner --label 'keep awake'` },
    commandExists: () => false
  });
  assert.deepEqual(custom, {
    executable: 'runner',
    args: ['--label', 'keep awake'],
    label: 'custom command (runner)',
    custom: true
  });

  const systemd = selectInhibitor('display', {
    platform: 'linux',
    environment: {},
    commandExists: (command) => command === 'systemd-inhibit',
    isWsl: false
  });
  assert.equal(systemd?.executable, 'systemd-inhibit');
  assert.ok(systemd?.args.includes('--what=idle:sleep'));
  assert.deepEqual(systemd?.args.slice(-2), ['sleep', 'infinity']);
  assert.equal(systemd?.needsScreenSaverInhibit, true);

  const wsl = selectInhibitor('sleep', {
    platform: 'linux',
    environment: {},
    commandExists: (command) => command === 'powershell.exe',
    isWsl: true
  });
  assert.equal(wsl?.executable, 'powershell.exe');
  assert.equal(wsl?.releaseOnStdinClose, true);
  assert.match(windowsInhibitorScript('display'), /0x80000003/);
  assert.equal(formatMode('sleep'), 'system-awake');
});

test('parses the defined shell-free custom-command grammar', () => {
  assert.deepEqual(
    splitCommand(String.raw`runner 'C:\Program Files\Pi\inhibitor.exe' "say \"hello\""`),
    ['runner', 'C:\\Program Files\\Pi\\inhibitor.exe', 'say "hello"']
  );
  assert.deepEqual(splitCommand('runner "" \'\''), ['runner', '', '']);
  assert.deepEqual(splitCommand(`runner pre" middle"' post'`), ['runner', 'pre middle post']);
  assert.deepEqual(splitCommand(String.raw`runner path\q`), ['runner', String.raw`path\q`]);
  assert.deepEqual(splitCommand(String.raw`runner a\"b a\'b a\\b`), [
    'runner',
    'a"b',
    "a'b",
    String.raw`a\b`
  ]);
  assert.deepEqual(splitCommand(String.raw`runner "a\qb\z"`), ['runner', String.raw`a\qb\z`]);
  const invalidCommand = (error: unknown): boolean =>
    error instanceof Error && error.message.startsWith('Invalid PI_CAFFEINATE_COMMAND');
  assert.throws(() => splitCommand('runner "unterminated'), invalidCommand);
  assert.throws(() => splitCommand("runner 'unterminated"), invalidCommand);
  assert.throws(() => splitCommand('runner trailing\\'), invalidCommand);
  assert.throws(() => splitCommand('runner "trailing\\'), invalidCommand);
});

test('settings validation and persistence preserve fields and reject malformed settings', async () => {
  assert.deepEqual(normalizeCaffeinateSettings({ mode: 'display' }), {
    mode: 'display',
    quiet: false,
    updatedAt: 0
  });
  assert.equal(normalizeCaffeinateSettings({ mode: 'display', quiet: 'yes' }), undefined);

  await withAgentDir(async (directory) => {
    const settingsPath = path.join(directory, 'pi-caffeinate.json');
    await writeFile(
      settingsPath,
      JSON.stringify({ mode: 'display', quiet: true, extra: 1 }),
      'utf8'
    );
    await saveSettings({ mode: 'sleep', updatedAt: 4 });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), {
      mode: 'sleep',
      quiet: true,
      updatedAt: 4,
      extra: 1
    });

    const malformed = '{"mode":"invalid"}\n';
    await writeFile(settingsPath, malformed, 'utf8');
    await assert.rejects(saveSettings({ mode: 'display', updatedAt: 5 }), /invalid file/);
    assert.equal(await readFile(settingsPath, 'utf8'), malformed);
  });
});

test('mode commands persist settings and surface save errors without changing the runtime mode', async () => {
  await withAgentDir(async (directory) => {
    const harness = createPi();
    caffeinate(harness.pi as never, { selectCommand: () => undefined });
    const context = new FakeContext(false);
    await harness.commands.get('caffeinate')?.('sleep', context);
    const saved = JSON.parse(await readFile(path.join(directory, 'pi-caffeinate.json'), 'utf8'));
    assert.equal(saved.mode, 'sleep');
    assert.match(context.notifications.at(-1)?.message ?? '', /system-awake and saved/);

    await writeFile(path.join(directory, 'pi-caffeinate.json'), '{"mode":"bad"}', 'utf8');
    await harness.commands.get('caffeinate')?.('display', context);
    assert.match(context.notifications.at(-1)?.message ?? '', /mode remains system-awake/);
    assert.match(context.notifications.at(-1)?.message ?? '', /not saved|save failed/);
  });
});

test('lifecycle retains inhibition across retries and releases it after settlement', async () => {
  await withAgentDir(async () => {
    const children: FakeChild[] = [];
    const harness = createPi();
    caffeinate(harness.pi as never, {
      selectCommand: () => ({ executable: 'fake', args: [], label: 'fake inhibitor' }),
      startProcess: fakeStarter(children)
    });
    const context = new FakeContext();
    await emit(harness, 'session_start', context);
    await emit(harness, 'agent_start', context);
    assert.equal(children.length, 1);
    assert.equal(context.statuses.get('caffeinate'), 'display-awake');

    await emit(harness, 'agent_end', context);
    assert.equal(children[0]?.killCalls.length, 0);
    await emit(harness, 'agent_start', context);
    assert.equal(children.length, 1);
    await emit(harness, 'agent_end', context);
    assert.equal(children[0]?.killCalls.length, 0);
    await emit(harness, 'agent_settled', context);
    assert.equal(children[0]?.killCalls.length, 1);

    await emit(harness, 'agent_start', context);
    assert.equal(children.length, 2);
    await harness.commands.get('caffeinate')?.('stop', context);
    assert.equal(children[1]?.killCalls.length, 1);
    assert.doesNotThrow(() => children[1]?.emit('error', new Error('spawn failed')));
    children[1]?.fail();
    assert.doesNotMatch(context.notifications.at(-1)?.message ?? '', /failed|exited unexpectedly/);

    await emit(harness, 'agent_start', context);
    assert.equal(children.length, 3);
    children[2]?.fail(9);
    assert.match(context.notifications.at(-1)?.message ?? '', /exited unexpectedly \(code 9\)/);
    assert.equal(context.statuses.get('caffeinate'), 'unavailable');
    await emit(harness, 'session_shutdown', context);
  });
});

test('explicit mode selections restart an unavailable built-in inhibitor', async () => {
  for (const targetMode of ['sleep', 'display'] as const) {
    await withAgentDir(async () => {
      const selectedModes: string[] = [];
      const children: FakeChild[] = [];
      const harness = createPi();
      caffeinate(harness.pi as never, {
        selectCommand: (mode) => {
          selectedModes.push(mode);
          return { executable: 'fake', args: [], label: `${mode} inhibitor` };
        },
        startProcess: fakeStarter(children)
      });
      const context = new FakeContext();
      await emit(harness, 'session_start', context);
      await emit(harness, 'agent_start', context);
      children[0]?.fail();
      assert.equal(context.statuses.get('caffeinate'), 'unavailable');

      await harness.commands.get('caffeinate')?.(targetMode, context);
      assert.deepEqual(selectedModes, ['display', targetMode]);
      assert.equal(children.length, 2);
      assert.equal(context.statuses.get('caffeinate'), formatMode(targetMode));
    });
  }
});

test('mode selection after a manual stop saves without restarting', async () => {
  await withAgentDir(async (directory) => {
    const children: FakeChild[] = [];
    const harness = createPi();
    caffeinate(harness.pi as never, {
      selectCommand: () => ({ executable: 'fake', args: [], label: 'built-in inhibitor' }),
      startProcess: fakeStarter(children)
    });
    const context = new FakeContext();
    await emit(harness, 'session_start', context);
    await emit(harness, 'agent_start', context);
    await harness.commands.get('caffeinate')?.('stop', context);
    await harness.commands.get('caffeinate')?.('sleep', context);

    assert.equal(children.length, 1);
    assert.equal(
      JSON.parse(await readFile(path.join(directory, 'pi-caffeinate.json'), 'utf8')).mode,
      'sleep'
    );
  });
});

test('mode selection with an active custom command saves without restarting', async () => {
  await withAgentDir(async (directory) => {
    const children: FakeChild[] = [];
    const harness = createPi();
    caffeinate(harness.pi as never, {
      selectCommand: () => ({
        executable: 'custom',
        args: [],
        label: 'custom inhibitor',
        custom: true
      }),
      startProcess: fakeStarter(children)
    });
    const context = new FakeContext();
    await emit(harness, 'session_start', context);
    await emit(harness, 'agent_start', context);
    await harness.commands.get('caffeinate')?.('sleep', context);

    assert.equal(children.length, 1);
    assert.equal(children[0]?.killCalls.length, 0);
    assert.equal(
      JSON.parse(await readFile(path.join(directory, 'pi-caffeinate.json'), 'utf8')).mode,
      'sleep'
    );
  });
});

test('a malformed custom command becomes unavailable without spawning or rejecting handlers', async () => {
  const previous = process.env.PI_CAFFEINATE_COMMAND;
  process.env.PI_CAFFEINATE_COMMAND = 'runner "unterminated';
  try {
    await withAgentDir(async () => {
      const children: FakeChild[] = [];
      const harness = createPi();
      caffeinate(harness.pi as never, { startProcess: fakeStarter(children) });
      const context = new FakeContext();
      await emit(harness, 'session_start', context);
      await assert.doesNotReject(emit(harness, 'agent_start', context));
      assert.equal(children.length, 0);
      assert.equal(context.statuses.get('caffeinate'), 'unavailable');
      assert.match(context.notifications.at(-1)?.message ?? '', /^Invalid PI_CAFFEINATE_COMMAND/);
      const command = harness.commands.get('caffeinate');
      assert.ok(command);
      await assert.doesNotReject(command('sleep', context));
      assert.equal(children.length, 0);
      assert.equal(context.statuses.get('caffeinate'), 'unavailable');
    });
  } finally {
    if (previous === undefined) delete process.env.PI_CAFFEINATE_COMMAND;
    else process.env.PI_CAFFEINATE_COMMAND = previous;
  }
});

test('stopping a just-spawned inhibitor consumes a later child-process error', () => {
  const child = new FakeChild();
  stopInhibitorProcess(child as never, undefined);
  assert.doesNotThrow(() => child.emit('error', new Error('spawn failed')));
});

test('stopping an inhibitor escalates from SIGTERM to SIGKILL when it ignores termination', () => {
  vi.useFakeTimers();
  try {
    const child = new FakeChild();
    child.kill = (signal?: NodeJS.Signals) => {
      child.killCalls.push(signal);
      return true;
    };
    stopInhibitorProcess(child as never, undefined);
    assert.deepEqual(child.killCalls, ['SIGTERM']);
    vi.advanceTimersByTime(2_000);
    assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL']);
    assert.doesNotThrow(() => child.emit('error', new Error('termination error')));
    child.emit('exit', null, 'SIGKILL');
    assert.equal(child.listenerCount('error'), 0);

    const stdinChild = new FakeChild();
    stdinChild.kill = (signal?: NodeJS.Signals) => {
      stdinChild.killCalls.push(signal);
      return true;
    };
    stopInhibitorProcess(stdinChild as never, { releaseOnStdinClose: true } as InhibitorCommand);
    assert.deepEqual(stdinChild.killCalls, []);
    vi.advanceTimersByTime(2_000);
    assert.deepEqual(stdinChild.killCalls, ['SIGKILL']);
  } finally {
    vi.useRealTimers();
  }
});

test('lifecycle status updates are skipped without a UI', async () => {
  await withAgentDir(async () => {
    const children: FakeChild[] = [];
    const harness = createPi();
    caffeinate(harness.pi as never, {
      selectCommand: () => ({ executable: 'fake', args: [], label: 'fake inhibitor' }),
      startProcess: fakeStarter(children)
    });
    const context = new FakeContext(false);
    await emit(harness, 'session_start', context);
    await emit(harness, 'agent_start', context);
    await emit(harness, 'agent_end', context);
    await emit(harness, 'agent_settled', context);
    await emit(harness, 'session_shutdown', context);
    assert.equal(context.statusCalls.length, 0);
  });
});

test('quiet mode suppresses lifecycle output while direct status remains visible', async () => {
  await withAgentDir(async (directory) => {
    await writeFile(
      path.join(directory, 'pi-caffeinate.json'),
      JSON.stringify({ mode: 'display', quiet: true, updatedAt: 1 }),
      'utf8'
    );
    const children: FakeChild[] = [];
    const harness = createPi();
    caffeinate(harness.pi as never, {
      selectCommand: () => ({ executable: 'fake', args: [], label: 'fake inhibitor' }),
      startProcess: fakeStarter(children)
    });
    const context = new FakeContext();
    await emit(harness, 'session_start', context);
    await emit(harness, 'agent_start', context);
    assert.equal(context.notifications.length, 0);
    assert.equal(context.statuses.get('caffeinate'), undefined);
    await harness.commands.get('caffeinate')?.('status', context);
    assert.match(context.notifications[0]?.message ?? '', /pi-caffeinate is active/);
    await emit(harness, 'agent_end', context);
    await emit(harness, 'agent_settled', context);
    assert.equal(context.notifications.length, 1);
  });
});

test('native Pi selection is guarded outside UI and routes selected mode through persistence', async () => {
  await withAgentDir(async (directory) => {
    const harness = createPi();
    caffeinate(harness.pi as never, { selectCommand: () => undefined });
    const printContext = new FakeContext(false);
    await harness.commands.get('caffeinate')?.('', printContext);
    assert.equal(printContext.selectCalls, 0);
    assert.match(
      printContext.notifications.at(-1)?.message ?? '',
      /Interactive selection is unavailable/
    );

    const interactiveContext = new FakeContext(true, [
      'sleep — keep the system awake and allow display sleep'
    ]);
    await harness.commands.get('caffeinate')?.('mode', interactiveContext);
    assert.equal(interactiveContext.selectCalls, 1);
    const saved = JSON.parse(await readFile(path.join(directory, 'pi-caffeinate.json'), 'utf8'));
    assert.equal(saved.mode, 'sleep');
  });
});

test('Linux D-Bus-only fallback, D-Bus failure, and cleanup are safe', async () => {
  await asLinux(async () => {
    await withAgentDir(async () => {
      const clients: FakeScreenSaver[] = [];
      const harness = createPi();
      caffeinate(harness.pi as never, {
        selectCommand: () => undefined,
        dbusFactory: fakeDbus(clients)
      });
      const context = new FakeContext();
      await emit(harness, 'session_start', context);
      await emit(harness, 'agent_start', context);
      assert.deepEqual(clients[0]?.inhibitCalls, ['Pi agent is active']);
      assert.match(context.notifications.at(-1)?.message ?? '', /partially active/);
      assert.equal(context.statuses.get('caffeinate'), 'display-awake');

      clients[0]?.fail('service disappeared');
      assert.match(context.notifications.at(-1)?.message ?? '', /service disappeared/);
      assert.equal(context.statuses.get('caffeinate'), 'unavailable');
      assert.equal(clients[0]?.closeCalls, 1);
      await emit(harness, 'agent_settled', context);
      assert.equal(clients[0]?.uninhibitCalls, 0);
    });
  });
});

test('Linux retains a process fallback when ScreenSaver acquisition fails', async () => {
  await asLinux(async () => {
    await withAgentDir(async () => {
      const children: FakeChild[] = [];
      const harness = createPi();
      const command: InhibitorCommand = {
        executable: 'systemd-inhibit',
        args: ['sleep', 'infinity'],
        label: 'systemd-inhibit (display-awake)',
        needsScreenSaverInhibit: true
      };
      caffeinate(harness.pi as never, {
        selectCommand: () => command,
        startProcess: fakeStarter(children),
        dbusFactory: async () => Promise.reject(new Error('no ScreenSaver service'))
      });
      const context = new FakeContext();
      await emit(harness, 'session_start', context);
      await emit(harness, 'agent_start', context);
      assert.equal(children.length, 1);
      assert.equal(context.statuses.get('caffeinate'), 'display-awake');
      assert.match(
        context.notifications.at(-1)?.message ?? '',
        /partially active.*no ScreenSaver service/
      );
      await emit(harness, 'agent_settled', context);
      assert.equal(children[0]?.killCalls.length, 1);
    });
  });
});

test('a sleep mode transaction cancels a pending display D-Bus start', async () => {
  await asLinux(async () => {
    await withAgentDir(async () => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const clients: FakeScreenSaver[] = [];
      const children: FakeChild[] = [];
      const harness = createPi();
      caffeinate(harness.pi as never, {
        selectCommand: (mode) =>
          mode === 'sleep' ? { executable: 'fake', args: [], label: 'sleep inhibitor' } : undefined,
        startProcess: fakeStarter(children),
        dbusFactory: fakeDbus(clients, gate)
      });
      const context = new FakeContext();
      await emit(harness, 'session_start', context);
      const start = emit(harness, 'agent_start', context);
      await waitFor(() => clients.length === 1 && clients[0]?.inhibitCalls.length === 1);

      const sleep = harness.commands.get('caffeinate')?.('sleep', context);
      await waitFor(() => clients[0]?.inhibitSignal?.aborted === true);
      assert.equal(clients[0]?.closeCalls, 1);

      release?.();
      await Promise.all([start, sleep]);
      assert.equal(clients[0]?.uninhibitCalls, 0);
      assert.equal(clients[0]?.closeCalls, 1);
      assert.equal(children.length, 1);
      await harness.commands.get('caffeinate')?.('status', context);
      assert.match(context.notifications.at(-1)?.message ?? '', /Mode: system-awake/);
      assert.doesNotMatch(context.notifications.at(-1)?.message ?? '', /ScreenSaver D-Bus/);
    });
  });
});

test('stop aborts and closes an in-flight Linux D-Bus acquisition', async () => {
  await asLinux(async () => {
    await withAgentDir(async () => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const clients: FakeScreenSaver[] = [];
      const harness = createPi();
      caffeinate(harness.pi as never, {
        selectCommand: () => undefined,
        dbusFactory: fakeDbus(clients, gate)
      });
      const context = new FakeContext();
      await emit(harness, 'session_start', context);
      const start = emit(harness, 'agent_start', context);
      await waitFor(() => clients.length === 1 && clients[0]?.inhibitCalls.length === 1);
      await emit(harness, 'agent_end', context);
      assert.equal(clients[0]?.inhibitSignal?.aborted, false);
      await emit(harness, 'agent_settled', context);
      assert.equal(clients[0]?.inhibitSignal?.aborted, true);
      assert.equal(clients[0]?.closeCalls, 1);
      release?.();
      await start;
      assert.equal(clients[0]?.uninhibitCalls, 0);
      assert.equal(clients[0]?.closeCalls, 1);
    });
  });
});

test('the native D-Bus client awaits its owner watch before trying both ScreenSaver paths', async () => {
  const calls: Array<{ member?: string; path?: string; body?: unknown[] }> = [];
  const connection = new EventEmitter();
  const signals = new EventEmitter();
  let establishWatch: (() => void) | undefined;
  const watchEstablished = new Promise<void>((resolve) => {
    establishWatch = resolve;
  });
  let watchCalls = 0;
  vi.resetModules();
  vi.doMock('dbus-native', () => ({
    sessionBus: () => ({
      connection,
      signals,
      mangle: (path: string, iface: string, member: string) => `${path}:${iface}:${member}`,
      async watch() {
        watchCalls += 1;
        await watchEstablished;
        return { async remove() {} };
      },
      invoke(
        message: { member?: string; path?: string; body?: unknown[] },
        _options: unknown,
        callback: (error: Error | null, value?: number) => void
      ) {
        calls.push(message);
        if (message.member === 'Inhibit' && message.path === '/org/freedesktop/ScreenSaver') {
          callback(new Error('first path unavailable'));
          return;
        }
        callback(null, message.member === 'Inhibit' ? 42 : undefined);
      },
      async close() {}
    })
  }));
  try {
    const { createScreenSaverClient } = await import('../src/dbus-inhibit.js');
    const client = await createScreenSaverClient();
    const inhibiting = client.inhibit('test');
    await waitFor(() => watchCalls === 1);
    assert.deepEqual(calls, []);
    establishWatch?.();
    await inhibiting;
    await client.uninhibit();
    await client.close();
    assert.deepEqual(
      calls.map(({ member, path, body }) => ({ member, path, body })),
      [
        {
          member: 'Inhibit',
          path: '/org/freedesktop/ScreenSaver',
          body: ['pi-caffeinate', 'test']
        },
        { member: 'Inhibit', path: '/ScreenSaver', body: ['pi-caffeinate', 'test'] },
        { member: 'UnInhibit', path: '/ScreenSaver', body: [42] }
      ]
    );
  } finally {
    vi.doUnmock('dbus-native');
    vi.resetModules();
  }
});

test('the native D-Bus client rejects a cookie returned after its service owner changes', async () => {
  const connection = new EventEmitter();
  const signals = new EventEmitter();
  const signal = '/org/freedesktop/DBus:org.freedesktop.DBus:NameOwnerChanged';
  let finishInhibit: ((value: number) => void) | undefined;
  vi.resetModules();
  vi.doMock('dbus-native', () => ({
    sessionBus: () => ({
      connection,
      signals,
      mangle: (path: string, iface: string, member: string) => `${path}:${iface}:${member}`,
      async watch() {
        return { async remove() {} };
      },
      invoke(
        message: { member?: string },
        _options: unknown,
        callback: (error: Error | null, value?: number) => void
      ) {
        if (message.member === 'Inhibit') {
          finishInhibit = (cookie) => callback(null, cookie);
          return;
        }
        callback(null);
      },
      async close() {}
    })
  }));
  try {
    const { createScreenSaverClient } = await import('../src/dbus-inhibit.js');
    const client = await createScreenSaverClient();
    const failures: Error[] = [];
    client.setFailureHandler((error) => failures.push(error));
    const inhibiting = client.inhibit('test');
    await waitFor(() => finishInhibit !== undefined);
    signals.emit(signal, ['org.freedesktop.ScreenSaver', ':1.4', ':1.5']);
    finishInhibit?.(42);
    await assert.rejects(inhibiting, /service owner changed while inhibiting/);
    await client.uninhibit();
    assert.deepEqual(failures, []);
    await client.close();
  } finally {
    vi.doUnmock('dbus-native');
    vi.resetModules();
  }
});

test('the native D-Bus client reports ScreenSaver service owner loss once', async () => {
  const connection = new EventEmitter();
  const signals = new EventEmitter();
  const signal = '/org/freedesktop/DBus:org.freedesktop.DBus:NameOwnerChanged';
  let removed = 0;
  vi.resetModules();
  vi.doMock('dbus-native', () => ({
    sessionBus: () => ({
      connection,
      signals,
      mangle: (path: string, iface: string, member: string) => `${path}:${iface}:${member}`,
      async watch() {
        return {
          async remove() {
            removed += 1;
          }
        };
      },
      invoke(
        message: { member?: string },
        _options: unknown,
        callback: (error: Error | null, value?: number) => void
      ) {
        callback(null, message.member === 'Inhibit' ? 42 : undefined);
      },
      async close() {}
    })
  }));
  try {
    const { createScreenSaverClient } = await import('../src/dbus-inhibit.js');
    const client = await createScreenSaverClient();
    const failures: Error[] = [];
    client.setFailureHandler((error) => failures.push(error));
    await client.inhibit('test');
    signals.emit(signal, ['org.freedesktop.ScreenSaver', ':1.4', ':1.5']);
    signals.emit(signal, ['org.freedesktop.ScreenSaver', ':1.5', '']);
    assert.deepEqual(
      failures.map((error) => error.message),
      ['D-Bus ScreenSaver service owner changed']
    );
    await client.close();
    await client.close();
    assert.equal(removed, 1);
    assert.equal(signals.listenerCount(signal), 0);
  } finally {
    vi.doUnmock('dbus-native');
    vi.resetModules();
  }
});

test('the native D-Bus client consumes a connection error emitted while close waits', async () => {
  const connection = new EventEmitter();
  let finishClose: (() => void) | undefined;
  vi.resetModules();
  vi.doMock('dbus-native', () => ({
    sessionBus: () => ({
      connection,
      signals: new EventEmitter(),
      mangle: () => '',
      async watch() {
        return { async remove() {} };
      },
      invoke(
        message: { member?: string },
        _options: unknown,
        callback: (error: Error | null, value?: number) => void
      ) {
        callback(null, message.member === 'Inhibit' ? 42 : undefined);
      },
      close: () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        })
    })
  }));
  try {
    const { createScreenSaverClient } = await import('../src/dbus-inhibit.js');
    const client = await createScreenSaverClient();
    await client.inhibit('test');
    const closing = client.close();
    await waitFor(() => finishClose !== undefined);
    assert.doesNotThrow(() => connection.emit('error', new Error('connection closing')));
    finishClose?.();
    await closing;
    assert.equal(connection.listenerCount('error'), 0);
  } finally {
    vi.doUnmock('dbus-native');
    vi.resetModules();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
