import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { loadWorkflowProfileConfig, saveWorkflowProfileConfig } from '../../profiles/config.js';
import type { WorkflowProfile, WorkflowProfileConfig } from '../../profiles/contracts.js';
import { terminalLine } from '../../shared/terminal-text.js';
import { activeProviderFor, selectableModels } from './choices.js';
import { type ProfileManagerAction, WorkflowProfileList } from './list.js';
import { type ProfileEditor, WorkflowProfileWizard } from './wizard.js';

/** Command orchestration only: components own interaction; profiles/config.ts owns persistence. */
export async function openWorkflowProfileManager(
  ctx: ExtensionCommandContext,
  agentDir?: string
): Promise<void> {
  if (ctx.mode !== 'tui') {
    ctx.ui.notify('/workflow-profiles requires interactive mode', 'error');
    return;
  }

  let config: WorkflowProfileConfig;
  try {
    config = loadWorkflowProfileConfig(agentDir);
  } catch (error) {
    ctx.ui.notify(errorMessage(error), 'error');
    return;
  }

  while (true) {
    const { action, profile } = await showWorkflowProfileList(ctx, config);
    if (action === 'close' || !action) return;
    if (action === 'reload') {
      await ctx.reload();
      return;
    }

    const nextConfig = await configForAction(action, profile, config, ctx);
    if (!nextConfig) continue;

    try {
      saveWorkflowProfileConfig(nextConfig, agentDir);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), 'error');
      continue;
    }

    // A configuration change alters the tool's captured profile list, so reload before
    // accepting another command or workflow. Never reuse ctx after reload.
    await ctx.reload();
    return;
  }
}

function showWorkflowProfileList(
  ctx: ExtensionCommandContext,
  config: WorkflowProfileConfig
): Promise<{ action: ProfileManagerAction; profile?: WorkflowProfile }> {
  return ctx.ui.custom(
    (tui, theme, _keybindings, done) =>
      new WorkflowProfileList(
        config.profiles,
        tui,
        theme,
        (action, profile) => done({ action, profile }),
        config.enabled
      )
  );
}

async function configForAction(
  action: ProfileManagerAction,
  profile: WorkflowProfile | undefined,
  config: WorkflowProfileConfig,
  ctx: ExtensionCommandContext
): Promise<WorkflowProfileConfig | undefined> {
  if (action === 'toggle') return { ...config, enabled: !config.enabled };
  const profiles = await profilesForAction(action, profile, config.profiles, ctx);
  return profiles && { ...config, profiles };
}

async function profilesForAction(
  action: ProfileManagerAction,
  profile: WorkflowProfile | undefined,
  profiles: WorkflowProfile[],
  ctx: ExtensionCommandContext
): Promise<WorkflowProfile[] | undefined> {
  if (action === 'new') {
    const next = await editWorkflowProfile(ctx, {});
    return next ? [...profiles, next] : undefined;
  }
  if (action === 'edit' && profile) {
    const next = await editWorkflowProfile(ctx, profile);
    return next
      ? profiles.map((current) => (current.name === profile.name ? next : current))
      : undefined;
  }
  if (action === 'delete' && profile) {
    const confirmed = await ctx.ui.confirm('Delete workflow profile?', profile.name);
    return confirmed ? profiles.filter((current) => current.name !== profile.name) : undefined;
  }
  return undefined;
}

async function editWorkflowProfile(
  ctx: ExtensionCommandContext,
  initial: ProfileEditor
): Promise<WorkflowProfile | undefined> {
  const models = selectableModels(ctx);
  if (models.length === 0) {
    ctx.ui.notify('No available models can be used for workflow profiles', 'error');
    return undefined;
  }

  const activeProvider = activeProviderFor(ctx, models);
  return ctx.ui.custom(
    (tui, theme, _keybindings, done) =>
      new WorkflowProfileWizard(
        tui,
        theme,
        models,
        ctx.scopedModels,
        activeProvider,
        ctx.model?.id,
        ctx.thinkingLevel,
        initial,
        (message) => ctx.ui.notify(message, 'error'),
        done
      )
  );
}

function errorMessage(error: unknown): string {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = 'Unknown error';
  }
  const characters = [...terminalLine(message)];
  const bounded = characters.slice(0, 240).join('');
  return characters.length > 240 ? `${bounded}…` : bounded || 'Unknown error';
}
