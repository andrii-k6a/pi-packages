import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { test } from 'vitest';
import {
  nextProfileIndex,
  openWorkflowProfileManager,
  selectedProfileIndex,
  WorkflowProfileList,
  WorkflowProfileTextInput
} from '../src/profile-manager.js';
import { loadWorkflowProfiles, saveWorkflowProfiles } from '../src/profiles.js';

function model(provider: string, id: string, reasoning = true) {
  return {
    provider,
    id,
    name: id,
    api: 'test',
    baseUrl: 'https://example.test',
    reasoning,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1
  };
}

type ManagerAction = 'edit' | 'new' | 'delete' | 'reload' | 'close' | undefined;

type MockContextOptions = {
  actions?: ManagerAction[];
  inputs?: (string | undefined)[];
  selects?: (string | undefined)[];
  confirms?: boolean[];
  mode?: 'tui' | 'print';
  models?: ReturnType<typeof model>[];
  activeModel?: ReturnType<typeof model>;
  scopedModels?: {
    model: ReturnType<typeof model>;
    thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  }[];
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
};

function mockContext(options: MockContextOptions = {}) {
  const notifications: { message: string; type: string | undefined }[] = [];
  const selectionOptions: string[][] = [];
  let reloads = 0;
  const models = options.models ?? [model('active', 'fast'), model('other', 'thorough', false)];
  const ctx = {
    mode: options.mode ?? 'tui',
    model: options.activeModel ?? models[0],
    scopedModels: options.scopedModels ?? [],
    thinkingLevel: options.thinkingLevel ?? 'medium',
    modelRegistry: { getAvailable: () => models },
    reload: async () => {
      reloads++;
    },
    ui: {
      notify: (message: string, type?: 'info' | 'warning' | 'error') => {
        notifications.push({ message, type });
      },
      custom: async <T>(
        factory: (
          tui: TUI,
          theme: { fg(color: string, value: string): string },
          keybindings: undefined,
          done: (result: T) => void
        ) => { handleInput(data: string): void; render?(width: number): string[] }
      ) => {
        return await new Promise<T>((resolve) => {
          const component = factory(
            { requestRender() {} } as TUI,
            {
              fg(_color: string, value: string) {
                return value;
              }
            },
            undefined,
            resolve
          );
          if (component.render?.(80).join('\n').includes('/workflow-profiles')) {
            const action = options.actions?.shift();
            const input =
              action === 'edit'
                ? 'e'
                : action === 'new'
                  ? 'n'
                  : action === 'delete'
                    ? 'd'
                    : action === 'reload'
                      ? 'r'
                      : 'q';
            component.handleInput(input);
            return;
          }

          const input = options.inputs?.shift();
          if (input !== undefined) {
            component.handleInput('\u000b');
            component.handleInput(input);
          }
          component.handleInput('\r');
        });
      },
      input: async () => options.inputs?.shift(),
      select: async (_label: string, choices: string[]) => {
        selectionOptions.push(choices);
        return options.selects?.shift();
      },
      confirm: async () => options.confirms?.shift() ?? false
    }
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    notifications,
    selectionOptions,
    get reloads() {
      return reloads;
    }
  };
}

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'pi-dynamic-workflows-manager-'));
}

test('profile manager keeps selection inside the available profile rows', () => {
  assert.equal(selectedProfileIndex(0, 0), 0);
  assert.equal(selectedProfileIndex(-1, 3), 0);
  assert.equal(selectedProfileIndex(4, 3), 2);
  assert.equal(selectedProfileIndex(1, 3), 1);
});

test('profile manager supports legacy and Kitty Vim navigation keys', () => {
  assert.equal(nextProfileIndex(0, 3, 'j'), 1);
  assert.equal(nextProfileIndex(1, 3, 'k'), 0);
  assert.equal(nextProfileIndex(0, 3, '\u001B[106u'), 1);
  assert.equal(nextProfileIndex(1, 3, '\u001B[107u'), 0);
  assert.equal(nextProfileIndex(0, 3, '\u001B[B'), 1);
  assert.equal(nextProfileIndex(1, 3, '\u001B[A'), 0);
  assert.equal(nextProfileIndex(2, 3, 'j'), 2);
  assert.equal(nextProfileIndex(0, 3, 'k'), 0);
  assert.equal(nextProfileIndex(0, 3, 'e'), 0);
});

test('profile manager maps Kitty printable sequences to every Vim action', () => {
  const actions: string[] = [];
  const list = new WorkflowProfileList(
    [{ name: 'fast', description: 'Quick', model: 'fast', thinkingLevel: 'low' }],
    { requestRender() {} } as TUI,
    {
      fg(_color: string, value: string) {
        return value;
      }
    } as never,
    (action) => actions.push(action ?? '')
  );

  for (const input of ['\u001B[101u', '\u001B[110u', '\u001B[100u', '\u001B[114u', '\u001B[113u']) {
    list.handleInput(input);
  }

  assert.deepEqual(actions, ['edit', 'new', 'delete', 'reload', 'close']);
});

test('profile manager removes terminal controls from rendered profile text', () => {
  const list = new WorkflowProfileList(
    [
      {
        name: 'fast\u001b]8;;https://example.test\u0007',
        description: 'Quick\u009d0;title\u009c triage',
        model: 'fast\u007f',
        thinkingLevel: 'low'
      } as never
    ],
    { requestRender() {} } as TUI,
    {
      fg(_color: string, value: string) {
        return value;
      }
    } as never,
    () => {}
  );

  const rendered = list.render(200);
  for (const line of rendered) assert.doesNotMatch(line, /\p{Cc}/u);
  assert.match(rendered[1], /fast]8;;https:\/\/example\.test {2}fast {2}Quick0;title triage/);
});

test('profile text input removes controls from bracketed paste before rendering', () => {
  const input = new WorkflowProfileTextInput(
    { requestRender() {} } as TUI,
    {
      fg(_color: string, value: string) {
        return value;
      }
    } as never,
    'Profile name',
    '',
    () => {}
  );

  input.handleInput('\u001b[200~safe\u001b]8;;https://example.test\u0007name\u001b[201~');

  const rendered = input.render(100).join('\n');
  for (const control of ['\u001b]', '\u009d', '\u009c', '\u0007']) {
    assert.equal(rendered.includes(control), false);
  }
  assert.match(rendered, /safe]8;;https:\/\/example\.testname/);
});

test('profile manager excludes unsafe registry models from provider and model choices', async () => {
  const directory = temporaryDirectory();
  const safe = model('active', 'fast');
  const unsafeProvider = model('bad\u001b]8;;https://example.test\u0007', 'bad-provider');
  const unsafeModel = model('other', 'bad\u009d0;title\u009c');
  const mocked = mockContext({
    actions: ['new'],
    models: [safe, unsafeProvider, unsafeModel],
    activeModel: unsafeProvider,
    inputs: ['fast', 'Quick'],
    selects: ['active', 'fast', 'low']
  });

  try {
    await openWorkflowProfileManager(mocked.ctx, directory);

    for (const options of mocked.selectionOptions) {
      for (const option of options) assert.doesNotMatch(option, /\p{Cc}/u);
    }
    assert.deepEqual(mocked.selectionOptions[0], ['active']);
    assert.equal(mocked.reloads, 1);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('profile manager sanitizes and bounds error notifications', async () => {
  const directory = temporaryDirectory();
  const unknownKey = `unknown\u001b]8;;https://example.test\u0007${'x'.repeat(500)}`;
  const configDirectory = join(directory, 'pi-dynamic-workflows');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(configDirectory);
  writeFileSync(
    join(configDirectory, 'profiles.json'),
    JSON.stringify({ profiles: [], [unknownKey]: true })
  );
  const mocked = mockContext();

  try {
    await openWorkflowProfileManager(mocked.ctx, directory);

    assert.equal(mocked.notifications.length, 1);
    assert.doesNotMatch(mocked.notifications[0].message, /\p{Cc}/u);
    assert.ok([...mocked.notifications[0].message].length < 500);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('profile manager rejects non-TUI commands without invoking terminal UI', async () => {
  const mocked = mockContext({ mode: 'print' });

  await openWorkflowProfileManager(mocked.ctx);

  assert.deepEqual(mocked.notifications, [
    { message: '/workflow-profiles requires interactive mode', type: 'error' }
  ]);
  assert.equal(mocked.reloads, 0);
});

test('profile manager creates a registry-backed profile and omits active provider', async () => {
  const directory = temporaryDirectory();
  const mocked = mockContext({
    actions: ['new'],
    inputs: [' fast ', ' Quick repository triage '],
    selects: ['Use active session provider (active)', 'fast', 'low']
  });

  try {
    await openWorkflowProfileManager(mocked.ctx, directory);

    assert.equal(mocked.reloads, 1);
    assert.deepEqual(loadWorkflowProfiles(directory), [
      {
        name: 'fast',
        description: 'Quick repository triage',
        model: 'fast',
        thinkingLevel: 'low',
        provider: undefined
      }
    ]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('profile manager only saves provider, model, and thinking selections from the registry', async () => {
  const invalidSelections = [
    ['not-available-provider'],
    ['other', 'not-available-model'],
    ['other', 'thorough', 'high']
  ];

  for (const selects of invalidSelections) {
    const directory = temporaryDirectory();
    const mocked = mockContext({
      actions: ['new'],
      inputs: ['thorough', 'Deliberate review'],
      selects
    });

    try {
      await openWorkflowProfileManager(mocked.ctx, directory);

      assert.equal(mocked.reloads, 0);
      assert.deepEqual(loadWorkflowProfiles(directory), []);
    } finally {
      rmSync(directory, { recursive: true });
    }
  }
});

test('profile manager limits routing choices to session-scoped models', async () => {
  const directory = temporaryDirectory();
  const active = model('active', 'fast');
  const scoped = model('other', 'thorough', false);
  const mocked = mockContext({
    actions: ['new'],
    models: [active, scoped],
    activeModel: active,
    scopedModels: [{ model: scoped }],
    inputs: ['thorough', 'Deliberate review'],
    selects: ['other', 'thorough', 'off']
  });

  try {
    await openWorkflowProfileManager(mocked.ctx, directory);

    assert.equal(mocked.reloads, 1);
    assert.deepEqual(loadWorkflowProfiles(directory), [
      {
        name: 'thorough',
        description: 'Deliberate review',
        provider: 'other',
        model: 'thorough',
        thinkingLevel: 'off'
      }
    ]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('profile manager rejects an unsupported session-scoped thinking level pin without saving', async () => {
  const directory = temporaryDirectory();
  const active = model('active', 'fast');
  const scoped = model('other', 'thorough', false);
  const mocked = mockContext({
    actions: ['new'],
    models: [active, scoped],
    activeModel: active,
    scopedModels: [{ model: scoped, thinkingLevel: 'low' }],
    inputs: ['thorough', 'Deliberate review'],
    selects: ['other', 'thorough']
  });

  try {
    await openWorkflowProfileManager(mocked.ctx, directory);

    assert.equal(mocked.reloads, 0);
    assert.deepEqual(loadWorkflowProfiles(directory), []);
    assert.deepEqual(mocked.notifications, [
      {
        message:
          'The session-scoped thinking level is unsupported by the selected model; profile was not saved',
        type: 'error'
      }
    ]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('profile manager only offers and saves a session-scoped thinking level pin', async () => {
  const directory = temporaryDirectory();
  const active = model('active', 'fast');
  const scoped = model('other', 'thorough');
  const mocked = mockContext({
    actions: ['new'],
    models: [active, scoped],
    activeModel: active,
    scopedModels: [{ model: scoped, thinkingLevel: 'low' }],
    inputs: ['thorough', 'Deliberate review'],
    selects: ['other', 'thorough', 'low']
  });

  try {
    await openWorkflowProfileManager(mocked.ctx, directory);

    assert.deepEqual(mocked.selectionOptions[2], ['low']);
    assert.equal(mocked.reloads, 1);
    assert.deepEqual(loadWorkflowProfiles(directory), [
      {
        name: 'thorough',
        description: 'Deliberate review',
        provider: 'other',
        model: 'thorough',
        thinkingLevel: 'low'
      }
    ]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('profile manager preserves prefilled name and description when an edit is unchanged', async () => {
  const directory = temporaryDirectory();
  const initial = {
    name: 'fast',
    description: 'Quick',
    model: 'fast',
    thinkingLevel: 'low' as const
  };
  const edit = mockContext({
    actions: ['edit'],
    inputs: [undefined, undefined],
    selects: ['Use active session provider (active)', 'fast', 'low']
  });

  try {
    saveWorkflowProfiles([initial], directory);
    await openWorkflowProfileManager(edit.ctx, directory);

    assert.equal(edit.reloads, 1);
    assert.deepEqual(loadWorkflowProfiles(directory), [{ ...initial, provider: undefined }]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('profile manager edits and deletes profiles through mocked dialogs', async () => {
  const directory = temporaryDirectory();
  const initial = {
    name: 'fast',
    description: 'Quick',
    model: 'fast',
    thinkingLevel: 'low' as const
  };
  const edit = mockContext({
    actions: ['edit'],
    inputs: ['faster', 'Faster triage'],
    selects: ['Use active session provider (active)', 'fast', 'medium']
  });

  try {
    saveWorkflowProfiles([initial], directory);
    await openWorkflowProfileManager(edit.ctx, directory);
    assert.equal(edit.reloads, 1);
    assert.deepEqual(loadWorkflowProfiles(directory), [
      {
        name: 'faster',
        description: 'Faster triage',
        model: 'fast',
        thinkingLevel: 'medium',
        provider: undefined
      }
    ]);

    const remove = mockContext({ actions: ['delete'], confirms: [true] });
    await openWorkflowProfileManager(remove.ctx, directory);
    assert.equal(remove.reloads, 1);
    assert.deepEqual(loadWorkflowProfiles(directory), []);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('profile manager reloads without changing profiles', async () => {
  const directory = temporaryDirectory();
  const mocked = mockContext({ actions: ['reload'] });

  try {
    await openWorkflowProfileManager(mocked.ctx, directory);
    assert.equal(mocked.reloads, 1);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
