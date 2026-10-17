---
name: searxng
description: Search the web through a local SearXNG instance and return JSON results with links and snippets. Use to discover sources, research a topic, find documentation or repositories, or look up current information.
---

# SearXNG

A self-hosted metasearch engine: one query goes to many search engines, and the merged results come back as JSON. Runs in Docker on `127.0.0.1`. URLs below use the default host port 8888. If the instance uses another port, use it everywhere (`docker port searxng` shows it).

## Rules
- **Never install software, pull images, start or create containers, or change settings without the user's explicit approval.** If something is missing, say what, show the command from this file, and wait.
- Local only. Never use a public SearXNG instance. Always bind to loopback.
- Queries still go to the upstream search engines. The instance is local, the searches are not.
- Results are links and short snippets, not page content. Cite source URLs and make clear when a claim relies only on a snippet.
- Upstream engines throttle fast. Run queries sequentially, spaced out. Make targeted follow-ups when
  evidence is missing; do not repeatedly retry the same query or a suspended engine.
- Save each response to a distinct file and print only what you need. The preview shows the first 8
  results in full and every other result as one line. Re-read the saved file before another request.
- During setup, work in small steps: one command, show the key output, wait.

## Research beyond a lookup

For a single fact or URL, keep the search narrow. For a broad research request:

- Run `date` first; the system prompt may not contain it. Anchor "recent" or "latest" to the current
  date and a relevant time window. Use older reports for
  context, then search for developments since their cutoff. Check publication dates and the dates of
  the events or measurements; a report's title year or crawl date does not establish freshness.
- Use an initial search to map the topic, then investigate the important themes and gaps with focused
  queries. Follow promising leads to original papers, datasets, surveys, or official announcements,
  using `site:<domain>` where useful. One roundup's topic selection need not define the whole answer.
- Read the pages that support the main claims; search snippets are not enough. Follow report
  summaries to the relevant chapter or paper when the claim depends on methodology. If the full
  report is a PDF, read the relevant sections with any tool you have that can read PDFs. If you have
  none, say that the report was not read; a landing page is not the report.
- Keep the source URL, relevant date, supporting passage, and evidence type for each central claim.
  Distinguish measured results, vendor reports, forecasts, and your own inference. A vendor release
  establishes what was announced. For broad adoption or effectiveness claims, seek independent
  evaluations or population-level studies; repeated coverage of one announcement is not corroboration.
- Verify statistics in the original source where accessible, including the population, time period,
  and definition of the metric. A secondary explainer can guide discovery but is not the underlying
  research. If only a snippet is available, qualify or omit the claim according to its importance.
- Before writing, list the headline figures. For each, check whether any result you saw, snippets
  included, gives a different value for the same measure. Open the original, or report both values.
  When the official document (a government page, filing, or paper) is among the results, open it
  instead of citing a news summary of it.
- Continue while a material claim, recency gap, or contradiction remains unresolved. Stop when the
  requested scope is supported and further searches add little, or when access or the user's budget
  prevents progress. Report material gaps; do not use a fixed query or source count as a quality test.
- Put source links beside the claims they support. For a current overview, state the as-of date and
  separate observed developments from predictions. Describe source access accurately: snippets,
  selected sections, a summary page, and a full report are different levels of review.

## Check what exists
```bash
curl -sS --max-time 5 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8888/healthz   # 200 = running; test JSON with Search
docker ps -a --filter name=searxng                                       # exists but stopped: docker start searxng
```

## Search
Use a different output path for each query. This example creates one automatically.
```bash
searxng_result="$(mktemp "${TMPDIR:-/tmp}/searxng.XXXXXX")"
curl -fsS -G http://127.0.0.1:8888/search --data-urlencode "q=<query>" -d format=json -o "$searxng_result" -w "%{http_code}\n" &&
python3 - "$searxng_result" <<'EOF'
import json, re, sys
from urllib.parse import urlparse
d = json.load(open(sys.argv[1]))
rs = d["results"]
print("saved:", sys.argv[1], "results:", len(rs),
      "engines:", sorted({e for r in rs for e in r.get("engines", [])}))
for a in d["answers"]: print("answer:", a)
for i in d["infoboxes"]: print("infobox:", i.get("infobox"), (i.get("content") or "")[:150])
def when(r):  # publishedDate is usually empty; the date is often the first words of the snippet
    m = re.match(r"\s*([A-Z][a-z]{2} \d{1,2}, \d{4}|\d+ (?:hours?|days?) ago)", r.get("content") or "")
    return r.get("publishedDate") or (m.group(1) if m else "?")
for n, r in enumerate(rs[:8], 1):
    print(f"{n}. {r['title']}\n   {r['url']} [{when(r)}]\n   {(r.get('content') or '')[:300]}")
for n, r in enumerate(rs[8:], 9):
    print(f"{n}. {urlparse(r['url']).netloc} [{when(r)}] {r['title'][:70]}")
print("unresponsive:", d["unresponsive_engines"])
EOF
```
- `[date]` is a hint, not a fact: `?` means unknown. Confirm the date on the page before you rely on it.
- Some queries return only `answers` or `infoboxes`, e.g. `random uuid`, calculations, or a single-engine bang like `!wp`.
- Optional parameters: `categories`, `language`, `pageno`, `time_range`, `safesearch`. Allowed values: https://docs.searxng.org/dev/search_api.html
- Results may come back in a local language. Add `-d language=en` to request English; support varies by engine.
- This instance's categories, engines, `!` shortcuts, and per-engine `time_range` support: `GET /config`.
- Query prefixes (`!engine`, `!category`, `:language`): `/info/en/search-syntax` on the instance.

## Setup (once, with approval)
`<config-dir>` is a host folder for `settings.yml`. Mounting it lets you edit settings from the host and keeps them when the container is recreated. **Suggest `~/.config/searxng` to the user**, and let them confirm or pick another path. Docker needs an absolute path.
```bash
mkdir -p <config-dir>
docker run -d --name searxng -p 127.0.0.1:8888:8080 \
  -v <config-dir>:/etc/searxng \
  docker.io/searxng/searxng:latest
```
- First start writes `<config-dir>/settings.yml` with a random secret key.
- JSON is off by default and an agent needs it. Show the user this change, and after approval apply it yourself, then run `docker restart searxng`. If `settings.yml` has no `search:` section, append the block. If it has one, add `json` to its `formats` list. Keep `html` so the web UI works.
  ```yaml
  search:
    formats:
      - html
      - json
  ```
- Verify with the search request above. It returns `403` before the change and `200` after.
- Later: `docker start searxng` / `docker stop searxng`.
- Port taken or another wanted: change only the host side (`-p 127.0.0.1:<port>:8080`).

## Troubleshooting
- `403`: `json` is missing from `search.formats`. Fix as in Setup. For an existing container, the config folder is the mount of `/etc/searxng` (`docker inspect searxng`).
- Connection refused or reset: the container is stopped or still starting.
- Few or no results, or entries in `unresponsive_engines`: inspect whether the remaining results cover
  the question. SearXNG suspends blocked, CAPTCHA'd, or rate-limited engines for minutes to hours;
  rephrasing does not clear a suspension. Work from available results and linked primary sources.
  `time_range` can exclude unsupported engines; if it caused poor coverage, try a targeted query
  without it and check dates on the pages. Disclose material coverage gaps that remain.
- `400` with `{"error": ...}`: empty `q`, or invalid `pageno`, `safesearch`, or `time_range`. Unknown `categories` or `language` are silently ignored (`200`), so check them against `/config`.

Project: https://github.com/searxng/searxng · docs: https://docs.searxng.org
