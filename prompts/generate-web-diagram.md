---
description: Generate a beautiful standalone HTML diagram and open it in the browser
argument-hint: "<topic>"
---
Use the `visual-explainer` skill. Read its `SKILL.md` and referenced templates before generating. Resolve all paths mentioned below relative to the loaded `visual-explainer` skill directory. Then generate an HTML diagram for: $@

Follow the visual-explainer skill workflow. Read the reference template and CSS patterns before generating. Pick a distinctive aesthetic that fits the content — vary fonts, palette, and layout style from previous diagrams.

If `surf` CLI is available (`which surf`), consider generating an AI illustration via `surf gemini --generate-image` when an image would genuinely enhance the page — a hero banner, conceptual illustration, or educational diagram that Mermaid can't express. Match the image style to the page's palette. Embed as base64 data URI. See the "Generated Images" section in the loaded skill's `references/css-patterns.md` for container styles. Skip images when the topic is purely structural or data-driven.

Write to `~/.pi/visual-explainer/` and open the result in the browser.
