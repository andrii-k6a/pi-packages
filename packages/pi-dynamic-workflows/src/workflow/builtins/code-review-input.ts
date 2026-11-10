export const MAX_REVIEW_DIFF_CHARS = 200_000;

export interface CodeReviewCapture {
  target: string;
  untracked: 'included' | 'excluded';
  includedAdditions: string[];
  exclusions: Array<{ path: string; reason: string }>;
  comparison?: {
    headCommit: string;
    commit: string;
    baseRef?: string;
    baseTipCommit?: string;
    localChanges: boolean;
  };
}

export interface CodeReviewArgs {
  mode?: 'changes' | 'files';
  diff?: string;
  diffSource?: string;
  baseCommit?: string;
  path?: string;
  goal?: string;
  profile?: string;
  capture?: CodeReviewCapture;
}

// This self-contained function is also embedded in the stored script. Keep its dependencies local
// so replacement arguments receive the same validation after a restart, without interpreter I/O.
export function validateCodeReviewArgs(
  value: unknown,
  maxDiffChars: number
): asserts value is CodeReviewArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Code review requires args to be an object');
  }
  const args = value as Record<string, unknown>;
  if (args.mode !== undefined && args.mode !== 'changes' && args.mode !== 'files') {
    throw new Error('Code review requires args.mode to be "changes" or "files"');
  }
  for (const key of ['diffSource', 'goal', 'baseCommit', 'path', 'profile']) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      throw new Error(`Code review requires args.${key} to be a string`);
    }
  }
  for (const key of ['baseCommit', 'path', 'profile']) {
    if (typeof args[key] === 'string' && !args[key].trim()) {
      throw new Error(`Code review requires args.${key} to be a non-empty string`);
    }
  }
  if (['base', 'trackedOnly'].some((key) => key in args)) {
    throw new Error(
      'Code review prepared inputs cannot include automatic-capture args.base or args.trackedOnly'
    );
  }
  if (args.mode === 'files') {
    if (typeof args.path !== 'string' || !args.path.trim()) {
      throw new Error('Code review requires args.path to be a non-empty string in files mode');
    }
    if (['diff', 'diffSource', 'baseCommit', 'capture'].some((key) => key in args)) {
      throw new Error(
        'Code review files mode cannot include diff, diffSource, baseCommit, or capture'
      );
    }
  } else {
    if ('path' in args) {
      throw new Error('Code review changes mode accepts a supplied diff, not args.path');
    }
    if (typeof args.diff !== 'string' || !args.diff.trim()) {
      throw new Error('Code review requires args.diff to be a non-empty string');
    }
    if (args.diff.length > maxDiffChars) {
      throw new Error(
        'Code review accepts at most ' +
          maxDiffChars +
          ' diff characters. Supply a smaller diff or select a narrower /code-review path.'
      );
    }
  }
  if (args.capture !== undefined) {
    const capture = args.capture as Partial<CodeReviewCapture> | null;
    if (
      !capture ||
      typeof capture !== 'object' ||
      Array.isArray(capture) ||
      typeof capture.target !== 'string' ||
      !capture.target.trim() ||
      !['included', 'excluded'].includes(capture.untracked ?? '') ||
      !Array.isArray(capture.includedAdditions) ||
      !capture.includedAdditions.every((path) => typeof path === 'string' && path.length > 0) ||
      !Array.isArray(capture.exclusions) ||
      !capture.exclusions.every(
        (entry) =>
          entry &&
          typeof entry.path === 'string' &&
          typeof entry.reason === 'string' &&
          entry.path.length > 0 &&
          entry.reason.length > 0
      )
    ) {
      throw new Error('Code review requires valid captured scope metadata');
    }
    if (capture.comparison !== undefined) {
      const comparison = capture.comparison;
      const commitId = (id: unknown) =>
        typeof id === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id);
      if (
        !comparison ||
        typeof comparison !== 'object' ||
        Array.isArray(comparison) ||
        !commitId(comparison.headCommit) ||
        !commitId(comparison.commit) ||
        comparison.commit !== args.baseCommit ||
        typeof comparison.localChanges !== 'boolean' ||
        (comparison.baseRef !== undefined &&
          (typeof comparison.baseRef !== 'string' || !comparison.baseRef.trim())) ||
        (comparison.baseTipCommit !== undefined && !commitId(comparison.baseTipCommit)) ||
        (comparison.baseRef === undefined) !== (comparison.baseTipCommit === undefined)
      ) {
        throw new Error('Code review requires valid captured comparison metadata');
      }
    }
  }
}
