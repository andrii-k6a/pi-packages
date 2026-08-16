import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  createWorkflowProfileResolver,
  loadWorkflowProfiles,
  type WorkflowProfileResolverContext
} from '../src/profiles.js';

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

function temporaryConfig(content?: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-dynamic-workflows-'));
  if (content !== undefined) {
    const configDirectory = join(directory, 'pi-dynamic-workflows');
    mkdirSync(configDirectory);
    writeFileSync(join(configDirectory, 'profiles.json'), content);
  }
  return directory;
}

function context(
  active = model('active', 'current'),
  targets = [model('active', 'fast')],
  available = targets
): WorkflowProfileResolverContext {
  return {
    model: active,
    modelRegistry: {
      find(provider, id) {
        return targets.find((target) => target.provider === provider && target.id === id);
      },
      getAvailable() {
        return available;
      }
    }
  } as WorkflowProfileResolverContext;
}

test('loadWorkflowProfiles accepts a valid user-owned config and ignores a missing file', () => {
  const missing = temporaryConfig();
  const configured = temporaryConfig(
    JSON.stringify({
      profiles: [
        {
          name: 'fast',
          description: 'Quick repository triage',
          provider: 'active',
          model: 'fast-model',
          thinkingLevel: 'low'
        }
      ]
    })
  );
  try {
    assert.deepEqual(loadWorkflowProfiles(missing), []);
    assert.deepEqual(loadWorkflowProfiles(configured), [
      {
        name: 'fast',
        description: 'Quick repository triage',
        provider: 'active',
        model: 'fast-model',
        thinkingLevel: 'low'
      }
    ]);
  } finally {
    rmSync(missing, { recursive: true });
    rmSync(configured, { recursive: true });
  }
});

test('loadWorkflowProfiles rejects malformed and invalid profile configurations', () => {
  const cases = [
    ['{', /Invalid dynamic workflow profile configuration/],
    ['[]', /expected an object/],
    ['{"unknown": true, "profiles": []}', /unknown key/],
    ['{"profiles": {}}', /profiles must be an array/],
    [
      '{"profiles": [{"name":"", "description":"desc", "model":"model", "thinkingLevel":"low"}]}',
      /non-empty string/
    ],
    [
      '{"profiles": [{"name":"fast", "description":"", "model":"model", "thinkingLevel":"low"}]}',
      /non-empty string/
    ],
    [
      '{"profiles": [{"name":"fast", "description":"desc", "model":"", "thinkingLevel":"low"}]}',
      /non-empty string/
    ],
    [
      '{"profiles": [{"name":"fast", "description":"desc", "provider":"", "model":"model", "thinkingLevel":"low"}]}',
      /non-empty string/
    ],
    [
      '{"profiles": [{"name":"fast", "description":"desc", "model":"model", "thinkingLevel":"invalid"}]}',
      /supported Pi thinking level/
    ],
    [
      '{"profiles": [{"name":"fast", "description":"desc", "model":"one", "thinkingLevel":"low"}, {"name":"fast", "description":"desc", "model":"two", "thinkingLevel":"low"}]}',
      /duplicates/
    ]
  ] as const;

  for (const [content, expected] of cases) {
    const directory = temporaryConfig(content);
    try {
      assert.throws(() => loadWorkflowProfiles(directory), expected);
    } finally {
      rmSync(directory, { recursive: true });
    }
  }
});

test('profile resolver uses an available model on only the active provider', () => {
  const target = model('active', 'fast');
  const resolver = createWorkflowProfileResolver(
    [{ name: 'fast', description: 'Quick', model: 'fast', thinkingLevel: 'low' }],
    context(undefined, [target, model('other', 'fast')])
  );

  assert.deepEqual(resolver('fast'), { model: target, thinkingLevel: 'low' });
});

test('profile resolver uses an explicitly configured provider', () => {
  const target = model('other', 'fast');
  const resolver = createWorkflowProfileResolver(
    [
      {
        name: 'fast',
        description: 'Quick',
        provider: 'other',
        model: 'fast',
        thinkingLevel: 'low'
      }
    ],
    context(undefined, [target])
  );

  assert.deepEqual(resolver('fast'), { model: target, thinkingLevel: 'low' });
});

test('profile resolver fails loudly for invalid routes', () => {
  const profile = {
    name: 'fast',
    description: 'Quick',
    model: 'fast',
    thinkingLevel: 'high' as const
  };

  assert.throws(
    () => createWorkflowProfileResolver([profile], context())('missing'),
    /profile is not approved/
  );
  assert.throws(
    () =>
      createWorkflowProfileResolver(
        [{ ...profile, provider: 'other' }],
        context(undefined, [model('active', 'fast')])
      )('fast'),
    /configured provider does not expose/
  );
  assert.throws(
    () =>
      createWorkflowProfileResolver(
        [profile],
        context(undefined, [model('active', 'fast')], [])
      )('fast'),
    /configured model is unavailable from its configured provider/
  );
  assert.throws(
    () =>
      createWorkflowProfileResolver(
        [profile],
        context(undefined, [model('active', 'fast', false)])
      )('fast'),
    /thinking level is unsupported/
  );
  assert.throws(
    () => createWorkflowProfileResolver([profile], { ...context(), model: undefined })('fast'),
    /no configured provider or active session model/
  );
  assert.deepEqual(
    createWorkflowProfileResolver([{ ...profile, provider: 'other' }], {
      ...context(undefined, [model('other', 'fast')]),
      model: undefined
    })('fast'),
    { model: model('other', 'fast'), thinkingLevel: 'high' }
  );
});
