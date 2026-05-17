# Web Discovery Skill

A local, browserless web discovery skill powered by SearXNG search and Defuddle/curl page fetching.

It runs SearXNG in podman/docker for discovery, then can use Defuddle to fetch and read result pages. Raw fetching remains available through curl. This gives agents a repeatable way to search the web, docs, package registries, repositories, code, and papers.

## Quick start

Run commands from this skill directory, or resolve the script paths relative to it when an agent invokes the skill.

```bash
# Start local SearXNG on http://localhost:8888
scripts/start-searxng --detach

# Search with compact formatted output
scripts/searx --category it --limit 5 "agent skills web search"
scripts/searx --category cargo tokio
scripts/searx --category packages --engines npm express

# JSON for agent parsing; --limit slices .results when jq is available
scripts/searx --category it --json --limit 5 "rust async" | jq '.results'

# Fetch a promising result page
scripts/fetch-url "https://example.com/article"
scripts/fetch-url --metadata "https://example.com/article"
scripts/fetch-url --raw "https://example.com/data.json"

# Stop when desired
podman stop searxng  # or: docker stop searxng
```

## Files

- `SKILL.md` — main skill instructions and quick reference.
- `scripts/start-searxng` — starts SearXNG with a minimal JSON-enabled local config.
- `scripts/searx` — bash helper around the SearXNG JSON API.
- `scripts/fetch-url` — fetches a URL and prints extracted readable content, concise metadata, or raw response bodies.
- `references/agent-usage.md` — detailed workflows for agents.
- `references/category-guide.md` — categories and engine selection.
- `references/package-engine-status.md` — package search engine notes.
- `references/pypi-direct-search.md` — PyPI workarounds.

## Requirements

- `curl`
- `podman` or `docker`
- `defuddle` on `$PATH` for extracted page fetching
- `jq` optional, for formatted parsing/output
- `python3` required for `scripts/fetch-url --metadata`; optional for formatting Defuddle output (`--raw` works without it)

No SearXNG installation is required; it runs in a container.

Install Defuddle explicitly before using extracted page fetching:

```bash
npm install -g --ignore-scripts defuddle@0.18.1
```

The skill does not install Defuddle automatically during normal use. Search, `scripts/fetch-url --metadata`, and `scripts/fetch-url --raw` still work without Defuddle.

## Useful categories

- `general` — broad web search.
- `it` — technical documentation/resources.
- `packages` — package registries across ecosystems.
- `cargo` — Rust crates.
- `repos` — source repositories.
- `code` — code search.
- `scientific publications` — papers.

## Notes

- PyPI search through SearXNG is unreliable because PyPI serves bot-protection challenges to scrapers. Use `uvx qypi search <term> --json` or exact PyPI JSON API lookups instead.
- SearXNG binds to `127.0.0.1` by default. Set `SEARXNG_HOST=0.0.0.0` only if you intentionally want to expose it beyond localhost.
- The default SearXNG config is stored under `${XDG_CACHE_HOME:-$HOME/.cache}/web-discovery`.
- The helper scripts are intentionally local to the skill; do not require adding them to `$PATH`.
