import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  clearSettledDispatch,
  ensureGoalToolsActive,
  filterStaleContinuationMessages,
  markDispatchInTurn,
  maybeDispatchContinuation
} from '../src/continuation.js';
import { createGoal, type RuntimeState } from '../src/state.js';
import { ids, MutableClock } from './helpers.js';

describe('continuation dispatch', () => {
  test('additively enables goal tools and preserves unrelated active tools', () => {
    let active = ['read', 'bash'];
    const pi = {
      getAllTools: () =>
        ['read', 'bash', 'pi_goal_claim_done', 'pi_goal_blocked'].map((name) => ({ name })),
      getActiveTools: () => active,
      setActiveTools(names: string[]) {
        active = names;
      }
    };

    const result = ensureGoalToolsActive(pi as never);

    assert.equal(result.ok, true);
    assert.deepEqual(active, ['read', 'bash', 'pi_goal_claim_done', 'pi_goal_blocked']);
  });

  test('dispatches at most one hidden follow-up while active and idle', () => {
    const clock = new MutableClock();
    const runtime: RuntimeState = {
      goal: createGoal({ objective: 'Ship', branchAnchorId: 'leaf', ids: ids('goal'), clock })
    };
    const sent: unknown[] = [];
    const pi = fakePi(sent);
    const ctx = fakeCtx(clock, [{ id: 'leaf' }]);

    const first = maybeDispatchContinuation({
      pi: pi as never,
      runtime,
      ctx: ctx as never,
      clock,
      ids: ids('dispatch'),
      commit() {}
    });
    const second = maybeDispatchContinuation({
      pi: pi as never,
      runtime,
      ctx: ctx as never,
      clock,
      ids: ids('dispatch2'),
      commit() {}
    });

    assert.equal(first, 'sent');
    assert.equal(second, 'already_queued');
    assert.equal(sent.length, 1);
    assert.equal(runtime.continuationDispatch?.state, 'sent');
  });

  test('tracks dispatch lifecycle from queued to sent to in_turn to cleared', () => {
    const clock = new MutableClock();
    const runtime: RuntimeState = {
      goal: createGoal({ objective: 'Ship', branchAnchorId: 'leaf', ids: ids('goal'), clock })
    };
    const sent: unknown[] = [];
    let stateDuringSend = '';
    const pi = {
      ...fakePi(sent),
      sendMessage(message: unknown) {
        stateDuringSend = runtime.continuationDispatch?.state ?? '';
        sent.push(message);
      }
    };

    const result = maybeDispatchContinuation({
      pi: pi as never,
      runtime,
      ctx: fakeCtx(clock, [{ id: 'leaf' }]) as never,
      clock,
      ids: ids('dispatch'),
      commit() {}
    });

    assert.equal(result, 'sent');
    assert.equal(stateDuringSend, 'queued');
    assert.equal(runtime.continuationDispatch?.state, 'sent');

    clearSettledDispatch(runtime, runtime.goal);
    assert.equal(runtime.continuationDispatch?.state, 'sent');

    markDispatchInTurn(runtime, runtime.goal);
    assert.equal(runtime.continuationDispatch?.state, 'in_turn');

    clearSettledDispatch(runtime, runtime.goal);
    assert.equal(runtime.continuationDispatch, undefined);
  });

  test('keeps in_turn when sendMessage synchronously starts the agent', () => {
    const clock = new MutableClock();
    const runtime: RuntimeState = {
      goal: createGoal({ objective: 'Ship', branchAnchorId: 'leaf', ids: ids('goal'), clock })
    };
    const sent: unknown[] = [];
    const pi = {
      ...fakePi(sent),
      sendMessage(message: unknown) {
        sent.push(message);
        markDispatchInTurn(runtime, runtime.goal);
      }
    };

    const result = maybeDispatchContinuation({
      pi: pi as never,
      runtime,
      ctx: fakeCtx(clock, [{ id: 'leaf' }]) as never,
      clock,
      ids: ids('dispatch'),
      commit() {}
    });

    assert.equal(result, 'sent');
    assert.equal(runtime.continuationDispatch?.state, 'in_turn');

    clearSettledDispatch(runtime, runtime.goal);
    assert.equal(runtime.continuationDispatch, undefined);
  });

  test('never dispatches while verifying and limits exhausted budgets', () => {
    const clock = new MutableClock();
    const active = createGoal({
      objective: 'Ship',
      branchAnchorId: 'leaf',
      ids: ids('goal'),
      clock
    });
    const runtime: RuntimeState = { goal: { ...active, tokensUsed: active.tokenBudget } };
    let committedStatus = '';

    const result = maybeDispatchContinuation({
      pi: fakePi([]) as never,
      runtime,
      ctx: fakeCtx(clock, [{ id: 'leaf' }]) as never,
      clock,
      ids: ids('dispatch'),
      commit(next) {
        committedStatus = next.status;
      }
    });

    assert.equal(result, 'budget_limited');
    assert.equal(committedStatus, 'budget_limited');

    runtime.goal = { ...active, status: 'verifying' };
    assert.equal(
      maybeDispatchContinuation({
        pi: fakePi([]) as never,
        runtime,
        ctx: fakeCtx(clock, [{ id: 'leaf' }]) as never,
        clock,
        ids: ids('dispatch'),
        commit() {}
      }),
      'not_active'
    );
  });

  test('pauses with tool_policy if goal tools cannot be active', () => {
    const clock = new MutableClock();
    const runtime: RuntimeState = {
      goal: createGoal({ objective: 'Ship', branchAnchorId: 'leaf', ids: ids('goal'), clock })
    };
    const pi = {
      getAllTools: () => [{ name: 'read' }],
      getActiveTools: () => ['read'],
      setActiveTools() {}
    };
    let pauseReason = '';

    const result = maybeDispatchContinuation({
      pi: pi as never,
      runtime,
      ctx: fakeCtx(clock, [{ id: 'leaf' }]) as never,
      clock,
      ids: ids('dispatch'),
      commit(next) {
        pauseReason = next.pauseReason ?? '';
      }
    });

    assert.equal(result, 'tool_policy');
    assert.equal(pauseReason, 'tool_policy');
  });

  test('pauses with tool_policy if setActiveTools throws during activation', () => {
    const clock = new MutableClock();
    const runtime: RuntimeState = {
      goal: createGoal({ objective: 'Ship', branchAnchorId: 'leaf', ids: ids('goal'), clock })
    };
    const sent: unknown[] = [];
    const notifications: Array<{ message: string; level: string }> = [];
    let requestedTools: string[] | undefined;
    const pi = {
      getAllTools: () =>
        ['read', 'pi_goal_claim_done', 'pi_goal_blocked'].map((name) => ({ name })),
      getActiveTools: () => ['read'],
      setActiveTools(names: string[]) {
        requestedTools = names;
        throw new Error('setActiveTools failed');
      },
      sendMessage(message: unknown) {
        sent.push(message);
      }
    };
    const ctx = {
      ...fakeCtx(clock, [{ id: 'leaf' }]),
      hasUI: true,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        }
      }
    };
    let committed: RuntimeState['goal'];

    const result = maybeDispatchContinuation({
      pi: pi as never,
      runtime,
      ctx: ctx as never,
      clock,
      ids: ids('dispatch'),
      commit(next) {
        committed = next;
        runtime.goal = next;
      }
    });

    assert.equal(result, 'tool_policy');
    assert.deepEqual(requestedTools, ['read', 'pi_goal_claim_done', 'pi_goal_blocked']);
    assert.equal(committed?.status, 'paused');
    assert.equal(committed?.pauseReason, 'tool_policy');
    assert.equal(sent.length, 0);
    assert.equal(runtime.continuationDispatch, undefined);
    assert.deepEqual(notifications, [
      {
        message:
          'Goal paused because required tools are unavailable. Enable pi_goal_claim_done and pi_goal_blocked, then run /goal resume.',
        level: 'warning'
      }
    ]);
  });

  test('filters stale hidden continuation messages from context', () => {
    const clock = new MutableClock();
    const state = createGoal({
      objective: 'Ship',
      branchAnchorId: 'leaf',
      ids: ids('goal'),
      clock
    });
    const messages = [
      {
        role: 'custom',
        customType: 'pi-goal-continuation',
        details: { goal_id: 'old', generation: 0 }
      },
      {
        role: 'custom',
        customType: 'pi-goal-continuation',
        details: { goal_id: state.id, generation: 0 }
      },
      { role: 'user', content: 'hello' }
    ];

    const filtered = filterStaleContinuationMessages(messages as never, state);

    assert.equal(filtered.length, 2);
    assert.equal((filtered[0] as { customType?: string }).customType, 'pi-goal-continuation');
    assert.equal((filtered[1] as { role?: string }).role, 'user');
  });
});

function fakePi(sent: unknown[]) {
  let active = ['read'];
  return {
    getAllTools: () => ['read', 'pi_goal_claim_done', 'pi_goal_blocked'].map((name) => ({ name })),
    getActiveTools: () => active,
    setActiveTools(names: string[]) {
      active = names;
    },
    sendMessage(message: unknown) {
      sent.push(message);
    }
  };
}

function fakeCtx(_clock: MutableClock, branch: Array<{ id: string }>) {
  return {
    sessionManager: { getBranch: () => branch },
    isIdle: () => true,
    hasPendingMessages: () => false
  };
}
