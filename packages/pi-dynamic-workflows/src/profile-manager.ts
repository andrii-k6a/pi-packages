import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel
} from '@earendil-works/pi-ai';
import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import { Input, Key, matchesKey, type TUI, truncateToWidth } from '@earendil-works/pi-tui';
import {
  loadWorkflowProfiles,
  sanitizeWorkflowProfileText,
  saveWorkflowProfiles,
  type WorkflowProfile
} from './profiles.js';

type ProfileEditor = Partial<WorkflowProfile>;

type ProfileManagerAction = 'edit' | 'new' | 'delete' | 'reload' | 'close' | undefined;

export class WorkflowProfileTextInput {
  readonly #input = new Input();
  #focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    title: string,
    initialValue: string,
    done: (value: string | undefined) => void
  ) {
    this.title = title;
    this.#input.setValue(sanitizeWorkflowProfileText(initialValue));
    this.#input.onSubmit = (value) => done(sanitizeWorkflowProfileText(value));
    this.#input.onEscape = () => done(undefined);
  }

  readonly title: string;

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#input.focused = value;
  }

  handleInput(data: string): void {
    this.#input.handleInput(data);
    const sanitized = sanitizeWorkflowProfileText(this.#input.getValue());
    if (sanitized !== this.#input.getValue()) this.#input.setValue(sanitized);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.#input.invalidate();
  }

  render(width: number): string[] {
    return [
      this.theme.fg('accent', this.title),
      ...this.#input.render(width),
      this.theme.fg('dim', 'Enter submit  Esc cancel')
    ];
  }
}

/** Returns the selected row after a list mutation, preserving a valid cursor. */
export function selectedProfileIndex(index: number, profileCount: number): number {
  return Math.max(0, Math.min(index, Math.max(0, profileCount - 1)));
}

/** Applies a single navigation key to a selected profile row. */
export function nextProfileIndex(index: number, profileCount: number, data: string): number {
  if (matchesKey(data, Key.down) || matchesKey(data, 'j'))
    return selectedProfileIndex(index + 1, profileCount);
  if (matchesKey(data, Key.up) || matchesKey(data, 'k'))
    return selectedProfileIndex(index - 1, profileCount);
  return selectedProfileIndex(index, profileCount);
}

export class WorkflowProfileList {
  #profiles: WorkflowProfile[];
  #selected = 0;
  #cachedWidth = -1;
  #cachedLines: string[] = [];

  constructor(
    profiles: readonly WorkflowProfile[],
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly onAction: (action: ProfileManagerAction, profile?: WorkflowProfile) => void
  ) {
    this.#profiles = [...profiles];
  }

  handleInput(data: string): void {
    const next = nextProfileIndex(this.#selected, this.#profiles.length, data);
    if (next !== this.#selected) {
      this.#selected = next;
      this.#refresh();
      return;
    }

    let action: ProfileManagerAction;
    if (matchesKey(data, Key.enter) || matchesKey(data, 'e')) action = 'edit';
    else if (matchesKey(data, 'n')) action = 'new';
    else if (matchesKey(data, 'd')) action = 'delete';
    else if (matchesKey(data, 'r')) action = 'reload';
    else if (matchesKey(data, 'q') || matchesKey(data, Key.escape)) action = 'close';
    else return;

    this.onAction(action, this.#profiles[this.#selected]);
  }

  render(width: number): string[] {
    if (this.#cachedWidth === width) return this.#cachedLines;

    const title = this.#border(width, ' /workflow-profiles ');
    const rows = this.#profiles.length
      ? this.#profiles.map((profile, index) => {
          const marker = index === this.#selected ? '› ' : '  ';
          const text = `${marker}${sanitizeWorkflowProfileText(profile.name)}  ${sanitizeWorkflowProfileText(profile.model)}  ${sanitizeWorkflowProfileText(profile.description)}`;
          return truncateToWidth(
            index === this.#selected ? this.theme.fg('accent', text) : this.theme.fg('text', text),
            width,
            ''
          );
        })
      : [truncateToWidth(this.theme.fg('muted', '  No profiles configured.'), width, '')];
    const help = this.theme.fg(
      'dim',
      ' j/k or ↑/↓ move  Enter/e edit  n new  d delete  r reload  q/Esc close '
    );
    this.#cachedLines = [
      title,
      ...rows,
      this.#border(width, ' profiles '),
      truncateToWidth(help, width, '')
    ];
    this.#cachedWidth = width;
    return this.#cachedLines;
  }

  invalidate(): void {
    this.#cachedWidth = -1;
    this.#cachedLines = [];
  }

  #refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  #border(width: number, label: string): string {
    if (width <= 0) return '';
    if (width <= label.length) return this.theme.fg('accent', '─'.repeat(width));
    const left = Math.floor((width - label.length) / 2);
    return this.theme.fg(
      'accent',
      `${'─'.repeat(left)}${label}${'─'.repeat(width - left - label.length)}`
    );
  }
}

export async function openWorkflowProfileManager(
  ctx: ExtensionCommandContext,
  agentDir?: string
): Promise<void> {
  if (ctx.mode !== 'tui') {
    ctx.ui.notify('/workflow-profiles requires interactive mode', 'error');
    return;
  }

  let profiles: WorkflowProfile[];
  try {
    profiles = loadWorkflowProfiles(agentDir);
  } catch (error) {
    ctx.ui.notify(errorMessage(error), 'error');
    return;
  }

  while (true) {
    const { action, profile } = await showWorkflowProfileList(ctx, profiles);
    if (action === 'close' || !action) return;
    if (action === 'reload') {
      await ctx.reload();
      return;
    }

    const nextProfiles = await profilesForAction(action, profile, profiles, ctx);
    if (!nextProfiles) continue;

    try {
      saveWorkflowProfiles(nextProfiles, agentDir);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), 'error');
      continue;
    }

    // A profile mutation changes the tool's captured profile list, so reload before
    // accepting another command or workflow.
    await ctx.reload();
    return;
  }
}

function showWorkflowProfileList(
  ctx: ExtensionCommandContext,
  profiles: WorkflowProfile[]
): Promise<{ action: ProfileManagerAction; profile?: WorkflowProfile }> {
  return ctx.ui.custom(
    (tui, theme, _keybindings, done) =>
      new WorkflowProfileList(profiles, tui, theme, (action, profile) => done({ action, profile })),
    {
      overlay: true,
      overlayOptions: { anchor: 'center', width: '70%', minWidth: 48 }
    }
  );
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
  const name = await inputWorkflowProfileText(ctx, 'Profile name', initial.name ?? '');
  if (name === undefined) return undefined;
  const description = await inputWorkflowProfileText(
    ctx,
    'Profile description',
    initial.description ?? ''
  );
  if (description === undefined) return undefined;

  const models = selectableModels(ctx);
  if (models.length === 0) {
    ctx.ui.notify('No available models can be used for workflow profiles', 'error');
    return undefined;
  }

  const activeProvider = activeProviderFor(ctx, models);
  const activeProviderOption = activeProvider
    ? `Use active session provider (${activeProvider})`
    : undefined;
  const providers = [...new Set(models.map((model) => model.provider))].sort();
  const providerOptions = prioritize(
    [...(activeProviderOption ? [activeProviderOption] : []), ...providers],
    initial.provider ? initial.provider : activeProviderOption
  );
  const providerChoice = await ctx.ui.select('Provider', providerOptions);
  if (!providerChoice || !providerOptions.includes(providerChoice)) return undefined;

  const provider = providerChoice === activeProviderOption ? undefined : providerChoice;
  const modelProvider = provider ?? activeProvider;
  if (!modelProvider) return undefined;
  const providerModels = models.filter((model) => model.provider === modelProvider);
  if (providerModels.length === 0) return undefined;

  const preferredModel =
    initial.model && (initial.provider ?? activeProvider) === modelProvider
      ? initial.model
      : ctx.model?.provider === modelProvider
        ? ctx.model.id
        : undefined;
  const modelOptions = prioritize(
    providerModels.map((model) => model.id),
    preferredModel
  );
  const modelChoice = await ctx.ui.select('Model', modelOptions);
  const model = providerModels.find((candidate) => candidate.id === modelChoice);
  if (!model) return undefined;

  const scopedThinkingLevel = scopedThinkingLevelFor(ctx, model);
  const modelThinkingLevels = getSupportedThinkingLevels(model);
  if (scopedThinkingLevel && !modelThinkingLevels.includes(scopedThinkingLevel)) {
    ctx.ui.notify(
      'The session-scoped thinking level is unsupported by the selected model; profile was not saved',
      'error'
    );
    return undefined;
  }
  const supportedThinkingLevels = scopedThinkingLevel ? [scopedThinkingLevel] : modelThinkingLevels;
  const preferredThinkingLevel = initial.thinkingLevel ?? ctx.thinkingLevel ?? 'off';
  const thinkingOptions = prioritize(
    supportedThinkingLevels,
    supportedThinkingLevels.includes(preferredThinkingLevel) ? preferredThinkingLevel : undefined
  );
  const thinkingLevel = await ctx.ui.select('Thinking level', thinkingOptions);
  if (!thinkingLevel || !supportedThinkingLevels.includes(thinkingLevel as ModelThinkingLevel))
    return undefined;

  return {
    name,
    description,
    ...(provider ? { provider } : {}),
    model: model.id,
    thinkingLevel: thinkingLevel as ThinkingLevel
  };
}

function inputWorkflowProfileText(
  ctx: ExtensionCommandContext,
  title: string,
  initialValue: string
): Promise<string | undefined> {
  return ctx.ui.custom(
    (tui, theme, _keybindings, done) =>
      new WorkflowProfileTextInput(tui, theme, title, initialValue, done),
    { overlay: true, overlayOptions: { anchor: 'center', width: '70%', minWidth: 48 } }
  );
}

function selectableModels(ctx: ExtensionCommandContext): Model<Api>[] {
  const available = ctx.modelRegistry.getAvailable();
  const scoped = new Set(ctx.scopedModels.map(({ model }) => modelKey(model)));
  const candidates = ctx.scopedModels.length
    ? available.filter((model) => scoped.has(modelKey(model)))
    : available;
  const safeCandidates = candidates.filter(
    (model) =>
      sanitizeWorkflowProfileText(model.provider) === model.provider &&
      sanitizeWorkflowProfileText(model.id) === model.id
  );
  return safeCandidates.filter(
    (model, index) =>
      safeCandidates.findIndex((candidate) => modelKey(candidate) === modelKey(model)) === index
  );
}

function scopedThinkingLevelFor(
  ctx: ExtensionCommandContext,
  model: Model<Api>
): ThinkingLevel | undefined {
  return ctx.scopedModels.find(({ model: scoped }) => modelKey(scoped) === modelKey(model))
    ?.thinkingLevel;
}

function activeProviderFor(
  ctx: ExtensionCommandContext,
  models: readonly Model<Api>[]
): string | undefined {
  const provider = ctx.model?.provider;
  return provider && models.some((model) => model.provider === provider) ? provider : undefined;
}

function modelKey(model: Model<Api>): string {
  return `${model.provider}\u0000${model.id}`;
}

function prioritize<T>(items: readonly T[], preferred: T | undefined): T[] {
  if (preferred === undefined) return [...items];
  const index = items.indexOf(preferred);
  return index < 0
    ? [...items]
    : [...items.slice(index, index + 1), ...items.slice(0, index), ...items.slice(index + 1)];
}

function errorMessage(error: unknown): string {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = 'Unknown error';
  }
  const characters = [...sanitizeWorkflowProfileText(message)].filter((character) => {
    const codePoint = character.codePointAt(0) ?? -1;
    return ![27, 144, 155, 157, 158, 159].includes(codePoint);
  });
  const bounded = characters.slice(0, 240).join('');
  return characters.length > 240 ? `${bounded}…` : bounded || 'Unknown error';
}
