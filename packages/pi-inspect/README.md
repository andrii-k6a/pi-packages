# pi-inspect

Pi extension that adds two CLI flags that print Pi session internals to stdout and exit before calling the model:

- `--dump-system-prompt` — the assembled system prompt
- `--dump-tools` — all registered tools with descriptions and source

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

Print all registered tools (name, source, description):

```bash
pi --dump-tools
```

Save to a file:

```bash
pi --dump-tools > tools.txt
```

Active tools are listed first. If any tools are registered but disabled for the current turn, they appear under an `--- inactive ---` separator.

### Providing your own prompt

Both flags accept an explicit prompt:

```bash
pi --dump-system-prompt -p "your prompt"
pi --dump-tools -p "your prompt"
```

Without an explicit prompt, the extension runs an internal synthetic `-p "dump"` turn so Pi still executes turn-scoped hooks like `before_agent_start`. The synthetic turn exits before any model request.

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
- Active vs. inactive status

## Notes

- Both flags exit before any model request is made; no tokens are consumed.
- When a flag is absent, the extension only performs cheap flag checks in event hooks.
- Output is captured after the full `before_agent_start` chain, so turn-scoped changes from other extensions are included.

## Uninstall

```bash
pi remove npm:@andrii-k6a/pi-inspect
```

## License

MIT
