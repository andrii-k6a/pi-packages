# pi-packages

These are packages built for my personal use and shared with the community of [pi](https://github.com/badlogic/pi-mono) in case it helps others.

Pi packages can include extensions, skills, prompt templates, and themes. See the [pi packages docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md) for details.

## Packages

| Package | Type | Description |
|---------|------|-------------|
| [@andrii-k6a/pi-ralph](./packages/pi-ralph/) | Extension | Ralph Loop |
| [@andrii-k6a/pi-btw](./packages/pi-btw/) | Extension | Side-question command `/btw` |

Each package has its own README with setup instructions, usage, and configuration details.

## Install All


```bash
pi install git:github.com/andrii-k6a/pi-packages
```

Or try without installing:

```bash
pi -e git:github.com/andrii-k6a/pi-packages
```

## Install One Package

Install a single package via npm:

```bash
pi install npm:@andrii-k6a/<package-name>
```

Use the specific command from the table above for each package.

<details>
<summary>Install commands by package</summary>

```bash
pi install npm:@andrii-k6a/pi-ralph
```

</details>

## Uninstall

If installed via git:

```bash
pi remove git:github.com/andrii-k6a/pi-packages
```

If installed individually via npm:

```bash
pi remove npm:@andrii-k6a/<package-name>
```

<details>
<summary>Uninstall commands by package</summary>

```bash
pi remove npm:@andrii-k6a/pi-ralph
```

</details>

### Testing locally

```bash
cd packages/<package-name>
pi -e .
```

## License

MIT
