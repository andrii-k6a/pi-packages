import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { terminalInput } from '../../shared/terminal-text.js';

export type ScopedModelRoute = { model: Model<Api>; thinkingLevel?: ThinkingLevel };

export function selectableModels(ctx: ExtensionCommandContext): Model<Api>[] {
  const available = ctx.modelRegistry.getAvailable();
  const scoped = new Set(ctx.scopedModels.map(({ model }) => modelKey(model)));
  const candidates = ctx.scopedModels.length
    ? available.filter((model) => scoped.has(modelKey(model)))
    : available;
  const safeCandidates = candidates.filter(
    (model) =>
      terminalInput(model.provider) === model.provider && terminalInput(model.id) === model.id
  );
  return safeCandidates.filter(
    (model, index) =>
      safeCandidates.findIndex((candidate) => modelKey(candidate) === modelKey(model)) === index
  );
}

export function scopedThinkingLevelFor(
  scopedModels: readonly ScopedModelRoute[],
  model: Model<Api>
): ThinkingLevel | undefined {
  return scopedModels.find(({ model: scoped }) => modelKey(scoped) === modelKey(model))
    ?.thinkingLevel;
}

export function activeProviderFor(
  ctx: ExtensionCommandContext,
  models: readonly Model<Api>[]
): string | undefined {
  const provider = ctx.model?.provider;
  return provider && models.some((model) => model.provider === provider) ? provider : undefined;
}

function modelKey(model: Model<Api>): string {
  return `${model.provider}\u0000${model.id}`;
}
