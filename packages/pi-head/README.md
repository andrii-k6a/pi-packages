# pi-head

Pi extension that adds `/head`: a keyboard-scrollable viewer for the latest assistant response, opened from its first line.

Use it when an assistant response is long and you want to jump back to the beginning without entering tmux copy/history mode.

## Features

- Adds the `/head` slash command.
- Finds the latest assistant text response on the active session branch.
- Opens that response in a full-screen Pi TUI viewer starting at line 1.
- Supports keyboard scrolling, paging, top/bottom jumps, and quick close.

## Install

```bash
pi install npm:@andrii-k6a/pi-head
```

Or try without installing:

```bash
pi -e npm:@andrii-k6a/pi-head
```

Or from this repo:

```bash
pi -e ./packages/pi-head
```

## Usage

Inside Pi, run:

```text
/head
```

The viewer opens on the latest assistant text response, starting at the first line.

## Keyboard controls

| Key | Action |
| --- | --- |
| `j`, `↓` | Scroll down one line |
| `k`, `↑` | Scroll up one line |
| `space`, `f`, `PageDown` | Page down |
| `b`, `PageUp` | Page up |
| `g` | Jump to top |
| `G` | Jump to bottom |
| `q`, `Esc` | Close |

## Uninstall

```bash
pi remove npm:@andrii-k6a/pi-head
```

## License

MIT
