# pi-graphify

Native Pi extension for Graphify knowledge graphs.

## Prerequisites

Install Graphify first:

```bash
uv tool install graphifyy
# or: pipx install graphifyy
```

Build a graph in a project:

```bash
graphify extract .
```

## Install

```bash
pi install npm:@andrii-k6a/pi-graphify
```

Try locally from this repo:

```bash
pi -e ./packages/pi-graphify
```

## Usage

```text
/graphify status
/graphify query What are the main modules?
/graphify explain AuthModule
/graphify path AuthModule Database
/graphify update .
/graphify extract .
/graphify report
/graphify open
```

Running `/graphify` without arguments shows status. If no graph exists, it asks before running a full extraction.

## Tools

- `graphify_status` — inspect local Graphify artifacts and CLI availability.
- `graphify_query` — query the graph for codebase context.
- `graphify_explain` — explain a node, symbol, file, module, or concept.
- `graphify_path` — find a shortest path between two graph nodes.
- `graphify_update` — update the graph after code edits.
- `graphify_build` — explicitly run extraction and clustering for a directory.
- `graphify_add` — add a URL to Graphify raw corpus, then update `./raw`.
- `graphify_cluster` — rerun clustering/report generation without extraction.
- `graphify_extract` — run explicit extraction with CI/headless flags.
- `graphify_export_callflow` — generate call-flow HTML from `graph.json`.
- `graphify_upgrade` — check or explicitly update the Graphify CLI/Pi skill.
- `graphify_watch` — start long-running watch mode until aborted.

## Configuration

Configuration is read from `prime-settings.json` under the `pi-graphify` key.
Project settings override global settings field-by-field.

Global:

```text
~/.pi/agent/prime-settings.json
```

Project:

```text
.pi/prime-settings.json
```

Example:

```json
{
  "pi-graphify": {
    "enabled": true,
    "outputDir": "graphify-out",
    "defaultQueryBudget": 2000,
    "semanticBackend": "pi",
    "autoContext": {
      "enabled": true,
      "sessionHint": true,
      "toolResultHints": true,
      "autoQuery": false
    }
  }
}
```

Supported semantic backends: `pi`, `auto`, `deepseek`, `openai`, `claude`, `kimi`, `gemini`, `ollama`, `bedrock`, `claude-cli`.

`pi` is the default: the extension maps the active Pi model/provider to the closest Graphify backend (`google` -> `gemini`, `anthropic` -> `claude`, `openai` -> `openai`, etc.). If the active Pi provider cannot be mapped, it falls back to Graphify CLI auto-detection. Use `auto` to always let Graphify choose from environment variables.

## Auto-context

When enabled and graph artifacts exist, the extension conservatively adds Graphify hints:

- a one-time hidden session hint reminding the model to use Graphify for architecture/dependency questions;
- bounded tool-result hints for large or architecture-related non-Graphify results.

It does **not** auto-query or auto-build graphs by default.

## Safety

The extension uses `execFile` and argv arrays. It does not pass user input through a shell. Full extraction, upgrades, and watch mode are only run when explicitly requested or confirmed.

## Troubleshooting

If Pi reports that Graphify is missing, install it with:

```bash
uv tool install graphifyy
```

If a query says no graph exists, build one first:

```bash
graphify extract .
```
