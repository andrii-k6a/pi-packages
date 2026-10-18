---
name: defuddle
description: Extract clean Markdown and metadata from a public web page or local HTML with the `defuddle` CLI. Use to read or summarize page content available without JavaScript rendering or login.
---

# Defuddle

Fetches a page over plain HTTP and returns only its main content as Markdown, without navigation, ads, or sidebars. It runs no browser, so it sees only the HTML the server sends.

Input must be HTML; raw Markdown, JSON, plain text, and PDFs are unsupported.

## Rules
- **Never install anything without the user's explicit approval.** If `defuddle` is missing, say so, show the install command below, and wait.
- Save each source to its own file in a new directory made for this task (see "Work directory").
  Read each file to its end, or say which part you did not read (see "Read and verify"). Fetching
  the whole page does not mean you have read it all.
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

## Work directory
Make one new directory per task and write every output file into it:
```bash
mktemp -d    # once per task; prints the new directory. Use that absolute path as OUT below
```
Never reuse a directory from an earlier task, or a fixed path such as `/tmp/research`. `-o` overwrites
without warning. A failed fetch exits 1 but leaves any old file of that name in place, and a leftover
file reads as a successful fetch. Shell variables may not persist between commands, so repeat the
path in each command.

## Use
```bash
OUT=/absolute/path/printed/by/mktemp   # the task's directory
defuddle parse "<url>" --md -f -o "$OUT/page.md"   # research default: Markdown with source and date metadata
defuddle parse "<url>" --md -o "$OUT/page.md"      # main content only
defuddle parse "<url>" -p title             # one field: title, author, published, description, site, domain, wordCount
defuddle parse page.html --md -o "$OUT/page.md"    # a local HTML file
defuddle parse - --md -o "$OUT/page.md" < page.html # HTML on stdin
```
The title is not in the body by default. Use `-f` or `-p title` to get it.

Image lines (`![alt](url)`) can be 10-30% of the output. Remove them before you read:
`grep -v '^!\[' "$OUT/page.md" > "$OUT/page.txt"`.

For several URLs, print one status line per URL. This keeps each failure tied to its URL. Pause
only before a repeat request to a host already fetched in the loop; a first request to a host needs
no pause, and a pause does not clear a block (403, 429):
```bash
OUT=/absolute/path/printed/by/mktemp   # the task's directory
seen=" "
while read -r name url; do   # one "name url" pair per line
  host=${url#*://}; host=${host%%/*}
  case "$seen" in *" $host "*) sleep 2 ;; esac
  seen="$seen$host "
  if defuddle parse "$url" --md -f -o "$OUT/$name.md" >/dev/null 2>"$OUT/$name.err"; then
    echo "$name ok $(wc -w <"$OUT/$name.md")w"
  else echo "$name FAIL $(head -1 "$OUT/$name.err")"; fi
done <<'EOF'
source-a https://example.com/a
source-b https://example.org/b
source-c https://example.com/c
EOF
```

## Read and verify

- Check the title, source, date, headings, and body to confirm this is the intended page. Metadata
  dates can be absent or misleading; distinguish publication dates from the period the data covers.
- Read each article to its end. Size it and list its headings, then read in chunks of about 100
  lines with a file-read tool (offset and limit) or `sed -n`:
  ```bash
  wc -l "$OUT/page.txt"                 # size; page.txt is page.md without image lines
  grep -n '^#' "$OUT/page.txt"          # outline with line numbers
  sed -n '1,100p' "$OUT/page.txt"       # then 101,200p and so on, up to the last line
  ```
  Do not stop at `head`, and do not shorten lines with `cut -c`: a paragraph is one line, and its
  qualifier is often at the end. Caveats and counter-evidence often come after the claim, for example
  a vendor's benchmark table followed by a note that its figures disagree with another source. Finish
  the article before you cite a figure from it. You may skip a footer, related links, comments, or a
  section you can name as irrelevant.
- Use `grep -n` to locate a claim, then read the surrounding paragraphs or table. An isolated
  matching line can omit qualifications, definitions, and denominators.
- Preserve the source URL with your notes. Describe what you inspected accurately, with line ranges:
  "read all 112 lines", or "partial: lines 1-70 of 112". Do not present a partial read as the
  article's full position. Selected sections or a summary page are not a full read of the article or
  the linked report. Follow links to the original report or study when a central claim needs its
  methods or statistical context.
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
