# pi-packages

These are packages built for my personal use and shared with the community of [pi](https://github.com/badlogic/pi-mono) in case it helps others.

Pi packages can include extensions, skills, prompt templates, and themes. See the [pi packages docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md) for details.

## Packages

| Package | Type | Description |
|---------|------|-------------|
| [@andrii-k6a/pi-generative-ui](./packages/pi-generative-ui/) | Extension | Render generated HTML/SVG widgets in native windows (`visualize_read_me`, `show_widget`) |
| [@andrii-k6a/pi-feedback](./packages/pi-feedback/) | Extension | Review assistant replies in your editor and submit as feedback (`/feedback`) |
| [@andrii-k6a/pi-inspect](./packages/pi-inspect/) | Extension | Print the assembled system prompt and exit (`--dump-system-prompt`, `--dump-tools`) |
| [@andrii-k6a/pi-tmux-branch](./packages/pi-tmux-branch/) | Extension | Branch the current Pi session into a new tmux pane (`/tmux-branch [direction]`) |
| [@andrii-k6a/pi-dynamic-workflows](./packages/pi-dynamic-workflows/) | Extension | Dynamic workflows — fan work out across subagents with separate conversation contexts via a `workflow` tool |
| [@andrii-k6a/pi-ask-question](./packages/pi-ask-question/) | Extension | Ask up to four multiple-choice questions in a terminal dialog and return structured answers (`ask_user_question`) |
| [@andrii-k6a/pi-caffeinate](./packages/pi-caffeinate/) | Extension | Keep the computer awake while an agent run is active |
| [engineering-discipline](./skills/engineering-discipline/) | Skill | Coding philosophy for non-trivial work |
| [searxng](./skills/searxng/) | Skill | Discover sources through local SearXNG search |
| [defuddle](./skills/defuddle/) | Skill | Read static web pages as clean Markdown |
| [crawl4ai](./skills/crawl4ai/) | Skill | Read rendered pages and crawl sites with a local browser |
| [assistant](./prompts/assistant.md) | Prompt | Treat the session as a general-purpose personal assistant |

Each extension has its own README with setup instructions, usage, and configuration details.
Skills document their usage in `SKILL.md`.
Prompt templates are single Markdown files in `prompts/`; the filename is the slash command.

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
