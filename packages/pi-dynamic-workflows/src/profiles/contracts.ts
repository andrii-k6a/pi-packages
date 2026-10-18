import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { terminalInput } from '../shared/terminal-text.js';

export interface WorkflowProfile {
  name: string;
  description: string;
  /** Optional provider. When omitted, resolve the model on the active session provider. */
  provider?: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface ResolvedWorkflowProfile {
  /** Only provider and model identity are needed to route a durable subagent. */
  model: Pick<Model<Api>, 'provider' | 'id'>;
  thinkingLevel: ThinkingLevel;
}

export interface WorkflowProfileResolverContext {
  model: Model<Api> | undefined;
  modelRegistry: {
    find(provider: string, modelId: string): Model<Api> | undefined;
    getAvailable(): Model<Api>[];
  };
  /** Empty or absent when no session model scope is configured. */
  scopedModels?: readonly {
    model: Model<Api>;
    thinkingLevel?: ThinkingLevel;
  }[];
}

export type WorkflowProfileResolver = (name: string) => ResolvedWorkflowProfile;

export class WorkflowProfileRoutingError extends Error {
  constructor(profileName: string, reason: string) {
    super(`Cannot route workflow profile ${describeProfileText(profileName)}: ${reason}`);
    this.name = 'WorkflowProfileRoutingError';
  }
}

/** Consistent, bounded representation of user-owned text in profile errors. */
export function boundedProfileText(value: string, maxLength = 160): string {
  const characters = [...terminalInput(value)];
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength).join('')}…`
    : characters.join('');
}

export function describeProfileText(value: string): string {
  return JSON.stringify(boundedProfileText(value));
}
