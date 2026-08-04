# Rendered-page fallback

This skill is browserless-first. This reference covers the optional, last-resort
escalation to a rendered browser page when browserless extraction of a readable
page fails, or nominally succeeds but is not actually sufficient for the task.

It does not turn `web-discovery` into a scraper and does not add a browser
dependency to `scripts/fetch-url`. Use it only when the general workflow in
`agent-usage.md` says to escalate.

## Scope and trigger signals

Escalate only when extraction fails or is insufficient **and** the task needs
the full source content or source media. Exit code zero is not proof of
sufficiency.

Trigger signals (any, judged against task intent — no universal word-count
threshold):

- Extracted fetching fails or returns no readable content.
- The expected article/post body is absent while the fetch "succeeded".
- Output is headline-only or thin (wrapper/shell captured, not the content).
- Navigation, replies, recommendations, or card previews dominate the output.
- Requested media (images/figures the task needs) are missing.

Do not enter this fallback merely because output beyond the helper's limit is
unknown. If `scripts/fetch-url` prints `[truncated to N characters]`, retry
extracted mode once with a larger bounded `--max-chars` and reassess first. If
that single retry remains truncated and required content cannot be verified,
record the limitation and enter this fallback without retrying extracted mode
again.

## Metadata-only vs full-content/media gate

- If the task only needs source *identity* — title, author, date, canonical
  URL, a snippet — do **not** escalate. Use `scripts/fetch-url --metadata`,
  alternate sources, or snippets, and label the evidence accordingly.
- Escalate only when full readable content and/or source media are required
  **and** browser automation is available. If browser automation is
  unavailable or blocked, fall back to metadata/alternate sources/snippets and
  state the limitation explicitly. Never bypass authentication, paywalls, or
  anti-bot controls, and never substitute raw HTML for readable content.

## Ordered workflow

1. **Preserve what is known.** Record the requested URL and the browserless
   output or error. Do not require effective/final or canonical URLs before
   they have been discovered.
2. **Probe identity inside the fallback.** Before browser navigation, try one
   metadata request to discover final/canonical URLs:

   ```bash
   scripts/fetch-url --metadata "$requested_url"
   ```

   This probe is part of rendered escalation, not acceptance of metadata-only
   evidence. Record final/canonical URLs when returned. If metadata fails or
   omits them, keep those fields unknown until the rendered page provides them;
   do not guess and do not block escalation.
3. **Load current browser instructions.** Before any browser command, load the
   installed agent-browser core workflow:

   ```bash
   agent-browser skills get core
   ```

   Follow the CLI-served instructions; do not assume flags from memory.
4. **Open the best-known public page in one uniquely named session.** Prefer a
   known canonical public wrapper/status page; otherwise open the requested
   URL. Generate the session name once, record the printed value, and reuse it
   for every browser command:

   ```bash
   browser_session="$(python3 -c 'import secrets; print("rendered-source-" + secrets.token_hex(4))')"
   printf 'browser_session=%s\n' "$browser_session"
   agent-browser --session "$browser_session" open "$page_url"
   ```

   If later commands run in separate tool invocations, paste the printed
   session value literally into each command; do not rerun the generator and do
   not assume a shell variable persists. Use a fresh session so concurrent or
   stale runs cannot share cookies, tabs, or navigation state and ambient
   logins do not leak in.
5. **Complete URL provenance after rendering.** Using that same session, record
   the browser's effective URL and the page's canonical URL when present:

   ```bash
   agent-browser --session "$browser_session" get url
   agent-browser --session "$browser_session" eval 'document.querySelector("link[rel=canonical]")?.href || null'
   ```

6. **Semantically inventory candidates.** Enumerate `main`/`article` candidates
   and describe them (headings, text length, links, images). Do not assume the
   first article is the source.
7. **Define the filtered source content set.** Select the primary container by
   title/author/timestamp and primary-article structure, then identify the
   ordered source-owned nodes inside it. Explicitly exclude nested replies,
   quote cards, recommendations, and chrome. Use this same filtered node set
   for extraction and text validation.
8. **Extract ordered text/links/figures** from the filtered source content set
   only, in document order.
9. **Hydrate lazy content only when media were requested.** Traverse the
   filtered source bounds with a bounded scroll/wait-until-stable procedure
   before taking the final media inventory (see Lazy-content hydration below).
10. **Acquire requested source media** from that final post-hydration inventory.
    Text-only tasks skip steps 9-10 and media-set validation.
11. **Validate** the applicable text, identity, local-artifact, and conditional
    media criteria below.
12. **Record provenance** as `rendered` evidence.
13. **Clean up on every exit path.** Before success, fallback, or error return,
    close the exact named browser session and remove temporary files:

    ```bash
    agent-browser --session "$browser_session" close
    ```

## Semantic scoping (required)

- Scope by target **title/author/timestamp** and `main`/primary `article`
  structure. Only after identifying the correct container may you use a
  page-specific selector to read within it.
- Within that container, define an ordered **filtered source content set** of
  source-owned nodes. Extraction and text validation must both use this set.
- **Do not** capture `document.body` as the source.
- **Do not** treat "the first `article`" as a universal rule; verify identity.
- Exclude replies, quoted/embedded posts not authored as the source,
  recommendations, avatars, card previews, QR codes, and other page chrome
  unless the task explicitly requests them.

## Candidate-inventory example (generic)

This eval only *inspects* candidates so you can choose the source. It does not
and must not claim to identify the source automatically.

```bash
agent-browser --session "$browser_session" eval '(() => {
  const nodes = Array.from(document.querySelectorAll("main article, article, main [role=article]"));
  return nodes.slice(0, 20).map((el, index) => {
    const headings = Array.from(el.querySelectorAll("h1, h2, h3"))
      .map((h) => h.textContent.trim())
      .filter(Boolean)
      .slice(0, 5);
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    return {
      index,
      headings,
      textLength: text.length,
      links: el.querySelectorAll("a[href]").length,
      images: el.querySelectorAll("img").length,
    };
  });
})()'
```

Use the returned inventory plus title/author/timestamp to pick the source
container. The indices are hints, not an identification. Use the unique session
value generated for `open`; across separate tool invocations, replace
`"$browser_session"` with the recorded literal rather than generating a new
value.

## Lazy-content hydration (only when media requested)

Before the final media inventory:

1. Traverse the **filtered source bounds** from top to bottom in document order.
   Scroll source-owned figures/placeholders into view or use bounded viewport
   increments that stop at the source container's end; do not continue into an
   infinite reply/recommendation feed.
2. After each bounded pass, wait briefly for lazy DOM/network updates using the
   current agent-browser guidance, then inventory source-media count,
   `currentSrc`/`src`, and natural dimensions from the filtered content set.
3. Stop after a complete top-to-bottom traversal and two consecutive identical
   inventories, or at a hard pass/time cap. Never scroll indefinitely.
4. If the cap is reached with absent sources or zero dimensions, record those
   assets as unresolved and do not claim media completeness.

Use the same unique named browser session for every scroll, wait, and inventory
command. The inventory taken after this phase is the validation baseline.

## Media acquisition (only when requested)

Skip media downloads, manifests, and media-set validation when the task needs
text only. You may still inventory media presence to confirm that filtering
excluded page chrome.

When source media are requested:

- Hydrate lazy content first and use the final stable inventory as the source
  image-reference set.
- Scope media discovery to the **filtered source content set**, not the page or
  unfiltered container.
- Preserve `currentSrc`/`src`/`srcset`, `alt`, natural dimensions, and source
  order. Distinguish cover/inline figures from chrome (avatars, card previews,
  icons, QR codes).
- Write a manifest that preserves the **original** URLs and document order.
- Request provider-supported *original* variants only when you have verified
  that the provider supports them (see the X note). Do not guess query params.
- Verify each downloaded asset: MIME/file type is valid and dimensions are
  plausible for the intended figure.

## Provider note: X / Twitter (labeled, non-generic)

These are provider-specific lessons; keep them out of the generic workflow and
do **not** encode unstable X CSS class names or selectors.

- Prefer the canonical **status** page for provenance.
- Resolve `t.co` shortlinks to their targets for identity only.
- A direct `/i/article/...` URL may return `403` or only a non-readable shell
  to curl while the corresponding **status** page renders the content — prefer
  the status page.
- `pbs.twimg.com` media can often be requested at original quality via
  `?format=<ext>&name=orig` (e.g. `format=jpg&name=orig`) — but only after
  confirming the base media URL belongs to the source post.
- `og:image` is usually only the cover image, not the full figure set.
- Reply, profile, and card-preview media must remain excluded.

## Markdown capture

You may capture the rendered content as Markdown, but do not fabricate source
alt text: a curator's or aggregator's description is not the original `alt`
attribute. Preserve real `alt` where present and mark absent alt as absent.

## Validation

Always validate:

- Normalized captured text equals the normalized text of the same **filtered
  source content set** after documented exclusions. Do not compare against the
  unfiltered container.
- Known canonical URL, title, author, and timestamp fields match the target;
  unresolved fields remain explicitly unknown rather than guessed.
- Exclusions (replies/cards/avatars/chrome) were reviewed and confirmed.

When creating local Markdown or another local artifact, verify its local links
resolve.

When source media were requested and downloaded, also verify:

- The final post-hydration source image-reference set equals the downloaded-file
  set and manifest set (no missing, no extra).
- Asset types and dimensions are valid.

## Evidence and provenance

- Classify claims from this path as `rendered`: verified from a rendered
  browser page, distinct from `fetched` (browserless), `metadata`, and
  `snippet`.
- Record the requested URL, the effective/canonical URLs when discovered (or
  that they remain unknown), and that a rendered session was used.
- Mirrors/syndicated copies may *corroborate* the canonical source but must not
  silently replace a differing canonical source; if they differ, say so.

## Failure handling

- Before falling back or returning an error, close the exact unique session
  created for this run and remove temporary files. If execution was interrupted,
  use the recorded session value to close the stale session before retrying;
  verify with `agent-browser session list`.
- If the browser cannot render or is blocked, stop escalating. Fall back to the
  existing metadata identity probe, alternate sources, or snippets and state
  the limitation. Do not circumvent access controls.
- Do not repeatedly retry the same rendered URL with the same approach.

## Anti-patterns

- Reusing a fixed example session name, generating a new name per command, or
  mixing the default session with the named isolated session.
- Leaving the named session open on a failure or fallback path.
- Escalating before resolving an explicit truncation marker with one bounded
  larger-`--max-chars` retry.
- Requiring final/canonical URLs before metadata or rendering can discover them.
- Capturing `document.body` or the whole page as the "source".
- Assuming the first `article` element is the source.
- Validating filtered output against an unfiltered container.
- Using a fixed word-count threshold to decide sufficiency.
- Hardcoding current X CSS classes/selectors.
- Downloading media for ordinary research that did not request it.
- Guessing provider media params instead of using verified behavior.
- Silently swapping a mirror for a differing canonical source.
- Bypassing authentication, paywalls, or anti-bot controls.

## Completion checklist

- [ ] Requested URL and browserless output/error preserved; effective/canonical
      URLs recorded when discovered or explicitly left unknown.
- [ ] agent-browser core instructions loaded before browser commands.
- [ ] A task-unique session value generated once, recorded, and used for every
      browser command; no fixed example/default session reused.
- [ ] Source container scoped semantically (title/author/timestamp), not by
      position or `document.body`.
- [ ] Filtered source content set defined; text/links/figures extracted from and
      validated against that same set.
- [ ] If media were requested: filtered source bounds traversed and inventories
      stabilized within a hard cap before downloads; manifest preserves source
      URLs/order and post-hydration set/type/dimension validation passed.
- [ ] If a local artifact was created: local links resolve.
- [ ] Exclusions reviewed (replies/cards/avatars/chrome).
- [ ] Evidence recorded as `rendered` with provenance.
- [ ] Exact named browser session closed and temporary files removed on success,
      fallback, and failure paths.
