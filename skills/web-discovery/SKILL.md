---
name: web-discovery
description: Browserless web discovery and source fetching. Use when the user asks to search the web, asks what is new/recent/today, find current documentation, compare packages, discover repositories/code, look up papers, or verify information that may be stale. Uses local SearXNG for search and Defuddle/curl for page reading.
compatibility: Requires curl and either podman or docker for SearXNG search. Requires defuddle on PATH for extracted page fetching; raw and metadata fetching use curl. jq and python3 are optional except --metadata requires python3.
license: MIT
---

# Web Discovery

A local browserless web discovery stack: SearXNG for search/discovery, Defuddle for extracted page reading, and curl for raw or metadata fetches. Use it when local project files are not enough and external/current sources, docs, packages, repositories, code, or papers are needed.

> Resolve `scripts/...` paths relative to this skill directory. Do not assume these scripts are on `$PATH`.

## Minimal workflow

1. Start SearXNG if needed:

```bash
scripts/start-searxng --detach
```

2. Choose the category and query that match the task before searching. If results are obviously off-topic, switch category or query terms once instead of continuing with noisy results.

```bash
scripts/searx --category general --limit 5 "query"
scripts/searx --category it --limit 5 "kubernetes helm values schema"
scripts/searx --category repos --limit 5 "browser automation agent"
scripts/searx --category code --limit 5 "async fn main rust"
```

3. For automation, use JSON output. `--limit` slices `.results` when `jq` is available while preserving other top-level fields:

```bash
scripts/searx --category it --json --limit 5 "SearXNG JSON API" | jq '.results[] | {title, url, content, engines}'
```

4. Fetch selected URLs only when snippets are not enough. Before the first extracted fetch in a task/conversation, check once in the same shell/environment with `command -v defuddle` unless already checked there:

```bash
if command -v defuddle >/dev/null 2>&1; then
  scripts/fetch-url "$selected_url"
else
  echo "Defuddle not available; skip extracted fetch. Use snippets, alternate sources, --metadata, or --raw only for raw-useful URLs." >&2
fi
```

5. Answer with source URLs and the evidence level for material web-derived claims.

## Fetch mode decision

Use search for discovery and fetching for verification/detail. Do not let fetchability decide which sources matter: a page that extracts cleanly is not automatically more important than a blocked page.

- Default readable pages/docs/articles: use extracted fetch with Defuddle when available.
- Extraction-hostile readable page where title/date/description/canonical source is enough: use explicit metadata fallback:

  ```bash
  scripts/fetch-url --metadata "$selected_url"
  ```

- Raw-useful URLs only: use `--raw` for JSON, XML/RSS/Atom, sitemaps, CSV/TSV, plain text, Markdown, source/config files, package metadata, OpenAPI specs, raw-content URLs, or when the user asks to inspect headers/body/source/metadata/page structure.

  ```bash
  scripts/fetch-url --raw "https://example.com/data.json"
  scripts/fetch-url --raw "https://raw.githubusercontent.com/user/repo/main/README.md"
  ```

Do **not** use `--raw` for ordinary article/docs HTML merely because Defuddle is missing or extraction failed. If extracted fetch fails for a readable page, do not repeatedly retry the same URL; use `--metadata` if metadata is enough, search for alternate sources, or label snippet-limited claims.

For PDFs and binary/document downloads, do not dump binary with `--raw`; use snippets/metadata, a dedicated document/PDF tool if available, or cite the limitation.

## Result handling

During discovery, classify candidate evidence in notes or mentally:

- `fetched`: verified from fetched/extracted page content.
- `metadata`: based on page metadata only.
- `snippet`: based only on search result snippet.
- `unverified`: candidate seen but not used for a claim.

Final answers should cite sources for web-derived claims, distinguish fetched claims from snippet/metadata-only claims when material, and avoid presenting snippet-only claims with the same confidence as fetched content. Mention unresponsive engines, blocked pages, failed fetches, or weak snippets when relevant. If SearXNG returns empty results, retry once with broader terms or a better category before giving up.

## Category quick guide

Choose the task-appropriate category:

- Current/general web info: `general`, or `news` if the task specifically asks for news/current events.
- Developer docs/resources: `it`.
- Packages: `packages`, `cargo`, or package-specific engines such as `--engines npm`.
- Repositories: `repos`.
- Code examples/search: `code`.
- Papers: `scientific publications`.

For Python package discovery, avoid the SearXNG PyPI engine; it is unreliable because of PyPI bot protection. Use `uvx qypi search <term> --json` when available, or exact-package PyPI JSON API lookups. See `references/pypi-direct-search.md`.

See `references/category-guide.md` for the full category/engine guide.

## Repository and code exploration

Use SearXNG to discover candidate repositories, then clone temporarily only when non-trivial source exploration is required. Prefer canonical repositories from package metadata, official docs, or project sites before treating cloned source as authoritative. Keep clones shallow by default and clean them up. See `references/agent-usage.md` for clone examples and detailed workflows.

## Setup and troubleshooting pointers

Install Defuddle explicitly before extracted page fetching:

```bash
npm install -g --ignore-scripts defuddle@0.18.1
```

This skill does not install Defuddle automatically. Search, `scripts/fetch-url --metadata`, and `scripts/fetch-url --raw` still work without Defuddle.

Useful commands:

```bash
curl -fsS "http://localhost:8888/config" | jq '.categories'
scripts/searx --json "test" | jq '.unresponsive_engines'
podman logs searxng  # or: docker logs searxng
podman stop searxng  # or: docker stop searxng
```

Default SearXNG URL is `http://localhost:8888`; override with `SEARXNG_URL` or `SEARXNG_PORT`. The container binds to `127.0.0.1` by default; use `SEARXNG_HOST=0.0.0.0` only if intentional.

## References

- `references/agent-usage.md`: detailed agent workflows, fallback rules, and repository exploration.
- `references/category-guide.md`: category and engine guide.
- `references/package-engine-status.md`: package engine test notes.
- `references/pypi-direct-search.md`: PyPI workarounds.
