export type SdlcOutcome =
  | 'accepted'
  | 'no-work'
  | 'needs-input'
  | 'blocked'
  | 'incomplete'
  | 'cancelled';
export type SdlcStage = 'analyst' | 'implementer' | 'reviewer';
export type SdlcLimits = {
  maxTasks: number;
  correctionRounds: number;
  replans: number;
  concurrency: number;
  taskTimeoutMs: number;
  checkTimeoutMs: number;
  tokenBudget: number;
};

/** Product policies, not estimates of an optimal team size or context allocation. */
export const DEFAULT_SDLC_LIMITS: Readonly<SdlcLimits> = Object.freeze({
  maxTasks: 24,
  correctionRounds: 3,
  replans: 2,
  concurrency: 2,
  taskTimeoutMs: 15 * 60_000,
  checkTimeoutMs: 5 * 60_000,
  tokenBudget: 500_000
});

export type SdlcRequirement = {
  id: string;
  description: string;
  verification: 'behavioral' | 'inspection';
  checkIds: string[];
};
export type SdlcCheck = {
  id: string;
  argv: string[];
  kind: 'test' | 'check';
  /** Relative directory inside the selected workspace. */
  cwd?: string;
  /** Required outcomes for which this check supplies evidence. */
  outcomes: string[];
};
export type SdlcQuestionInput = {
  id: string;
  text: string;
  choices?: string[];
  affectedTasks: string[];
};
export type SdlcTaskContract = {
  id: string;
  title: string;
  outcome: string;
  dependsOn: string[];
  /** Literal relative files or directory prefixes. An asterisk grants the whole workspace. */
  writes: string[];
  inputs: string[];
  checks: string[];
  questionIds: string[];
};
export type SdlcPlanInput = {
  reason: string;
  tasks: SdlcTaskContract[];
};
export type SdlcArgs = {
  goal: string;
  context?: string | string[];
  constraints?: string[];
  acceptance?: Array<
    | string
    | {
        id?: string;
        description: string;
        verification?: 'behavioral' | 'inspection';
        checkIds?: string[];
      }
  >;
  checks?: SdlcCheck[];
  questions?: SdlcQuestionInput[];
  unresolvedDecisions?: string[];
  planning?: 'auto' | 'investigate';
  plan?: SdlcPlanInput;
  evidence?: Array<{ kind: 'code-review'; runId: string; attempt: number }>;
  workspace?: { mode: 'existing' | 'isolated'; cwd?: string };
  policy?: {
    roles?: Partial<Record<SdlcStage, string>>;
    profile?: string;
    phaseProfiles?: Partial<Record<SdlcStage, string>>;
    /** Heuristic fraction of usable context, not cumulative billed tokens. Default 0.5. */
    contextTarget?: number;
    /** Usable window for heuristic planning, including tools, instructions and response headroom. */
    contextWindowTokens?: number;
    limits?: Partial<SdlcLimits>;
  };
  /** Explicit caller assertion of an already empty scope, never inferred from model output. */
  noWork?: { confirmed: true; reason: string };
};
export type SdlcBrief = {
  originalGoal: string;
  goal: string;
  revision: number;
  goalRevision: number;
  context: string[];
  constraints: string[];
  acceptance: SdlcRequirement[];
  assumptions: string[];
  unresolvedDecisions: string[];
  clarifications: Array<{ questionId: string; answer: string; atRevision: number }>;
};
export type SdlcAnswer = { questionId: string; briefRevision: number; answer: string };
export type ContinueSdlcOptions = {
  answers?: SdlcAnswer[];
  /** Optimistic concurrency guard for an authorized goal change. */
  goalRevision?: number;
  goal?: string;
  context?: string[];
  constraints?: string[];
  /** Replaces explicit criteria only with a recorded authorized goal revision. */
  acceptance?: SdlcArgs['acceptance'];
  /** Add authorized verification commands. Existing commands and criteria cannot be weakened. */
  checks?: SdlcCheck[];
  limits?: Partial<SdlcLimits>;
  resumeProfile?: string;
};
export type SdlcFinding = {
  id: string;
  file: string;
  line: number;
  summary: string;
  evidence: string;
  priority: number;
  scenario: string;
  alternative: string;
  references: Array<{ file: string; line: number; observation: string }>;
  verdict: 'CONFIRMED' | 'REFUTED' | 'UNCERTAIN';
  reason: string;
  counterevidence: string;
  limitations: string[];
};
export type SdlcReview = {
  goalRevision: number;
  candidateRevision: string;
  codeReview: {
    verdict: 'pass' | 'changes-requested' | 'unverified';
    findings: SdlcFinding[];
    limitations: string[];
  };
  outcomes: Array<{
    id: string;
    status: 'met' | 'not-met' | 'unverified';
    evidenceIds: string[];
    /** Configured checks independently inspected as evidence for this outcome. */
    checkIds?: string[];
    observations: Array<{ file: string; line: number; observation: string }>;
    reason: string;
  }>;
  findingDispositions: Array<{
    id: string;
    disposition: 'confirmed' | 'refuted' | 'uncertain' | 'resolved' | 'deferred';
    reason: string;
    /** Current source evidence required to close an imported or operation finding. */
    observations?: Array<{ file: string; line: number; observation: string }>;
  }>;
  coverageGaps: string[];
  /** At most two bounded inspection scopes that the initial reviewer cannot cover alone. */
  reviewRequests?: Array<{ scope: string; reason: string }>;
};
