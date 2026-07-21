# pi-packages

These are packages built for my personal use and shared with the community of [pi](https://github.com/badlogic/pi-mono) in case it helps others.

Pi packages can include extensions, skills, prompt templates, and themes. See the [pi packages docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md) for details.

## Packages

| Package | Type | Description |
|---------|------|-------------|
| [@andrii-k6a/pi-draw](./packages/pi-draw/) | Extension | Open a tldraw canvas and attach drawings to the prompt (`/draw`, `Ctrl+Shift+C`) |
| [@andrii-k6a/pi-btw](./packages/pi-btw/) | Extension | Side-question command `/btw` |
| [@andrii-k6a/pi-feedback](./packages/pi-feedback/) | Extension | Review assistant replies in your editor and submit as feedback (`/feedback`) |
| [@andrii-k6a/pi-inspect](./packages/pi-inspect/) | Extension | Print the assembled system prompt and exit (`--dump-system-prompt`, `--dump-tools`) |
| [@andrii-k6a/pi-head](./packages/pi-head/) | Extension | Keyboard-scrollable viewer for the latest response (`/head`) |
| [@andrii-k6a/pi-tmux-branch](./packages/pi-tmux-branch/) | Extension | Branch the current Pi session into a new tmux pane (`/tmux-branch-*`) |
| [@andrii-k6a/pi-telegram](./packages/pi-telegram/) | Extension | Telegram DM bridge — forward messages to/from pi via a Telegram bot |
| [@andrii-k6a/pi-dynamic-workflows](./packages/pi-dynamic-workflows/) | Extension | Claude-Code-style dynamic workflows — fan work out across isolated subagents via a `workflow` tool |
| [agent-browser](./skills/agent-browser/) | Skill | Browser automation via `agent-browser` CLI |
| [engineering-discipline](./skills/engineering-discipline/) | Skill | Coding philosophy for non-trivial work |
| [i-have-adhd](./skills/i-have-adhd/) | Skill | Action-first, ADHD-friendly output shaping |
| [pi-simple-subagent](./skills/pi-simple-subagent/) | Skill | Delegate a task to a detached background Pi sub-agent, then pull back only its final result |
| [web-discovery](./skills/web-discovery/) | Skill | Browserless web search via local SearXNG + Defuddle |
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

## Uninstall

```bash
pi remove git:github.com/andrii-k6a/pi-packages
```

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
