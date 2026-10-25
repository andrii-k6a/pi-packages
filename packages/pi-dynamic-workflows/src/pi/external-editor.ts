import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';

/**
 * The command Pi's own external-editor key (Ctrl+G) would use: the `externalEditor` setting,
 * then `$VISUAL`, then `$EDITOR`. Only global settings count; a project must not choose a
 * command that `/workflows` then runs.
 */
export function resolveEditorCommand(cwd: string): string {
  return SettingsManager.create(cwd, getAgentDir(), {
    projectTrusted: false
  }).getExternalEditorCommand();
}

/**
 * Shows `text` in the user's editor, with Pi's terminal UI stopped, and returns when the editor
 * exits. The text is a temporary copy that is deleted afterwards. Rejects when the editor cannot
 * start. A non-zero exit code is not an error: `:cq` is a normal way to leave a viewer.
 */
export async function viewInExternalEditor(
  tui: Pick<TUI, 'stop' | 'start' | 'requestRender'>,
  text: string,
  options: { command: string; filename: string }
): Promise<void> {
  const [editor, ...args] = options.command.trim().split(/\s+/);
  // mkdtemp creates the directory with mode 0700; transcripts can contain secrets.
  const directory = mkdtempSync(join(tmpdir(), 'pi-workflows-'));
  try {
    const file = join(directory, options.filename);
    writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
    tui.stop();
    try {
      await new Promise<void>((resolve, reject) => {
        // Not spawnSync: on Windows it can race the editor for console input.
        const child = spawn(editor, [...args, file], {
          stdio: 'inherit',
          shell: process.platform === 'win32'
        });
        child.once('error', reject);
        child.once('close', () => resolve());
      });
    } finally {
      tui.start();
      tui.requestRender(true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
