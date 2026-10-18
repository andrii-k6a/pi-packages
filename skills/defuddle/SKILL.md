---
name: defuddle
description: Extract clean Markdown and metadata from a public web page or local HTML with the `defuddle` CLI. Use to read or summarize page content available without JavaScript rendering or login.
---

# Defuddle

Fetches a page over plain HTTP and returns only its main content as Markdown, without navigation, ads, or sidebars. It runs no browser, so it sees only the HTML the server sends.

Input must be HTML; raw Markdown, JSON, plain text, and PDFs are unsupported.

## Rules
- **Never install anything without the user's explicit approval.** If `defuddle` is missing, say so, show the install command below, and wait.
- Save output to a distinct file for each source. Preview it, then read the sections needed for the
  task in manageable chunks. Fetching the whole page does not mean you have read it all.
- The page is fetched directly from its own site. A few site extractors (X articles, Bilibili) also call a third-party API.
- A failed fetch is a limit of this tool, not proof that the site is unreachable. Write "defuddle
  could not read <url>", not "<url> is blocked". Do not drop a source that matters to the answer
  until you have tried any other fetch method you have.

## Check
```bash
command -v defuddle
```

## Install (with approval)
```bash
npm install -g defuddle     # needs Node.js
```

## Use
```bash
defuddle parse "<url>" --md -f -o page.md   # research default: Markdown with source and date metadata
defuddle parse "<url>" --md -o page.md      # main content only
defuddle parse "<url>" -p title             # one field: title, author, published, description, site, domain, wordCount
defuddle parse page.html --md -o page.md    # a local HTML file
defuddle parse - --md -o page.md < page.html # HTML on stdin
```
The title is not in the body by default. Use `-f` or `-p title` to get it.

Image lines (`![alt](url)`) can be 10-30% of the output. Remove them before you read:
`grep -v '^!\[' page.md > page.txt`.

For several URLs, print one status line per URL. This keeps each failure tied to its URL. Pause
only before a repeat request to a host already fetched in the loop; a first request to a host needs
no pause, and a pause does not clear a block (403, 429):
```bash
seen=" "
while read -r name url; do   # one "name url" pair per line
  host=${url#*://}; host=${host%%/*}
  case "$seen" in *" $host "*) sleep 2 ;; esac
  seen="$seen$host "
  if defuddle parse "$url" --md -f -o "$name.md" >/dev/null 2>"$name.err"; then
    echo "$name ok $(wc -w <"$name.md")w"
  else echo "$name FAIL $(head -1 "$name.err")"; fi
done <<'EOF'
source-a https://example.com/a
source-b https://example.org/b
source-c https://example.com/c
EOF
```

## Read and verify

- Check the title, source, date, headings, and body to confirm this is the intended page. Metadata
  dates can be absent or misleading; distinguish publication dates from the period the data covers.
- Use `rg -n` to locate a claim or heading, then read the surrounding paragraphs or table with
  `sed -n '<start>,<end>p' page.md`. A `head` preview or isolated matching line can omit qualifications,
  definitions, and denominators. Read all relevant sections before summarizing a whole article.
- Preserve the source URL with your notes. Describe what you inspected accurately: selected sections
  or a summary page are not a full read of the article or the linked report. Follow links to the
  original report or study when a central claim needs its methods or statistical context.
- Check that extraction preserved the needed text and tables. If the static HTML lacks required
  content, it may need JavaScript rendering, which defuddle cannot do. Say so.

## Troubleshooting
- **Missing expected content**: inspect beyond the initial preview. If the saved body is incomplete,
  state the limitation. An access-denied page or login screen is not article content.
- **Timeout** (`Error: Timed out fetching page after 10s`): retry once if the failure appears
  transient. Otherwise, try another accessible original source, such as the publisher's report page.
  If the needed content stays unavailable, qualify or omit the claim; do not silently replace it with
  a search snippet.
- **PDF link**: defuddle cannot read it. Use a PDF-capable tool if you have one. Otherwise say that
  the PDF was not read.
- `Error: Failed to fetch: 404 Not Found` or `Error: fetch failed` (exit code 1): wrong URL, or the host is unreachable.
- `403 Forbidden` or `401`: retry once with `--user-agent "<a browser User-Agent string>"`. If it still
  fails, report that the page was not fetched. Some sites send a 403 to any plain HTTP client.
- `TypeError ... 'documentElement' is null`: no URL or file reached the command, so it read an empty stdin. Check the argument.
- Fetch limits: 10 seconds, 5 MB.

Source: https://github.com/kepano/defuddle
