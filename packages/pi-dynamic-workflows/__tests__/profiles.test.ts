import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import { test } from 'vitest';
import {
  createWorkflowProfileResolver,
  loadWorkflowProfiles,
  saveWorkflowProfiles,
  type WorkflowProfileResolverContext
} from '../src/profiles.js';

function model(provider: string, id: string, reasoning = true): Model<Api> {
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
  } as Model<Api>;
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
    },
    scopedModels: []
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
    ],
    [
      JSON.stringify({
        profiles: [
          {
            name: 'fast\u001b]8;;https://example.test\u0007',
            description: 'desc',
            model: 'model',
            thinkingLevel: 'low'
          }
        ]
      }),
      /terminal control characters/
    ],
    [
      JSON.stringify({
        profiles: [
          {
            name: 'fast',
            description: 'desc\u009d0;title\u009c',
            provider: 'provider',
            model: 'model',
            thinkingLevel: 'low'
          }
        ]
      }),
      /terminal control characters/
    ],
    [
      JSON.stringify({
        profiles: [
          {
            name: 'fast',
            description: 'desc',
            provider: 'provider\u0000',
            model: 'model',
            thinkingLevel: 'low'
          }
        ]
      }),
      /terminal control characters/
    ],
    [
      JSON.stringify({
        profiles: [
          {
            name: 'fast',
            description: 'desc',
            provider: 'provider',
            model: 'model\u007f',
            thinkingLevel: 'low'
          }
        ]
      }),
      /terminal control characters/
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

test('profile configuration errors sanitize and bound unknown keys', () => {
  const unknownKey = `unknown\u001b]8;;https://example.test\u0007${'x'.repeat(500)}`;
  const directory = temporaryConfig(JSON.stringify({ profiles: [], [unknownKey]: true }));

  try {
    assert.throws(
      () => loadWorkflowProfiles(directory),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /\p{Cc}/u);
        assert.match(error.message, /unknown key "unknown]8;;https:\/\/example\.testx+…"/);
        assert.ok([...error.message].length < 500);
        return true;
      }
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('saveWorkflowProfiles creates its missing directory and validates before replacing configuration', () => {
  const directory = temporaryConfig();
  const profile = {
    name: 'fast',
    description: 'Quick repository triage',
    model: 'fast-model',
    thinkingLevel: 'low' as const
  };
  const parsedProfile = { ...profile, provider: undefined };

  try {
    assert.deepEqual(saveWorkflowProfiles([profile], directory), [parsedProfile]);
    assert.equal(
      readFileSync(join(directory, 'pi-dynamic-workflows', 'profiles.json'), 'utf8'),
      `${JSON.stringify({ profiles: [profile] }, null, 2)}\n`
    );
    assert.deepEqual(loadWorkflowProfiles(directory), [parsedProfile]);

    assert.throws(
      () => saveWorkflowProfiles([{ ...profile, name: '' }], directory),
      /non-empty string/
    );
    assert.deepEqual(loadWorkflowProfiles(directory), [parsedProfile]);
  } finally {
    rmSync(directory, { recursive: true });
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

test('profile resolver preserves unrestricted routing without a session model scope', () => {
  const target = model('other', 'fast');
  const profile = {
    name: 'fast',
    description: 'Quick',
    provider: 'other',
    model: 'fast',
    thinkingLevel: 'low' as const
  };

  assert.deepEqual(createWorkflowProfileResolver([profile], context(undefined, [target]))('fast'), {
    model: target,
    thinkingLevel: 'low'
  });
});

test('profile resolver rejects persisted profiles outside a session model scope', () => {
  const scoped = model('active', 'allowed');
  const outsideScope = model('other', 'fast');
  const profile = {
    name: 'fast',
    description: 'Quick',
    provider: 'other',
    model: 'fast',
    thinkingLevel: 'low' as const
  };

  assert.throws(
    () =>
      createWorkflowProfileResolver([profile], {
        ...context(undefined, [scoped, outsideScope]),
        scopedModels: [{ model: scoped }]
      })('fast'),
    /outside the session model scope/
  );
});

test('profile resolver enforces a session-scoped thinking level pin', () => {
  const target = model('other', 'fast');
  const profile = {
    name: 'fast',
    description: 'Quick',
    provider: 'other',
    model: 'fast',
    thinkingLevel: 'high' as const
  };
  const resolverContext = {
    ...context(undefined, [target]),
    scopedModels: [{ model: target, thinkingLevel: 'low' as const }]
  };

  assert.throws(
    () => createWorkflowProfileResolver([profile], resolverContext)('fast'),
    /does not match the session-scoped model pin/
  );
  assert.deepEqual(
    createWorkflowProfileResolver([{ ...profile, thinkingLevel: 'low' }], resolverContext)('fast'),
    { model: target, thinkingLevel: 'low' }
  );
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
