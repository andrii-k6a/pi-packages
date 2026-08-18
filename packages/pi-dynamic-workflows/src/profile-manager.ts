import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { type Api, getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai';
import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  type Focusable,
  Input,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth
} from '@earendil-works/pi-tui';
import {
  loadWorkflowProfiles,
  sanitizeWorkflowProfileText,
  saveWorkflowProfiles,
  type WorkflowProfile
} from './profiles.js';

type ProfileEditor = Partial<WorkflowProfile>;

type ProfileManagerAction = 'edit' | 'new' | 'delete' | 'reload' | 'close' | undefined;
type ScopedModelRoute = {
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
};
type WizardStep = 'name' | 'description' | 'provider' | 'model' | 'thinking';

type WizardOption = {
  value: string;
  label: string;
};

const WIZARD_STEPS: readonly WizardStep[] = [
  'name',
  'description',
  'provider',
  'model',
  'thinking'
];
const ACTIVE_PROVIDER_OPTION = '\u0000active-session-provider';

/** A full-width, keyboard-driven editor for one workflow routing profile. */
export class WorkflowProfileWizard implements Focusable {
  #input = new Input();
  readonly #initial: ProfileEditor;
  readonly #providerOptions: WizardOption[];
  #name: string;
  #description: string;
  #step = 0;
  #providerIndex = 0;
  #modelIndex = 0;
  #thinkingIndex = 0;
  #firstVisibleOption = 0;
  #focused = false;
  #cachedWidth = -1;
  #cachedPageSize = -1;
  #cachedLines: string[] = [];
  #message: string | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly models: readonly Model<Api>[],
    private readonly scopedModels: readonly ScopedModelRoute[],
    private readonly activeProvider: string | undefined,
    private readonly activeModelId: string | undefined,
    private readonly sessionThinkingLevel: ThinkingLevel | undefined,
    initial: ProfileEditor,
    private readonly onInvalidRoute: (message: string) => void,
    private readonly done: (profile: WorkflowProfile | undefined) => void
  ) {
    this.#initial = initial;
    this.#name = sanitizeWorkflowProfileText(initial.name ?? '');
    this.#description = sanitizeWorkflowProfileText(initial.description ?? '');
    this.#providerOptions = this.#createProviderOptions(initial.provider);
    this.#providerIndex = this.#preferredProviderIndex(initial.provider);
    this.#resetModelIndex(initial);
    this.#syncInput();
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#input.focused = value && this.#isTextStep();
  }

  handleInput(data: string): void {
    if (this.#isTextStep()) {
      if (matchesKey(data, Key.shift('tab'))) {
        this.#goBack();
        return;
      }
      this.#input.handleInput(data);
      const sanitized = sanitizeWorkflowProfileText(this.#input.getValue());
      if (sanitized !== this.#input.getValue()) this.#input.setValue(sanitized);
      this.#refresh();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.left)) {
      this.#goBack();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, 'k')) {
      this.#moveOption(-1);
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, 'j')) {
      this.#moveOption(1);
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.#setCurrentOptionIndex(0);
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.#setCurrentOptionIndex(this.#currentOptions().length - 1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) this.#submitChoiceStep();
  }

  render(width: number): string[] {
    const pageSize = this.#optionPageSize();
    if (this.#cachedWidth === width && this.#cachedPageSize === pageSize) return this.#cachedLines;

    const step = WIZARD_STEPS[this.#step];
    const lines = [
      this.#rule(width),
      this.#title(),
      this.#stepBar(),
      this.theme.fg('text', ` ${this.#stepTitle(step)}`),
      this.theme.fg(
        this.#message ? 'warning' : 'muted',
        ` ${this.#message ?? this.#stepHint(step)}`
      ),
      ...(this.#isTextStep() ? this.#inputLines(width) : this.#choiceLines(pageSize)),
      '',
      this.theme.fg('dim', this.#helpText()),
      this.#rule(width)
    ];
    this.#cachedLines = lines.map((line) => truncateToWidth(line, width, ''));
    this.#cachedWidth = width;
    this.#cachedPageSize = pageSize;
    return this.#cachedLines;
  }

  invalidate(): void {
    this.#cachedWidth = -1;
    this.#cachedPageSize = -1;
    this.#cachedLines = [];
    this.#input.invalidate();
  }

  #createProviderOptions(initialProvider: string | undefined): WizardOption[] {
    const providers = [...new Set(this.models.map((model) => model.provider))].sort();
    const activeOption = this.activeProvider
      ? [
          {
            value: ACTIVE_PROVIDER_OPTION,
            label: `Use active session provider (${this.activeProvider})`
          }
        ]
      : [];
    const options = [
      ...activeOption,
      ...providers.map((provider) => ({ value: provider, label: provider }))
    ];
    const preferred = initialProvider ?? (this.activeProvider ? ACTIVE_PROVIDER_OPTION : undefined);
    return prioritize(
      options,
      options.find((option) => option.value === preferred)
    );
  }

  #preferredProviderIndex(initialProvider: string | undefined): number {
    const preferred = initialProvider ?? (this.activeProvider ? ACTIVE_PROVIDER_OPTION : undefined);
    return Math.max(
      0,
      this.#providerOptions.findIndex((option) => option.value === preferred)
    );
  }

  #resetModelIndex(initial: ProfileEditor): void {
    const modelOptions = this.#modelOptions();
    const provider = this.#modelProvider();
    const preferred =
      initial.model && (initial.provider ?? this.activeProvider) === provider
        ? initial.model
        : this.activeProvider === provider
          ? this.activeModelId
          : undefined;
    this.#modelIndex = Math.max(
      0,
      modelOptions.findIndex((option) => option.value === preferred)
    );
    this.#resetThinkingIndex(initial.thinkingLevel);
  }

  #resetThinkingIndex(preferred: ThinkingLevel | undefined): void {
    const options = this.#thinkingOptions();
    const level = preferred ?? this.sessionThinkingLevel ?? 'off';
    this.#thinkingIndex = Math.max(
      0,
      options.findIndex((option) => option.value === level)
    );
  }

  #isTextStep(): boolean {
    const step = WIZARD_STEPS[this.#step];
    return step === 'name' || step === 'description';
  }

  #syncInput(): void {
    const step = WIZARD_STEPS[this.#step];
    this.#input = new Input();
    this.#input.onSubmit = () => this.#submitTextStep();
    this.#input.onEscape = () => this.done(undefined);
    this.#input.setValue(step === 'name' ? this.#name : this.#description);
    this.#input.focused = this.#focused && this.#isTextStep();
  }

  #submitTextStep(): void {
    const value = sanitizeWorkflowProfileText(this.#input.getValue()).trim();
    if (!value) {
      this.#message = `${this.#stepTitle(WIZARD_STEPS[this.#step])} is required.`;
      this.#refresh();
      return;
    }
    if (WIZARD_STEPS[this.#step] === 'name') this.#name = value;
    else this.#description = value;
    this.#moveTo(this.#step + 1);
  }

  #submitChoiceStep(): void {
    const step = WIZARD_STEPS[this.#step];
    const options = this.#currentOptions();
    if (options.length === 0) return;

    if (step === 'provider') {
      this.#resetModelIndex(this.#initial);
      this.#moveTo(this.#step + 1);
      return;
    }
    if (step === 'model') {
      const model = this.#selectedModel();
      const scopedThinkingLevel = model
        ? scopedThinkingLevelFor(this.scopedModels, model)
        : undefined;
      if (
        model &&
        scopedThinkingLevel &&
        !getSupportedThinkingLevels(model).includes(scopedThinkingLevel)
      ) {
        this.onInvalidRoute(
          'The session-scoped thinking level is unsupported by the selected model; profile was not saved'
        );
        this.done(undefined);
        return;
      }
      this.#resetThinkingIndex(this.#initial.thinkingLevel);
      this.#moveTo(this.#step + 1);
      return;
    }

    const model = this.#selectedModel();
    const thinkingLevel = this.#thinkingOptions()[this.#thinkingIndex]?.value as
      | ThinkingLevel
      | undefined;
    if (!model || !thinkingLevel) return;
    this.done({
      name: this.#name,
      description: this.#description,
      ...(this.#selectedProvider() ? { provider: this.#selectedProvider() } : {}),
      model: model.id,
      thinkingLevel
    });
  }

  #goBack(): void {
    if (this.#step === 0) {
      this.done(undefined);
      return;
    }
    if (this.#isTextStep()) this.#storeTextValue();
    this.#moveTo(this.#step - 1);
  }

  #moveTo(step: number): void {
    this.#step = Math.max(0, Math.min(step, WIZARD_STEPS.length - 1));
    this.#firstVisibleOption = 0;
    this.#message = undefined;
    if (this.#isTextStep()) this.#syncInput();
    this.#ensureOptionVisible();
    this.#refresh();
  }

  #storeTextValue(): void {
    const value = sanitizeWorkflowProfileText(this.#input.getValue());
    if (WIZARD_STEPS[this.#step] === 'name') this.#name = value;
    else this.#description = value;
  }

  #moveOption(delta: number): void {
    this.#setCurrentOptionIndex(this.#currentOptionIndex() + delta);
  }

  #setCurrentOptionIndex(index: number): void {
    const options = this.#currentOptions();
    const selected = Math.max(0, Math.min(index, options.length - 1));
    const step = WIZARD_STEPS[this.#step];
    if (step === 'provider') this.#providerIndex = selected;
    else if (step === 'model') this.#modelIndex = selected;
    else this.#thinkingIndex = selected;
    this.#ensureOptionVisible();
    this.#refresh();
  }

  #currentOptionIndex(): number {
    const step = WIZARD_STEPS[this.#step];
    if (step === 'provider') return this.#providerIndex;
    if (step === 'model') return this.#modelIndex;
    return this.#thinkingIndex;
  }

  #currentOptions(): WizardOption[] {
    const step = WIZARD_STEPS[this.#step];
    if (step === 'provider') return this.#providerOptions;
    if (step === 'model') return this.#modelOptions();
    if (step === 'thinking') return this.#thinkingOptions();
    return [];
  }

  #selectedProvider(): string | undefined {
    const value = this.#providerOptions[this.#providerIndex]?.value;
    return value === ACTIVE_PROVIDER_OPTION ? undefined : value;
  }

  #modelProvider(): string | undefined {
    return this.#selectedProvider() ?? this.activeProvider;
  }

  #modelOptions(): WizardOption[] {
    const provider = this.#modelProvider();
    return this.models
      .filter((model) => model.provider === provider)
      .map((model) => ({ value: model.id, label: model.id }));
  }

  #selectedModel(): Model<Api> | undefined {
    const provider = this.#modelProvider();
    const id = this.#modelOptions()[this.#modelIndex]?.value;
    return this.models.find((model) => model.provider === provider && model.id === id);
  }

  #thinkingOptions(): WizardOption[] {
    const model = this.#selectedModel();
    if (!model) return [];
    const scopedThinkingLevel = scopedThinkingLevelFor(this.scopedModels, model);
    const supported = getSupportedThinkingLevels(model);
    const levels = scopedThinkingLevel ? [scopedThinkingLevel] : supported;
    return levels
      .filter((level) => supported.includes(level))
      .map((level) => ({ value: level, label: level }));
  }

  #choiceLines(pageSize: number): string[] {
    const options = this.#currentOptions();
    if (options.length === 0) {
      return [
        '',
        this.theme.fg(
          'warning',
          ' No compatible thinking level is available for this model and session scope.'
        )
      ];
    }
    this.#ensureOptionVisible(pageSize);
    return [
      '',
      ...options
        .slice(this.#firstVisibleOption, this.#firstVisibleOption + pageSize)
        .map((option, index) => {
          const optionIndex = this.#firstVisibleOption + index;
          const selected = optionIndex === this.#currentOptionIndex();
          const prefix = selected ? '> ' : '  ';
          return this.theme.fg(
            selected ? 'accent' : 'text',
            `${prefix}${optionIndex + 1}. ${option.label}`
          );
        })
    ];
  }

  #inputLines(width: number): string[] {
    return ['', ...this.#input.render(Math.max(1, width - 1)).map((line) => ` ${line}`)];
  }

  #optionPageSize(): number {
    const terminal = this.tui as TUI & { terminal?: { rows: number } };
    const terminalRows = terminal.terminal?.rows ?? 24;
    const chromeRows = 9;
    return Math.max(1, terminalRows - chromeRows);
  }

  #ensureOptionVisible(pageSize = this.#optionPageSize()): void {
    const selected = this.#currentOptionIndex();
    const maxFirstVisible = Math.max(0, this.#currentOptions().length - pageSize);
    if (selected < this.#firstVisibleOption) this.#firstVisibleOption = selected;
    if (selected >= this.#firstVisibleOption + pageSize) {
      this.#firstVisibleOption = selected - pageSize + 1;
    }
    this.#firstVisibleOption = Math.max(0, Math.min(this.#firstVisibleOption, maxFirstVisible));
  }

  #title(): string {
    const mode = this.#initial.name ? 'Edit workflow profile' : 'New workflow profile';
    return `${this.theme.fg('accent', ` ${this.theme.bold('/workflow-profiles')}`)}${this.theme.fg('muted', ` · ${mode}`)}`;
  }

  #stepBar(): string {
    return WIZARD_STEPS.map((step, index) => {
      const marker = index < this.#step ? '✓' : index === this.#step ? '●' : '○';
      const label = this.#stepLabel(step);
      const cell = ` ${marker} ${label} `;
      if (index === this.#step)
        return `${this.theme.bg('selectedBg', this.theme.fg('text', cell))} `;
      return `${this.theme.fg(index < this.#step ? 'success' : 'muted', cell)} `;
    }).join('');
  }

  #stepLabel(step: WizardStep): string {
    return step === 'name'
      ? 'Name'
      : step === 'description'
        ? 'Description'
        : step === 'provider'
          ? 'Provider'
          : step === 'model'
            ? 'Model'
            : 'Thinking';
  }

  #stepTitle(step: WizardStep): string {
    return step === 'name'
      ? 'Profile name'
      : step === 'description'
        ? 'Profile description'
        : step === 'provider'
          ? 'Provider'
          : step === 'model'
            ? 'Model'
            : 'Thinking level';
  }

  #stepHint(step: WizardStep): string {
    if (step === 'name') return 'A short route name workflow authors can reference.';
    if (step === 'description') return 'Explain when this profile should be used.';
    if (step === 'provider') return 'Choose the provider that exposes the selected model.';
    if (step === 'model') return 'Only available, approved models are shown.';
    return 'Choose the subagent reasoning intensity.';
  }

  #helpText(): string {
    if (this.#isTextStep()) return ' Enter continue • Shift+Tab back • Esc cancel';
    if (this.#currentOptions().length === 0) return ' Shift+Tab/← back • Esc cancel';
    return ' ↑/↓ or j/k move • Enter select • Shift+Tab/← back • Esc cancel';
  }

  #refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  #rule(width: number): string {
    return this.theme.fg('accent', '─'.repeat(Math.max(0, width)));
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
  #firstVisible = 0;
  #cachedWidth = -1;
  #cachedPageSize = -1;
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
      this.#ensureSelectionVisible();
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
    const pageSize = this.#pageSize();
    if (this.#cachedWidth === width && this.#cachedPageSize === pageSize) return this.#cachedLines;

    this.#ensureSelectionVisible(pageSize);
    const visibleProfiles = this.#profiles.slice(this.#firstVisible, this.#firstVisible + pageSize);
    const title = `${this.theme.fg('accent', ` ${this.theme.bold('/workflow-profiles')}`)}${this.theme.fg('muted', ` · ${this.#rangeLabel(visibleProfiles.length)}`)}`;
    const rows = visibleProfiles.length
      ? visibleProfiles.flatMap((profile, offset) =>
          this.#profileLines(profile, this.#firstVisible + offset)
        )
      : [this.theme.fg('muted', '  No profiles configured.')];
    const help = ' ↑/↓ or j/k move • Enter/e edit • n new • d delete • r reload • q/Esc close';

    this.#cachedLines = [
      this.#rule(width),
      title,
      this.theme.fg('muted', ' Approved routing profiles for workflow subagents.'),
      '',
      ...rows,
      '',
      this.theme.fg('dim', help),
      this.#rule(width)
    ].map((line) => truncateToWidth(line, width, ''));
    this.#cachedWidth = width;
    this.#cachedPageSize = pageSize;
    return this.#cachedLines;
  }

  invalidate(): void {
    this.#cachedWidth = -1;
    this.#cachedPageSize = -1;
    this.#cachedLines = [];
  }

  #profileLines(profile: WorkflowProfile, index: number): string[] {
    const selected = index === this.#selected;
    const name = sanitizeWorkflowProfileText(profile.name);
    const description = sanitizeWorkflowProfileText(profile.description);
    const model = sanitizeWorkflowProfileText(profile.model);
    const provider = profile.provider
      ? sanitizeWorkflowProfileText(profile.provider)
      : 'active session provider';
    const prefix = `${selected ? '>' : ' '} ${index + 1}. `;
    const indent = ' '.repeat(prefix.length);

    return [
      this.theme.fg(selected ? 'accent' : 'text', `${prefix}${this.theme.bold(name)}`),
      this.theme.fg(selected ? 'text' : 'muted', `${indent}${description}`),
      this.theme.fg(
        selected ? 'muted' : 'dim',
        `${indent}${model}  •  ${provider}  •  thinking: ${profile.thinkingLevel}`
      )
    ];
  }

  #pageSize(): number {
    // Reserve the full-width frame, heading, explanatory text, spacing, and help line.
    const terminal = this.tui as TUI & { terminal?: { rows: number } };
    const terminalRows = terminal.terminal?.rows ?? 24;
    const chromeRows = 7;
    const profileRows = 3;
    return Math.max(1, Math.floor((terminalRows - chromeRows) / profileRows));
  }

  #ensureSelectionVisible(pageSize = this.#pageSize()): void {
    const maxFirstVisible = Math.max(0, this.#profiles.length - pageSize);
    if (this.#selected < this.#firstVisible) this.#firstVisible = this.#selected;
    if (this.#selected >= this.#firstVisible + pageSize) {
      this.#firstVisible = this.#selected - pageSize + 1;
    }
    this.#firstVisible = Math.max(0, Math.min(this.#firstVisible, maxFirstVisible));
  }

  #rangeLabel(visibleCount: number): string {
    if (this.#profiles.length === 0) return 'no profiles';
    const first = this.#firstVisible + 1;
    return `${first}–${first + visibleCount - 1} of ${this.#profiles.length} profiles`;
  }

  #refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  #rule(width: number): string {
    return this.theme.fg('accent', '─'.repeat(Math.max(0, width)));
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
      new WorkflowProfileList(profiles, tui, theme, (action, profile) => done({ action, profile }))
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
  scopedModels: readonly ScopedModelRoute[],
  model: Model<Api>
): ThinkingLevel | undefined {
  return scopedModels.find(({ model: scoped }) => modelKey(scoped) === modelKey(model))
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
