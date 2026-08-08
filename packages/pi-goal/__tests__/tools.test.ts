import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createGoal, limitBudget } from '../src/state.js';
import {
  findAssistantToolBatch,
  registerGoalTools,
  shouldBlockTerminalGoalBatch
} from '../src/tools.js';
import { ids, MutableClock } from './helpers.js';

describe('goal tools and terminal batch guard', () => {
  test('terminal batch guard blocks sibling that appears before claim', () => {
    const clock = new MutableClock();
    const state = createGoal({
      objective: 'done',
      branchAnchorId: 'leaf',
      ids: ids('goal'),
      clock
    });
    const branch = branchWithToolCalls([
      { id: 'bash-1', name: 'bash', arguments: { command: 'npm test' } },
      {
        id: 'claim-1',
        name: 'pi_goal_claim_done',
        arguments: {
          goal_id: state.id,
          generation: state.generation,
          summary: 'done',
          evidence: 'proof'
        }
      }
    ]);

    const decision = shouldBlockTerminalGoalBatch({
      eventToolName: 'bash',
      eventToolCallId: 'bash-1',
      eventInput: { command: 'npm test' },
      branch,
      state
    });

    assert.equal(decision?.block, true);
    assert.equal(decision?.terminate, true);
  });

  test('allows one current terminal call and blocks duplicate', () => {
    const clock = new MutableClock();
    const state = createGoal({
      objective: 'done',
      branchAnchorId: 'leaf',
      ids: ids('goal'),
      clock
    });
    const args = {
      goal_id: state.id,
      generation: state.generation,
      summary: 'done',
      evidence: 'proof'
    };
    const branch = branchWithToolCalls([
      { id: 'claim-1', name: 'pi_goal_claim_done', arguments: args },
      { id: 'claim-2', name: 'pi_goal_claim_done', arguments: args }
    ]);

    assert.equal(
      shouldBlockTerminalGoalBatch({
        eventToolName: 'pi_goal_claim_done',
        eventToolCallId: 'claim-1',
        eventInput: args,
        branch,
        state
      }),
      undefined
    );
    assert.match(
      shouldBlockTerminalGoalBatch({
        eventToolName: 'pi_goal_claim_done',
        eventToolCallId: 'claim-2',
        eventInput: args,
        branch,
        state
      })?.reason ?? '',
      /duplicate/
    );
  });

  test('stale terminal call blocks every sibling safely', () => {
    const clock = new MutableClock();
    const state = createGoal({
      objective: 'done',
      branchAnchorId: 'leaf',
      ids: ids('goal'),
      clock
    });
    const branch = branchWithToolCalls([
      { id: 'read-1', name: 'read', arguments: { path: 'x' } },
      {
        id: 'claim-1',
        name: 'pi_goal_claim_done',
        arguments: { goal_id: state.id, generation: 99, summary: 'done', evidence: 'proof' }
      }
    ]);

    assert.match(
      shouldBlockTerminalGoalBatch({
        eventToolName: 'read',
        eventToolCallId: 'read-1',
        eventInput: { path: 'x' },
        branch,
        state
      })?.reason ?? '',
      /terminal pi-goal tool/
    );
    const reason =
      shouldBlockTerminalGoalBatch({
        eventToolName: 'pi_goal_claim_done',
        eventToolCallId: 'claim-1',
        eventInput: { goal_id: state.id, generation: 99, summary: 'done', evidence: 'proof' },
        branch,
        state
      })?.reason ?? '';
    assert.match(reason, /stale or invalid/);
    assert.match(reason, /Current goal status=active/);
    assert.match(reason, /expected goal_id="goal", generation=0/);
    assert.match(reason, /provided goal_id="goal", generation=99/);
    assert.doesNotMatch(reason, /proof/);
  });

  test('stale terminal call without discoverable batch blocks safely', () => {
    const clock = new MutableClock();
    const state = createGoal({
      objective: 'done',
      branchAnchorId: 'leaf',
      ids: ids('goal'),
      clock
    });
    const limited = limitBudget(state, clock, 'tokens');

    const decision = shouldBlockTerminalGoalBatch({
      eventToolName: 'pi_goal_claim_done',
      eventToolCallId: 'claim-1',
      eventInput: { goal_id: state.id, generation: 0, summary: 'done', evidence: 'proof' },
      branch: [],
      state: limited
    });

    assert.equal(decision?.block, true);
    assert.equal(decision?.terminate, true);
    assert.match(decision?.reason ?? '', /Current goal status is budget_limited/);
    assert.match(decision?.reason ?? '', /terminal goal tools require active/);
  });

  test('current terminal call without discoverable batch is allowed', () => {
    const clock = new MutableClock();
    const state = createGoal({
      objective: 'done',
      branchAnchorId: 'leaf',
      ids: ids('goal'),
      clock
    });

    assert.equal(
      shouldBlockTerminalGoalBatch({
        eventToolName: 'pi_goal_claim_done',
        eventToolCallId: 'claim-1',
        eventInput: {
          goal_id: state.id,
          generation: 0,
          summary: 'done',
          evidence: 'proof'
        },
        branch: [],
        state
      }),
      undefined
    );
  });

  test('terminal diagnostics redact claim payload text', () => {
    const clock = new MutableClock();
    const state = createGoal({
      objective: 'done',
      branchAnchorId: 'leaf',
      ids: ids('goal'),
      clock
    });
    const branch = branchWithToolCalls([
      {
        id: 'claim-1',
        name: 'pi_goal_claim_done',
        arguments: {
          goal_id: state.id,
          generation: 0,
          summary: 'SECRET SUMMARY',
          evidence: '   '
        }
      }
    ]);

    const reason =
      shouldBlockTerminalGoalBatch({
        eventToolName: 'pi_goal_claim_done',
        eventToolCallId: 'claim-1',
        eventInput: {
          goal_id: state.id,
          generation: 0,
          summary: 'SECRET SUMMARY',
          evidence: '   '
        },
        branch,
        state
      })?.reason ?? '';

    assert.match(reason, /evidence is required after sanitization/);
    assert.doesNotMatch(reason, /SECRET SUMMARY/);
  });

  test('terminal diagnostics include no-current-goal context', () => {
    const decision = shouldBlockTerminalGoalBatch({
      eventToolName: 'pi_goal_blocked',
      eventToolCallId: 'block-1',
      eventInput: { goal_id: 'goal', generation: 0, reason: 'Need user' },
      branch: [],
      state: undefined
    });

    assert.equal(decision?.block, true);
    assert.match(decision?.reason ?? '', /Current goal status=none/);
    assert.match(decision?.reason ?? '', /provided goal_id="goal", generation=0/);
  });

  test('finds current assistant tool batch by event id', () => {
    const branch = branchWithToolCalls([{ id: 'one', name: 'read', arguments: { path: 'a' } }]);
    assert.deepEqual(
      findAssistantToolBatch(branch, 'one')?.map((block) => block.name),
      ['read']
    );
  });

  test('registered claim tool transitions to verifying and returns terminating details', async () => {
    const clock = new MutableClock();
    let state = createGoal({ objective: 'done', branchAnchorId: 'leaf', ids: ids('goal'), clock });
    const registered: Record<string, RegisteredTool> = {};
    const appended: Array<{ type: string; data: unknown }> = [];
    const pi = {
      registerTool(tool: RegisteredTool) {
        registered[tool.name] = tool;
      },
      on() {},
      appendEntry(type: string, data: unknown) {
        appended.push({ type, data });
      }
    };

    registerGoalTools(pi as never, {
      getGoal: () => state,
      commit(next) {
        state = next;
      },
      clearContinuationDispatch() {},
      ids: ids('claim', 'attempt'),
      clock
    });

    const result = await registered.pi_goal_claim_done.execute(
      'tool-1',
      { goal_id: 'goal', generation: 0, summary: 'done', evidence: 'proof' },
      undefined,
      undefined,
      { sessionManager: { getBranch: () => [] } }
    );

    assert.equal(state.status, 'verifying');
    assert.equal(result.terminate, true);
    assert.equal(result.details.claim?.claim_id, 'claim');
    assert.equal(appended.length, 0);
  });
});

interface RegisteredTool {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown
  ): Promise<{ terminate?: boolean; details: { claim?: { claim_id?: string } } }>;
}

function branchWithToolCalls(calls: Array<{ id: string; name: string; arguments: unknown }>) {
  return [
    {
      type: 'message',
      id: 'assistant',
      message: {
        role: 'assistant',
        content: calls.map((call) => ({ type: 'toolCall', ...call }))
      }
    }
  ];
}
