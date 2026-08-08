import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, test } from 'vitest';
import { estimateTokensFromText } from '../src/jsonl.js';
import { claimGoalDone, createGoal } from '../src/state.js';
import {
  buildVerifierArgs,
  cleanupVerifierTempFiles,
  createVerifierTempFiles,
  resolveSourceModel,
  runVerifierSubprocess,
  type SpawnedProcess,
  type SpawnProcess,
  verifierTempFileModes
} from '../src/verifier.js';
import { buildVerifierTask, VERIFIER_SYSTEM_PROMPT } from '../src/verifier-prompt.js';
import { ids, MutableClock } from './helpers.js';

function verifyingGoal() {
  const clock = new MutableClock();
  const state = createGoal({ objective: 'Ship', branchAnchorId: 'leaf', ids: ids('goal'), clock });
  const result = claimGoalDone(state, clock, ids('claim', 'attempt'), {
    summary: 'done',
    evidence: 'proof'
  });
  return { clock, state: result.state, claim: result.claim };
}

describe('verifier subprocess helpers', () => {
  test('builds hardened verifier flags with same model and read-only tools', () => {
    const args = buildVerifierArgs({
      source: {
        cliModel: 'anthropic/sonnet',
        provider: 'anthropic',
        model: 'sonnet',
        thinking: 'high'
      },
      systemPromptPath: '/tmp/system.md',
      taskPath: '/tmp/task.md'
    });

    assert.deepEqual(args.slice(0, 3), ['--mode', 'json', '-p']);
    assert.equal(args.includes('--no-session'), true);
    assert.equal(args.includes('--no-extensions'), true);
    assert.equal(args.includes('--no-skills'), true);
    assert.equal(args.includes('--no-prompt-templates'), true);
    assert.equal(args.includes('--no-themes'), true);
    assert.equal(args.includes('--no-context-files'), true);
    assert.equal(args.includes('--no-approve'), true);
    assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls');
    assert.equal(args.includes('bash'), false);
    assert.equal(args.includes('edit'), false);
    assert.equal(args.includes('write'), false);
    assert.equal(args[args.indexOf('--model') + 1], 'anthropic/sonnet');
    assert.equal(args[args.indexOf('--thinking') + 1], 'high');
    assert.equal(args.at(-1), '@/tmp/task.md');
  });

  test('writes temp prompt/task files as 0600 and cleans them up', async () => {
    const { state, claim } = verifyingGoal();
    const files = await createVerifierTempFiles({
      state,
      claim,
      launchLeafId: 'leaf',
      cwd: '/repo'
    });

    assert.deepEqual(await verifierTempFileModes(files), [0o600, 0o600]);
    await cleanupVerifierTempFiles(files);
  });

  test('resolves same source model and thinking level', () => {
    const source = resolveSourceModel({ provider: 'p', id: 'model/with/slash' } as never, 'medium');

    assert.deepEqual(source, {
      cliModel: 'p/model/with/slash',
      provider: 'p',
      model: 'model/with/slash',
      thinking: 'medium'
    });
  });

  test('runs fake verifier process and parses strict report', async () => {
    const { state, claim, clock } = verifyingGoal();
    let captured: { command: string; args: string[]; cwd: string; shell: false } | undefined;
    const spawnProcess: SpawnProcess = (command, args, options) => {
      captured = { command, args, cwd: options.cwd, shell: options.shell };
      const proc = new FakeProcess();
      queueMicrotask(() => {
        proc.stdout.write(
          `${JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              provider: 'p',
              model: 'm',
              stopReason: 'stop',
              usage: {
                totalTokens: 10,
                input: 4,
                output: 6,
                cacheRead: 0,
                cacheWrite: 0,
                cost: {}
              },
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    goal_id: 'goal',
                    generation: 0,
                    claim_id: 'claim',
                    verifier_attempt_id: 'attempt',
                    verdict: 'pass',
                    rationale: 'ok',
                    evidence_reviewed: ['proof']
                  })
                }
              ]
            }
          })}\n`
        );
        proc.close(0);
      });
      return proc;
    };

    const result = await runVerifierSubprocess(
      {
        state,
        claim,
        launchLeafId: 'leaf',
        cwd: '/repo',
        source: { cliModel: 'p/m', provider: 'p', model: 'm', thinking: 'low' },
        remainingTimeMs: 10_000,
        signal: new AbortController().signal,
        clock
      },
      spawnProcess
    );

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.report.verdict : undefined, 'pass');
    assert.equal(result.usageTokens, 10);
    assert.equal(captured?.cwd, '/repo');
    assert.equal(captured?.shell, false);
    assert.equal(captured?.args.includes('--no-extensions'), true);
  });

  test('missing verifier usage includes prompt, task, and output estimates', async () => {
    const { state, claim, clock } = verifyingGoal();
    const reportText = JSON.stringify({
      goal_id: 'goal',
      generation: 0,
      claim_id: 'claim',
      verifier_attempt_id: 'attempt',
      verdict: 'pass',
      rationale: 'ok',
      evidence_reviewed: ['proof']
    });
    const spawnProcess: SpawnProcess = () => {
      const proc = new FakeProcess();
      queueMicrotask(() => {
        proc.stdout.write(
          `${JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              provider: 'p',
              model: 'm',
              stopReason: 'stop',
              content: [{ type: 'text', text: reportText }]
            }
          })}\n`
        );
        proc.close(0);
      });
      return proc;
    };

    const result = await runVerifierSubprocess(
      {
        state,
        claim,
        launchLeafId: 'leaf',
        cwd: '/repo',
        source: { cliModel: 'p/m', provider: 'p', model: 'm', thinking: 'low' },
        remainingTimeMs: 10_000,
        signal: new AbortController().signal,
        clock
      },
      spawnProcess
    );

    const promptAndTaskEstimate =
      estimateTokensFromText(VERIFIER_SYSTEM_PROMPT) +
      estimateTokensFromText(
        buildVerifierTask({ state, claim, launchLeafId: 'leaf', cwd: '/repo' })
      );
    assert.equal(result.ok, true);
    assert.equal(
      result.usageTokens >= promptAndTaskEstimate + estimateTokensFromText(reportText),
      true
    );
  });

  test('aborting verifier signal sends SIGTERM and returns invalidated result', async () => {
    const { state, claim, clock } = verifyingGoal();
    const controller = new AbortController();
    let proc: FakeProcess | undefined;
    let resolveSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      resolveSpawned = resolve;
    });
    const spawnProcess: SpawnProcess = () => {
      proc = new FakeProcess();
      resolveSpawned?.();
      return proc;
    };

    const resultPromise = runVerifierSubprocess(
      {
        state,
        claim,
        launchLeafId: 'leaf',
        cwd: '/repo',
        source: { cliModel: 'p/m', provider: 'p', model: 'm', thinking: 'low' },
        remainingTimeMs: 10_000,
        signal: controller.signal,
        clock
      },
      spawnProcess
    );

    await spawned;
    controller.abort();

    assert.equal(proc?.killed, true);
    assert.deepEqual(proc?.killSignals, ['SIGTERM']);

    proc?.close(0);
    const result = await resultPromise;

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.invalidated, true);
  });
});

class FakeProcess extends EventEmitter implements SpawnedProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  killSignals: Array<NodeJS.Signals | undefined> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    return true;
  }

  close(code: number): void {
    this.emit('close', code, null);
  }
}
