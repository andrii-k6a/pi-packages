---
description: Generate a stunning magazine-quality slide deck as a self-contained HTML page
argument-hint: "<topic>"
---
Use the `visual-explainer` skill. Read its `SKILL.md` and referenced templates before generating. Resolve all paths mentioned below relative to the loaded `visual-explainer` skill directory. Then generate a slide deck for: $@

Follow the visual-explainer skill workflow. Read the loaded skill's `templates/slide-deck.html`, `references/slide-patterns.md`, `references/css-patterns.md`, and `references/libraries.md` before generating.

**Slide output is always opt-in.** Only generate slides when this prompt is invoked or the user explicitly asks for a slide deck.

**Aesthetic:** Pick a distinctive direction from the 4 slide presets in the loaded skill's `references/slide-patterns.md` (Midnight Editorial, Warm Signal, Terminal Mono, Swiss Clean) or adapt one of the aesthetic directions from the skill. Vary from previous decks. Commit to one direction and carry it through every slide.

**Narrative structure:** Slides have a temporal dimension — compose a story arc, not a list of sections. Start with impact (title), build context (overview), deep dive (content, diagrams, data), resolve (summary/next steps). Plan the slide sequence and assign a composition (centered, left-heavy, split, full-bleed) to each slide before writing HTML.

**Visual richness:** Proactively reach for visuals. If `surf` CLI is available (`which surf`), consider generating images for title slide backgrounds and full-bleed slides via `surf gemini --generate-image` when they add explanatory value. Add SVG decorative accents, inline sparklines, mini-charts, and small Mermaid diagrams where they make the story more compelling. Visual-first, text-second.

**Compositional variety:** Consecutive slides must vary their spatial approach. Alternate between centered, left-heavy, right-heavy, split, edge-aligned, and full-bleed. Three centered slides in a row means push one off-axis.

Write to `~/.pi/visual-explainer/` and open the result in the browser.
