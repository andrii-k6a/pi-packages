# Search API

## Discovery

`GET /config` includes engine names, categories, shortcuts, default `enabled` state, `paging`,
`language_support`, language/region traits, `safesearch`, `time_range_support`, and timeouts.
The helper's `config` subcommand saves the complete object and prints a filterable summary.

- `enabled: false` means off by default; `engines=` or an explicit engine bang can still select it.
  Inactive engines may be absent entirely. Token-restricted engines are hidden unless the request
  supplies an accepted token. Suspension and current health are not shown by `/config`.
- `locales` describes UI translations, not supported search languages. Consult engine `languages`
  and `regions` traits and the instance's preferences page instead.
- `time_range_support` is a boolean, not a list of supported ranges. Individual engines may implement
  only some ranges. Language, region, safe-search, and operators also differ by engine.
- Plugins are returned as `{name, enabled}`; `name` is the ID for request parameters.
- `/config` does not advertise allowed output formats or all preference locks. A JSON search tests
  whether JSON is enabled. An administrator can lock preferences.

## Search parameters

`GET /search` and `POST /search` accept the same fields; `/` also accepts searches. POST uses
`application/x-www-form-urlencoded`, not a JSON body. If query-string and form fields overlap,
form fields win. The helper supports both methods, uses JSON responses, and sends no cookie jar.

| API parameter / helper flag | Meaning and limits |
| --- | --- |
| `q` / positional query | Required query. Blank queries are rejected by the helper. |
| `format` / fixed `json` | HTML, JSON, CSV, RSS if enabled in `search.formats`; disabled formats return 403. Unknown format names fall back to HTML. |
| `engines` / `--engines` | Comma-separated exact engine names, including spaces. Use shortcuts as query bangs, not engine parameter values. |
| `categories` / `--categories` | Comma-separated category names. Combined with explicit engines, adds category engines. |
| `language` / `--language` | Search language/region, e.g. `en`, `en-US`, `uk`, `all`, `auto`. Valid-looking unsupported codes do not guarantee useful filtering; malformed codes can return 400. |
| `pageno` / `--pageno` | Positive integer, default 1. Not an offset or requested result count. |
| `time_range` / `--time-range` | `day`, **`week`**, `month`, `year`; empty means unrestricted. The public API documentation lists only `day`, `month`, and `year`, but the parser accepts `week`; an HTTP 400 means this instance rejects it. |
| `safesearch` / `--safesearch` | 0 off, 1 moderate, 2 strict. Omit to preserve the instance default. |
| `timeout_limit` / `--timeout-limit` | SearXNG engine deadline in seconds, subject to server limits. Does not extend every engine's own timeout. |
| `enabled_plugins`, `disabled_plugins` | Comma-separated plugin IDs. Matching helper flags use hyphens and pair these parameters correctly. |
| `enabled_engines`, `disabled_engines` | Preference IDs in `engine name__category` form; matching helper flags. Usually prefer explicit `--engines`. |
| `category_<name>=on/off` | Per-category form control; normally prefer `--categories`. |
| `engine_data-<engine>-<key>` | Engine-specific continuation state. Some engines need it for paging; JSON does not expose aggregate `engine_data`, so page numbers alone may be insufficient. Never fabricate tokens. |
| `preferences` | Encoded preferences exported by SearXNG; replaces ordinary request preference parsing, including plugin selection. Use only a known exported value. |
| `tokens` | Credentials for restricted engines. Use only if provided for the task; never commit secrets in examples or artifacts. |
| `locale`, `doi_resolver` | UI/answer locale and DOI rewriting preference. The latter can enable `oa_doi_rewrite`; inspect config's `doi_resolvers`. Neither is a search language flag. |

`--param NAME=VALUE` supports verified fields without a dedicated helper flag. It rejects duplicate
keys and overrides of dedicated arguments, including `q` and `format`. Unknown server fields can
be silently ignored. This API has no universal `sort`, date-start/date-end, `limit`,
or `num_results` search parameter. The helper's `--limit` only limits detailed previews;
remaining titles and URLs are still shown to help identify sources worth opening.

For an export, use the API directly and save to a fresh file:

```bash
curl --fail-with-body --silent --show-error --max-time 60 --get http://127.0.0.1:8888/search \
  --data-urlencode 'q=SearXNG' --data-urlencode 'format=rss' --output /absolute/new-results.rss
```

Each format can be disabled independently of JSON. Keep redirects disabled.
UI preferences such as `theme`, `simple_style`, `image_proxy`, `results_on_new_tab`, `hotkeys`,
and `url_formatting`, and the `infiniteScroll` plugin do not improve JSON search coverage.
The `method` preference sets the UI form method; the helper's `--method` selects the HTTP method.

## Query syntax and precedence

| Syntax | Behavior |
| --- | --- |
| `!wp Paris`, `!wikipedia Paris` | Select an engine by shortcut or name, even if disabled by default. |
| `!science topic`, `!images topic` | Select a category's enabled engines. |
| `!map !ddg !wp Paris` | Union of the selected category and engines. |
| `!google_news topic` | Underscores or hyphens in a bang become spaces for engine/category lookup. |
| `:fr topic`, `:en-US topic` | Select language. The last recognized language modifier wins. |
| `<3 topic`, `<850 topic` | Engine deadline: integers below 100 are seconds, 100 and above are milliseconds. Quote the query so the shell does not interpret `<`. |
| `!!wfr Paris` | External bang: redirect to an external search site, even with `format=json`. The helper refuses redirects. |
| `!! Paris` | Feeling lucky: first-result redirect for HTML/RSS. JSON/CSV return before this redirect is applied; it does not improve their ranking or coverage. |

Recognized engine/category bangs override `engines` and `categories` request fields. Language
modifiers override `language`; query timeouts override `timeout_limit`. Administrator locks can
override category/language choices. Unrecognized modifiers can remain literal query text.
Unknown engine/category parameters can be ignored and cause a default-category search.

Without `outgoing.max_request_timeout`, a requested deadline is capped at the largest selected
engine timeout. With that maximum configured, the requested deadline is capped by the maximum.
Prefer defaults unless latency is a task constraint.

Upstream operators such as `site:example.org`, `"exact phrase"`, `-term`, `filetype:pdf`,
`intitle:`, and `before:`/`after:` pass through as search text. Their meaning depends on the
engine. For strict filtering, choose an engine that supports the operator and inspect returned URLs,
titles, and dates.

## Plugins and specialized results

`Preferences.parse_dict` reads plugin/engine preference pairs only when the `disabled_*` field is
present. Thus `enabled_plugins=hash_plugin` alone can be ignored. The helper sends
`disabled_plugins=` automatically with `--enabled-plugins`; the same rule applies to engines.
These are per-request choices and do not rewrite settings.

```bash
python3 scripts/searxng.py search 'sha256 example' --enabled-plugins hash_plugin
python3 scripts/searxng.py search 'SearXNG' --disabled-plugins tracker_url_remover
python3 scripts/searxng.py search 'SearXNG' --categories general --disabled-engines 'bing__general'
python3 scripts/searxng.py search 'avg 10 20 30' --param locale=en
```

Only request plugin IDs present in `config`. `tracker_url_remover`, `hostnames`, and
`oa_doi_rewrite` can change result URLs; inspect destinations when citing. `hash_plugin`,
`unit_converter`, `time_zone`, and `self_info` can add answers. A plugin listed in `config` does
not guarantee JSON output; for example, `calculator` is mainly a UI feature. Test with a query.
Answerers are separate from plugins.

- Answerers: `random uuid` and `avg 10 20 30` can return only `answers`. Successful answerers
  can short-circuit ordinary engine searches.
- Unit conversion: `10 kg to lb` can add an answer with `unit_converter`.
- Dictionary/translation engines can require syntax such as `en-de house`.
- Currency engines can require syntax such as `10 USD to EUR`.
- URL-search engines require a URL in the query; some support image data URLs. This is a search
  input, not a general full-page extraction API.
- Images, videos, maps, science, packages, and repositories: inspect their categories and engines.
  Raw results can contain thumbnails, media URLs, coordinates, authors, DOI, or other fields
  omitted from the text preview.

`GET /autocompleter?q=...` suggests completions and bangs. With the header
`X-Requested-With: XMLHttpRequest` it returns a simple JSON array; otherwise an OpenSearch-style
array. It may call an upstream service. Prefer suggestions in saved responses before extra requests.
`/preferences` exposes special-query examples; `/stats/errors` can help diagnose engine failures.

## Interpreting JSON

A response normally contains `query`, `results`, `answers`, `corrections`, `infoboxes`,
`suggestions`, and `unresponsive_engines`. Treat that list as a minimum: other instances can add
fields or use plain strings instead of objects for `answers`. The helper preserves the entire
response.

The helper validates the response envelope before printing either a preview or raw JSON. Search
responses must contain a `results` array of objects; config responses must contain an `engines`
array of objects with string names. Extra fields are preserved. Malformed responses still remain
in the saved file for diagnosis. Empty result arrays and partial engine failures remain valid.

Fields vary by engine/template: common ones include `title`, `url`, `content`, `publishedDate`,
`engine`, `engines`, `positions`, `score`, and `category`. Scores and contributing engines
describe aggregation, not truth or independent verification. `len(results)` is the returned page
size, not a total hit count. Do not rely on an aggregate `paging` or `engine_data` field or on
`number_of_results`; the JSON does not guarantee them.

Empty `results` is not itself an error if answers/infoboxes are useful. Engine errors can accompany
useful results and HTTP 200. Inspect `unresponsive_engines`, typically arrays containing engine,
error, and sometimes a suspension indicator. Filtering and pagination can silently skip engines;
an empty failure list does not prove every configured engine participated.

## Verifying and updating this reference

This reference describes behavior, not a specific release. A claim may be out of date for the
running instance. When one is in doubt, check in this order:

1. The running instance: `config` for engines, plugins, and `version`; a small probe search for
   behavior; the saved error body for rejected parameters.
2. The upstream source at https://github.com/searxng/searxng. If the instance's `version` ends in
   `+<commit>`, read that commit; otherwise read the default branch.

Useful starting points, relative to the upstream repository root rather than this skill:

- `searx/webapp.py`: routes, preference loading, formats, redirects, config, autocomplete.
- `searx/webadapter.py`: validation, week range, engine/category union, modifier precedence.
- `searx/query.py`: bangs, language, timeout, external redirects, feeling lucky.
- `searx/preferences.py`: preference IDs, locks, paired enable/disable parsing.
- `searx/search/__init__.py` and `searx/search/processors/`: deadlines, skipped engines, special syntax.
- `searx/webutils.py:get_json_response`: serialized response fields.
- `searx/plugins/`, `searx/answerers/`, `searx/settings.yml`: optional behavior and defaults.
- `docs/dev/search_api.rst`, `searx/infopage/en/search-syntax.md`: public documentation.

Correct this file when it disagrees with the instance. An option that is not documented upstream
does not replace capability discovery with `config`.

## Helper organization and maintenance

The helper is a bundled Python package behind the existing `scripts/searxng.py` launcher:

- [cli.py](../scripts/searxng_cli/cli.py): argument parsing, API parameters, and command orchestration.
- [client.py](../scripts/searxng_cli/client.py): loopback HTTP transport and response validation.
  The client returns status and exact bytes so error responses can be saved before decoding.
  For HTTP errors it appends the JSON `error` text (truncated to 300 characters), and the CLI
  strips control characters from every printed error because that text is untrusted.
- [storage.py](../scripts/searxng_cli/storage.py): output-path checks and response persistence.
- [formatter.py](../scripts/searxng_cli/formatter.py): plain-text previews of results and capabilities.
  Formatters return strings without printing or modifying the response.

Only the CLI coordinates these modules. The client does not know about command-line arguments or
output files, and the formatters do not perform I/O. All modules use the Python standard library.

After changing the helper, run its offline tests from this skill's directory:
`python3 -B -m unittest discover -s scripts/tests -v`. They cover HTTP encoding, preference pairs,
saved responses, local-only requests, redirects, errors, independent components, and portability.
