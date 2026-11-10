import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MAX_REVIEW_DIFF_CHARS } from '../../src/workflow/builtins/code-review.js';
import { resolveBuiltinWorkflow } from '../../src/workflow/builtins.js';
import type { WorkflowAgentExecutor } from '../../src/workflow/contracts.js';
import { runWorkflow } from '../../src/workflow/runtime.js';

const patch = (file: string, before = 'old', after = 'new') =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
const diff = patch('service.ts');
const script = () => resolveBuiltinWorkflow('code-review', { diff });
const candidate = {
  file: 'service.ts',
  line: 4,
  summary: 'The error is lost',
  evidence: 'The caller treats a failed request as successful',
  priority: 2,
  scenario: 'A failed request returns success to its caller',
  alternative: '',
  references: [{ file: 'caller.ts', line: 12, observation: 'The caller consumes the success flag' }]
};
const confirmed = {
  ...candidate,
  verdict: 'CONFIRMED',
  reason: 'Static inspection traces failure to the returned success flag',
  counterevidence: 'The caller has no guard for this result',
  limitations: []
};
interface ReviewResult {
  total: number;
  findings: Array<
    typeof candidate & {
      id: string;
      candidateIds: string[];
      category: string;
      categories: string[];
      verdict: string;
      reason: string;
      counterevidence: string;
    }
  >;
  report: string;
  limitations: string[];
}

function review(agent: WorkflowAgentExecutor, args: Record<string, unknown> = { diff }) {
  return runWorkflow<ReviewResult>(script(), { args, agent });
}

test('built-in lookup rejects unknown names and unusable review inputs', () => {
  assert.throws(() => resolveBuiltinWorkflow('missing', { diff }), /Unknown built-in.*code-review/);
  for (const value of [undefined, '', ' \n ', 10]) {
    assert.throws(
      () => resolveBuiltinWorkflow('code-review', { diff: value }),
      /args.diff.*non-empty string/
    );
  }
  assert.throws(
    () => resolveBuiltinWorkflow('code-review', { diff: 'x'.repeat(MAX_REVIEW_DIFF_CHARS + 1) }),
    /at most 200000 diff characters/
  );
  for (const key of ['diffSource', 'goal', 'baseCommit']) {
    for (const value of [null, 12, {}, []]) {
      assert.throws(
        () => resolveBuiltinWorkflow('code-review', { diff, [key]: value }),
        new RegExp(`args.${key}.*string`)
      );
    }
  }
  assert.throws(
    () => resolveBuiltinWorkflow('code-review', { diff, baseCommit: ' ' }),
    /args.baseCommit.*non-empty string/
  );
  assert.equal(resolveBuiltinWorkflow('code-review', { diff, goal: '' }), script());
});

test('stored review scripts reject invalid replacement args before starting any agents', async () => {
  let calls = 0;
  for (const args of [
    { diff: '' },
    { diff: 'x'.repeat(MAX_REVIEW_DIFF_CHARS + 1) },
    { diff, diffSource: 1 },
    { diff, goal: null },
    { diff, baseCommit: false },
    { diff, baseCommit: '' },
    { mode: 'invalid', diff },
    { mode: 'files', path: '' },
    { mode: 'files', path: 'src', diff },
    { mode: 'files', path: 'src', baseCommit: 'HEAD' },
    { mode: 'files', path: 'src', diffSource: 'anything' },
    { mode: 'files', path: 'src', capture: {} },
    { mode: 'changes', diff, path: 'src' },
    { diff, profile: null },
    { diff, profile: ' ' },
    { diff, capture: { untracked: true } },
    { base: 'main' },
    { diff, base: 'main' },
    { diff, trackedOnly: false },
    { mode: 'files', path: 'src', base: 'main' },
    {
      diff,
      capture: {
        target: '.',
        untracked: 'included',
        includedAdditions: [],
        exclusions: [],
        comparison: { headCommit: 'HEAD' }
      }
    }
  ]) {
    await assert.rejects(
      runWorkflow(script(), {
        args,
        agent: {
          async run() {
            calls++;
          }
        }
      }),
      /Code review (requires|accepts|files mode|changes mode|prepared inputs)/
    );
  }
  assert.equal(calls, 0);
});

test('three independent roles deduplicate obvious causes, retain same-location issues, and apply verifier corrections', async () => {
  const refuted = { ...candidate, line: 12, summary: 'A supposedly missing guard' };
  const architecture = {
    ...candidate,
    summary: 'Policy has two owners',
    scenario: 'Every policy update now requires changes in two layers',
    alternative: 'Keep the policy in its existing owning layer',
    priority: 1
  };
  const maintenance = {
    ...candidate,
    line: 20,
    summary: 'Unnecessary mirrored state',
    scenario: 'Every new field requires synchronizing two local representations',
    alternative: 'Derive the representation from existing state',
    priority: 1
  };
  const labels: string[] = [];
  const args = { diff, goal: 'Propagate request failures without moving policy ownership' };
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = await review(
    {
      async run(prompt, options) {
        labels.push(options.label);
        assert.equal(options.profile, undefined);
        assert.equal(options.isolation, undefined, 'HEAD worktrees omit the reviewed changes');
        assert.equal(options.toolset, 'review');
        assert.ok(prompt.includes(args.goal));
        if (options.label.startsWith('find-')) {
          assert.ok(!prompt.includes(architecture.summary), 'discovery does not share candidates');
          if (labels.length === 3) release();
          await allStarted;
        }
        switch (options.label) {
          case 'find-behavior':
            return { candidates: [candidate, refuted], limitations: [] };
          case 'find-architecture':
            return {
              candidates: [
                {
                  ...candidate,
                  file: './src/../service.ts',
                  summary: ' THE  ERROR IS LOST. ',
                  scenario: ' A FAILED request returns SUCCESS to its caller. ',
                  references: [
                    { file: './service.ts', line: 4, observation: 'Failure becomes success' }
                  ]
                },
                architecture
              ],
              limitations: []
            };
          case 'find-maintainability':
            assert.match(prompt, /Comments should explain necessary rationale or constraints/);
            assert.match(prompt, /Check incorrect comments and documentation/);
            assert.match(prompt, /State each fact once/);
            assert.match(prompt, /purpose, setup, usage, and development/);
            return {
              candidates: [maintenance],
              limitations: ['The external contract is unavailable']
            };
          case 'verify-candidate-01':
            assert.match(prompt, /"categories":\["behavior","architecture"\]/);
            assert.match(prompt, /Failure becomes success/);
            assert.match(prompt, /The caller consumes the success flag/);
            return {
              ...confirmed,
              file: './caller.ts',
              line: 7,
              summary: 'Surface request failures',
              priority: 1
            };
          case 'verify-candidate-02':
            return { ...confirmed, ...refuted, verdict: 'REFUTED', reason: 'A guard handles it' };
          case 'verify-candidate-03':
            return {
              ...confirmed,
              ...architecture,
              reason: 'Static inspection confirms divergent policy ownership, not a runtime failure'
            };
          case 'verify-candidate-04':
            return {
              ...confirmed,
              ...maintenance,
              verdict: 'UNCERTAIN',
              reason:
                'Obtain the external contract to determine whether both representations are required'
            };
          default:
            throw new Error(`Unexpected agent: ${options.label}`);
        }
      }
    },
    args
  );

  assert.equal(result.result.total, 4);
  assert.deepEqual(
    structuredClone(result.result.findings).map(
      ({ summary, file, line, categories, verdict, priority }) => ({
        summary,
        file,
        line,
        categories,
        verdict,
        priority
      })
    ),
    [
      {
        summary: 'Surface request failures',
        file: 'caller.ts',
        line: 7,
        categories: ['behavior', 'architecture'],
        verdict: 'CONFIRMED',
        priority: 1
      },
      {
        summary: architecture.summary,
        file: architecture.file,
        line: architecture.line,
        categories: ['architecture'],
        verdict: 'CONFIRMED',
        priority: 1
      },
      {
        summary: maintenance.summary,
        file: maintenance.file,
        line: maintenance.line,
        categories: ['maintainability'],
        verdict: 'UNCERTAIN',
        priority: 1
      }
    ]
  );
  assert.match(result.result.report, /### P1 · Surface request failures\n\n[^\n]*caller\\.ts:7/);
  assert.match(result.result.report, /\*\*Alternative:\*\* Keep the policy/);
  assert.doesNotMatch(result.result.report, /supposedly missing guard/);
  assert.ok(
    result.result.report.indexOf('## Confirmed') < result.result.report.indexOf('## Uncertain')
  );
  assert.match(result.result.report, /Obtain the external contract/);
  assert.ok(result.result.limitations.includes('The external contract is unavailable'));
  assert.deepEqual(result.phases, ['Find', 'Verify', 'Report']);
  assert.deepEqual(labels, [
    'find-behavior',
    'find-architecture',
    'find-maintainability',
    'verify-candidate-01',
    'verify-candidate-02',
    'verify-candidate-03',
    'verify-candidate-04'
  ]);
  assert.equal(result.agentCount, 3 + result.result.total);
});

test.each([false, true])(
  'exact verified duplicates preserve one canonical conclusion and remedy (explicit duplicate: %s)',
  async (explicitDuplicate) => {
    const result = await review({
      async run(_prompt, { label }) {
        if (label.startsWith('find-')) {
          return {
            candidates: label === 'find-maintainability' ? [] : [{ ...candidate, summary: label }],
            limitations: []
          };
        }
        return {
          ...confirmed,
          summary: label === 'verify-candidate-01' ? ' One cause ' : 'one  cause.',
          reason: label,
          counterevidence: label,
          alternative:
            label === 'verify-candidate-01'
              ? 'Reject resume when the profile is disabled.'
              : 'Document that disabled profiles may continue.',
          evidence: `${label} observed the missing approval check`,
          ...(explicitDuplicate && label === 'verify-candidate-02'
            ? { duplicateOf: 'candidate-01' }
            : {}),
          references: [{ file: './caller.ts', line: 12, observation: label }]
        };
      }
    });
    assert.equal(result.result.total, 2);
    assert.equal(result.agentCount, 5);
    assert.equal(result.result.findings.length, 1);
    const finding = result.result.findings[0];
    assert.deepEqual(Array.from(finding.categories), ['behavior', 'architecture']);
    assert.deepEqual(Array.from(finding.candidateIds), ['candidate-01', 'candidate-02']);
    assert.equal(finding.references.length, 2);
    assert.equal(finding.alternative, 'Reject resume when the profile is disabled.');
    assert.equal(finding.reason, 'verify-candidate-01');
    assert.equal(finding.counterevidence, 'verify-candidate-01\nverify-candidate-02');
    assert.match(finding.evidence, /verify-candidate-01 observed/);
    assert.match(finding.evidence, /verify-candidate-02 observed/);
    assert.doesNotMatch(result.result.report, /Document that disabled profiles may continue/);
  }
);

test('verifiers can identify one cause across code and documentation without combining conflicting remedies', async () => {
  const documentation = {
    ...candidate,
    file: 'README.md',
    line: 10,
    summary: 'Correct the resume approval promise',
    scenario: 'Operators expect revoked profiles to stop resumable work',
    alternative: 'Document that revoked profiles still run'
  };
  const labels: string[] = [];
  const verifierPrefixes: string[] = [];
  const result = await review({
    async run(prompt, { label }) {
      labels.push(label);
      if (label.startsWith('find-'))
        return {
          candidates:
            label === 'find-behavior'
              ? [candidate]
              : label === 'find-maintainability'
                ? [documentation]
                : [],
          limitations: []
        };
      assert.match(prompt, /"candidateCatalog":/);
      assert.ok(prompt.includes(documentation.summary));
      verifierPrefixes.push(prompt.split('\n\n## Candidate and evidence input\n\n')[0]);
      return label === 'verify-candidate-01'
        ? { ...confirmed, alternative: 'Recheck current approval before scheduling' }
        : {
            ...confirmed,
            ...documentation,
            duplicateOf: 'candidate-01',
            reason: 'The same missing approval check causes the inaccurate documentation claim'
          };
    }
  });
  assert.equal(result.result.total, 2);
  assert.equal(labels.length, 5, 'deduplication needs no additional model call');
  assert.equal(verifierPrefixes.length, 2);
  assert.equal(verifierPrefixes[0], verifierPrefixes[1], 'candidate input follows a stable prefix');
  assert.equal(result.result.findings.length, 1);
  const finding = result.result.findings[0];
  assert.deepEqual(Array.from(finding.candidateIds), ['candidate-01', 'candidate-02']);
  assert.deepEqual(Array.from(finding.categories), ['behavior', 'maintainability']);
  assert.equal(finding.alternative, 'Recheck current approval before scheduling');
  assert.doesNotMatch(result.result.report, /Document that revoked profiles still run/);
});

test('different verifier verdicts do not collapse through a duplicate reference', async () => {
  const result = await review({
    async run(_prompt, { label }) {
      if (label.startsWith('find-'))
        return {
          candidates:
            label === 'find-behavior'
              ? [candidate, { ...candidate, line: 20, summary: 'A related but unproved claim' }]
              : [],
          limitations: []
        };
      return label === 'verify-candidate-01'
        ? confirmed
        : { ...confirmed, line: 20, verdict: 'UNCERTAIN', duplicateOf: 'candidate-01' };
    }
  });
  assert.equal(result.result.findings.length, 2);
  assert.deepEqual(
    Array.from(result.result.findings, (finding) => finding.verdict),
    ['CONFIRMED', 'UNCERTAIN']
  );
});

test('report limitations preserve compound explanations and omit only standalone common caveats', async () => {
  const missing = 'The external contract for service.ts is unavailable.';
  const result = await review({
    async run(_prompt, { label }) {
      const limitations = label.startsWith('find-')
        ? [
            'Static inspection only.',
            'No tests or builds were executed.',
            missing,
            'The loader contract was unavailable. That prevented verification of loader recovery.'
          ]
        : ['Files were live, not an immutable snapshot.', missing];
      return label.startsWith('find-')
        ? { candidates: [candidate], limitations }
        : { ...confirmed, limitations };
    }
  });
  assert.equal(
    result.result.limitations.filter((item) => /Static inspection only/i.test(item)).length,
    1
  );
  assert.equal(result.result.limitations.filter((item) => item === missing).length, 1);
  assert.ok(
    result.result.limitations.includes(
      'The loader contract was unavailable. That prevented verification of loader recovery.'
    )
  );
  assert.match(
    result.result.report,
    /Candidates checked: 1\. Distinct confirmed findings: 1\. Uncertain findings: 0\./
  );
  assert.ok(!result.result.limitations.some((item) => /^No tests|^Files were live/.test(item)));
});

test.each(['find-behavior', 'verify-candidate-01'])(
  'a failed %s does not become a successful review',
  async (failedLabel) => {
    await assert.rejects(
      review({
        async run(_prompt, { label }) {
          if (label === failedLabel) throw new Error('Provider unavailable');
          if (label.startsWith('find-')) return { candidates: [candidate], limitations: [] };
          return confirmed;
        }
      }),
      /code review (finder|verifier) failed.*Inspect the failure diagnostics/
    );
  }
);

test.each([
  { label: 'find-behavior', output: undefined },
  { label: 'find-architecture', output: { candidates: [], limitations: null } },
  {
    label: 'find-maintainability',
    output: { candidates: Array(6).fill(candidate), limitations: [] }
  },
  {
    label: 'find-behavior',
    output: { candidates: [{ ...candidate, file: '../escape' }], limitations: [] }
  },
  { label: 'verify-candidate-01', output: { verdict: 'CONFIRMED' } },
  { label: 'verify-candidate-01', output: { ...confirmed, verdict: 'PLAUSIBLE' } },
  { label: 'verify-candidate-01', output: { ...confirmed, duplicateOf: 'candidate-99' } },
  { label: 'verify-candidate-01', output: { ...confirmed, duplicateOf: 'candidate-01' } }
])('unusable $label output fails closed', async ({ label: failedLabel, output }) => {
  await assert.rejects(
    review({
      async run(_prompt, { label }) {
        if (label === failedLabel) return output;
        if (label.startsWith('find-')) return { candidates: [candidate], limitations: [] };
        return confirmed;
      }
    }),
    /code review (finder|verifier) returned unusable output.*Inspect the validation error/
  );
});

test('an empty review skips verifiers and treats supplied context as data', async () => {
  const input = {
    diff: `'; throw new Error('injected'); //\n${diff}`,
    diffSource: '"untrusted"\nsource',
    goal: 'Preserve the failure contract',
    baseCommit: "HEAD'; touch /tmp/not-a-command"
  };
  const labels: string[] = [];
  const result = await review(
    {
      async run(prompt, { label }) {
        labels.push(label);
        assert.ok(prompt.includes(JSON.stringify(input.diff)));
        assert.ok(prompt.includes(JSON.stringify(input.diffSource)));
        assert.ok(prompt.includes(JSON.stringify(input.goal)));
        assert.ok(prompt.includes(JSON.stringify(input.baseCommit)));
        assert.match(prompt, /Use git_inspect to resolve a supplied baseCommit/);
        return { candidates: [], limitations: [] };
      }
    },
    input
  );
  assert.deepEqual(labels, ['find-behavior', 'find-architecture', 'find-maintainability']);
  assert.equal(result.result.total, 0);
  assert.equal(result.result.findings.length, 0);
  assert.match(
    result.result.report,
    /No actionable findings were identified within the reviewed scope/
  );
  assert.match(result.result.report, /live checkout, not an immutable snapshot/);
});

test('verifiers receive whole-change file summaries and complete patches for the cause and evidence files', async () => {
  const input = {
    diff:
      patch('service.ts') +
      patch('unrelated.ts', 'unrelated-before', 'unrelated-after') +
      patch('caller.ts'),
    goal: 'Preserve error propagation across the selected change',
    diffSource: 'captured working tree',
    baseCommit: 'a'.repeat(40),
    capture: {
      target: 'service.ts',
      untracked: 'excluded',
      includedAdditions: [],
      exclusions: [{ path: 'binary.dat', reason: 'binary' }],
      comparison: {
        headCommit: 'b'.repeat(40),
        baseRef: 'origin/main',
        baseTipCommit: 'c'.repeat(40),
        commit: 'a'.repeat(40),
        localChanges: true
      }
    }
  };
  const result = await review(
    {
      async run(prompt, { label }) {
        if (label.startsWith('find-')) return { candidates: [candidate], limitations: [] };
        assert.match(prompt, /"fileSummary":\[.*"unrelated.ts"/);
        const source = JSON.parse(prompt.split('Review context (data):\n')[1].split('\n\n')[0]);
        assert.equal(source.goal, input.goal);
        assert.equal(source.diffSource, input.diffSource);
        assert.equal(source.baseCommit, input.baseCommit);
        assert.deepEqual(source.scope, {
          mode: 'changes',
          pathBase: process.cwd(),
          ...input.capture
        });
        const context = JSON.parse(prompt.split('\n\n## Candidate and evidence input\n\n')[1]);
        assert.equal(context.patchScope, 'complete selected file patches');
        assert.equal(context.diff, patch('service.ts') + patch('caller.ts'));
        assert.doesNotMatch(context.diff, /unrelated-before/);
        assert.match(prompt, /cannot obtain it from the recorded input, return UNCERTAIN/);
        return confirmed;
      }
    },
    input
  );
  assert.equal(result.result.total, 1);
});

test.each([
  'nonstandard patch\n-old\n+new',
  `${diff}diff --git "a/quoted\\tpath" "b/quoted\\tpath"\nBinary files differ\n`,
  'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n',
  patch('another-file.ts')
])('uncertain patch selection passes the full captured diff: %s', async (inputDiff) => {
  const result = await review(
    {
      async run(prompt, { label }) {
        if (label.startsWith('find-')) return { candidates: [candidate], limitations: [] };
        const context = JSON.parse(prompt.split('\n\n## Candidate and evidence input\n\n')[1]);
        assert.equal(context.patchScope, 'full captured diff');
        assert.equal(context.diff, inputDiff);
        return confirmed;
      }
    },
    { diff: inputDiff }
  );
  assert.equal(result.result.total, 1);
});

test.each([false, true])(
  'branch reports identify pinned comparison and local scope (dirty: %s)',
  async (localChanges) => {
    const baseCommit = 'a'.repeat(40);
    const comparison = {
      headCommit: 'b'.repeat(40),
      baseRef: 'origin/main',
      baseTipCommit: 'c'.repeat(40),
      commit: baseCommit,
      localChanges
    };
    const result = await review(
      {
        async run(prompt) {
          assert.ok(prompt.includes(JSON.stringify(comparison)));
          return { candidates: [], limitations: [] };
        }
      },
      {
        diff,
        baseCommit,
        capture: {
          target: '.',
          untracked: 'included',
          includedAdditions: [],
          exclusions: [],
          comparison
        }
      }
    );
    assert.match(result.result.report, /Comparison: working tree against merge base/);
    assert.match(result.result.report, /origin/);
    assert.ok(result.result.report.includes(baseCommit));
    assert.equal(result.result.report.includes('not a committed-only branch review'), localChanges);
  }
);

test('files mode verifies pre-existing problems without diff-selection context', async () => {
  const args = { mode: 'files', path: '../existing source', goal: 'Review error propagation' };
  assert.equal(resolveBuiltinWorkflow('code-review', args), script());
  const result = await review(
    {
      async run(prompt, options) {
        assert.equal(options.toolset, 'review');
        assert.match(prompt, /including pre-existing ones/);
        assert.ok(prompt.includes(JSON.stringify(args.path)));
        assert.equal(prompt.split(args.goal).length - 1, 1, 'the goal is not repeated');
        assert.doesNotMatch(prompt, /"diff":|"patchScope":|"fileSummary":/);
        assert.match(prompt, /structured_output/);
        assert.ok(options.schema);
        if (options.label.startsWith('find-')) {
          assert.match(prompt, /^# Review task\n\n/);
          assert.match(prompt, /\n\n## Investigation\n\n- /);
          const input = JSON.parse(prompt.split('\n\n## Review input\n\n')[1]);
          assert.deepEqual(input, {
            scope: { mode: 'files', target: args.path, pathBase: process.cwd() },
            goal: args.goal
          });
          return { candidates: [candidate], limitations: [] };
        }
        assert.match(prompt, /^# Verify one candidate\n\n/);
        assert.match(prompt, /\n\n## Verification procedure\n\n1\. /);
        const source = JSON.parse(prompt.split('Review context (data):\n')[1].split('\n\n')[0]);
        assert.equal(source.goal, args.goal);
        assert.deepEqual(source.scope, {
          mode: 'files',
          target: args.path,
          pathBase: process.cwd()
        });
        const input = JSON.parse(prompt.split('\n\n## Candidate and evidence input\n\n')[1]);
        assert.equal(input.candidate.summary, candidate.summary);
        assert.deepEqual(input.candidate.references, candidate.references);
        return { ...confirmed, file: '../existing source/service.ts' };
      }
    },
    args
  );
  assert.equal(result.result.total, 1);
  assert.equal(result.result.findings[0].verdict, 'CONFIRMED');
  assert.equal(result.result.findings[0].file, '../existing source/service.ts');
  assert.match(result.result.report, /Mode: files/);
  assert.match(result.result.report, /inspected live/);
  assert.match(result.result.report, /not a fresh audit/);
});

test('one explicit profile reaches every finder and verifier despite phase resets', async () => {
  const seen: string[] = [];
  const result = await runWorkflow<ReviewResult>(script(), {
    args: { diff, profile: 'thorough' },
    profileResolver(name) {
      assert.equal(name, 'thorough');
      return { model: { provider: 'approved', id: 'reviewer' }, thinkingLevel: 'high' };
    },
    agent: {
      async run(_prompt, options) {
        seen.push(options.label);
        assert.equal(options.profile, 'thorough');
        assert.deepEqual(options.route, {
          model: { provider: 'approved', id: 'reviewer' },
          thinkingLevel: 'high'
        });
        assert.equal(options.toolset, 'review');
        return options.label.startsWith('find-')
          ? { candidates: [candidate], limitations: [] }
          : confirmed;
      }
    }
  });
  assert.equal(result.result.total, 1);
  assert.deepEqual(seen, [
    'find-behavior',
    'find-architecture',
    'find-maintainability',
    'verify-candidate-01'
  ]);
});

test('an unavailable explicit profile fails before starting a model', async () => {
  let calls = 0;
  await assert.rejects(
    runWorkflow(script(), {
      args: { diff, profile: 'missing' },
      agent: {
        async run() {
          calls++;
        }
      }
    }),
    /Cannot route workflow profile.*routing is unavailable/
  );
  assert.equal(calls, 0);
});

test('literal POSIX filenames keep spaces, backslashes, and newlines in structured finding locations', async () => {
  const file = ' leading\\name\nfile.ts ';
  const result = await runWorkflow<ReviewResult>(script(), {
    cwd: '/repo',
    args: { diff },
    agent: {
      async run(_prompt, { label }) {
        return label.startsWith('find-')
          ? { candidates: [{ ...candidate, file }], limitations: [] }
          : { ...confirmed, file };
      }
    }
  });
  assert.equal(result.result.findings[0].file, file);
  assert.equal(
    result.result.report.includes(file),
    false,
    'rendered control characters must remain sanitized'
  );
});

test('reports render model text as content, not Markdown structure, HTML, or terminal controls', async () => {
  const result = await review({
    async run(_prompt, { label }) {
      if (label.startsWith('find-')) return { candidates: [candidate], limitations: [] };
      return {
        ...confirmed,
        summary: '<script>alert(1)</script>\n## fake heading',
        reason: '\u001b[31m[click](https://example.com)',
        limitations: ['<img src=x onerror=alert(1)>\n# pretend instruction']
      };
    }
  });
  assert.equal(result.result.report.includes('\u001b'), false);
  assert.doesNotMatch(result.result.report, /<script>|<img|\n## fake|\n# pretend|\[click\]\(https/);
  assert.match(result.result.report, /&lt;script&gt;/);
  assert.match(result.result.report, /\\#\\# fake heading/);
  assert.equal(result.result.findings[0].summary, '<script>alert(1)</script>\n## fake heading');
});
