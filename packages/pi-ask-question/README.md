# @andrii-k6a/pi-ask-question

A Pi extension that gives the agent one tool — `ask_user_question` — which opens a terminal dialog of up to four questions with written-out options and hands your choices back as structured data.

Instead of guessing when a request is underspecified, Pi can ask. You answer with the keyboard, and Pi receives the answers as text plus a machine-readable payload.

## Install

```bash
pi install npm:@andrii-k6a/pi-ask-question
```

Try locally from this repository:

```bash
pi -e ./packages/pi-ask-question
```

## What the dialog looks like

Question with an option preview, on a wide terminal:

```text
────────────────────────────────────────────────────────────────────────────────────────────────
 ←  □ Library   □ Checks   ✓ Submit  →

 Which library should we use for date formatting?

> 1. date-fns (Recommended)                  ┌─────────────────────────────────────────────────┐
     Tree-shakeable, immutable helpers       │```ts                                            │
  2. Luxon                                   │import { format } from 'date-fns';               │
     Rich time zone support, larger bundle   │format(d, 'PP');                                 │
  3. Type something.                         │```                                              │
                                             └─────────────────────────────────────────────────┘

 Tab/←→ questions • ↑↓ move • Enter select • Esc cancel
────────────────────────────────────────────────────────────────────────────────────────────────
```

Multi-select question:

```text
 Which checks should run on save?

  [x] 1. Lint
         Runs Biome on write
  [ ] 2. Typecheck
         Slower, catches more
> [ ] 3. Unit tests
         Slowest, highest confidence
  [ ] 4. Type something.

 Tab/←→ questions • ↑↓ move • Space toggle • Enter confirm • Esc cancel
```

## Keys

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move between options |
| `Enter` | Single-select: pick the focused option and advance. Multi-select: confirm the question |
| `Space` | Multi-select: toggle the focused option. Single-select: same as `Enter` |
| `Tab` / `→` | Next question (or the Submit tab) |
| `Shift+Tab` / `←` | Previous question |
| `Enter` on `Type something.` | Open an editor for a free-text answer |
| `Esc` in the editor | Discard the text and go back to the options |
| `Esc` in the options | Dismiss the whole questionnaire |

A `Type something.` row is appended to every question automatically, so you are never boxed in by the offered options. With several questions, a tab bar tracks progress (`□` unanswered, `■` answered) and submission happens from the trailing `✓ Submit` tab once every question has an answer.

Answered questions can be revisited with `Tab` before submitting; a new pick replaces the old one.

## Tool contract

```jsonc
{
  "questions": [
    {
      "question": "Which library should we use for date formatting?",
      "header": "Library",              // max 16 chars, tab label, unique per call
      "multiSelect": false,             // optional, default false
      "options": [                      // 2-4 options
        {
          "label": "date-fns (Recommended)",  // max 60 chars
          "description": "Tree-shakeable, immutable helpers",
          "preview": "```ts\nformat(d, 'PP');\n```"  // optional markdown for the focused option
        },
        { "label": "Luxon", "description": "Rich time zone support" }
      ]
    }
  ]
}
```

Limits: 1-4 questions, 2-4 options each, `question` ≤ 1000 characters, `header` ≤ 16 characters, `label` ≤ 60 characters, `description` ≤ 500 characters, and `preview` ≤ 4000 characters. `question`, `header`, `label`, and `description` are required.

The focused option's preview renders in a bordered pane beside the option list when the terminal is at least 76 columns wide; narrower terminals stack the pane under the options. Previews work for both single- and multi-select questions. While you type a free-text answer, the pane yields to the editor. Long previews are clipped with a `… N more lines` note.

### Returned data

The model receives one line per answered question:

```text
Library: user selected 1. date-fns (Recommended)
Checks: user selected 1. Lint, 3. Unit tests; wrote: and a smoke test
```

The structured `details` payload is:

```jsonc
{
  "cancelled": false,
  "answers": [
    {
      "header": "Checks",
      "question": "Which checks should run on save?",
      "multiSelect": true,
      "selections": [
        { "index": 1, "label": "Lint", "custom": false },
        { "index": null, "label": "and a smoke test", "custom": true }
      ]
    }
  ]
}
```

`index` is the 1-based option number, or `null` for free text (`custom: true`). Only answered questions appear. If you dismiss the dialog, `cancelled` is `true` and any answers recorded before dismissal are still reported in `details`, while the model is told nothing was submitted.

## Behavior notes

- **Rejected calls.** Malformed calls throw a descriptive error naming the exact path, so the model can retry. Beyond the schema limits, the extension rejects reserved option labels (`Other`, `Type something.`, `Something else` — the free-text row is automatic), duplicate headers, and whitespace-only strings.
- **Non-interactive runs.** In `print`, `json`, and `rpc` modes there is no dialog, so the call returns without error, reporting `unavailable: true` and telling the model to proceed on its own judgement and state its assumptions.
- **Aborting.** If the tool call is cancelled while the dialog is open, the dialog closes and reports a dismissal.
- **Sequential execution.** The tool takes over the editor, so it is registered with `executionMode: 'sequential'` and never runs alongside other tool calls.

## Development

From the repository root:

```bash
npm run check   # Biome + TypeScript
npm test        # Vitest
```
