# pi-btw

Pi extension that adds a `/btw` side-question command.

Use `/btw <question>` to ask a quick question using the current session as context, without adding it to the main conversation.

## Install

```bash
pi install npm:@andrii-k6a/pi-btw
```

Or try without installing:

```bash
pi -e npm:@andrii-k6a/pi-btw
```

Or from this repo:

```bash
pi -e ./packages/pi-btw
```

## Usage

```text
/btw <your side question>
```

Examples:

```text
/btw explain the purpose of the changes
```

## Uninstall

```bash
pi remove npm:@andrii-k6a/pi-btw
```

## License

MIT
