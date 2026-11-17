import { Value } from 'typebox/value';
import { expect, test } from 'vitest';
import { SDLC_REVIEW_SCHEMA, validateSdlcReview } from '../../src/workflow/sdlc/review.js';
import { createBrief } from '../../src/workflow/sdlc/validation.js';

const brief = createBrief({ goal: 'Preserve cursor behavior' });
function review() {
  return {
    goalRevision: 1,
    candidateRevision: 'candidate',
    codeReview: {
      verdict: 'pass',
      findings: [
        {
          id: 'F1',
          file: 'api.ts',
          line: 1,
          summary: 'The final page is consumed',
          evidence: 'The cursor is checked after reading',
          priority: 2,
          scenario: 'All three pages are retained',
          alternative: '',
          references: [{ file: 'api.ts', line: 1, observation: 'The final cursor is read' }],
          verdict: 'REFUTED',
          reason: 'Current source handles the final page',
          counterevidence: '',
          limitations: [] as string[]
        }
      ],
      limitations: []
    },
    outcomes: [
      { id: 'goal', status: 'met', evidenceIds: [], observations: [], reason: 'Observed' }
    ],
    findingDispositions: [],
    coverageGaps: []
  };
}

test.each([
  ['id', 1000],
  ['file', 500],
  ['summary', 240],
  ['evidence', 1000],
  ['scenario', 800],
  ['alternative', 600],
  ['reason', 1000],
  ['counterevidence', 800]
] as const)('finding %s schema and semantic validation enforce the same limit', (field, limit) => {
  const result = review();
  result.codeReview.findings[0][field] = 'x'.repeat(limit);
  expect(Value.Check(SDLC_REVIEW_SCHEMA, result)).toBe(true);
  expect(() => validateSdlcReview(result, brief, 'candidate', '/project')).not.toThrow();
  result.codeReview.findings[0][field] += 'x';
  expect(() => validateSdlcReview(result, brief, 'candidate', '/project')).toThrow();
  expect(Value.Check(SDLC_REVIEW_SCHEMA, result)).toBe(false);
});

test.each([
  ['file', 500],
  ['observation', 400]
] as const)('finding reference %s schema matches semantic validation', (field, limit) => {
  const result = review();
  result.codeReview.findings[0].references[0][field] = 'x'.repeat(limit);
  expect(Value.Check(SDLC_REVIEW_SCHEMA, result)).toBe(true);
  expect(() => validateSdlcReview(result, brief, 'candidate', '/project')).not.toThrow();
  result.codeReview.findings[0].references[0][field] += 'x';
  expect(() => validateSdlcReview(result, brief, 'candidate', '/project')).toThrow();
  expect(Value.Check(SDLC_REVIEW_SCHEMA, result)).toBe(false);
});

test.each(['finding', 'code review'])(
  '%s limitation schema matches semantic validation',
  (kind) => {
    const result = review();
    const target = kind === 'finding' ? result.codeReview.findings[0] : result.codeReview;
    target.limitations = ['x'.repeat(600)];
    expect(Value.Check(SDLC_REVIEW_SCHEMA, result)).toBe(true);
    expect(() => validateSdlcReview(result, brief, 'candidate', '/project')).not.toThrow();
    target.limitations[0] += 'x';
    expect(() => validateSdlcReview(result, brief, 'candidate', '/project')).toThrow();
    expect(Value.Check(SDLC_REVIEW_SCHEMA, result)).toBe(false);
  }
);
