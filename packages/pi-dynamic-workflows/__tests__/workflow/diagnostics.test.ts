import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  classifyWorkflowFailure,
  diagnosticText,
  workflowFailureSummary
} from '../../src/workflow/diagnostics.js';
import { createWorkflowSnapshot, recomputeWorkflowSnapshot } from '../../src/workflow/snapshot.js';

test.each([
  [{ error: { type: 'budget_exceeded' } }, 'quota'],
  ['429 {"error":{"type":"budget_exceeded"}}', 'quota'],
  ['429 rate limit exceeded', 'transient'],
  ['workflow token budget exhausted', 'unknown'],
  ['OAuth refresh failed: SSO cookies expired. Run /login provider again.', 'authentication'],
  ['subagent was cancelled', 'cancellation'],
  ['Invalid review location', 'invalid-output'],
  ['unexpected provider response: schema mismatch', 'unknown']
] as const)('classifies %j without treating every 429 as exhausted quota', (error, expected) => {
  assert.equal(classifyWorkflowFailure(error), expected);
});

test('summaries group identical causes but preserve distinct failures, routes, and reusable work', () => {
  const snapshot = recomputeWorkflowSnapshot({
    ...createWorkflowSnapshot({ name: 'review', description: 'Review' }),
    runId: 'run-1',
    agents: [
      { id: 1, label: 'kept', prompt: '', status: 'done', reusedFrom: 1 },
      ...['a', 'b'].map((label, index) => ({
        id: index + 2,
        label,
        prompt: '',
        status: 'error' as const,
        phase: 'Verify',
        profile: 'hard',
        model: 'provider/premium',
        error: '429 budget_exceeded'
      })),
      {
        id: 4,
        label: 'c',
        prompt: '',
        status: 'error',
        phase: 'Find',
        profile: 'basic',
        model: 'other/model',
        error: 'OAuth refresh failed: SSO cookies expired'
      },
      { id: 5, label: 'd', prompt: '', status: 'error', error: 'new useful unknown cause' }
    ]
  });
  const text = workflowFailureSummary(snapshot, 'A code review verifier failed.').join('\n');
  assert.match(text, /Verify: a, b \[profile hard, provider\/premium\] quota/);
  assert.match(text, /Find: c \[profile basic, other\/model\] authentication/);
  assert.match(text, /1 completed reusable agent result/);
  assert.match(text, /new useful unknown cause/);
  assert.match(text, /Pi \/login before resuming/);
  assert.match(text, /Wait for quota to reset/);
  assert.match(text, /resumeProfile/);
});

test('public diagnostics redact credentials and account identifiers and bound terminal-safe output', () => {
  const text = diagnosticText(
    'SSO cookies expired\u001b[31m\nAuthorization: Bearer secret-token\n' +
      'access_token="private-token" account_id=acct-123 accountId=acct-456 tenant_id=tenant-123\n' +
      'cookie: session=private-cookie\nhttps://user:password@provider.test/path?key=secret\nuser@example.com',
    2000
  );
  assert.match(text, /SSO cookies expired/);
  assert.equal(text.includes('\u001b'), false);
  assert.doesNotMatch(
    text,
    /secret-token|private-token|acct-|tenant-123|private-cookie|user@example|password/
  );
  assert.ok(diagnosticText('x'.repeat(10000)).length <= 300);
});
