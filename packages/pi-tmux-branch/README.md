# Tmux Branch Pi extension

A Pi coding agent extension that branches the current Pi session into a new `tmux` pane.

The extension creates an independent branch of the current persisted Pi session, then opens that branch in a new tmux split by running:

```sh
pi --session <branched-session-file>
```

## Install

Install from GitHub:

```sh
pi install git:github.com/andrii-k6a/pi-tmux-branch
```

Try it without installing:

```sh
pi -e git:github.com/andrii-k6a/pi-tmux-branch
```

For regular use, install the extension. Temporary `-e` packages may be resolved again in each branched Pi process, so installation is faster and more reliable.

When Pi is started with temporary extension flags, the extension passes the common forms through to branched panes: `-e <spec>`, `--extension <spec>`, and `--extension=<spec>`. Repeated flags are preserved in order. For example, a session started with:

```sh
pi -e git:github.com/andrii-k6a/pi-tmux-branch
```

branches into a pane that runs an equivalent command:

```sh
pi -e git:github.com/andrii-k6a/pi-tmux-branch --session <branched-session-file>
```

Only explicit temporary extension flags from the current process are copied. Installed global/project extensions are discovered by Pi as usual, and short-option clusters such as `-ex` are not expanded.

### Requirements

- `tmux`

## Usage

Run one of the `/tmux-branch-*` commands or use a shortcut. The extension branches the current Pi session and opens the branch in a new tmux pane.

If the current Pi conversation has not been persisted yet, such as immediately after starting Pi before the first assistant response, the extension opens a fresh Pi conversation in the requested tmux pane instead of branching. If the current Pi process was started with `--no-session`, the fresh pane also uses `--no-session`.

Command handlers wait until Pi is idle before branching. Shortcut handlers require Pi to already be idle; if Pi is busy, the extension displays an error notification.

### How it works

1. Verifies Pi is running with an interactive UI inside `tmux`.
2. If the current session is persisted and has a leaf, opens it with `SessionManager.open(...)`, creates a branched session using `createBranchedSession(leafId)`, and starts Pi with `--session <branched-session-file>`.
3. Runs `tmux split-window` with the requested direction.

The extension intentionally creates the branched session directly instead of using `ctx.fork()`, because `ctx.fork()` would replace the current runtime/pane. This also means Pi's normal fork lifecycle events are not emitted in the original pane: `session_before_fork`, `session_shutdown`, and `session_start` do not run for this branch operation.

## Controls

### Commands

| Command | Behavior |
| --- | --- |
| `/tmux-branch-right` | Branch the current Pi session into a new tmux pane on the right |
| `/tmux-branch-left` | Branch the current Pi session into a new tmux pane on the left |
| `/tmux-branch-down` | Branch the current Pi session into a new tmux pane below |
| `/tmux-branch-up` | Branch the current Pi session into a new tmux pane above |

### Default shortcuts

By default, Vim-style shortcuts mirror tmux pane navigation: `h/j/k/l` = left/down/up/right.

| Shortcut | Behavior |
| --- | --- |
| `Ctrl+Shift+L` | Branch the current Pi session into a new tmux pane on the right |
| `Ctrl+Shift+H` | Branch the current Pi session into a new tmux pane on the left |
| `Ctrl+Shift+J` | Branch the current Pi session into a new tmux pane below |
| `Ctrl+Shift+K` | Branch the current Pi session into a new tmux pane above |

> Note: your terminal and tmux configuration must pass `Ctrl+Shift+<letter>` key combinations through to Pi distinctly for the shortcuts to work.

## Configuration

Slash commands are always registered. Shortcuts are configured with `settings.json` under the extension's Pi config directory:

- global: `~/.pi/agent/pi-tmux-branch/settings.json`
- project-local: `<project>/.pi/pi-tmux-branch/settings.json`

Project-local configuration uses whole-file precedence over global configuration. If a project-local settings file exists, the global settings file is ignored; settings are not deep-merged.

### Commands only

Disable shortcut registration while keeping slash commands available:

```json
{
  "shortcutsEnabled": false
}
```

### Default Vim-style shortcuts

This is the default when no configuration file exists. To be explicit:

```json
{
  "shortcutsEnabled": true
}
```

### Custom shortcut bindings

Use an object to override one or more directions. Missing directions keep their default Vim-style shortcut. Set a direction to `false` or `null` to leave that direction command-only.

```json
{
  "shortcuts": {
    "right": "ctrl+alt+l",
    "left": "ctrl+alt+h",
    "down": "ctrl+alt+j",
    "up": "ctrl+alt+k"
  }
}
```

## Development

From this repository:

```sh
npm install
npm run typecheck
pi -e .
```
