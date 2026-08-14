# pi-caffeinate

`pi-caffeinate` keeps the computer awake while Pi is working, then releases the
inhibitor once the request settles or the session shuts down.

## Install

```bash
pi install npm:@andrii-k6a/pi-caffeinate
```

For local development:

```bash
pi -e ./packages/pi-caffeinate
```

## Commands

```text
/caffeinate           Open the interactive controls when a UI is available
/caffeinate display   Keep the system and display awake (default)
/caffeinate sleep     Keep the system awake while allowing display idle
/caffeinate status    Show mode, settings, and inhibitor state
/caffeinate mode      Select display or sleep mode in an interactive UI
/caffeinate stop      Release the current inhibitor until the next agent run
/caffeinate help      Show the command summary
```

Interactive routes use Pi's standard selector and are intentionally unavailable
in print and JSON modes. Direct routes execute in every mode, but their
notification responses are visible only in the TUI and RPC; print and JSON do
not expose direct-command output.

## Platform behavior

- macOS uses `caffeinate`.
- Windows uses a PowerShell process that maintains the appropriate execution-state flag.
- WSL uses `powershell.exe` when it is available.
- Linux uses `systemd-inhibit --what=sleep ... sleep infinity` for sleep mode.
  Display mode uses `systemd-inhibit --what=idle:sleep ... sleep infinity` and
  also asks the standard ScreenSaver session service for idle inhibition.
- On Linux without systemd, `caffeinate` is used when present. Display mode also
  attempts ScreenSaver idle inhibition; when no command is available, a successful
  ScreenSaver request remains a partial display-only fallback.

The systemd child is deliberately long-lived. `/caffeinate stop` stops only the
current inhibitor; the next `agent_start` event starts a new one.

## Settings

Settings live at:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-caffeinate.json
```

A selected mode is saved as JSON. The extension preserves unrecognized fields
and remembers `quiet` if it is already present:

```json
{
  "mode": "display",
  "quiet": false,
  "updatedAt": 1767225600000
}
```

Missing or invalid settings fall back to display mode. Invalid recognized
settings are never overwritten by a mode command: repair the file first.
The legacy `pi-caffeinate-settings.json` name is read for compatibility, while
new saves always write the canonical file.

`quiet: true` suppresses routine lifecycle notifications and status text. It
does not suppress warnings or direct command responses.

## Environment

- `PI_CAFFEINATE_DISABLED=1` disables inhibition.
- `PI_CAFFEINATE_COMMAND` provides a directly launched custom command and overrides
  the saved mode. It is never passed to a shell. Its command line grammar is:
  - Unquoted whitespace delimits arguments.
  - Single-quoted content is literal, including backslashes.
  - Inside double quotes, a backslash followed by a double quote is a literal
    quote, and a backslash followed by a backslash becomes one backslash. Any
    other backslash-`X` remains the two literal characters backslash and `X`.
  - Outside quotes, a backslash escapes whitespace, either quote, and a
    backslash; before any other character it remains literal.
  - Quoted and unquoted segments concatenate, and quote presence preserves empty
    arguments.

  Unclosed quotes and a dangling recognized escape (outside quotes or inside
  double quotes) reject the command with an `Invalid PI_CAFFEINATE_COMMAND` error.
  There is no expansion, substitution, globbing, comment syntax, operator syntax,
  or shell invocation.
- `PI_CAFFEINATE_ICON` prepends text to the active status indicator.

## Development

```bash
npm run test -- packages/pi-caffeinate
npm run typecheck
npm run lint
```

## License

MIT
