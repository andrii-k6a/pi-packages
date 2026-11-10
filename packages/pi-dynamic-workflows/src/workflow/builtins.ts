import { CODE_REVIEW_SCRIPT } from './builtins/code-review.js';
import { MAX_REVIEW_DIFF_CHARS, validateCodeReviewArgs } from './builtins/code-review-input.js';

export const BUILTIN_WORKFLOWS = [
  {
    name: 'code-review',
    description:
      'Review behavior, architecture, and maintainability with independent verification. In changes mode, new named starts capture local changes automatically when diff is absent. args: { mode?: "changes", base?: string, path?: string, trackedOnly?: boolean, goal?: string, profile?: string }. base selects the merge base with captured HEAD. Automatic capture includes local edits and eligible untracked additions. It does not fetch. Omit path for the whole repository, or use a literal path relative to the calling directory. Alternatively supply { diff: string, diffSource?: string, goal?: string, baseCommit?: string, profile?: string } without base/path/trackedOnly. Supplied diffs are authoritative and need no Git. Audit existing code with { mode: "files", path: string, goal?: string, profile?: string }, also without Git. Resume uses stored prepared inputs without recapture.',
    resolve(value: object = {}): string {
      validateCodeReviewArgs(value, MAX_REVIEW_DIFF_CHARS);
      return CODE_REVIEW_SCRIPT;
    }
  }
] as const;

export function resolveBuiltinWorkflow(name: string, args?: object): string {
  const builtin = BUILTIN_WORKFLOWS.find((workflow) => workflow.name === name);
  if (!builtin) {
    throw new Error(
      `Unknown built-in workflow ${JSON.stringify(name)}. Available: ${BUILTIN_WORKFLOWS.map((workflow) => workflow.name).join(', ')}`
    );
  }
  return builtin.resolve(args);
}
