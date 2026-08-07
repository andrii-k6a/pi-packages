# pi-generative-ui

A pi extension for rendering generated HTML/SVG widgets in native windows.

It adds two tools:

- `visualize_read_me` — loads compact design guidance before a widget is created.
- `show_widget` — opens generated HTML, SVG, charts, diagrams, mockups, or interactive explainers in a native WebView window.

Widgets can use CSS, JavaScript, Canvas, SVG, and CDN libraries. Interactions inside the widget can update local widget state, but they are display-only for pi; user actions are not sent back to the agent.

## Install

This package is kept for local/private use in this workspace. From the repository root:

```bash
pi -e .
```

For local package testing:

```bash
cd packages/pi-generative-ui
pi -e .
```

## Usage

Ask pi for visual output, for example:

- "Show me how compound interest works"
- "Visualize this architecture"
- "Create a small dashboard for this data"
- "Draw an SVG diagram of this flow"

The model should call `visualize_read_me` once, then call `show_widget` with the widget code.

## Notes

- Runtime window support is provided by the `glimpseui` package.
- The page-side runtime is prebuilt in `src/runtime.bundle.ts` so normal use does not need a build step.
- If you edit files under `src/runtime/` or `src/svg-styles.ts`, rebuild with:

```bash
npm run build:runtime
```

- On Linux, SVG clipboard/save helpers require common desktop utilities (`wl-copy`, `xclip`, `xsel`, `zenity`, or `kdialog`).
- On Windows, PowerShell is used for clipboard and save dialogs. Set `GLIMPSE_PS_PATH` to override the executable.
