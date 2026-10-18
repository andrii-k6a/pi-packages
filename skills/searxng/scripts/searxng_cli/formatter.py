"""Plain-text previews of complete responses; no I/O or mutation of result data."""

import json
from typing import Optional


def compact(value):
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False)
    # Do not pass terminal control characters through from untrusted result text.
    return " ".join("".join(c if c.isprintable() or c.isspace() else " " for c in value).split())


def engine_counts(results: list) -> str:
    """Count results per contributing engine, so single-engine dependence is visible."""
    counts: dict = {}
    for result in results:
        names = result.get("engines") or result.get("engine") or []
        if isinstance(names, str):
            names = [names]
        for name in {compact(name) for name in names}:
            counts[name] = counts.get(name, 0) + 1
    return ", ".join(f"{name}={n}" for name, n in sorted(counts.items(), key=lambda i: (-i[1], i[0])))


def format_results(
    data: dict, *, limit: int = 8, offset: int = 0, snippet_chars: int = 500,
) -> str:
    results = data.get("results", [])
    if not isinstance(results, list) or any(not isinstance(item, dict) for item in results):
        raise ValueError("expected a results array of objects")
    lines = [f"query: {compact(data.get('query', ''))} | returned results: {len(results)}"]
    if results:
        lines.append(f"engines contributing: {engine_counts(results)}")
    for key in ("answers", "infoboxes", "corrections", "suggestions", "unresponsive_engines"):
        for item in data.get(key) or []:
            lines.append(f"{key}: {compact(item)}")
    if not results and data.get("unresponsive_engines"):
        lines.append(
            "hint: no results while engines were unresponsive; retrying them will not help. "
            "Use other engines or categories (config without --enabled-only lists default-off "
            "engines)."
        )
    end = len(results) if limit == 0 else offset + limit
    for index, result in enumerate(results[offset:end], offset + 1):
        lines.append(f"{index}. {compact(result.get('title', '(untitled)'))}")
        lines.append(f"   {compact(result.get('url', ''))}")
        lines.append(
            f"   date hint: {compact(result.get('publishedDate') or 'unknown')} | "
            f"engines: {compact(result.get('engines') or result.get('engine') or [])} | "
            f"category: {compact(result.get('category', 'unknown'))}"
        )
        content = compact(result.get("content") or "")
        if snippet_chars and len(content) > snippet_chars:
            content = content[:snippet_chars] + "…"
        if content:
            lines.append(f"   {content}")
    if end < len(results):
        lines.append(f"{len(results) - end} more saved results (title and URL only):")
        for index, result in enumerate(results[end:], end + 1):
            title = compact(result.get("title", "(untitled)"))[:100]
            lines.append(f"{index}. {title} | {compact(result.get('url', ''))}")
        lines.append(f"For full details: preview --offset {end} or --limit 0")
    return "\n".join(lines)


def format_config(
    data: dict, *, category: Optional[str] = None, engine: Optional[str] = None,
    enabled_only: bool = False, time_range_support: bool = False, details: bool = False,
) -> str:
    lines = [
        f"instance: {compact(data.get('instance_name', ''))} | "
        f"version: {compact(data.get('version', ''))}",
        "categories: " + compact(data.get("categories", [])),
        "plugins: " + compact(data.get("plugins", [])),
        "engine | shortcut | default | categories | capabilities | timeout (s)",
    ]
    count = 0
    for item in data.get("engines", []):
        if category and category not in item.get("categories", []):
            continue
        if engine and engine.lower() not in item.get("name", "").lower():
            continue
        if enabled_only and not item.get("enabled"):
            continue
        if time_range_support and not item.get("time_range_support"):
            continue
        capabilities = [
            key for key in ("paging", "time_range_support", "language_support", "safesearch")
            if item.get(key)
        ]
        values = [
            item.get("name", ""), "!" + compact(item["shortcut"]) if item.get("shortcut") else "",
            "on" if item.get("enabled") else "off", item.get("categories", []),
            capabilities, item.get("timeout", "unknown"),
        ]
        lines.append(" | ".join(compact(value) for value in values))
        if details:
            lines.append("  languages: " + compact(item.get("languages", [])))
            lines.append("  regions: " + compact(item.get("regions", [])))
        count += 1
    lines.append(f"shown engines: {count}; default off engines can still be explicitly selected")
    return "\n".join(lines)
