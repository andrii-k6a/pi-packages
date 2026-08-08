import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';
import { describe, test } from 'vitest';
import { GOAL_CONTINUATION_MESSAGE } from '../src/continuation.js';
import { type GoalExtensionOptions, registerGoalExtension } from '../src/goal.js';
import { estimateTokensFromModelPayload, estimateTokensFromText } from '../src/jsonl.js';
import { STATE_ENTRY, VERIFICATION_ENTRY } from '../src/persistence.js';
import { TEXT_LIMITS } from '../src/sanitize.js';
import type { GoalState } from '../src/state.js';
import { GOAL_WIDGET_KEY } from '../src/ui.js';
import type { VerifierRunInput, VerifierRunResult } from '../src/verifier.js';
import { ids, MutableClock } from './helpers.js';

type CommandHandler = (args: string, ctx: ReturnType<typeof fakeCtx>) => Promise<void>;
type EventHandler = (event: unknown, ctx: ReturnType<typeof fakeCtx>) => unknown;
type ToolDefinition = {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ReturnType<typeof fakeCtx>
  ): Promise<{ terminate?: boolean; details?: { state?: GoalState } }>;
};

type VerificationClaimIds = Pick<
  NonNullable<GoalState['pendingClaim']>,
  'goal_id' | 'generation' | 'claim_id' | 'verifier_attempt_id'
>;

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text
};

type TestEntryRenderer = (
  entry: { data: unknown },
  options: { expanded: boolean },
  theme: typeof plainTheme
) =>
  | {
      render(width: number): string[];
    }
  | undefined;

describe('pi-goal extension integration', () => {
  test('/goal creates persisted active goal and queues continuation', async () => {
    const clock = new MutableClock();
    const harness = createHarness({ ids: ids('goal', 'dispatch'), clock });
    registerGoalExtension(harness.pi as never, harness.options);

    await harness.commands.goal('Ship it', fakeCtx({ branch: [{ id: 'leaf' }], hasUI: false }));

    const state = latestState(harness.appended);
    assert.equal(state?.status, 'active');
    assert.equal(state?.objective, 'Ship it');
    assert.equal(state?.tokenBudget, 10_000_000);
    assert.equal(harness.sent.length, 1);
  });

  test('/goal --tokens overrides configured defaults', async () => {
    const clock = new MutableClock();
    const harness = createHarness({
      ids: ids('goal', 'dispatch'),
      clock,
      defaultTokenBudget: '1M'
    });
    registerGoalExtension(harness.pi as never, harness.options);

    await harness.commands.goal(
      '--tokens 50k Ship it',
      fakeCtx({ branch: [{ id: 'leaf' }], hasUI: false })
    );

    const state = latestState(harness.appended);
    assert.equal(state?.objective, 'Ship it');
    assert.equal(state?.tokenBudget, 50_000);
  });

  test('/goal uses option, environment, and project config token defaults', async () => {
    const originalEnv = process.env.PI_GOAL_TOKEN_BUDGET;
    try {
      const optionClock = new MutableClock();
      const optionHarness = createHarness({
        ids: ids('option-goal', 'option-dispatch'),
        clock: optionClock,
        defaultTokenBudget: '1M'
      });
      registerGoalExtension(optionHarness.pi as never, optionHarness.options);
      await optionHarness.commands.goal(
        'Option default',
        fakeCtx({ branch: [{ id: 'leaf' }], hasUI: false })
      );
      assert.equal(latestState(optionHarness.appended)?.tokenBudget, 1_000_000);

      process.env.PI_GOAL_TOKEN_BUDGET = '100k';
      const envClock = new MutableClock();
      const envHarness = createHarness({ ids: ids('env-goal', 'env-dispatch'), clock: envClock });
      registerGoalExtension(envHarness.pi as never, envHarness.options);
      await envHarness.commands.goal(
        'Env default',
        fakeCtx({ branch: [{ id: 'leaf' }], hasUI: false })
      );
      assert.equal(latestState(envHarness.appended)?.tokenBudget, 100_000);

      delete process.env.PI_GOAL_TOKEN_BUDGET;
      const cwd = makeProjectConfig({ defaultTokenBudget: '10M' });
      try {
        const configClock = new MutableClock();
        const configHarness = createHarness({
          ids: ids('config-goal', 'config-dispatch'),
          clock: configClock
        });
        registerGoalExtension(configHarness.pi as never, configHarness.options);
        await configHarness.commands.goal(
          'Config default',
          fakeCtx({ branch: [{ id: 'leaf' }], hasUI: false, cwd })
        );
        assert.equal(latestState(configHarness.appended)?.tokenBudget, 10_000_000);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      if (originalEnv === undefined) delete process.env.PI_GOAL_TOKEN_BUDGET;
      else process.env.PI_GOAL_TOKEN_BUDGET = originalEnv;
    }
  });

  test('agent_settled keeps sent continuation queued until matching agent_start', async () => {
    const clock = new MutableClock();
    const harness = createHarness({ ids: ids('goal', 'dispatch-1', 'dispatch-2'), clock });
    registerGoalExtension(harness.pi as never, harness.options);
    const ctx = fakeCtx({ branch: [{ id: 'leaf' }], hasUI: false });

    await harness.commands.goal('Continue safely', ctx);

    assert.equal(harness.sent.length, 1);
    const first = harness.sent[0] as {
      customType?: string;
      display?: boolean;
      details?: Record<string, unknown>;
    };
    assert.equal(first.customType, GOAL_CONTINUATION_MESSAGE);
    assert.equal(first.display, false);
    assert.equal(first.details?.dispatch_id, 'dispatch-1');

    harness.emit('agent_settled', {}, ctx);

    assert.equal(harness.sent.length, 1);

    harness.emit('agent_start', {}, ctx);
    harness.emit('agent_settled', {}, ctx);

    assert.equal(harness.sent.length, 2);
    const second = harness.sent[1] as { details?: Record<string, unknown> };
    assert.equal(second.details?.dispatch_id, 'dispatch-2');
  });

  test('/goal refuses replacement without UI', async () => {
    const clock = new MutableClock();
    const harness = createHarness({ ids: ids('goal', 'dispatch'), clock });
    registerGoalExtension(harness.pi as never, harness.options);
    const ctx = fakeCtx({ branch: [{ id: 'leaf' }], hasUI: false });

    await harness.commands.goal('First', ctx);
    await harness.commands.goal('Second', ctx);

    assert.equal(latestState(harness.appended)?.objective, 'First');
  });

  test('/goal confirms replacement before resolving invalid default budget', async () => {
    const originalEnv = process.env.PI_GOAL_TOKEN_BUDGET;
    try {
      process.env.PI_GOAL_TOKEN_BUDGET = 'invalid';
      const clock = new MutableClock();
      const harness = createHarness({ ids: ids('goal', 'dispatch'), clock });
      registerGoalExtension(harness.pi as never, harness.options);
      let confirmCalls = 0;
      const ctx = fakeCtx({
        branch: [{ id: 'leaf' }],
        hasUI: true,
        confirm: async () => {
          confirmCalls += 1;
          return false;
        }
      });

      await harness.commands.goal('--tokens 50k First', ctx);
      await harness.commands.goal('Second', ctx);

      assert.equal(confirmCalls, 1);
      assert.equal(latestState(harness.appended)?.objective, 'First');
      assert.doesNotMatch(ctx.notifications.at(-1)?.message ?? '', /Invalid PI_GOAL_TOKEN_BUDGET/);
    } finally {
      if (originalEnv === undefined) delete process.env.PI_GOAL_TOKEN_BUDGET;
      else process.env.PI_GOAL_TOKEN_BUDGET = originalEnv;
    }
  });

  test('/goal rejects oversized replacement before UI confirmation', async () => {
    const clock = new MutableClock();
    const harness = createHarness({ ids: ids('goal', 'dispatch'), clock });
    registerGoalExtension(harness.pi as never, harness.options);
    let confirmCalls = 0;
    const ctx = fakeCtx({
      branch: [{ id: 'leaf' }],
      hasUI: true,
      confirm: async () => {
        confirmCalls += 1;
        return true;
      }
    });

    await harness.commands.goal('First', ctx);
    await harness.commands.goal('x'.repeat(TEXT_LIMITS.objective + 1), ctx);

    assert.equal(confirmCalls, 0);
    assert.equal(latestState(harness.appended)?.objective, 'First');
    assert.equal(
      ctx.notifications.at(-1)?.message,
      `Goal objective must be at most ${TEXT_LIMITS.objective} characters.`
    );
    assert.equal(ctx.notifications.at(-1)?.type, 'error');
  });

  test('session_start pauses restored active goal', () => {
    const clock = new MutableClock();
    const harness = createHarness({ ids: ids('goal'), clock });
    registerGoalExtension(harness.pi as never, harness.options);
    const active: GoalState = {
      version: 1,
      id: 'goal',
      generation: 0,
      branchAnchorId: 'leaf',
      objective: 'Restore me',
      status: 'active',
      createdAt: clock.nowIso(),
      updatedAt: clock.nowIso(),
      tokensUsed: 0,
      tokenBudget: 100_000,
      elapsedActiveMs: 0,
      timeBudgetMs: 3_600_000,
      activeStartedAt: clock.nowIso()
    };
    const ctx = fakeCtx({
      branch: [{ type: 'custom', customType: STATE_ENTRY, data: { state: active }, id: 'leaf' }],
      hasUI: true
    });

    harness.emit('session_start', { reason: 'startup' }, ctx);

    const restored = latestState(harness.appended);
    assert.equal(restored?.status, 'paused');
    assert.equal(restored?.pauseReason, 'reload');
  });

  test('restored verifying goal archives interruption when paused for reload or branch', () => {
    for (const scenario of [
      { eventName: 'session_start', event: { reason: 'startup' }, reason: 'reload' },
      { eventName: 'session_tree', event: {}, reason: 'branch' }
    ] as const) {
      const clock = new MutableClock();
      const harness = createHarness({ ids: ids('goal'), clock });
      registerGoalExtension(harness.pi as never, harness.options);
      const { state, claim } = restoredVerifyingGoal(clock);
      const ctx = fakeCtx({
        branch: [{ type: 'custom', customType: STATE_ENTRY, data: { state }, id: 'leaf' }],
        hasUI: true
      });

      harness.emit(scenario.eventName, scenario.event, ctx);

      const restored = latestState(harness.appended);
      assert.equal(restored?.status, 'paused');
      assert.equal(restored?.pauseReason, scenario.reason);
      assert.equal(restored?.pendingClaim, undefined);
      assert.equal(restored?.generation, 1);
      const records = verificationRecords(harness.appended);
      assert.equal(records.length, 1);
      assertInterruptedVerification(records[0], claim, scenario.reason);
    }
  });

  test('clear confirmation refuses to clear if goal changed while waiting', async () => {
    const clock = new MutableClock();
    const harness = createHarness({ ids: ids('goal', 'dispatch'), clock });
    registerGoalExtension(harness.pi as never, harness.options);
    let resolveConfirm: ((value: boolean) => void) | undefined;
    const ctx = fakeCtx({
      branch: [{ id: 'leaf' }],
      hasUI: true,
      confirm: () =>
        new Promise<boolean>((resolve) => {
          resolveConfirm = resolve;
        })
    });

    await harness.commands.goal('First', ctx);
    const clearPromise = harness.commands.goal('clear', ctx);
    await harness.commands.goal('pause', fakeCtx({ branch: [{ id: 'leaf' }], hasUI: false }));
    resolveConfirm?.(true);
    await clearPromise;

    assert.equal(latestState(harness.appended)?.status, 'paused');
    assert.match(ctx.notifications.at(-1)?.message ?? '', /changed/);
  });

  test('tool output without nested usage is not charged to the goal budget', async () => {
    const clock = new MutableClock();
    const harness = createHarness({ ids: ids('goal', 'dispatch'), clock });
    registerGoalExtension(harness.pi as never, harness.options);
    const ctx = fakeCtx({ branch: [{ id: 'leaf' }], hasUI: false });

    await harness.commands.goal('Read a large file', ctx);
    harness.emit('agent_start', {}, ctx);
    harness.emit(
      'tool_result',
      {
        toolName: 'read',
        toolCallId: 'tool',
        input: {},
        content: [{ type: 'text', text: 'x'.repeat(400_000) }],
        isError: false
      },
      ctx
    );

    const state = latestState(harness.appended);
    assert.equal(state?.status, 'active');
    assert.equal(state?.tokensUsed, 0);
  });

  test('tool result accounts only explicit nested usage metadata', async () => {
    const clock = new MutableClock();
    const harness = createHarness({ ids: ids('goal', 'dispatch'), clock });
    registerGoalExtension(harness.pi as never, harness.options);
    const ctx = fakeCtx({ branch: [{ id: 'leaf' }], hasUI: false });

    await harness.commands.goal('Use a nested-model tool', ctx);
    harness.emit('agent_start', {}, ctx);
    harness.emit(
      'tool_result',
      {
        toolName: 'custom_llm_tool',
        toolCallId: 'tool',
        input: {},
        content: [{ type: 'text', text: 'x'.repeat(10_000) }],
        isError: false,
        usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 0, cost: {} }
      },
      ctx
    );

    const state = latestState(harness.appended);
    assert.equal(state?.status, 'active');
    assert.equal(state?.tokensUsed, 10);
  });

  test('missing executor usage falls back to provider payload and assistant output', async () => {
    const clock = new MutableClock();
    const harness = createHarness({ ids: ids('goal', 'dispatch'), clock });
    registerGoalExtension(harness.pi as never, harness.options);
    const ctx = fakeCtx({ branch: [{ id: 'leaf' }], hasUI: false });
    const payload = {
      system: 'executor system context',
      messages: [{ content: [{ type: 'text', text: 'user goal context' }] }]
    };
    const output = 'assistant response without usage metadata';

    await harness.commands.goal('Account missing usage', ctx);
    harness.emit('agent_start', {}, ctx);
    harness.emit('before_provider_request', { payload }, ctx);
    harness.emit(
      'message_end',
      {
        message: {
          role: 'assistant',
          usage: { totalTokens: 0 },
          content: [{ type: 'text', text: output }]
        }
      },
      ctx
    );

    const state = latestState(harness.appended);
    assert.equal(state?.status, 'active');
    assert.equal(
      state?.tokensUsed,
      estimateTokensFromModelPayload(payload) + estimateTokensFromText(output)
    );
  });

  test('token budget exhaustion aborts the active executor run', async () => {
    const clock = new MutableClock();
    const harness = createHarness({
      ids: ids('goal', 'dispatch'),
      clock,
      defaultTokenBudget: 100_000
    });
    registerGoalExtension(harness.pi as never, harness.options);
    const ctx = fakeCtx({ branch: [{ id: 'leaf' }], hasUI: true });

    await harness.commands.goal('Stop on budget', ctx);
    harness.emit('agent_start', {}, ctx);
    harness.emit(
      'message_end',
      {
        message: {
          role: 'assistant',
          usage: { totalTokens: 100_001 },
          content: []
        }
      },
      ctx
    );

    const latest = latestState(harness.appended);
    assert.equal(latest?.status, 'budget_limited');
    assert.equal(latest?.budgetReason, 'tokens');
    assert.equal(ctx.abortCalls, 1);
  });

  test('valid claim launches verifier after settlement and pass completes', async () => {
    const clock = new MutableClock();
    const harness = createHarness({
      ids: ids('goal', 'dispatch', 'claim', 'attempt'),
      clock,
      runVerifier: async () => ({
        ok: true,
        usageTokens: 7,
        diagnostics: [],
        report: {
          goal_id: 'goal',
          generation: 0,
          claim_id: 'claim',
          verifier_attempt_id: 'attempt',
          verdict: 'pass',
          rationale: 'evidence supports completion',
          evidence_reviewed: ['proof'],
          createdAt: clock.nowIso()
        }
      })
    });
    registerGoalExtension(harness.pi as never, harness.options);
    const ctx = fakeCtx({ branch: [{ id: 'leaf' }], hasUI: true });

    await harness.commands.goal('Finish task', ctx);
    await harness.tools.pi_goal_claim_done.execute(
      'tool',
      { goal_id: 'goal', generation: 0, summary: 'done', evidence: 'proof' },
      undefined,
      undefined,
      ctx
    );
    harness.emit('agent_settled', {}, ctx);
    await new Promise((resolve) => setImmediate(resolve));

    const completed = latestState(harness.appended);
    assert.equal(completed?.status, 'complete');
    assert.equal(completed?.tokensUsed, 7);
    assert.equal(verificationRecords(harness.appended).at(-1)?.claim_summary, 'done');
  });

  test('verifier progress and final result are visible in the goal widget', async () => {
    const clock = new MutableClock();
    const verifier = createDeferredVerifier();
    const harness = createHarness({
      ids: ids('goal', 'dispatch', 'claim', 'attempt'),
      clock,
      runVerifier: verifier.runVerifier
    });
    registerGoalExtension(harness.pi as never, harness.options);
    const ctx = fakeCtx({ branch: [{ id: 'leaf' }], hasUI: true });

    await harness.commands.goal('Finish task', ctx);
    await harness.tools.pi_goal_claim_done.execute(
      'tool',
      { goal_id: 'goal', generation: 0, summary: 'done', evidence: 'proof' },
      undefined,
      undefined,
      ctx
    );
    harness.emit('agent_settled', {}, ctx);

    assert.equal(verifier.calls.length, 1);
    const progressWidget = ctx.widgets.get(GOAL_WIDGET_KEY)?.join('\n') ?? '';
    assert.match(progressWidget, /Verifying goal/);
    assert.match(progressWidget, /Claim: done/);
    assert.match(progressWidget, /Verifier: running/);
    assert.match(ctx.notifications.at(-1)?.message ?? '', /Verifier started/);

    verifier.resolve(verifierPass(clock));
    await settleAsync();

    const finalWidget = ctx.widgets.get(GOAL_WIDGET_KEY)?.join('\n') ?? '';
    assert.match(finalWidget, /Goal complete/);
    assert.match(finalWidget, /Summary: done/);
    assert.match(finalWidget, /Verifier: evidence supports completion/);
    assert.match(ctx.notifications.at(-1)?.message ?? '', /Goal complete: done/);
  });

  test('verification entry renderer includes final summary and verifier rationale', () => {
    const clock = new MutableClock();
    const harness = createHarness({ ids: ids('goal'), clock });
    registerGoalExtension(harness.pi as never, harness.options);
    const renderer = harness.entryRenderers.get(VERIFICATION_ENTRY) as
      | TestEntryRenderer
      | undefined;

    const pass = verifierPass(clock);
    const rendered = renderer?.(
      {
        data: {
          goal_id: 'goal',
          generation: 0,
          claim_id: 'claim',
          verifier_attempt_id: 'attempt',
          ok: true,
          usageTokens: 7,
          diagnostics: [],
          claim_summary: 'done',
          report: pass.ok ? pass.report : undefined
        }
      },
      { expanded: false },
      plainTheme
    )
      ?.render(100)
      .join('\n');

    assert.match(rendered ?? '', /Goal complete/);
    assert.match(rendered ?? '', /Summary: done/);
    assert.match(rendered ?? '', /Verifier: evidence supports completion/);
  });

  test('duplicate agent_settled while verifying starts exactly one verifier', async () => {
    const clock = new MutableClock();
    const verifier = createDeferredVerifier();
    const harness = createHarness({
      ids: ids('goal', 'dispatch', 'claim', 'attempt'),
      clock,
      runVerifier: verifier.runVerifier
    });
    registerGoalExtension(harness.pi as never, harness.options);
    const ctx = fakeCtx({ branch: [{ id: 'leaf' }], hasUI: true });

    await harness.commands.goal('Finish task', ctx);
    await harness.tools.pi_goal_claim_done.execute(
      'tool',
      { goal_id: 'goal', generation: 0, summary: 'done', evidence: 'proof' },
      undefined,
      undefined,
      ctx
    );
    harness.emit('agent_settled', {}, ctx);
    harness.emit('agent_settled', {}, ctx);

    assert.equal(verifier.calls.length, 1);
    assert.equal(verifier.calls[0]?.signal.aborted, false);

    verifier.resolve(verifierPass(clock));
    await settleAsync();

    assert.equal(latestState(harness.appended)?.status, 'complete');
  });

  test('/goal pause while verifying archives interruption and ignores later result', async () => {
    const clock = new MutableClock();
    const verifier = createDeferredVerifier();
    const harness = createHarness({
      ids: ids('goal', 'dispatch', 'claim', 'attempt'),
      clock,
      runVerifier: verifier.runVerifier
    });
    registerGoalExtension(harness.pi as never, harness.options);
    const ctx = fakeCtx({ branch: [{ id: 'leaf' }], hasUI: true });

    await harness.commands.goal('Finish task', ctx);
    await harness.tools.pi_goal_claim_done.execute(
      'tool',
      { goal_id: 'goal', generation: 0, summary: 'done', evidence: 'proof' },
      undefined,
      undefined,
      ctx
    );
    harness.emit('agent_settled', {}, ctx);

    assert.equal(verifier.calls.length, 1);
    const signal = verifier.calls[0]?.signal;

    await harness.commands.goal('pause', ctx);

    const paused = latestState(harness.appended);
    const appendedAfterPause = harness.appended.length;
    assert.equal(signal?.aborted, true);
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.pauseReason, 'user');
    const records = verificationRecords(harness.appended);
    assert.equal(records.length, 1);
    assertInterruptedVerification(records[0], expectedClaimIds(), 'pause');

    verifier.resolve({
      ok: false,
      reason: 'invalidated',
      usageTokens: 500,
      diagnostics: [],
      invalidated: true
    });
    await settleAsync();

    assert.equal(harness.appended.length, appendedAfterPause);
    assert.deepEqual(latestState(harness.appended), paused);
    assert.equal(verificationRecords(harness.appended).length, 1);
  });

  test('session_before_tree aborts in-flight verifier and ignores invalidated result', async () => {
    const clock = new MutableClock();
    const verifier = createDeferredVerifier();
    const harness = createHarness({
      ids: ids('goal', 'dispatch', 'claim', 'attempt'),
      clock,
      runVerifier: verifier.runVerifier
    });
    registerGoalExtension(harness.pi as never, harness.options);
    const ctx = fakeCtx({ branch: [{ id: 'leaf' }], hasUI: true });

    await harness.commands.goal('Finish task', ctx);
    await harness.tools.pi_goal_claim_done.execute(
      'tool',
      { goal_id: 'goal', generation: 0, summary: 'done', evidence: 'proof' },
      undefined,
      undefined,
      ctx
    );
    harness.emit('agent_settled', {}, ctx);

    assert.equal(verifier.calls.length, 1);
    const signal = verifier.calls[0]?.signal;

    harness.emit('session_before_tree', {}, ctx);

    const paused = latestState(harness.appended);
    const appendedAfterPause = harness.appended.length;
    assert.equal(signal?.aborted, true);
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.pauseReason, 'branch');
    const records = verificationRecords(harness.appended);
    assert.equal(records.length, 1);
    assertInterruptedVerification(records[0], expectedClaimIds(), 'branch');

    verifier.resolve({
      ok: false,
      reason: 'invalidated',
      usageTokens: 500,
      diagnostics: [],
      invalidated: true
    });
    await settleAsync();

    assert.equal(harness.appended.length, appendedAfterPause);
    assert.deepEqual(latestState(harness.appended), paused);
    assert.equal(verificationRecords(harness.appended).length, 1);
  });

  test('session_shutdown aborts in-flight verifier and persists reload pause', async () => {
    const clock = new MutableClock();
    const verifier = createDeferredVerifier();
    const harness = createHarness({
      ids: ids('goal', 'dispatch', 'claim', 'attempt'),
      clock,
      runVerifier: verifier.runVerifier
    });
    registerGoalExtension(harness.pi as never, harness.options);
    const ctx = fakeCtx({ branch: [{ id: 'leaf' }], hasUI: true });

    await harness.commands.goal('Finish task', ctx);
    await harness.tools.pi_goal_claim_done.execute(
      'tool',
      { goal_id: 'goal', generation: 0, summary: 'done', evidence: 'proof' },
      undefined,
      undefined,
      ctx
    );
    harness.emit('agent_settled', {}, ctx);

    assert.equal(verifier.calls.length, 1);
    const signal = verifier.calls[0]?.signal;

    harness.emit('session_shutdown', {}, ctx);

    const paused = latestState(harness.appended);
    const appendedAfterPause = harness.appended.length;
    assert.equal(signal?.aborted, true);
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.pauseReason, 'reload');
    const records = verificationRecords(harness.appended);
    assert.equal(records.length, 1);
    assertInterruptedVerification(records[0], expectedClaimIds(), 'reload');

    verifier.resolve({
      ok: false,
      reason: 'invalidated',
      usageTokens: 500,
      diagnostics: [],
      invalidated: true
    });
    await settleAsync();

    assert.equal(harness.appended.length, appendedAfterPause);
    assert.deepEqual(latestState(harness.appended), paused);
    assert.equal(verificationRecords(harness.appended).length, 1);
  });

  test('verifier fail that exhausts token budget becomes budget_limited', async () => {
    const clock = new MutableClock();
    const harness = createHarness({
      ids: ids('goal', 'dispatch', 'claim', 'attempt'),
      clock,
      runVerifier: async () => verifierFail(clock, 20),
      defaultTokenBudget: 100_000
    });
    registerGoalExtension(harness.pi as never, harness.options);
    const ctx = fakeCtx({ branch: [{ id: 'leaf' }], hasUI: true });

    await harness.commands.goal('Finish task', ctx);
    harness.emit('agent_start', {}, ctx);
    harness.emit(
      'message_end',
      {
        message: {
          role: 'assistant',
          usage: { totalTokens: 99_990 },
          content: []
        }
      },
      ctx
    );
    await harness.tools.pi_goal_claim_done.execute(
      'tool',
      { goal_id: 'goal', generation: 0, summary: 'done', evidence: 'proof' },
      undefined,
      undefined,
      ctx
    );
    harness.emit('agent_settled', {}, ctx);
    await settleAsync();

    const latest = latestState(harness.appended);
    assert.equal(latest?.status, 'budget_limited');
    assert.equal(latest?.budgetReason, 'tokens');
    assert.equal(latest?.tokensUsed, 100_010);
  });

  test('mismatched ok verifier report blocks safely instead of staying verifying', async () => {
    const clock = new MutableClock();
    const harness = createHarness({
      ids: ids('goal', 'dispatch', 'claim', 'attempt'),
      clock,
      runVerifier: async () => ({
        ok: true,
        usageTokens: 0,
        diagnostics: [],
        report: {
          goal_id: 'goal',
          generation: 0,
          claim_id: 'wrong-claim',
          verifier_attempt_id: 'attempt',
          verdict: 'pass',
          rationale: 'ok',
          evidence_reviewed: ['proof'],
          createdAt: clock.nowIso()
        }
      })
    });
    registerGoalExtension(harness.pi as never, harness.options);
    const ctx = fakeCtx({ branch: [{ id: 'leaf' }], hasUI: true });

    await harness.commands.goal('Finish task', ctx);
    await harness.tools.pi_goal_claim_done.execute(
      'tool',
      { goal_id: 'goal', generation: 0, summary: 'done', evidence: 'proof' },
      undefined,
      undefined,
      ctx
    );
    harness.emit('agent_settled', {}, ctx);
    await settleAsync();

    const latest = latestState(harness.appended);
    assert.equal(latest?.status, 'blocked');
    assert.match(latest?.blockedReason ?? '', /verification_error/);
  });
});

function createHarness(options: GoalExtensionOptions) {
  const commands: Record<string, CommandHandler> = {};
  const tools: Record<string, ToolDefinition> = {};
  const events: Record<string, EventHandler[]> = {};
  const appended: Array<{ customType: string; data: unknown }> = [];
  const sent: unknown[] = [];
  const entryRenderers = new Map<string, unknown>();
  let activeTools = ['read', 'bash'];

  return {
    options,
    commands,
    tools,
    events,
    appended,
    sent,
    entryRenderers,
    emit(name: string, event: unknown, ctx: ReturnType<typeof fakeCtx>) {
      for (const handler of events[name] ?? []) handler(event, ctx);
    },
    pi: {
      registerCommand(name: string, command: { handler: CommandHandler }) {
        commands[name] = command.handler;
      },
      registerTool(tool: ToolDefinition & { name: string }) {
        tools[tool.name] = tool;
      },
      registerEntryRenderer(customType: string, renderer: unknown) {
        entryRenderers.set(customType, renderer);
      },
      on(name: string, handler: EventHandler) {
        events[name] = [...(events[name] ?? []), handler];
      },
      appendEntry(customType: string, data: unknown) {
        appended.push({ customType, data });
      },
      sendMessage(message: unknown) {
        sent.push(message);
      },
      getAllTools() {
        return ['read', 'bash', ...Object.keys(tools)].map((name) => ({ name }));
      },
      getActiveTools() {
        return activeTools;
      },
      setActiveTools(names: string[]) {
        activeTools = names;
      },
      getThinkingLevel() {
        return 'low';
      }
    }
  };
}

function fakeCtx(input: {
  branch: Array<Record<string, unknown>>;
  hasUI: boolean;
  confirm?: () => Promise<boolean>;
  cwd?: string;
  projectTrusted?: boolean;
}) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, string[]>();
  let abortCalls = 0;
  return {
    cwd: input.cwd ?? '/repo',
    mode: input.hasUI ? 'tui' : 'json',
    hasUI: input.hasUI,
    notifications,
    statuses,
    widgets,
    get abortCalls() {
      return abortCalls;
    },
    model: { provider: 'p', id: 'm' },
    thinkingLevel: 'low',
    sessionManager: { getBranch: () => input.branch },
    isIdle: () => true,
    hasPendingMessages: () => false,
    isProjectTrusted: () => input.projectTrusted ?? true,
    abort() {
      abortCalls += 1;
    },
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      setStatus(key: string, text: string | undefined) {
        statuses.set(key, text);
      },
      setWidget(key: string, content: string[] | undefined) {
        if (content) widgets.set(key, content);
        else widgets.delete(key);
      },
      confirm: input.confirm ?? (async () => true)
    }
  };
}

function makeProjectConfig(config: Record<string, unknown>): string {
  const cwd = mkdtempForGoalTest();
  const configDir = join(cwd, CONFIG_DIR_NAME);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'pi-goal.json'), JSON.stringify(config), 'utf8');
  return cwd;
}

function mkdtempForGoalTest(): string {
  return mkdtempSync(join(tmpdir(), 'pi-goal-'));
}

function latestState(
  appended: Array<{ customType: string; data: unknown }>
): GoalState | undefined {
  for (let index = appended.length - 1; index >= 0; index--) {
    const entry = appended[index];
    if (entry.customType !== STATE_ENTRY) continue;
    const data = entry.data as { state?: GoalState };
    return data.state;
  }
  return undefined;
}

function verificationRecords(
  appended: Array<{ customType: string; data: unknown }>
): Array<Record<string, unknown>> {
  return appended
    .filter((entry) => entry.customType === VERIFICATION_ENTRY)
    .map((entry) => entry.data as Record<string, unknown>);
}

function assertInterruptedVerification(
  record: Record<string, unknown> | undefined,
  claim: VerificationClaimIds,
  reason: 'pause' | 'branch' | 'reload'
): void {
  assert.ok(record, 'expected interrupted verification record');
  assert.equal(record.goal_id, claim.goal_id);
  assert.equal(record.generation, claim.generation);
  assert.equal(record.claim_id, claim.claim_id);
  assert.equal(record.verifier_attempt_id, claim.verifier_attempt_id);
  assert.equal(record.ok, false);
  assert.equal(record.usageTokens, 0);
  assert.deepEqual(record.diagnostics, []);
  assert.equal(record.interrupted, true);
  assert.equal(record.reason, `interrupted: ${reason}`);
}

function expectedClaimIds(): VerificationClaimIds {
  return {
    goal_id: 'goal',
    generation: 0,
    claim_id: 'claim',
    verifier_attempt_id: 'attempt'
  };
}

function restoredVerifyingGoal(clock: MutableClock): {
  state: GoalState;
  claim: NonNullable<GoalState['pendingClaim']>;
} {
  const now = clock.nowIso();
  const claim: NonNullable<GoalState['pendingClaim']> = {
    ...expectedClaimIds(),
    summary: 'done',
    evidence: 'proof',
    createdAt: now
  };
  return {
    claim,
    state: {
      version: 1,
      id: 'goal',
      generation: 0,
      branchAnchorId: 'leaf',
      objective: 'Restore verifier',
      status: 'verifying',
      createdAt: now,
      updatedAt: now,
      tokensUsed: 0,
      tokenBudget: 100_000,
      elapsedActiveMs: 0,
      timeBudgetMs: 3_600_000,
      activeStartedAt: now,
      pendingClaim: claim
    }
  };
}

function createDeferredVerifier() {
  const calls: VerifierRunInput[] = [];
  let resolveVerifier: ((value: VerifierRunResult) => void) | undefined;

  return {
    calls,
    runVerifier(input: VerifierRunInput) {
      calls.push(input);
      return new Promise<VerifierRunResult>((resolve) => {
        resolveVerifier = resolve;
      });
    },
    resolve(result: VerifierRunResult) {
      resolveVerifier?.(result);
    }
  };
}

function verifierPass(clock: MutableClock): VerifierRunResult {
  return {
    ok: true,
    usageTokens: 7,
    diagnostics: [],
    report: {
      goal_id: 'goal',
      generation: 0,
      claim_id: 'claim',
      verifier_attempt_id: 'attempt',
      verdict: 'pass',
      rationale: 'evidence supports completion',
      evidence_reviewed: ['proof'],
      createdAt: clock.nowIso()
    }
  };
}

function verifierFail(clock: MutableClock, usageTokens: number): VerifierRunResult {
  return {
    ok: true,
    usageTokens,
    diagnostics: [],
    report: {
      goal_id: 'goal',
      generation: 0,
      claim_id: 'claim',
      verifier_attempt_id: 'attempt',
      verdict: 'fail',
      rationale: 'missing evidence',
      evidence_reviewed: ['proof'],
      next_action: 'collect more proof',
      createdAt: clock.nowIso()
    }
  };
}

function settleAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
