# pi-inspect

Pi extension that adds two CLI flags that print Pi session internals to stdout and exit before calling the model:

- `--dump-system-prompt` — the assembled system prompt
- `--dump-tools` — all registered tools with source, description, and parameter schema

## Install

```bash
pi install npm:@andrii-k6a/pi-inspect
```

Or try without installing:

```bash
pi -e npm:@andrii-k6a/pi-inspect
```

Or from this repo:

```bash
pi -e ./packages/pi-inspect
```

## Usage

### System prompt

Print the assembled system prompt:

```bash
pi --dump-system-prompt
```

Save it to a file:

```bash
pi --dump-system-prompt > system-prompt.txt
```

### Tools

Print all registered tools (name, source, description, JSON parameter schema):

```bash
pi --dump-tools
```

Save to a file:

```bash
pi --dump-tools > tools.txt
```

Active tools are listed first. If any tools are registered but disabled for the current turn, they appear under an `--- inactive ---` separator. Only active tools are declared to the model.

### Both flags

If you pass both flags, only the system prompt is printed.

Like every Pi boolean flag, a dump flag is on whenever it is present, whatever value follows. `--dump-tools=false` still dumps the tools.

### Providing your own prompt

Both flags accept an explicit prompt:

```bash
pi --dump-system-prompt -p "your prompt"
pi --dump-tools -p "your prompt"
```

Without an explicit prompt, the extension runs an internal synthetic `-p "dump"` turn so Pi still executes turn-scoped hooks like `before_agent_start`. The synthetic turn exits before any model request.

The synthetic turn runs with `--no-session`, so it leaves nothing in your session history. If you select a session with `-c`, `-r`, `--session`, or `--fork`, the synthetic `dump` message is appended to that session. An explicit `-p "your prompt"` also writes to the session as usual.

With `--mode rpc`, no synthetic turn runs, because RPC mode ignores `-p`. The dump happens on the first prompt sent over RPC.

> **Tip:** Pi reads a bare word right after a boolean flag as that flag's value, so `pi --dump-tools "your prompt"` does not pass a prompt. Use `-p "your prompt"`.

## What's included in the output

**`--dump-system-prompt`** reflects the full system prompt as Pi assembles it for that turn:

- Pi's built-in instructions
- Loaded tools, skills, and context files
- Custom `--system-prompt` and `--append-system-prompt` values
- Current date and working directory

> **Note:** Provider-payload rewrites from `before_provider_request` hooks are not included — those run after the point where this extension captures the prompt.

**`--dump-tools`** shows every tool registered for the session:

- Tool name and the source it came from (e.g. `builtin`, package name)
- Full description text
- JSON parameter schema, as the model receives it
- Active vs. inactive status

## Notes

- Both flags exit before any model request is made; no tokens are consumed.
- A model and credentials must still be configured. Pi checks them before the point where this extension prints, so without them Pi reports that no model or credentials are available and exits with status 1.
- When a flag is absent, the extension only performs cheap flag checks in event hooks.
- Output is captured after the full `before_agent_start` chain, so turn-scoped changes from other extensions are included.

## Uninstall

```bash
pi remove npm:@andrii-k6a/pi-inspect
```

## License

MIT
