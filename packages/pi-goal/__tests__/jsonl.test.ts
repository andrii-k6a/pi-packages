import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { parseVerificationReportText } from '../src/claims.js';
import { PiJsonlCollector, parseFinalVerifierReport, usageMetadataToTokens } from '../src/jsonl.js';

describe('verifier JSONL parsing', () => {
  test('handles partial JSONL chunks and extracts final assistant JSON', () => {
    const collector = new PiJsonlCollector();
    const report = JSON.stringify({
      goal_id: 'goal',
      generation: 0,
      claim_id: 'claim',
      verifier_attempt_id: 'attempt',
      verdict: 'pass',
      rationale: 'ok',
      evidence_reviewed: ['proof']
    });
    const line = JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'p',
        model: 'm',
        stopReason: 'stop',
        usage: { totalTokens: 12, input: 5, output: 7, cacheRead: 0, cacheWrite: 0, cost: {} },
        content: [{ type: 'text', text: report }]
      }
    });

    collector.write(line.slice(0, 20));
    collector.write(`${line.slice(20)}\n`);

    const collected = collector.finish();
    const result = parseFinalVerifierReport(collected, {
      exitCode: 0,
      requestedProvider: 'p',
      requestedModel: 'm',
      createdAt: '2026-01-01T00:00:00.000Z'
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.report.verdict : undefined, 'pass');
    assert.equal(result.usageTokens, 12);
    assert.equal(collected.usageEstimated, false);
    assert.equal(collected.assistantMessages.at(-1)?.usageEstimated, false);
  });

  test('rejects markdown fences, additional properties, and schema violations', () => {
    assert.throws(
      () => parseVerificationReportText('```json\n{}\n```', '2026-01-01T00:00:00.000Z'),
      /JSON object/
    );
    assert.throws(
      () =>
        parseVerificationReportText(
          JSON.stringify({
            goal_id: 'goal',
            generation: 0,
            claim_id: 'claim',
            verifier_attempt_id: 'attempt',
            verdict: 'pass',
            rationale: 'ok',
            evidence_reviewed: ['proof'],
            extra: true
          }),
          '2026-01-01T00:00:00.000Z'
        ),
      /unsupported field/
    );
    assert.throws(
      () =>
        parseVerificationReportText(
          JSON.stringify({
            goal_id: 'goal',
            generation: 0,
            claim_id: 'claim',
            verifier_attempt_id: 'attempt',
            verdict: 'pass',
            rationale: 'x'.repeat(4001),
            evidence_reviewed: ['proof']
          }),
          '2026-01-01T00:00:00.000Z'
        ),
      /at most 4000/
    );
    assert.throws(
      () =>
        parseVerificationReportText(
          JSON.stringify({
            goal_id: 'goal',
            generation: 0,
            claim_id: 'claim',
            verifier_attempt_id: 'attempt',
            verdict: 'pass',
            rationale: 'ok',
            evidence_reviewed: Array.from({ length: 21 }, (_, index) => `proof ${index}`)
          }),
          '2026-01-01T00:00:00.000Z'
        ),
      /at most 20/
    );
  });

  test('extracts usage metadata without text fallback', () => {
    assert.equal(usageMetadataToTokens(undefined), undefined);
    assert.equal(usageMetadataToTokens({ totalTokens: 0 } as never), undefined);
    assert.equal(
      usageMetadataToTokens({ input: 2, output: 3, cacheRead: 5, cacheWrite: 0 } as never),
      10
    );
  });

  test('estimates usage when assistant usage metadata is missing', () => {
    const collector = new PiJsonlCollector();
    collector.write(
      `${JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          provider: 'p',
          model: 'm',
          stopReason: 'stop',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                goal_id: 'goal',
                generation: 0,
                claim_id: 'claim',
                verifier_attempt_id: 'attempt',
                verdict: 'fail',
                rationale: 'x'.repeat(30),
                evidence_reviewed: ['proof']
              })
            }
          ]
        }
      })}\n`
    );

    const collected = collector.finish();
    const result = parseFinalVerifierReport(collected, {
      exitCode: 0,
      requestedProvider: 'p',
      requestedModel: 'm',
      createdAt: '2026-01-01T00:00:00.000Z'
    });

    assert.equal(result.ok, true);
    assert.equal(result.usageTokens > 0, true);
    assert.equal(collected.usageEstimated, true);
    assert.equal(collected.assistantMessages.at(-1)?.usageEstimated, true);
  });

  test('treats length stop reason, non-zero exit, and model mismatch as errors', () => {
    const base = {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'p',
        model: 'other',
        stopReason: 'length',
        content: [{ type: 'text', text: '{}' }]
      }
    };
    const collector = new PiJsonlCollector();
    collector.write(`${JSON.stringify(base)}\n`);

    assert.match(
      reasonOf(
        parseFinalVerifierReport(collector.finish(), {
          exitCode: 0,
          requestedProvider: 'p',
          requestedModel: 'm',
          createdAt: '2026-01-01T00:00:00.000Z'
        })
      ),
      /length/
    );

    const collector2 = new PiJsonlCollector();
    collector2.write(
      `${JSON.stringify({ ...base, message: { ...base.message, stopReason: 'stop' } })}\n`
    );
    assert.match(
      reasonOf(
        parseFinalVerifierReport(collector2.finish(), {
          exitCode: 1,
          stderr: 'boom',
          createdAt: '2026-01-01T00:00:00.000Z'
        })
      ),
      /exited/
    );

    const collector3 = new PiJsonlCollector();
    collector3.write(
      `${JSON.stringify({ ...base, message: { ...base.message, stopReason: 'stop' } })}\n`
    );
    assert.match(
      reasonOf(
        parseFinalVerifierReport(collector3.finish(), {
          exitCode: 0,
          requestedProvider: 'p',
          requestedModel: 'm',
          createdAt: '2026-01-01T00:00:00.000Z'
        })
      ),
      /model mismatch/
    );
  });
});

function reasonOf(result: ReturnType<typeof parseFinalVerifierReport>): string {
  assert.equal(result.ok, false);
  return result.reason;
}
