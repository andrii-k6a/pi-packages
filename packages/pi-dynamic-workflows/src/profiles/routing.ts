import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import {
  type WorkflowProfile,
  type WorkflowProfileResolver,
  type WorkflowProfileResolverContext,
  WorkflowProfileRoutingError
} from './contracts.js';

export function createWorkflowProfileResolver(
  profiles: readonly WorkflowProfile[],
  context: WorkflowProfileResolverContext
): WorkflowProfileResolver {
  const profilesByName = new Map(profiles.map((profile) => [profile.name, profile]));

  return (name) => {
    const profile = profilesByName.get(name);
    if (!profile) throw new WorkflowProfileRoutingError(name, 'the profile is not approved');

    const provider = profile.provider ?? context.model?.provider;
    if (!provider) {
      throw new WorkflowProfileRoutingError(
        name,
        'there is no configured provider or active session model to anchor routing'
      );
    }
    const model = context.modelRegistry.find(provider, profile.model);
    if (!model || model.provider !== provider) {
      throw new WorkflowProfileRoutingError(
        name,
        'the configured provider does not expose the configured model'
      );
    }

    const isAvailable = context.modelRegistry
      .getAvailable()
      .some((available) => available.provider === provider && available.id === model.id);
    if (!isAvailable) {
      throw new WorkflowProfileRoutingError(
        name,
        'the configured model is unavailable from its configured provider'
      );
    }

    const scopedModels = context.scopedModels ?? [];
    const scopedModel = scopedModels.find(
      ({ model: scoped }) => scoped.provider === model.provider && scoped.id === model.id
    );
    if (scopedModels.length > 0 && !scopedModel) {
      throw new WorkflowProfileRoutingError(
        name,
        'the configured model is outside the session model scope'
      );
    }
    if (
      scopedModel?.thinkingLevel !== undefined &&
      profile.thinkingLevel !== scopedModel.thinkingLevel
    ) {
      throw new WorkflowProfileRoutingError(
        name,
        'the configured thinking level does not match the session-scoped model pin'
      );
    }

    if (!getSupportedThinkingLevels(model).includes(profile.thinkingLevel)) {
      throw new WorkflowProfileRoutingError(
        name,
        'the configured thinking level is unsupported by the selected model'
      );
    }

    return { model, thinkingLevel: profile.thinkingLevel };
  };
}
