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
  WorkflowProfileWizard
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
  const wizardOptionLabels: string[][] = [];
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
          theme: {
            fg(color: string, value: string): string;
            bg(color: string, value: string): string;
            bold(value: string): string;
          },
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
              },
              bg(_color: string, value: string) {
                return value;
              },
              bold(value: string) {
                return value;
              }
            },
            undefined,
            resolve
          );
          const rendered = component.render?.(80).join('\n') ?? '';
          if (
            rendered.includes('New workflow profile') ||
            rendered.includes('Edit workflow profile')
          ) {
            driveWorkflowProfileWizard(component, options, wizardOptionLabels);
            return;
          }
          if (rendered.includes('/workflow-profiles')) {
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

          component.handleInput('\r');
        });
      },
      input: async () => options.inputs?.shift(),
      select: async (_label: string, _choices: string[]) => options.selects?.shift(),
      confirm: async () => options.confirms?.shift() ?? false
    }
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    notifications,
    wizardOptionLabels,
    get reloads() {
      return reloads;
    }
  };
}

function driveWorkflowProfileWizard(
  component: { handleInput(data: string): void; render?(width: number): string[] },
  options: MockContextOptions,
  optionLabels: string[][]
): void {
  for (let step = 0; step < 2; step++) {
    const input = options.inputs?.shift();
    if (input !== undefined) {
      component.handleInput('\u000b');
      component.handleInput(input);
    }
    component.handleInput('\r');
  }

  for (let step = 0; step < 3; step++) {
    const choice = options.selects?.shift();
    const rendered = component.render?.(80).join('\n') ?? '';
    const lines = rendered.split('\n');
    const visibleOptions = lines
      .filter((line) => /^[> ] \d+\. /.test(line))
      .map((line) => line.replace(/^[> ] \d+\. /, ''));
    optionLabels.push(visibleOptions);
    const selectedIndex = lines.findIndex((line) => line.startsWith('> '));
    const choiceIndex = choice
      ? lines.findIndex((line) => line.endsWith(`. ${choice}`) || line.includes(`(${choice})`))
      : -1;
    if (selectedIndex < 0 || choiceIndex < 0) {
      component.handleInput('\u001b');
      return;
    }
    for (let index = selectedIndex; index < choiceIndex; index++) component.handleInput('j');
    for (let index = selectedIndex; index > choiceIndex; index--) component.handleInput('k');
    component.handleInput('\r');
  }
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

function profileTheme() {
  return {
    fg(_color: string, value: string) {
      return value;
    },
    bg(_color: string, value: string) {
      return value;
    },
    bold(value: string) {
      return value;
    }
  } as never;
}

test('profile manager maps Kitty printable sequences to every Vim action', () => {
  const actions: string[] = [];
  const list = new WorkflowProfileList(
    [{ name: 'fast', description: 'Quick', model: 'fast', thinkingLevel: 'low' }],
    { requestRender() {} } as TUI,
    profileTheme(),
    (action) => actions.push(action ?? '')
  );

  for (const input of ['\u001B[101u', '\u001B[110u', '\u001B[100u', '\u001B[114u', '\u001B[113u']) {
    list.handleInput(input);
  }

  assert.deepEqual(actions, ['edit', 'new', 'delete', 'reload', 'close']);
});

test('profile manager renders profiles as readable three-line cards', () => {
  const list = new WorkflowProfileList(
    [
      {
        name: 'fast',
        description: 'Quick repository triage',
        model: 'gpt-5-mini',
        thinkingLevel: 'low'
      }
    ],
    { requestRender() {} } as TUI,
    profileTheme(),
    () => {}
  );

  assert.deepEqual(list.render(80).slice(4, 7), [
    '> 1. fast',
    '     Quick repository triage',
    '     gpt-5-mini  •  active session provider  •  thinking: low'
  ]);
});

test('profile manager fits one profile card in a short terminal', () => {
  const list = new WorkflowProfileList(
    [
      {
        name: 'fast',
        description: 'Quick repository triage',
        model: 'gpt-5-mini',
        thinkingLevel: 'low'
      },
      {
        name: 'thorough',
        description: 'Deliberate review',
        model: 'gpt-5',
        thinkingLevel: 'high'
      }
    ],
    { terminal: { rows: 10 }, requestRender() {} } as TUI,
    profileTheme(),
    () => {}
  );

  const rendered = list.render(80);
  assert.equal(rendered.length, 10);
  assert.match(rendered[1], /1–1 of 2 profiles/);
  assert.match(rendered.join('\n'), /> 1\. fast/);
  assert.doesNotMatch(rendered.join('\n'), /thorough/);
});

test('profile manager keeps the selected card visible while navigating', () => {
  const profiles = Array.from({ length: 8 }, (_, index) => ({
    name: `profile-${index + 1}`,
    description: `Description ${index + 1}`,
    model: `model-${index + 1}`,
    thinkingLevel: 'low' as const
  }));
  const list = new WorkflowProfileList(
    profiles,
    { terminal: { rows: 16 }, requestRender() {} } as TUI,
    profileTheme(),
    () => {}
  );

  for (let index = 0; index < 7; index++) list.handleInput('j');

  const rendered = list.render(80).join('\n');
  assert.match(rendered, /6–8 of 8/);
  assert.match(rendered, /> 8\. profile-8/);
  assert.doesNotMatch(rendered, /profile-1/);
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
    profileTheme(),
    () => {}
  );

  const rendered = list.render(200);
  for (const line of rendered) assert.doesNotMatch(line, /\p{Cc}/u);
  assert.match(rendered[4], /fast]8;;https:\/\/example\.test/);
  assert.match(rendered[5], /Quick0;title triage/);
  assert.match(rendered[6], /fast.*thinking: low/);
});

test('profile wizard removes controls from bracketed paste before rendering', () => {
  const wizard = new WorkflowProfileWizard(
    { requestRender() {} } as TUI,
    profileTheme(),
    [model('active', 'fast')] as never,
    [],
    'active',
    'fast',
    'medium',
    {},
    () => {},
    () => {}
  );

  wizard.handleInput('\u001b[200~safe\u001b]8;;https://example.test\u0007name\u001b[201~');

  const rendered = wizard.render(100).join('\n');
  for (const control of ['\u001b]', '\u009d', '\u009c', '\u0007']) {
    assert.equal(rendered.includes(control), false);
  }
  assert.match(rendered, /safe]8;;https:\/\/example\.testname/);
});

test('profile wizard renders each step in the shared full-width dialog', () => {
  const wizard = new WorkflowProfileWizard(
    { terminal: { rows: 24 }, requestRender() {} } as TUI,
    profileTheme(),
    [model('active', 'fast'), model('other', 'thorough')] as never,
    [],
    'active',
    'fast',
    'medium',
    {},
    () => {},
    () => {}
  );

  const nameStep = wizard.render(80).join('\n');
  assert.match(nameStep, /^─{80}/);
  assert.match(nameStep, /New workflow profile/);
  assert.match(nameStep, /● Name/);
  assert.match(nameStep, /○ Description/);

  wizard.handleInput('fast');
  wizard.handleInput('\r');
  wizard.handleInput('Quick repository triage');
  wizard.handleInput('\r');

  const providerStep = wizard.render(80).join('\n');
  assert.match(providerStep, /✓ Name/);
  assert.match(providerStep, /✓ Description/);
  assert.match(providerStep, /● Provider/);
  assert.match(providerStep, /> 1\. Use active session provider \(active\)/);
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

    for (const options of mocked.wizardOptionLabels) {
      for (const option of options) assert.doesNotMatch(option, /\p{Cc}/u);
    }
    assert.deepEqual(mocked.wizardOptionLabels[0], ['active']);
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

    assert.deepEqual(mocked.wizardOptionLabels[2], ['low']);
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
