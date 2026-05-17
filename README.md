# pi-packages

These are packages built for my personal use and shared with the community of [pi](https://github.com/badlogic/pi-mono) in case it helps others.

Pi packages can include extensions, skills, prompt templates, and themes. See the [pi packages docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md) for details.

## Packages

| Package | Type | Description |
|---------|------|-------------|
| [@andrii-k6a/pi-btw](./packages/pi-btw/) | Extension | Side-question command `/btw` |
| [@andrii-k6a/pi-feedback](./packages/pi-feedback/) | Extension | Review assistant replies in your editor and submit as feedback (`/feedback`) |
| [@andrii-k6a/pi-system-prompt](./packages/pi-system-prompt/) | Extension | Print the assembled system prompt and exit (`--dump-system-prompt`) |
| [@andrii-k6a/pi-head](./packages/pi-head/) | Extension | Keyboard-scrollable viewer for the latest response (`/head`) |
| [@andrii-k6a/pi-ralph](./packages/pi-ralph/) | Extension | Ralph Loop |
| [agent-browser](./skills/agent-browser/) | Skill | Browser automation via `agent-browser` CLI |
| [engineering-discipline](./skills/engineering-discipline/) | Skill | Coding philosophy for non-trivial work |
| [visual-explainer](./skills/visual-explainer/) | Skill | Generate visual HTML explanations |
| [web-discovery](./skills/web-discovery/) | Skill | Browserless web search via local SearXNG + Defuddle |
| [diff-review](./prompts/diff-review.md) | Prompt | Review a diff |
| [fact-check](./prompts/fact-check.md) | Prompt | Fact-check a claim |
| [generate-slides](./prompts/generate-slides.md) | Prompt | Generate a slide deck |
| [generate-visual-plan](./prompts/generate-visual-plan.md) | Prompt | Generate a visual plan |
| [generate-web-diagram](./prompts/generate-web-diagram.md) | Prompt | Generate a web diagram |
| [grill-me](./prompts/grill-me.md) | Prompt | Socratic questioning |
| [plan-review](./prompts/plan-review.md) | Prompt | Review a plan |
| [project-recap](./prompts/project-recap.md) | Prompt | Recap a project |
| [tokyonight](./themes/tokyonight.json) | Theme | Tokyo Night color theme |

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
pi install npm:@andrii-k6a/pi-btw
pi install npm:@andrii-k6a/pi-feedback
pi install npm:@andrii-k6a/pi-head
pi install npm:@andrii-k6a/pi-ralph
pi install npm:@andrii-k6a/pi-system-prompt
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
pi remove npm:@andrii-k6a/pi-btw
pi remove npm:@andrii-k6a/pi-feedback
pi remove npm:@andrii-k6a/pi-head
pi remove npm:@andrii-k6a/pi-ralph
pi remove npm:@andrii-k6a/pi-system-prompt
```

</details>

### Testing locally

```bash
cd packages/<package-name>
pi -e .
```

## Community Skills

Catalogs and collections for inspiration:

- [skills.sh](https://skills.sh/) — searchable index of community skills
- [anthropics/skills](https://github.com/anthropics/skills) — official Anthropic skills (docx, pdf, pptx, xlsx, web dev)
- [openai/skills](https://github.com/openai/skills) — official OpenAI skills
- [obra/superpowers](https://github.com/obra/superpowers) — Jesse Vincent's curated skill pack
- [contains-studio/agents](https://github.com/contains-studio/agents) — Contains Studio's collection of agents
- [mattpocock/skills](https://github.com/mattpocock/skills) — Matt Pocock's skills collection

## License

MIT
