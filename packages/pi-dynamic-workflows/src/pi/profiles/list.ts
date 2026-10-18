import type { Theme } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, type TUI, truncateToWidth } from '@earendil-works/pi-tui';
import type { WorkflowProfile } from '../../profiles/contracts.js';
import { terminalInput } from '../../shared/terminal-text.js';

export type ProfileManagerAction = 'edit' | 'new' | 'delete' | 'reload' | 'close' | undefined;

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
    const name = terminalInput(profile.name);
    const description = terminalInput(profile.description);
    const model = terminalInput(profile.model);
    const provider = profile.provider ? terminalInput(profile.provider) : 'active session provider';
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
