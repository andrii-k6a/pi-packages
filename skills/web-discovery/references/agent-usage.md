# Web Discovery with SearXNG for Agents

This guide explains how to use the `web-discovery` skill from an agent harness.

Resolve `scripts/...` paths relative to the skill directory. Do not assume `searx` or `start-searxng` are installed globally.

## Why use SearXNG?

SearXNG gives the agent:

- Local, privacy-respecting metasearch.
- JSON output suitable for tool use.
- Search categories for packages, repositories, code, IT resources, papers, news, and more.
- Package registry search for many ecosystems.

Use it when local project files are not enough and external sources are required.

## Basic workflow

### 1. Start SearXNG if needed

```bash
curl -sf http://localhost:8888/ >/dev/null 2>&1 || scripts/start-searxng --detach
```

The start script is idempotent: if the named container is already running, it waits for readiness and exits successfully.

### 2. Pick the right category

| User intent | Category / approach |
| --- | --- |
| Current/general web info | `general`, or `news` when specifically news/current-events |
| Technical docs/resources | `it` |
| Rust crates | `cargo` |
| npm or multi-ecosystem packages | `packages`, optionally `--engines npm` |
| GitHub/GitLab/Codeberg repos | `repos` |
| Code examples/patterns | `code` |
| Papers | `scientific publications` |
| Python packages | Prefer `uvx qypi search <term> --json`; see `pypi-direct-search.md` |

### 3. Search

Formatted output:

```bash
scripts/searx --category it --limit 5 "kubernetes helm values schema"
scripts/searx --category cargo --limit 5 "http client"
scripts/searx --category packages --engines npm --limit 5 "react form validation"
```

JSON output (`--limit` slices `.results` when `jq` is available):

```bash
scripts/searx --category repos --json --limit 5 "terminal AI agent" | jq '.results[] | {title, url, content, engines}'
```

Direct API:

```bash
curl -fsS -G "http://localhost:8888/search" \
  --data-urlencode "q=tokio async" \
  --data-urlencode "format=json" \
  --data-urlencode "categories=cargo" | jq '.results[0:5]'
```

### 4. Clone repositories when source exploration is needed

Search results are for discovering repositories; local tools are for understanding code. Prefer the canonical repository from package metadata, official docs, or the project website before treating cloned source as authoritative. If the task requires searching across files, reading multiple source files, checking history, understanding structure, or comparing implementations, clone the selected repository into a temporary directory.

```bash
workdir="$(mktemp -d "${TMPDIR:-/tmp}/web-discovery.XXXXXX")"
repo_dir="$workdir/repo"
git clone --depth 1 --single-branch "$repo_url" "$repo_dir"
printf 'workdir=%q\nrepo_dir=%q\n' "$workdir" "$repo_dir"
```

For iterative agent workflows, do not rely on `trap` cleanup or `cd` from a previous shell/tool call. Copy the printed paths into later commands and use explicit paths:

```bash
repo_dir="/tmp/web-discovery.xxxxxx/repo"  # paste the printed repo_dir value

rg "search term" "$repo_dir"
git -C "$repo_dir" grep "symbol_name"

# If commit history is needed:
git -C "$repo_dir" fetch --deepen=50
git -C "$repo_dir" log --oneline -20
```

Keep clones shallow by default for structure/search tasks; if history is needed, deepen or unshallow only as much as necessary. Clean up the temporary work directory explicitly when exploration is done:

```bash
workdir="/tmp/web-discovery.xxxxxx"  # paste the printed workdir value
rm -rf "$workdir"
```

For large repositories, use metadata or raw fetched files for narrow questions. When relevant paths are known, replace the clone command above with a sparse/filtered clone:

```bash
workdir="$(mktemp -d "${TMPDIR:-/tmp}/web-discovery.XXXXXX")"
repo_dir="$workdir/repo"
git clone --depth 1 --filter=blob:none --sparse "$repo_url" "$repo_dir"
git -C "$repo_dir" sparse-checkout set docs src/package-name
printf 'workdir=%q\nrepo_dir=%q\n' "$workdir" "$repo_dir"
```

Do not clone for README-level, package-metadata, license, or single-file questions when snippets, package APIs, or raw fetched files are enough. Do not install dependencies, run project code, or make persistent changes in temporary clones unless the user asks or it is clearly required.

### 5. Fetch when snippets are not enough

Search results are good for discovery. Fetch pages before relying on details that are not present in snippets. The fetch helper requires Defuddle on `PATH` for extracted content and never installs packages on demand. Metadata fallback and raw `--raw` fetching are curl-backed and work without Defuddle.

Before the first extracted fetch in a task/conversation, check once in the same shell/environment with `command -v defuddle` unless already checked there. Do not run this preflight for search-only tasks, because SearXNG search, snippets, package/repository discovery, and raw fetching do not need Defuddle.

Interactive check pattern:

```bash
if command -v defuddle >/dev/null 2>&1; then
  echo "Defuddle available for extracted fetches"
else
  echo "Defuddle not available; skip extracted fetch. Use snippets, alternate sources, --metadata, or --raw only for raw-useful URLs/sources." >&2
  # Interactive pattern: continue without extracted fetch. In automation, exit 1 here.
fi
```

Then, only when the check succeeds, fetch the selected real result URL(s):

```bash
scripts/fetch-url "$selected_url"
scripts/fetch-url --max-chars 20000 "$selected_docs_url"
```

If Defuddle is missing, search still works and `scripts/fetch-url --metadata` / `scripts/fetch-url --raw` still work. Do not attempt extracted fetching; use snippets, alternate sources, `--metadata` when page title/date/description/canonical source is enough, or `--raw` only for URLs/sources where the raw response itself is useful.

Prefer extracted fetch for readable articles, blog posts, news pages, documentation pages, and guides.

Prefer `--metadata` for extraction-hostile readable pages when concise metadata is enough to verify source identity, title, description, canonical URL, or dates. Claims based on metadata only must be labeled as metadata-limited.

Prefer `--raw` for machine-readable or source-like content, for example: JSON APIs, package metadata, XML/RSS/Atom feeds, sitemaps, CSV/TSV, plain text, Markdown, source/config files, OpenAPI specs, and raw-content URLs. Also use it when the user asks for diagnostics/source inspection such as headers/body/source, redirects, metadata, JS-rendered links, page structure, or HTML markup itself.

Do not use `--raw` for normal article/docs HTML merely because Defuddle failed; if extracted text was desired, ordinary HTML is usually not raw-useful.

```bash
scripts/fetch-url --metadata "https://example.com/article"
scripts/fetch-url --raw "https://example.com/data.json"
scripts/fetch-url --raw "https://raw.githubusercontent.com/user/repo/main/README.md"
scripts/fetch-url --raw "https://example.com/sitemap.xml"
```

For PDFs and binary/document downloads, do not expect Defuddle extraction and do not dump binary with `--raw`. Use snippets/metadata, a dedicated document/PDF tool if available, or cite the downloadable source and limitation.

### Avoid fetch-driven tunnel vision

Defuddle is for reading pages, not ranking the web. A page that extracts cleanly is not automatically more important than a blocked page. Collect candidates with search first, then fetch a small set of high-signal URLs.

Blocked pages are common. If source returns 401/403, use metadata/snippets, search for alternate coverage, or cite the limitation.

If extracted fetching fails:

1. Do not retry the same URL with the same mode.
2. Use `--metadata` if title/date/description/canonical metadata is enough.
3. If the raw response itself is useful — machine-readable/source-like content, raw-content URLs, diagnostics/source inspection, or HTML source when the markup itself is needed — try `--raw` once.
4. Otherwise, search for another source or syndicated/secondary coverage.
5. If no better source exists, use the SearXNG snippet and clearly say the claim is snippet-only.

If raw fetching fails, do not fall back to another raw attempt on the same URL. Search for another source, use available snippets with clear caveats, or cite the limitation.

### 6. Present results

- Classify material claims as `fetched`, `metadata`, `snippet`, or `unverified` while working.
- Cite URLs for web-derived claims.
- Prefer a small curated set of high-signal results.
- Distinguish fetched-page evidence from metadata-only or snippet-only evidence.
- Note blocked pages when relevant.
- Avoid presenting inaccessible page details as if fully verified.
- Mention uncertainty if snippets are weak, pages could not be fetched, or engines were unresponsive.
- If results are empty, retry once with broader terms or a different category.

## Common use cases

### Package discovery

```bash
scripts/searx --category cargo --json "http requests" | \
  jq -r '.results[0:5][] | "- [\(.title)](\(.url)) — \(.content // "")"'
```

For npm only:

```bash
scripts/searx --category packages --engines npm --json "date picker" | \
  jq '.results[0:5] | .[] | {title, url, content}'
```

### Repository discovery

```bash
scripts/searx --category repos --json "browser automation agent" | \
  jq '.results[0:10] | .[] | {title, url, engines}'
```

For deeper code exploration, follow workflow step 4.

### Code examples

```bash
scripts/searx --category code --json "async fn main tokio" | \
  jq '.results[0:10] | .[] | {title, url, content}'
```

### Academic papers

```bash
scripts/searx --category "scientific publications" --json "retrieval augmented generation evaluation" | \
  jq '.results[0:5] | .[] | {title, url, date: .publishedDate, content}'
```

### Search, then fetch top URLs

```bash
if command -v defuddle >/dev/null 2>&1; then
  scripts/searx --category it --json "SearXNG settings.yml formats json" | \
    jq -r '.results[0:3][] | .url' | \
    while read -r url; do
      scripts/fetch-url --max-chars 8000 "$url"
    done
else
  echo "Defuddle not available; use snippets or alternate sources for readable pages" >&2
fi
```

## Error handling

### SearXNG is not responding

```bash
scripts/start-searxng --detach
podman logs searxng  # or: docker logs searxng
```

### Empty or poor results

1. Check unresponsive engines:
   ```bash
   scripts/searx --json "query" | jq '.unresponsive_engines'
   ```
2. Try broader terms.
3. Try a category that better matches the task.
4. Try engine-specific search with `--engines`.

### PyPI

Avoid SearXNG's PyPI engine. Use:

```bash
uvx qypi search pandas --json
uvx qypi info requests --json
curl -fsS "https://pypi.org/pypi/requests/json" | jq '.info | {name, version, summary, home_page}'
```

## Cleanup

Leave SearXNG running during a search-heavy task. Stop it only when done or when the user asks:

```bash
podman stop searxng  # or: docker stop searxng
```
