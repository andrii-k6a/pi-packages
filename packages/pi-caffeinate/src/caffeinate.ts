import type { ChildProcess } from 'node:child_process';
import process from 'node:process';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
} from '@earendil-works/pi-coding-agent';
import {
  createScreenSaverClient,
  SCREEN_SAVER_REASON,
  SCREEN_SAVER_SERVICE,
  type ScreenSaverClient,
  type ScreenSaverFactory
} from './dbus-inhibit.js';
import {
  type ProcessStarter,
  startInhibitorProcess,
  stopInhibitorProcess
} from './inhibitor-process.js';
import {
  formatMode,
  type InhibitorCommand,
  selectInhibitor,
  splitCommand,
  windowsInhibitorScript
} from './inhibitors.js';
import {
  type CaffeinateMode,
  loadSettings,
  normalizeCaffeinateSettings,
  saveSettings,
  settingsFilePath
} from './settings.js';

const STATUS_KEY = 'caffeinate';
const DEFAULT_MODE = 'display' satisfies CaffeinateMode;
const DISABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

const completionItems = [
  { value: 'display', label: 'display', description: 'Keep the system and display awake' },
  { value: 'sleep', label: 'sleep', description: 'Keep the system awake and allow display sleep' },
  { value: 'status', label: 'status', description: 'Show keep-awake status' },
  { value: 'mode', label: 'mode', description: 'Choose a keep-awake mode' },
  { value: 'stop', label: 'stop', description: 'Release the inhibitor until the next agent run' },
  { value: 'help', label: 'help', description: 'Show command help' }
];

export type CaffeinateAction = 'menu' | 'help' | 'status' | 'mode' | 'sleep' | 'display' | 'stop';

export interface CaffeinateOptions {
  dbusFactory?: ScreenSaverFactory;
  selectCommand?: (mode: CaffeinateMode) => InhibitorCommand | undefined;
  startProcess?: ProcessStarter;
}

interface PendingDbusStart {
  token: number;
  controller: AbortController;
  client?: ScreenSaverClient;
}

interface State {
  agentActive: boolean;
  available: boolean;
  command?: InhibitorCommand;
  child?: ChildProcess;
  dbus?: ScreenSaverClient;
  dbusCleanup?: Promise<void>;
  disabled: boolean;
  generation: number;
  lastError?: string;
  mode: CaffeinateMode;
  notice?: string;
  pendingDbus?: PendingDbusStart;
  quiet: boolean;
  settingsError?: string;
  settingsLoaded: boolean;
  startedAt?: number;
  starting: boolean;
  warning?: string;
  context?: { generation: number; ctx: ExtensionContext };
}

export default function caffeinate(pi: ExtensionAPI, options: CaffeinateOptions = {}): void {
  const state: State = {
    agentActive: false,
    available: true,
    disabled: isDisabled(),
    generation: 0,
    mode: DEFAULT_MODE,
    quiet: false,
    settingsLoaded: false,
    starting: false
  };
  const dbusFactory = options.dbusFactory ?? createScreenSaverClient;
  const commandForMode = options.selectCommand ?? selectInhibitor;
  const startProcess = options.startProcess ?? startInhibitorProcess;
  let inhibitionToken = 0;
  let modeQueue = Promise.resolve();

  pi.on('session_start', async (_event, ctx) => {
    const generation = ++state.generation;
    state.agentActive = false;
    state.context = { generation, ctx };
    state.settingsLoaded = false;
    state.notice = undefined;
    await loadSettingsIntoState(ctx, generation);
    if (generation === state.generation) updateStatus(ctx);
  });

  pi.on('agent_start', async (_event, ctx) => {
    const generation = state.generation;
    state.agentActive = true;
    state.context = { generation, ctx };
    await ensureSettings(ctx, generation);
    if (!isCurrent(generation)) return;
    await startInhibition(ctx, generation, !state.quiet);
    if (isCurrent(generation)) updateStatus(ctx);
  });

  pi.on('agent_end', (_event, ctx) => {
    if (isCurrent(state.generation)) updateStatus(ctx);
  });

  pi.on('agent_settled', async (_event, ctx) => {
    const generation = state.generation;
    state.agentActive = false;
    await stopInhibition(ctx, 'agent settled', !state.quiet);
    if (isCurrent(generation)) updateStatus(ctx);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    ++state.generation;
    state.agentActive = false;
    state.context = undefined;
    await stopInhibition(ctx, 'session shutdown', false);
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand('caffeinate', {
    description: 'Control pi-caffeinate keep-awake inhibition',
    getArgumentCompletions: commandCompletions,
    handler: async (args, ctx) => {
      const generation = state.generation;
      const action = parseCommand(args);
      if (action === 'unknown') {
        ctx.ui.notify(
          `Unknown /caffeinate command: ${args.trim()}\n\n${commandGuide()}`,
          'warning'
        );
        return;
      }
      await ensureSettings(ctx, generation);
      if (!isCurrent(generation)) return;
      await handleAction(action, ctx, generation);
    }
  });

  async function handleAction(
    action: CaffeinateAction,
    ctx: ExtensionCommandContext,
    generation: number
  ): Promise<void> {
    if (action === 'help') {
      ctx.ui.notify(commandGuide(), 'info');
      return;
    }
    if (action === 'status') {
      ctx.ui.notify(describeState(), statusType());
      updateStatus(ctx);
      return;
    }
    if (action === 'stop') {
      await stopInhibition(ctx, 'manual stop', true);
      if (isCurrent(generation)) updateStatus(ctx);
      return;
    }
    if (action === 'sleep' || action === 'display') {
      await queueModeChange(() => setMode(ctx, action, generation));
      return;
    }
    if (!ctx.hasUI) {
      const usage =
        action === 'mode' ? 'sleep or display' : 'status, sleep, display, stop, or help';
      ctx.ui.notify(
        `Interactive selection is unavailable here. Use /caffeinate ${usage}.`,
        'warning'
      );
      return;
    }
    if (action === 'mode') {
      const selected = await ctx.ui.select('Choose a keep-awake mode', [
        'display — keep the system and display awake',
        'sleep — keep the system awake and allow display sleep'
      ]);
      if (!isCurrent(generation) || !selected) return;
      await queueModeChange(() =>
        setMode(ctx, selected.startsWith('sleep') ? 'sleep' : 'display', generation)
      );
      return;
    }

    const selected = await ctx.ui.select(`pi-caffeinate\n\n${describeState()}`, [
      'display — keep the system and display awake',
      'sleep — keep the system awake and allow display sleep',
      'status — show status',
      'stop — release current inhibitor',
      'help — show command help'
    ]);
    if (!isCurrent(generation) || !selected) return;
    const selectedAction = parseCommand(selected.split(' ', 1)[0] ?? '');
    if (selectedAction !== 'unknown' && selectedAction !== 'menu') {
      await handleAction(selectedAction, ctx, generation);
    }
  }

  function queueModeChange(operation: () => Promise<void>): Promise<void> {
    const next = modeQueue.then(operation);
    modeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async function setMode(
    ctx: ExtensionCommandContext,
    mode: CaffeinateMode,
    generation: number
  ): Promise<void> {
    if (!isCurrent(generation)) return;
    const previousMode = state.mode;
    const restart =
      state.agentActive &&
      !state.command?.custom &&
      (state.starting || hasActiveInhibitor() || !state.available);

    // A D-Bus-only display start has no active backend until Inhibit resolves.
    // Invalidate it before the selected mode changes, so that result can never
    // attach itself after a sleep-mode restart.
    if (restart) await stopInhibition(ctx, 'mode changed', false);
    if (!isCurrent(generation)) return;

    try {
      const saved = await saveSettings({ mode, updatedAt: Date.now() });
      if (!isCurrent(generation)) return;
      state.mode = mode;
      state.quiet = saved.quiet;
      state.settingsError = undefined;
    } catch (error) {
      if (restart && state.agentActive) await startInhibition(ctx, generation, false);
      state.settingsError = `settings save failed: ${errorMessage(error)}`;
      ctx.ui.notify(
        `pi-caffeinate mode remains ${formatMode(previousMode)}; ${state.settingsError}`,
        'warning'
      );
      updateStatus(ctx);
      return;
    }

    if (restart && state.agentActive) {
      await startInhibition(ctx, generation, false);
      if (!hasActiveInhibitor()) {
        const failure = state.lastError ?? 'the new inhibitor did not start';
        state.mode = previousMode;
        try {
          const restored = await saveSettings({ mode: previousMode, updatedAt: Date.now() });
          state.quiet = restored.quiet;
          if (state.agentActive) await startInhibition(ctx, generation, false);
          state.settingsError = hasActiveInhibitor()
            ? `mode application failed and was restored: ${failure}`
            : `mode application failed: ${failure}; previous inhibitor could not be restored`;
        } catch (error) {
          state.settingsError = `mode application failed: ${failure}; restore save failed: ${errorMessage(error)}`;
        }
        ctx.ui.notify(`pi-caffeinate ${state.settingsError}`, 'warning');
        updateStatus(ctx);
        return;
      }
    }

    ctx.ui.notify(`pi-caffeinate mode set to ${formatMode(mode)} and saved.`, 'info');
    updateStatus(ctx);
  }

  async function startInhibition(
    ctx: ExtensionContext,
    generation: number,
    notify: boolean
  ): Promise<void> {
    if (state.disabled || state.starting || hasActiveInhibitor()) return;
    const token = ++inhibitionToken;
    let command: InhibitorCommand | undefined;
    try {
      command = commandForMode(state.mode);
    } catch (error) {
      state.starting = false;
      state.startedAt = undefined;
      state.warning = undefined;
      state.available = false;
      state.lastError = errorMessage(error);
      ctx.ui.notify(state.lastError, 'warning');
      updateStatus(ctx);
      return;
    }
    const wantsDbus =
      !command?.custom &&
      process.platform === 'linux' &&
      state.mode === 'display' &&
      (!command || command.needsScreenSaverInhibit === true);

    if (!command && !wantsDbus) {
      state.available = false;
      state.lastError = `No supported sleep inhibitor found for ${process.platform}.`;
      ctx.ui.notify(state.lastError, 'warning');
      updateStatus(ctx);
      return;
    }

    state.starting = true;
    state.warning = undefined;
    let child: ChildProcess | undefined;
    let childFailure =
      !command && wantsDbus
        ? 'No supported system sleep inhibitor is available; direct system suspend may remain possible.'
        : undefined;
    let assembling = true;
    const childFailed = (message: string): void => {
      if (!child || token !== inhibitionToken || state.child !== child) return;
      state.child = undefined;
      state.command = undefined;
      if (assembling) childFailure = message;
      else applyChildFailure(message);
    };

    if (command) {
      try {
        child = startProcess(
          command,
          (error) => childFailed(`${command.label} failed: ${error.message}`),
          (exit) => childFailed(`${command.label} exited unexpectedly (${exit}).`)
        );
        state.child = child;
        state.command = command;
        state.startedAt = Date.now();
      } catch (error) {
        childFailure = `${command.label} failed: ${errorMessage(error)}`;
      }
    }

    let dbus: ScreenSaverClient | undefined;
    let dbusFailure: string | undefined;
    if (wantsDbus) {
      const pending: PendingDbusStart = { token, controller: new AbortController() };
      state.pendingDbus = pending;
      try {
        const client = await dbusFactory();
        pending.client = client;
        if (!pendingIsCurrent(pending, generation)) {
          await takePendingClient(pending)
            ?.close()
            .catch(() => undefined);
          await discardPendingStart(token, child, command);
          return;
        }
        await client.inhibit(SCREEN_SAVER_REASON, pending.controller.signal);
        if (!pendingIsCurrent(pending, generation)) {
          await takePendingClient(pending)
            ?.close()
            .catch(() => undefined);
          await discardPendingStart(token, child, command);
          return;
        }
        pending.client = undefined;
        state.pendingDbus = undefined;
        dbus = client;
      } catch (error) {
        const stale = !pendingIsCurrent(pending, generation) || pending.controller.signal.aborted;
        const client = takePendingClient(pending);
        await client?.close().catch(() => undefined);
        if (stale) {
          await discardPendingStart(token, child, command);
          return;
        }
        dbusFailure = `ScreenSaver D-Bus inhibition (${SCREEN_SAVER_SERVICE}) failed: ${errorMessage(error)}`;
      }
    }

    assembling = false;
    if (!isCurrent(generation) || token !== inhibitionToken) {
      await discardPendingStart(token, child, command);
      await dbus?.close().catch(() => undefined);
      return;
    }

    state.starting = false;
    state.dbus = dbus;
    if (dbus) dbus.setFailureHandler((error) => applyDbusFailure(token, dbus, error));
    const failures = [childFailure, dbusFailure].filter((value): value is string => Boolean(value));
    if (!hasActiveInhibitor()) {
      state.available = false;
      state.startedAt = undefined;
      state.command = undefined;
      state.lastError =
        failures.join('; ') || `No supported sleep inhibitor found for ${process.platform}.`;
      ctx.ui.notify(state.lastError, 'warning');
      updateStatus(ctx);
      return;
    }

    state.available = true;
    state.lastError = undefined;
    state.warning = failures.join('; ') || undefined;
    if (state.warning) {
      ctx.ui.notify(`pi-caffeinate is partially active: ${state.warning}`, 'warning');
    } else if (notify) {
      ctx.ui.notify(`Keeping computer awake (${activeModeLabel()}).`, 'info');
    }
    updateStatus(ctx);
  }

  async function stopInhibition(
    ctx: ExtensionContext,
    reason: string,
    notify: boolean
  ): Promise<void> {
    ++inhibitionToken;
    const child = state.child;
    const command = state.command;
    const dbus = state.dbus;
    const pending = state.pendingDbus;
    const priorCleanup = state.dbusCleanup;
    const wasStarting = state.starting;
    state.child = undefined;
    state.command = undefined;
    state.dbus = undefined;
    state.pendingDbus = undefined;
    state.dbusCleanup = undefined;
    state.startedAt = undefined;
    state.starting = false;
    state.warning = undefined;
    dbus?.setFailureHandler(undefined);
    pending?.controller.abort(new DOMException(`Caffeinate stopped: ${reason}`, 'AbortError'));
    const pendingClient = pending?.client;
    if (pending) pending.client = undefined;
    if (child) stopInhibitorProcess(child, command);
    if (notify && (child || dbus || pendingClient || wasStarting)) {
      ctx.ui.notify(`Released pi-caffeinate (${reason}).`, 'info');
    }
    await Promise.all([priorCleanup, pendingClient?.close().catch(() => undefined)]);
    if (!dbus) return;
    await dbus.uninhibit().catch(() => undefined);
    await dbus.close().catch(() => undefined);
  }

  async function discardPendingStart(
    token: number,
    child: ChildProcess | undefined,
    command: InhibitorCommand | undefined
  ): Promise<void> {
    if (token !== inhibitionToken) return;
    ++inhibitionToken;
    state.starting = false;
    const pending = state.pendingDbus?.token === token ? state.pendingDbus : undefined;
    state.pendingDbus = undefined;
    pending?.controller.abort(new DOMException('Caffeinate start cancelled', 'AbortError'));
    const pendingClient = pending?.client;
    if (pending) pending.client = undefined;
    if (child && state.child === child) {
      state.child = undefined;
      state.command = undefined;
      state.startedAt = undefined;
      stopInhibitorProcess(child, command);
    }
    await pendingClient?.close().catch(() => undefined);
  }

  function applyChildFailure(message: string): void {
    if (state.dbus) {
      state.warning = message;
      state.available = true;
      state.lastError = undefined;
    } else {
      state.available = false;
      state.lastError = message;
      state.startedAt = undefined;
      state.warning = undefined;
    }
    const ctx = currentContext();
    if (!ctx) return;
    ctx.ui.notify(message, 'warning');
    updateStatus(ctx);
  }

  function applyDbusFailure(token: number, client: ScreenSaverClient, error: Error): void {
    if (token !== inhibitionToken || state.dbus !== client) return;
    client.setFailureHandler(undefined);
    state.dbus = undefined;
    const message = `ScreenSaver D-Bus inhibition (${SCREEN_SAVER_SERVICE}) failed: ${error.message}`;
    if (state.child) {
      state.warning = message;
      state.available = true;
      state.lastError = undefined;
    } else {
      state.warning = undefined;
      state.available = false;
      state.lastError = message;
      state.startedAt = undefined;
      state.command = undefined;
    }
    const cleanup = client.close().catch(() => undefined);
    state.dbusCleanup = cleanup;
    void cleanup.then(() => {
      if (state.dbusCleanup === cleanup) state.dbusCleanup = undefined;
    });
    const ctx = currentContext();
    if (!ctx) return;
    ctx.ui.notify(
      state.child ? `pi-caffeinate is partially active: ${message}` : message,
      'warning'
    );
    updateStatus(ctx);
  }

  async function ensureSettings(ctx: ExtensionContext, generation: number): Promise<void> {
    if (state.settingsLoaded || state.disabled) return;
    await loadSettingsIntoState(ctx, generation);
  }

  async function loadSettingsIntoState(ctx: ExtensionContext, generation: number): Promise<void> {
    if (state.disabled) {
      state.settingsLoaded = true;
      return;
    }
    const result = await loadSettings();
    if (!isCurrent(generation)) return;
    state.settingsLoaded = true;
    state.settingsError = undefined;
    state.notice = result.notice;
    if (result.notice) ctx.ui.notify(result.notice, 'warning');
    if (result.kind === 'loaded') {
      state.mode = result.settings.mode;
      state.quiet = result.settings.quiet;
      return;
    }
    state.mode = DEFAULT_MODE;
    state.quiet = false;
    if (result.kind === 'invalid') {
      state.settingsError = result.reason;
      ctx.ui.notify(
        `pi-caffeinate settings ignored: ${result.reason}; using ${formatMode(DEFAULT_MODE)}.`,
        'warning'
      );
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (state.disabled || state.quiet) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    if (hasActiveInhibitor()) {
      ctx.ui.setStatus(STATUS_KEY, statusText(activeModeLabel()));
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, state.available ? undefined : statusText('unavailable'));
  }

  function describeState(): string {
    const lines = [
      `Mode: ${formatMode(state.mode)}${state.command?.custom ? ' (overridden by custom command)' : ''}`,
      `Quiet mode: ${state.quiet ? 'enabled' : 'disabled'}`,
      `Settings: ${settingsFilePath()}`
    ];
    if (state.notice) lines.push(`Settings note: ${state.notice}`);
    if (state.settingsError) lines.push(`Settings warning: ${state.settingsError}`);
    if (state.disabled)
      return [`pi-caffeinate is disabled by PI_CAFFEINATE_DISABLED.`, ...lines].join('\n');
    if (hasActiveInhibitor()) {
      const elapsed = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1_000) : 0;
      const backends = [
        state.child && state.command ? state.command.label : undefined,
        state.dbus ? `ScreenSaver D-Bus (${SCREEN_SAVER_SERVICE})` : undefined
      ].filter(Boolean);
      if (state.warning) lines.push(`Inhibitor warning: ${state.warning}`);
      return [
        `pi-caffeinate is active using ${backends.join(' + ')} for ${elapsed}s.`,
        ...lines
      ].join('\n');
    }
    if (!state.available) {
      return [
        `pi-caffeinate is unavailable: ${state.lastError ?? 'unknown reason'}`,
        ...lines
      ].join('\n');
    }
    return ['pi-caffeinate is idle and will activate with the next agent run.', ...lines].join(
      '\n'
    );
  }

  function statusType(): 'info' | 'warning' {
    return state.available && !state.settingsError && !state.warning ? 'info' : 'warning';
  }

  function activeModeLabel(): string {
    return state.command?.custom ? 'custom' : formatMode(state.mode);
  }

  function statusText(text: string): string {
    const icon = process.env.PI_CAFFEINATE_ICON?.trim();
    return icon ? `${icon} ${text}` : text;
  }

  function hasActiveInhibitor(): boolean {
    return Boolean(state.child || state.dbus);
  }

  function isCurrent(generation: number): boolean {
    return generation === state.generation;
  }

  function pendingIsCurrent(pending: PendingDbusStart, generation: number): boolean {
    return (
      state.pendingDbus === pending &&
      !pending.controller.signal.aborted &&
      isCurrent(generation) &&
      pending.token === inhibitionToken
    );
  }

  function takePendingClient(pending: PendingDbusStart): ScreenSaverClient | undefined {
    if (state.pendingDbus === pending) state.pendingDbus = undefined;
    const client = pending.client;
    pending.client = undefined;
    return client;
  }

  function currentContext(): ExtensionContext | undefined {
    return state.context?.generation === state.generation ? state.context.ctx : undefined;
  }
}

export function parseCommand(args: string): CaffeinateAction | 'unknown' {
  const command = args.trim().toLowerCase();
  if (!command) return 'menu';
  if (command === 'help') return 'help';
  if (command === 'status') return 'status';
  if (command === 'mode' || command === 'config' || command === 'settings') return 'mode';
  if (command === 'sleep' || command === 'system') return 'sleep';
  if (command === 'display' || command === 'screen') return 'display';
  if (command === 'stop' || command === 'off') return 'stop';
  return 'unknown';
}

export function commandCompletions(prefix: string) {
  const normalized = prefix.trimStart().toLowerCase();
  if (/\s/.test(normalized)) return null;
  const matches = completionItems.filter((item) => item.value.startsWith(normalized));
  return matches.length > 0 ? matches : null;
}

function commandGuide(): string {
  return [
    'pi-caffeinate commands:',
    '/caffeinate — open keep-awake controls',
    '/caffeinate display — keep the system and display awake',
    '/caffeinate sleep — keep the system awake while allowing display sleep',
    '/caffeinate status — show current status',
    '/caffeinate mode — select a mode',
    '/caffeinate stop — release the inhibitor until the next agent run'
  ].join('\n');
}

function isDisabled(): boolean {
  const value = process.env.PI_CAFFEINATE_DISABLED?.trim().toLowerCase();
  return value ? DISABLED_VALUES.has(value) : false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export {
  formatMode,
  normalizeCaffeinateSettings,
  selectInhibitor,
  splitCommand,
  windowsInhibitorScript
};
