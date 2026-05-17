# pi-system-prompt

Pi extension that adds `--dump-system-prompt`: a CLI flag that prints Pi's assembled system prompt to stdout and exits before calling the model.

## Install

```bash
pi install npm:@andrii-k6a/pi-system-prompt
```

Or try without installing:

```bash
pi -e npm:@andrii-k6a/pi-system-prompt
```

Or from this repo:

```bash
pi -e ./packages/pi-system-prompt
```

## Usage

Print the assembled system prompt:

```bash
pi --dump-system-prompt
```

Save it to a file:

```bash
pi --dump-system-prompt > system-prompt.txt
```

Provide your own prompt text:

```bash
pi --dump-system-prompt -p "your prompt"
```

If no prompt is given, the extension runs an internal synthetic `-p "dump"` turn so Pi still executes turn-scoped hooks like `before_agent_start`. The synthetic turn exits before any model request.

## What's included in the output

The printed prompt reflects the full system prompt as Pi assembles it for that turn:

- Pi's built-in instructions
- Loaded tools, skills, and context files
- Custom `--system-prompt` and `--append-system-prompt` values
- Current date and working directory

> **Note:** Provider-payload rewrites from `before_provider_request` hooks are not included — those run after the point where this extension captures the prompt.

## Notes

- Exits before any model request is made; no tokens are consumed.
- When the flag is absent, the extension only performs cheap flag checks in event hooks.
- Output is captured after the full `before_agent_start` chain, so turn-scoped system-prompt changes from other extensions are included.

## Uninstall

```bash
pi remove npm:@andrii-k6a/pi-system-prompt
```

## License

MIT
