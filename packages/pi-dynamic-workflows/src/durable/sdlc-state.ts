import type { JsonValue } from '@earendil-works/chord';
import { defineDoc } from '@earendil-works/pi-durable';
import type {
  SdlcArgs,
  SdlcBrief,
  SdlcCheck,
  SdlcFinding,
  SdlcLimits,
  SdlcOutcome,
  SdlcQuestionInput,
  SdlcReview,
  SdlcTaskContract
} from '../workflow/sdlc/contracts.js';
import type { StoredUsage } from './docs.js';
import type { SdlcWorkspace } from './sdlc-workspace.js';

export type SdlcQuestion = SdlcQuestionInput & {
  briefRevision: number;
  answer?: string;
  answeredAt?: number;
};
export type SdlcTask = SdlcTaskContract & {
  revision: number;
  planRevision: number;
  briefRevision: number;
  kind: 'analysis' | 'implementation' | 'review';
  status: 'pending' | 'preparing' | 'running' | 'completed' | 'failed' | 'invalidated';
  inputRevision?: string;
  candidateRevision?: string;
  outputRevision?: string;
  workspace?: SdlcWorkspace;
  /** Pinned before admission; recovery never hashes a partially edited checkout. */
  prompt?: string;
  role?: string;
  resolvedRole?: JsonValue;
  schema?: JsonValue;
  result?: JsonValue;
  error?: string;
  changedFiles?: string[];
  ownershipViolations?: string[];
  filesBefore?: Record<string, string>;
  forkBaseRevision?: string;
  settled?: boolean;
  /** Bounded independent review work uses the same reviewer role and inspection ceiling. */
  reviewContext?: {
    purpose: 'specialist' | 'verification' | 'synthesis';
    parentTaskId: string;
    scope: string;
    sourceReviewIds: string[];
    findingIds: string[];
  };
  /** A retried or invalidated assignment is replaced once; later continuations must not resurrect it. */
  supersededBy?: string;
  integration?: {
    expectedRevision: string;
    status: 'intent' | 'completed' | 'conflict' | 'resolved';
    outputRevision?: string;
    error?: string;
    resolutionTaskId?: string;
  };
};
export type SdlcEvidence = {
  id: string;
  kind: 'check' | 'review' | 'artifact' | 'import';
  producingTask: string;
  briefRevision: number;
  goalRevision: number;
  inputRevision: string;
  candidateRevision: string;
  scope: string[];
  dependencies: string[];
  result: JsonValue;
  limitations: string[];
  invalidatedBy?: string;
};
export type SdlcCheckResult = {
  id: string;
  command: SdlcCheck;
  cwd: string;
  environment: string;
  candidateRevision: string;
  startedAt: number;
  endedAt: number;
  status: 'passed' | 'failed' | 'unavailable' | 'empty' | 'unknown' | 'interrupted';
  exitCode?: number;
  testCount?: number;
  output: string;
  truncated: boolean;
  error?: string;
  classification?:
    | 'baseline-failure'
    | 'introduced-failure'
    | 'missing-baseline'
    | 'missing-coverage';
};
export type SdlcAssessment = {
  id: string;
  goalRevision: number;
  candidateRevision: string;
  reviewTask: string;
  /** Corrections already spent when this candidate was assessed; absent on older records. */
  correctionCount?: number;
  findingDispositions?: SdlcReview['findingDispositions'];
  codeReview: SdlcReview['codeReview'];
  outcomes: SdlcReview['outcomes'];
  coverageGaps: string[];
  accepted: boolean;
};
export type SdlcResult = {
  operationId: string;
  outcome: SdlcOutcome;
  goalRevision: number;
  workspace: SdlcWorkspace;
  candidateRevision: string;
  changedFiles: string[];
  assessmentId?: string;
  acceptanceEvidence: string[];
  findingDispositions: SdlcReview['findingDispositions'];
  unresolvedWork: string[];
  pendingQuestions: SdlcQuestion[];
  limits: SdlcLimits;
  consumed: SdlcState['consumed'];
  usage: StoredUsage;
  report: string;
};
export type SdlcState = {
  version: 1;
  operationId: string;
  args: SdlcArgs;
  brief: SdlcBrief;
  briefHistory: SdlcBrief[];
  plans: Array<{
    revision: number;
    reason: string;
    shape: 'single' | 'sequential' | 'parallel' | 'investigation';
    taskIds: string[];
    briefRevision: number;
  }>;
  tasks: SdlcTask[];
  questions: SdlcQuestion[];
  workspace: SdlcWorkspace;
  setup: 'intent' | 'ready';
  candidateRevision: string;
  changedFiles: string[];
  evidence: SdlcEvidence[];
  assessments: SdlcAssessment[];
  checks: Array<{
    id: string;
    phase: 'baseline' | 'task' | 'integration';
    taskId: string;
    candidateRevision: string;
    status: 'intent' | 'completed';
    result?: SdlcCheckResult;
  }>;
  importedFindings: SdlcFinding[];
  importedUsage: StoredUsage;
  limits: SdlcLimits;
  consumed: { tasks: number; corrections: number; replans: number; failedTasks: number };
  usage: StoredUsage;
  roleSnapshots: Record<string, JsonValue>;
  decisions: Array<{
    id: string;
    at: number;
    kind: string;
    reason: string;
    inputRevision: string;
    taskIds: string[];
  }>;
  extensions: Array<{ at: number; previous: SdlcLimits; next: SdlcLimits; reason: string }>;
  continuation: number;
  /** Last continuation whose starting target revision was reconciled. */
  adoptedContinuation?: number;
  activity: string;
  outcome?: SdlcOutcome;
  result?: SdlcResult;
  stopReason?: string;
};

/** New documents only. Legacy runs have no SDLC state and retain their original semantics. */
export const WorkflowSdlcDoc = defineDoc<{ state: SdlcState | null }>({
  kind: 'workflow.sdlc',
  version: 1,
  scope: 'session',
  initial: () => ({ state: null })
});
