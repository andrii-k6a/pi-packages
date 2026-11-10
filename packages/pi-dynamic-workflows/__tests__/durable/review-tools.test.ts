import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type JsonObject,
  type TranscriptContext
} from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { Type } from 'typebox';
import { afterEach, beforeEach, test, vi } from 'vitest';
import {
  WorkflowHost,
  type WorkflowHostOptions,
  type WorkflowRunBinding
} from '../../src/durable/host.js';
import { agentBaseKey } from '../../src/durable/tasks/run.js';
import { resolveBuiltinWorkflow } from '../../src/workflow/builtins.js';

const exec = promisify(execFile);
const HEADER =
  "export const meta = { name: 'review_tools', description: 'Inspect without mutation' }\n";
let directory: string;
let cwd: string;
let faux: ReturnType<typeof fauxProvider>;
let hosts: WorkflowHost[];

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'workflow-review-tools-')));
  cwd = join(directory, 'project');
  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(join(cwd, 'dist'));
  await writeFile(
    join(cwd, 'src/service.ts'),
    'export function request(failed: boolean) {\n  if (failed) return "success";\n  return "success";\n}\n'
  );
  await writeFile(join(cwd, 'dist/generated.ts'), 'generated hidden\n');
  await writeFile(join(cwd, '.ignore'), 'src/ignored.ts\n');
  await writeFile(join(cwd, 'src/ignored.ts'), 'ignored source\n');
  await writeFile(join(cwd, 'binary'), Buffer.from([0, 1, 2]));
  await symlink(cwd, join(cwd, 'src/cycle'));
  faux = fauxProvider({ models: [{ id: 'default' }, { id: 'thorough' }] });
  hosts = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const host of hosts) await host.closeAll();
  await rm(directory, { recursive: true, force: true });
});

function textOf(content: unknown): string {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? '').join('')
      : '';
}

function respond(
  responder: (request: {
    prompt: string;
    results: Array<{ toolName: string; text: string; isError: boolean }>;
    context: TranscriptContext;
    signal?: AbortSignal;
  }) => AssistantMessage | Promise<AssistantMessage>
) {
  const step = (context: TranscriptContext, options?: { signal?: AbortSignal }) =>
    responder({
      context,
      prompt: textOf(context.messages.find((message) => message.role === 'user')?.content),
      results: context.messages.flatMap((message) =>
        message.role === 'toolResult'
          ? [
              {
                toolName: message.toolName,
                text: textOf(message.content),
                isError: message.isError
              }
            ]
          : []
      ),
      signal: options?.signal
    });
  faux.setResponses(Array.from({ length: 100 }, () => step));
}

function host(options: WorkflowHostOptions = {}) {
  const runs = new WorkflowHost({
    runsRoot: join(directory, 'runs'),
    watchIntervalMs: 5,
    ...options
  });
  hosts.push(runs);
  return runs;
}

function binding(): WorkflowRunBinding {
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    models,
    route: { provider: 'faux', modelId: 'default', thinkingLevel: 'off' },
    resolveProfile(name) {
      if (name !== 'thorough') throw new Error('profile not approved');
      return { provider: 'faux', modelId: 'thorough', thinkingLevel: 'off' };
    },
    promptContext: async () => ({ contextFiles: [], skills: '', append: '' })
  };
}

const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const text = (value: string) => fauxAssistantMessage([fauxText(value)]);

async function inspect(calls: Array<[string, JsonObject]>, options: WorkflowHostOptions = {}) {
  let results: Array<{ toolName: string; text: string; isError: boolean }> = [];
  respond((request) => {
    results = request.results;
    const next = calls[results.length];
    return next ? call(...next) : text('inspection finished');
  });
  const runs = host(options);
  const handle = await runs.start(
    { script: `${HEADER}return await agent('inspect fixture', { toolset: 'review' })`, cwd },
    binding()
  );
  const outcome = await handle.wait();
  await handle.close();
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.status === 'completed' && outcome.value, 'inspection finished');
  assert.equal(results.length, calls.length);
  return results;
}

test('real durable review agents can list, locate, search, and read without traversing generated output or symlink cycles', async () => {
  const results = await inspect([
    ['ls', { path: '.' }],
    ['find', { pattern: '*.ts' }],
    ['grep', { pattern: 'if (failed)', path: 'src', context: 1, literal: true }],
    ['read', { path: 'src/service.ts', offset: 2, limit: 1 }],
    ['read', { path: 'dist/generated.ts' }],
    ['find', { pattern: '*', path: 'dist/generated.ts' }],
    ['read', { path: 'binary' }],
    ['git_inspect', { operation: 'resolve' }]
  ]);
  assert.match(results[0].text, /"src"\//);
  assert.match(results[1].text, /src\/service.ts/);
  assert.doesNotMatch(results[1].text, /generated.ts|ignored.ts/);
  assert.match(results[2].text, /src\/service.ts.*:2:.*if \(failed\)/);
  assert.match(results[2].text, /src\/service.ts.*:1-/);
  assert.match(results[3].text, /if \(failed\)/);
  assert.doesNotMatch(results[3].text, /export function/);
  assert.match(results[4].text, /generated hidden/);
  assert.match(results[5].text, /dist\/generated.ts/);
  assert.equal(results[6].isError, true);
  assert.match(results[6].text, /Binary contents/);
  assert.equal(results[7].isError, true);
  assert.match(results[7].text, /Git\/history unavailable.*not a git repository/i);
});

test.each(['regular', 'symlink', 'missing'])(
  'read preserves Unicode spaces instead of selecting an ASCII-space %s counterpart',
  async (counterpart) => {
    const literal = 'src/a\u00a0b.ts';
    await writeFile(join(cwd, literal), 'literal file\nsecond line\n');
    const ascii = join(cwd, 'src/a b.ts');
    if (counterpart === 'regular') await writeFile(ascii, 'wrong file\n');
    if (counterpart === 'symlink') await symlink(join(cwd, 'src/service.ts'), ascii);
    const results = await inspect([
      ['read', { path: literal }],
      ['read', { path: `@${literal}`, offset: 2, limit: 1 }]
    ]);
    assert.equal(results[0].isError, false);
    assert.match(results[0].text, /literal file/);
    assert.doesNotMatch(results[0].text, /wrong file|function request/);
    assert.equal(results[1].isError, false);
    assert.match(results[1].text, /second line/);
    assert.doesNotMatch(results[1].text, /literal file/);
  }
);

test('read uses the opened no-follow file even if its path becomes a symlink', async () => {
  const selected = join(cwd, 'selected.ts');
  await writeFile(selected, 'selected file\n');
  let opens = 0;
  class ReplacingEnv extends NodeExecutionEnv {
    override async openBinaryReader(...args: Parameters<NodeExecutionEnv['openBinaryReader']>) {
      const reader = await super.openBinaryReader(...args);
      opens++;
      if (reader.ok && opens === 1) {
        await rename(selected, join(cwd, 'original.ts'));
        await symlink(join(cwd, 'src/service.ts'), selected);
      }
      return reader;
    }
  }
  const results = await inspect([['read', { path: 'selected.ts' }]], {
    env: () => new ReplacingEnv({ cwd })
  });
  assert.equal(results[0].isError, false);
  assert.match(results[0].text, /selected file/);
  assert.doesNotMatch(results[0].text, /function request/);
  assert.equal(opens, 1);
});

test('literal reads keep byte limits, UTF-8 boundaries, BOMs, and continuation honest', async () => {
  const maxBytes = 50 * 1024;
  const boundary = 'x'.repeat(maxBytes);
  await writeFile(join(cwd, 'boundary.txt'), `${boundary}\ntail\n`);
  await writeFile(join(cwd, 'split.txt'), `${'a'.repeat(maxBytes - 1)}éz\n`);
  await writeFile(join(cwd, 'bom.txt'), '\uFEFFfirst\n\uFEFFsecond\n');
  const results = await inspect([
    ['read', { path: 'boundary.txt' }],
    ['read', { path: 'boundary.txt', offset: 2, limit: 1 }],
    ['read', { path: 'split.txt' }],
    ['read', { path: 'bom.txt', limit: 1 }],
    ['read', { path: 'bom.txt', offset: 2, limit: 1 }]
  ]);
  assert.ok(results[0].text.startsWith(boundary));
  assert.match(results[0].text, /offset=2/);
  assert.ok(results[1].text.startsWith('tail'));
  assert.ok(results[2].text.startsWith('a'.repeat(maxBytes - 1)));
  assert.doesNotMatch(results[2].text, /\uFFFD/);
  assert.match(results[2].text, /prefix.*full line was not reviewed/);
  assert.ok(results[3].text.startsWith('first'));
  assert.ok(results[4].text.startsWith('\uFEFFsecond'));
});

test('empty-line pages advance the read offset even when the page contains no text', async () => {
  await writeFile(join(cwd, 'blank.txt'), '\nsecond\n');
  const results = await inspect([
    ['read', { path: 'blank.txt', limit: 1 }],
    ['read', { path: 'blank.txt', offset: 2, limit: 1 }]
  ]);
  assert.equal(results[0].isError, false);
  assert.match(results[0].text, /offset=2/);
  assert.ok(results[1].text.startsWith('second'));
});

test('tools make truncation and invalid inputs visible instead of reporting a clean empty search', async () => {
  await writeFile(join(cwd, 'src/second.ts'), 'second\n');
  await writeFile(join(cwd, 'long.txt'), 'x\n'.repeat(3000));
  const results = await inspect([
    ['ls', { path: 'src', limit: 1 }],
    ['ls', { path: 'src', limit: 1, offset: 1 }],
    ['find', { pattern: '*.ts', limit: 1 }],
    ['read', { path: 'long.txt' }],
    ['grep', { pattern: '[', path: 'src' }],
    ['read', { path: 'missing.ts' }]
  ]);
  assert.match(results[0].text, /truncated|offset=1/i);
  assert.notEqual(results[0].text, results[1].text);
  assert.match(results[2].text, /truncated|offset=1/i);
  assert.match(results[3].text, /offset=2001|Showing lines/);
  assert.equal(results[4].isError, true);
  assert.match(results[4].text, /regex|parse error/);
  assert.equal(results[5].isError, true);
});

async function largeFileListing() {
  const names = Array.from(
    { length: 750 },
    (_, index) => `file-${String(index).padStart(3, '0')}-${'x'.repeat(100)}.ts`
  );
  await mkdir(join(cwd, 'bulk'));
  for (let index = 0; index < names.length; index += 50) {
    await Promise.all(
      names.slice(index, index + 50).map((name) => writeFile(join(cwd, 'bulk', name), ''))
    );
  }
  return names.map((name) => `bulk/${name}`);
}

function foundPaths(output: string): string[] {
  return output
    .split('<harness>')[0]
    .split('\n')
    .filter((line) => line.startsWith('"'))
    .map((line) => JSON.parse(line));
}

test('filename filtering reaches matches beyond the raw listing capture limit', async () => {
  await largeFileListing();
  const listing = (await exec('rg', ['--no-config', '--files', '--null', '--', 'bulk'], { cwd }))
    .stdout;
  assert.ok(listing.length > 50_000);
  const target = listing.split('\0').filter(Boolean).at(-1) as string;
  const results = await inspect([
    ['find', { path: 'bulk', pattern: target.slice('bulk/'.length) }]
  ]);
  assert.equal(results[0].isError, false);
  assert.deepEqual(foundPaths(results[0].text), [target]);
});

test('filename pagination continues after retained output fills without skipping or losing files', async () => {
  const expected = await largeFileListing();
  const first = (await inspect([['find', { path: 'bulk', pattern: '*.ts', limit: 1000 }]]))[0];
  const firstPaths = foundPaths(first.text);
  assert.ok(firstPaths.length > 0 && firstPaths.length < expected.length);
  const second = (
    await inspect([
      ['find', { path: 'bulk', pattern: '*.ts', offset: firstPaths.length, limit: 1000 }]
    ])
  )[0];
  const paths = [...firstPaths, ...foundPaths(second.text)];
  assert.equal(paths.length, expected.length);
  assert.deepEqual(paths.sort(), expected);
  assert.match(first.text, new RegExp(`Use offset=${firstPaths.length}\\b`));
  assert.ok(Buffer.byteLength(first.text.split('<harness>')[0]) <= 50_000);
  assert.doesNotMatch(second.text, /Output truncated/);
});

test('Git inspection resolves commits and reads focused history, treating paths and revisions as data', async () => {
  await exec('git', ['init', '-q', cwd]);
  await exec('git', ['add', '.'], { cwd });
  await exec(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'base'
    ],
    { cwd }
  );
  const base = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  await writeFile(join(cwd, 'src/service.ts'), 'live edits are not history\n');
  const results = await inspect([
    ['git_inspect', { operation: 'resolve', revision: base }],
    [
      'git_inspect',
      { operation: 'show', revision: base, path: 'src/service.ts', offset: 2, limit: 1 }
    ],
    [
      'git_inspect',
      { operation: 'show', revision: base, path: 'src/service.ts', offset: 3, limit: 1 }
    ],
    ['git_inspect', { operation: 'log', revision: base, path: 'src/service.ts' }],
    [
      'git_inspect',
      { operation: 'blame', revision: base, path: 'src/service.ts', offset: 2, limit: 1 }
    ],
    ['git_inspect', { operation: 'resolve', revision: '--output=owned;$(touch owned)' }],
    ['git_inspect', { operation: 'show', revision: base, path: '../../outside' }],
    ['grep', { pattern: '--pre=touch owned;$(touch owned)', path: 'src', literal: true }],
    ['find', { pattern: '--exec=touch owned;$(touch owned)' }]
  ]);
  assert.equal(results[0].text.trim(), base);
  assert.match(results[1].text, /if \(failed\) return "success"/);
  assert.doesNotMatch(results[1].text, /live edits/);
  assert.match(results[2].text, /return "success"/);
  assert.match(results[3].text, new RegExp(`${base} base`));
  assert.match(results[4].text, /if \(failed\)/);
  assert.equal(results[5].isError, true);
  assert.equal(results[6].isError, true);
  assert.match(results[6].text, /inside the Git worktree/);
  assert.equal(results[7].isError, false);
  assert.equal(results[8].isError, false);
  await assert.rejects(readFile(join(cwd, 'owned')), /ENOENT/);
});

test('the supplied execution environment is used for exploration with no local-machine fallback', async () => {
  const remote = join(directory, 'remote');
  await mkdir(remote);
  await writeFile(join(remote, 'remote-only.ts'), 'REMOTE_EVIDENCE\n');
  const results = await inspect(
    [
      ['ls', {}],
      ['find', { pattern: '*.ts' }],
      ['grep', { pattern: 'REMOTE_EVIDENCE' }],
      ['read', { path: 'remote-only.ts' }],
      ['read', { path: 'src/service.ts' }]
    ],
    { env: () => new NodeExecutionEnv({ cwd: remote }) }
  );
  for (const result of results.slice(0, 4)) assert.equal(result.isError, false);
  assert.match(results[1].text, /remote-only.ts/);
  assert.match(results[3].text, /REMOTE_EVIDENCE/);
  assert.equal(results[4].isError, true, 'the local file must not be used as a fallback');
});

const candidate = {
  file: 'src/service.ts',
  line: 2,
  summary: 'Failure is returned as success',
  evidence: 'The failed branch returns success',
  priority: 2,
  scenario: 'A failed request is reported successful to its caller',
  alternative: '',
  references: [{ file: 'src/service.ts', line: 2, observation: 'failed returns success' }]
};

test.each([false, true])(
  'file mode verifies a pre-existing problem without Git (Git executable unavailable: %s)',
  async (withoutGit) => {
    if (withoutGit) vi.stubEnv('PATH', '');
    respond(({ prompt, results, context }) => {
      const system = context.messages
        .filter((message) => message.role === 'system')
        .map((message) => JSON.stringify(message))
        .join('\n');
      assert.doesNotMatch(system, /Use ls and find to orient/);
      if (!results.length) return call('read', { path: 'src/service.ts', offset: 1, limit: 4 });
      assert.match(results[0].text, /if \(failed\) return "success"/);
      const finding = prompt.includes('Responsibility: Behavior') ? [candidate] : [];
      return call(
        'structured_output',
        prompt.includes('Evaluate this candidate as a hypothesis')
          ? {
              ...candidate,
              verdict: 'CONFIRMED',
              reason: 'Static inspection confirms a pre-existing incorrect result',
              counterevidence: 'No guard changes the result',
              limitations: []
            }
          : { candidates: finding, limitations: [] }
      );
    });
    const args = { mode: 'files', path: 'src', profile: 'thorough' };
    const runs = host();
    const handle = await runs.start(
      { script: resolveBuiltinWorkflow('code-review', args), args, cwd },
      binding()
    );
    const outcome = await handle.wait();
    await handle.close();
    assert.equal(outcome.status, 'completed');
    if (outcome.status !== 'completed') return;
    const result = outcome.value as {
      findings: Array<{ verdict: string }>;
      scope: { mode: string };
      limitations: string[];
    };
    assert.equal(result.findings[0].verdict, 'CONFIRMED');
    assert.equal(result.scope.mode, 'files');
    assert.equal(outcome.agentCount, 4);
    for (const agent of outcome.snapshot.agents) {
      assert.equal(agent.profile, 'thorough');
      assert.equal(agent.model, 'faux/thorough');
    }
  }
);

test('missing or unsupported file-mode targets fail before model work, but supplied diffs need no Git', async () => {
  const runs = host();
  for (const path of ['missing', 'src/cycle']) {
    const args = { mode: 'files', path };
    await assert.rejects(
      runs.start({ script: resolveBuiltinWorkflow('code-review', args), args, cwd }, binding()),
      /Cannot inspect file-review target/
    );
  }
  assert.equal(faux.state.callCount, 0);
  assert.equal(runs.list().length, 0);
  respond(() => call('structured_output', { candidates: [], limitations: [] }));
  vi.stubEnv('PATH', '');
  const args = { diff: 'supplied change\n-old\n+new' };
  const handle = await runs.start(
    { script: resolveBuiltinWorkflow('code-review', args), args, cwd },
    binding()
  );
  assert.equal((await handle.wait()).status, 'completed');
  await handle.close();
});

test('review conversations reject mutation and inherited tools at execution time even with permissive host defaults', async () => {
  let extraCalls = 0;
  const extra = defineExtension({
    name: 'test.extra',
    tools: [
      defineTool({
        name: 'extra_execution',
        description: 'Forbidden extra',
        parameters: Type.Object({}),
        async execute() {
          extraCalls++;
          return { output: [] };
        }
      })
    ]
  });
  const results = await inspect(
    [
      ['write', { path: 'src/service.ts', content: 'mutated' }],
      ['edit', { path: 'src/service.ts', edits: [{ oldText: 'success', newText: 'mutated' }] }],
      ['bash', { command: 'touch owned' }],
      ['extra_execution', {}],
      ['mcp__server__mutate', {}]
    ],
    { extensions: [extra], settings: { extensions: [extra] } }
  );
  assert.equal(extraCalls, 0);
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.match(result.text, /not available/);
  }
  assert.match(await readFile(join(cwd, 'src/service.ts'), 'utf8'), /if \(failed\)/);
  await assert.rejects(readFile(join(cwd, 'owned')), /ENOENT/);
});

test('review restrictions survive restart of an already-created conversation', async () => {
  let reached!: () => void;
  const reachedGate = new Promise<void>((resolve) => {
    reached = resolve;
  });
  respond(async ({ results, signal }) => {
    if (!results.length) return call('read', { path: 'src/service.ts' });
    reached();
    return new Promise<AssistantMessage>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('closed')), { once: true });
    });
  });
  const script = `${HEADER}return await agent('inspect fixture', { label: 'review', toolset: 'review' })`;
  const first = host();
  const handle = await first.start({ script, cwd }, binding());
  await reachedGate;
  const prior = (await first.report(handle.runId)).attempts[0].agents;
  const conversationId = Object.values(prior)[0].conversationId;
  await first.closeAll();
  let rejected = false;
  respond(({ results }) => {
    if (!results.some((result) => result.toolName === 'bash'))
      return call('bash', { command: 'touch owned' });
    rejected = results.some(
      (result) => result.toolName === 'bash' && result.isError && /not available/.test(result.text)
    );
    return text('restricted after restart');
  });
  const second = host();
  const resumed = await second.resume(handle.runId, {}, binding());
  const outcome = await resumed.wait();
  await resumed.close();
  assert.equal(outcome.status, 'completed');
  assert.equal(rejected, true);
  assert.equal(outcome.snapshot.agents[0].conversationId, conversationId);
  await assert.rejects(readFile(join(cwd, 'owned')), /ENOENT/);
});

test.each([
  { abort: false, revoked: false },
  { abort: true, revoked: false },
  { abort: false, revoked: true },
  { abort: true, revoked: true }
])(
  'profiled review resume preserves route pins but enforces current approval ($abort, $revoked)',
  async ({ abort, revoked }) => {
    let verifierStarted!: () => void;
    const verifierGate = new Promise<void>((resolve) => {
      verifierStarted = resolve;
    });
    respond(async ({ prompt, signal }) => {
      if (prompt.includes('Responsibility:')) {
        return call('structured_output', {
          candidates: prompt.includes('Responsibility: Behavior') ? [candidate] : [],
          limitations: []
        });
      }
      verifierStarted();
      return new Promise<AssistantMessage>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('closed')), { once: true });
      });
    });
    const args = { mode: 'files', path: 'src', profile: 'thorough' };
    let providerOpens = 0;
    const providers = [
      {
        name: 'unused-provider',
        async open() {
          providerOpens++;
          return { extensions: [], notes: [], async close() {} };
        }
      }
    ];
    const first = host({ providers });
    const handle = await first.start(
      { script: resolveBuiltinWorkflow('code-review', args), args, cwd },
      binding()
    );
    await verifierGate;
    const before = await first.report(handle.runId);
    assert.equal(
      Object.values(before.attempts[0].agents).filter((agent) => agent.status === 'done').length,
      3
    );
    if (abort) {
      await handle.abort();
      assert.equal((await handle.wait()).status, 'aborted');
    }
    await first.closeAll();
    let newFinders = 0;
    respond(({ prompt }) => {
      if (prompt.includes('Responsibility:')) newFinders++;
      assert.match(prompt, /"mode":"files"/);
      return call('structured_output', {
        ...candidate,
        verdict: 'CONFIRMED',
        reason: 'Present incorrect result',
        counterevidence: 'No guard',
        limitations: []
      });
    });
    const second = host({ providers });
    const resumedBinding = binding();
    let approvalChecks = 0;
    resumedBinding.resolveProfile = (name, pinned) => {
      approvalChecks++;
      assert.equal(name, 'thorough');
      if (revoked) throw new Error('profile not approved');
      assert.deepEqual(pinned, { provider: 'faux', modelId: 'thorough', thinkingLevel: 'off' });
      return pinned;
    };
    if (revoked) {
      const calls = faux.state.callCount;
      await assert.rejects(second.resume(handle.runId, {}, resumedBinding), /profile not approved/);
      assert.equal(faux.state.callCount, calls);
      assert.equal((await second.report(handle.runId)).attempts.length, 1);
      assert.equal(providerOpens, 0);
      return;
    }
    const resumed = await second.resume(handle.runId, {}, resumedBinding);
    const outcome = await resumed.wait();
    await resumed.close();
    assert.equal(outcome.status, 'completed');
    assert.equal(newFinders, 0, 'completed discovery must not incur more model work');
    assert.ok(approvalChecks > 0);
    assert.equal(providerOpens, 0, 'fixed reviews must not acquire tools they cannot use');
    assert.equal(outcome.snapshot.agents.length, 4);
    for (const agent of outcome.snapshot.agents) {
      assert.equal(agent.profile, 'thorough');
      assert.equal(agent.model, 'faux/thorough');
    }
    const calls = faux.state.callCount;
    resumedBinding.resolveProfile = () => {
      throw new Error('profile revoked after completion');
    };
    const stored = await second.resume(handle.runId, {}, resumedBinding);
    assert.equal((await stored.wait()).status, 'completed');
    await stored.close();
    assert.equal(
      faux.state.callCount,
      calls,
      'stored-result retrieval must not revalidate profiles or spend'
    );
  }
);

test('provider acquisition is retained when replacing fixed and ordinary workflows', async () => {
  let opened = 0;
  let closed = 0;
  const runs = host({
    providers: [
      {
        name: 'ordinary-provider',
        async open() {
          opened++;
          return {
            extensions: [],
            notes: [],
            async close() {
              closed++;
            }
          };
        }
      }
    ]
  });
  respond(() => call('structured_output', { candidates: [], limitations: [] }));
  const args = { mode: 'files', path: 'src' };
  const script = resolveBuiltinWorkflow('code-review', args);
  const first = await runs.start({ script, args, cwd }, binding());
  assert.equal((await first.wait()).status, 'completed');
  await first.close();
  assert.equal(opened, 0);
  respond(() => text('ordinary result'));
  const ordinary = await runs.resume(
    first.runId,
    { script: `${HEADER}return await agent('ordinary work')` },
    binding()
  );
  assert.equal((await ordinary.wait()).status, 'completed');
  await ordinary.close();
  assert.equal(opened, 1);
  respond(() => call('structured_output', { candidates: [], limitations: [] }));
  const review = await runs.resume(first.runId, { script, args }, binding());
  assert.equal((await review.wait()).status, 'completed');
  await review.close();
  assert.equal(opened, 2, 'replacement must still restore prior ordinary capabilities');
  assert.equal(closed, opened);
});

test.each(['files', 'changes'] as const)(
  'finder and verifier paths, text, and duplicate IDs are corrected in %s mode',
  async (mode) => {
    const finding = {
      file: 'src/service.ts',
      line: 1,
      summary: 'A supported issue',
      evidence: 'Evidence',
      priority: 2,
      scenario: 'Scenario',
      alternative: '',
      references: [{ file: 'src/service.ts', line: 1, observation: 'Observation' }]
    };
    let finderCorrections = 0;
    let verifierCorrections = 0;
    respond(({ prompt, results }) => {
      const verifier = prompt.startsWith('# Verify one candidate');
      if (!verifier) {
        if (results.length === 0)
          return call('structured_output', {
            candidates: [
              {
                ...finding,
                references: [
                  {
                    ...finding.references[0],
                    file: mode === 'files' ? '/absolute.ts' : '../outside.ts'
                  }
                ]
              }
            ],
            limitations: []
          });
        assert.equal(results[0].isError, true);
        finderCorrections++;
        return call('structured_output', { candidates: [finding], limitations: [] });
      }
      const verdict = {
        ...finding,
        verdict: 'CONFIRMED',
        reason: 'Verified',
        counterevidence: '',
        limitations: []
      };
      if (results.length === 0)
        return call('structured_output', { ...verdict, duplicateOf: 'candidate-01' });
      assert.equal(results.at(-1)?.isError, true);
      verifierCorrections++;
      if (results.length === 1) return call('structured_output', { ...verdict, reason: '   ' });
      if (results.length === 2)
        return call('structured_output', {
          ...verdict,
          file: mode === 'files' ? '/absolute.ts' : '../outside.ts'
        });
      return call('structured_output', verdict);
    });
    const runs = host();
    const args = mode === 'files' ? { mode, path: 'src' } : { mode, diff: 'captured change' };
    const handle = await runs.start(
      { script: resolveBuiltinWorkflow('code-review', args), args, cwd },
      binding()
    );
    assert.equal((await handle.wait()).status, 'completed');
    await handle.close();
    assert.equal(finderCorrections, 3);
    assert.equal(verifierCorrections, 3);
    const attempts = (await runs.report(handle.runId)).attempts;
    assert.ok(Object.values(attempts[0].agents).every((row) => row.status === 'done'));
  }
);

test.each(['custom_review', 'code_review'])(
  'custom workflow %s retains its own output contract',
  async (name) => {
    const schema = Type.Object({
      candidates: Type.Array(
        Type.Object({
          file: Type.String(),
          line: Type.Integer(),
          summary: Type.String(),
          evidence: Type.String(),
          priority: Type.Integer(),
          scenario: Type.String(),
          alternative: Type.String(),
          references: Type.Array(Type.String())
        })
      ),
      limitations: Type.Array(Type.String())
    });
    const output = {
      candidates: [
        {
          file: '/absolute-is-valid-here',
          line: 0,
          summary: '',
          evidence: '',
          priority: 0,
          scenario: '',
          alternative: '',
          references: []
        }
      ],
      limitations: []
    };
    respond(() => call('structured_output', output));
    const runs = host();
    const handle = await runs.start(
      {
        cwd,
        script: `export const meta = { name: '${name}', description: 'Custom output contract' }\nreturn await agent('custom review', { toolset: 'review', schema: ${JSON.stringify(schema)} })`
      },
      binding()
    );
    const outcome = await handle.wait();
    assert.equal(outcome.status, 'completed');
    if (outcome.status === 'completed') assert.deepEqual(outcome.value, output);
    await handle.close();
  }
);

test('uncorrected review output fails closed and is not reused as successful work', async () => {
  respond(({ results }) =>
    results.length
      ? text('I cannot supply valid structured output.')
      : call('structured_output', { candidates: [], limitations: ['   '] })
  );
  const runs = host();
  const args = { mode: 'files', path: 'src' };
  const handle = await runs.start(
    { script: resolveBuiltinWorkflow('code-review', args), args, cwd },
    binding()
  );
  assert.equal((await handle.wait()).status, 'failed');
  await handle.close();
  const failed = (await runs.report(handle.runId)).attempts[0];
  assert.ok(Object.values(failed.agents).every((row) => row.status === 'error'));
  const calls = faux.state.callCount;
  respond(() => call('structured_output', { candidates: [], limitations: [] }));
  const resumed = await runs.resume(handle.runId, {}, binding());
  assert.equal((await resumed.wait()).status, 'completed');
  await resumed.close();
  assert.equal(faux.state.callCount - calls, 3);
});

test('review semantic errors are corrected before success is cached', async () => {
  let corrections = 0;
  respond(({ results }) => {
    if (results.some((result) => result.isError)) {
      corrections++;
      return call('structured_output', { candidates: [], limitations: [] });
    }
    return call('structured_output', {
      candidates: [
        {
          file: '/absolute.ts',
          line: 1,
          summary: '   ',
          evidence: 'Evidence',
          priority: 2,
          scenario: 'Scenario',
          alternative: '',
          references: [{ file: 'src/service.ts', line: 1, observation: 'Observation' }]
        }
      ],
      limitations: []
    });
  });
  const runs = host();
  const args = { mode: 'files', path: 'src' };
  const handle = await runs.start(
    { script: resolveBuiltinWorkflow('code-review', args), args, cwd },
    binding()
  );
  assert.equal((await handle.wait()).status, 'completed');
  await handle.close();
  assert.equal(corrections, 3);
  respond(() => {
    throw new Error('stored report must not call a provider');
  });
  const resumed = await runs.resume(handle.runId, {}, binding());
  assert.equal((await resumed.wait()).status, 'completed');
  await resumed.close();
});

test('unavailable rg and Git remain explicit tool limitations without disabling native listing and reads', async () => {
  vi.stubEnv('PATH', '');
  const results = await inspect([
    ['ls', { path: 'src' }],
    ['read', { path: 'src/service.ts' }],
    ['find', { pattern: '*.ts' }],
    ['grep', { pattern: 'failed' }],
    ['git_inspect', { operation: 'resolve' }]
  ]);
  assert.equal(results[0].isError, false);
  assert.equal(results[1].isError, false);
  for (const result of results.slice(2)) {
    assert.equal(result.isError, true);
    assert.match(result.text, /unavailable in this execution environment/);
  }
});

test('restricted calls cannot reuse completed unrestricted calls, while ordinary workflows still edit', async () => {
  const runs = host();
  respond(({ results }) =>
    results.length
      ? text('ordinary edit complete')
      : call('write', { path: 'ordinary.txt', content: 'ordinary tools retained' })
  );
  const firstScript = `${HEADER}await agent('same task', { label: 'same' }); throw new Error('retry')`;
  const first = await runs.start({ script: firstScript, cwd }, binding());
  assert.equal((await first.wait()).status, 'failed');
  await first.close();
  assert.equal(await readFile(join(cwd, 'ordinary.txt'), 'utf8'), 'ordinary tools retained');
  const count = faux.state.callCount;
  respond(() => text('new restricted result'));
  const resumed = await runs.resume(
    first.runId,
    {
      script: `${HEADER}return await agent('same task', { label: 'same', toolset: 'review' })`
    },
    binding()
  );
  const outcome = await resumed.wait();
  await resumed.close();
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.status === 'completed' && outcome.value, 'new restricted result');
  assert.equal(faux.state.callCount, count + 1);
  assert.notEqual(
    agentBaseKey('same', {}, undefined),
    agentBaseKey('same', { toolset: 'review' }, undefined)
  );
  assert.equal(
    agentBaseKey('same', {}, undefined),
    agentBaseKey('same', { toolset: undefined }, undefined)
  );
});
