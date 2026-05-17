# pi-feedback

Pi extension for reviewing the latest assistant message in your external editor and submitting the edit as feedback.

## What it does

Run `/feedback` in Pi to open the latest assistant response in `$VISUAL` or `$EDITOR`. After you save and close the editor, the extension stores:

- `original.md`
- `edited.md`
- `diff.patch`
- `metadata.json`

It then stages a `[Review feedback]` placeholder in the Pi editor. Submit it with optional notes to send the unified diff back to the assistant as feedback, or delete the placeholder to discard it.

## Use

Start Pi, then run:

```text
/feedback
```

Edit the assistant message, save, and close your editor. Pi will stage the review feedback for submission.

## Local development

Run directly from this repo:

```bash
pi -e ./feedback.ts
```

Or install the local package:

```bash
pi install .
```
