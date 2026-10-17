---
name: crawl4ai
description: Fetch, extract, and crawl web pages with Crawl4AI running locally via `crwl` or Docker. Use when a page needs JavaScript rendering or refuses plain HTTP requests, or when a task needs saved browser sessions, page interaction, screenshots, PDF export, structured JSON extraction, or a site crawl.
---

# Crawl4AI

Two ways to run it: the `crwl` CLI, or a REST server in Docker, on `127.0.0.1`, default port 11235.

## Rules
- **Never install software, pull images, start or create containers, or create credentials without the user's explicit approval.** If something is missing, say what, show the command from this file, and wait.
- Don't start the server unless the task needs it (see Which one). If `crwl` can do the job, use it.
- Local only. Do not use `crwl cloud` or `api.crawl4ai.com`.
- Never print the API token or write it to a file.
- Save output to distinct files per source. Preview large results, then read the needed sections in
  manageable chunks. Fetching or rendering a whole page does not mean you have read all its content.
- Always run `crwl` and `crawl4ai-*` commands with `CRAWL4AI_NO_CLOUD_NOTICE=1` to hide the Cloud promo banner.
- During setup, work in small steps: one command, show the key output, wait.

## Which one
- **`crwl`** (default): one page or a few, ad-hoc, no server. Also when the browser matters: a visible window, a saved login profile, or images and screenshots (the server runs a lean text-only browser by default).
- **REST**: many URLs in one call (batch or streaming), repeated calls (browser stays warm), several tools sharing one crawler, or keeping the browser isolated in a container.

## Check what exists
```bash
command -v crwl                                          # CLI installed?
curl -fsS --max-time 5 http://127.0.0.1:11235/health      # server running?
docker ps -a --filter name=crawl4ai                      # container exists?
security find-generic-password -a "$USER" -s crawl4ai-local >/dev/null 2>&1 && echo token present
```

## Install CLI (with approval)
Missing? Ask the user, then install with a supported Python (listed on https://pypi.org/project/crawl4ai/), not necessarily the system default:
```bash
uv tool install crawl4ai --python <x.y>   # no uv: brew install uv
CRAWL4AI_NO_CLOUD_NOTICE=1 crawl4ai-setup   # downloads the browser
CRAWL4AI_NO_CLOUD_NOTICE=1 crawl4ai-doctor  # verify
```

## CLI
```bash
CRAWL4AI_NO_CLOUD_NOTICE=1 crwl "<url>" -o markdown -O page.md     # raw Markdown for source verification
CRAWL4AI_NO_CLOUD_NOTICE=1 crwl "<url>" -o markdown-fit -O fit.md  # pruned preview; may omit relevant content
CRAWL4AI_NO_CLOUD_NOTICE=1 crwl "<url>" -o all -O result.json      # full result (large)
CRAWL4AI_NO_CLOUD_NOTICE=1 crwl --help                            # browser/crawler options, extraction, deep crawl
```
Bound a slow page with `-c page_timeout=45000` (milliseconds). macOS has no `timeout` command.

Put all `-c` options in one flag, separated by commas: `-c "magic=true,page_timeout=45000"`. A second
`-c` silently replaces the first.

`crwl` cannot read a PDF URL. It fails with `'NoneType' object has no attribute 'raw_markdown'`.
Use a PDF-capable tool if you have one. Otherwise say that the PDF was not read.

## Blocked pages
A protected site can answer with `Access Denied`, a CAPTCHA, a "security verification" page, or an
empty page, and the command still succeeds. Check the size and the first lines of the output. A file
of a few hundred bytes is an error page.

Try each blocked URL, not a sample, in this order. Stop at the first step that returns the article:
1. `CRAWL4AI_NO_CLOUD_NOTICE=1 crwl "<url>" -o markdown -O page.md` (the default).
2. Add anti-bot handling:
   `CRAWL4AI_NO_CLOUD_NOTICE=1 crwl "<url>" -c "magic=true" -o markdown -O page.md`. This works only
   some of the time. On one strict Akamai site it returned the article in about 1 attempt in 5, and
   step 1 never did. Try up to 5 times, 5 seconds apart. Stop at the first result of several KB.
   Some sites stay denied or empty at every attempt.
3. Still denied or empty: report the page as not fetched. Do not retry further or use the cloud API.

## Verify rendered content

- If a page's content is missing or blocked, fetch that specific page first. Inspect whether the
  missing content actually appears before expanding to a site crawl. If the evidence lives in the
  source's own report, find that report's page or link; exporting a web page as PDF does not
  retrieve a linked report.
- `markdown-fit` is filtered content. If a claim depends on caveats, tables, or methods, inspect raw
  Markdown and the surrounding section. If extraction still loses them, inspect the rendered page or
  full result as needed. A successful request can still return an error page, login, or consent wall.
- Keep the URL and available source dates with the relevant passage. Distinguish the article date
  from the data period and retrieval date. Check statistics against their definitions and population.
- Report remaining access or extraction gaps and which sections you inspected; do not describe a
  preview or filtered output as a full read.

## REST server
Needs Docker and a token. Without a token the server is unreachable. Always bind to loopback.

**Port:** prefer 11235. If it is taken or the user wants another, change only the host side (`-p 127.0.0.1:<port>:11235`) and use that port in every URL. `docker port crawl4ai` shows the one in use.

**Token** (macOS Keychain; on other systems use the OS secret store):
```bash
security add-generic-password -a "$USER" -s crawl4ai-local -w "$(openssl rand -hex 32)"   # once
TOKEN="$(security find-generic-password -a "$USER" -s crawl4ai-local -w)"                 # per use
```

**Run** (once; later `docker start crawl4ai` / `docker stop crawl4ai`):
```bash
docker run -d -p 127.0.0.1:11235:11235 --name crawl4ai --shm-size=1g \
  -e CRAWL4AI_API_TOKEN="$(security find-generic-password -a "$USER" -s crawl4ai-local -w)" \
  unclecode/crawl4ai:latest
```

**Call** (`/health` needs no auth, everything else needs the Bearer token):
```bash
curl -fsS http://127.0.0.1:11235/md -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"url": "<url>"}' -o resp.json
```
Check `success` before using the response's `markdown`; an HTTP 200 alone does not prove the crawl succeeded.
Other endpoints: `/crawl`, `/html`, `/screenshot`, `/pdf`, `/execute_js`. Request formats: https://docs.crawl4ai.com/core/self-hosting/

## Troubleshooting
Source of truth: https://github.com/unclecode/crawl4ai

Common: `401` means a missing or wrong Bearer token. "Connection reset" means the container started without a token, or is still starting (about 20s).
