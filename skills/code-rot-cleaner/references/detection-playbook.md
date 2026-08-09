# Detection playbook

Read this before reviewing scanner candidates. A file is not dead merely because no ordinary import points to it.

## Evidence ladder

Build confidence from independent signals:

1. The file or symbol is outside known entry points and has no static inbound reference.
2. Repository-wide search finds no path, basename, symbol, registry, route, template, or configuration reference.
3. Framework conventions do not make it discoverable.
4. Existing project-native dead-code tooling agrees.
5. Removing it in a disposable copy preserves an already-green baseline across relevant tests, build, typecheck, and lint.
6. Coverage or runtime traces show no reachability under representative workloads.

Only file-level candidates with strong signals through step 5 are normally eligible for `SAFE TO REMOVE`. Incomplete tests, optional features, platform-specific code, and rare operational paths lower confidence.

## Common false positives

- **Route-by-filename systems:** Next.js `app/` and `pages/`, Remix routes, Nuxt pages and server routes, SvelteKit routes, Astro pages, Rails controllers and jobs, Django management commands, Laravel conventions.
- **Plugin and registry loading:** glob imports, package metadata entry points, dependency injection, reflection, decorators, annotations, service loaders, test discovery, Storybook stories, migrations, seeds, workers, cron jobs, and queue handlers.
- **String reachability:** `import()`, variable `require()`, filesystem paths, template names, event names, command names, serialized class names, native bridges, and environment-selected modules.
- **Packaging:** `main`, `module`, `browser`, `bin`, `exports`, `files`, side-effect CSS, post-install scripts, peer dependencies, optional dependencies, and bundler plugins.
- **Public libraries:** exported symbols may be consumed by downstream users without an in-repository reference.
- **Platform branches:** mobile, browser, server, OS, architecture, enterprise, feature-flag, and locale-specific code.

## Category rules

### Orphan files

High confidence requires no inbound import, no filename convention, no string reference, no package entry, and no generated or operational role. Treat public library surfaces and framework roots as `REVIEW` even when isolated.

### Unused exports

A missing in-repository reference is weak evidence. Re-exports, declaration generation, public APIs, reflection, templates, tests, and external consumers can use a symbol. Prefer project-native compiler or analyzer evidence and prove the precise edit.

### Unused dependencies

Search source, config, scripts, lockfile metadata, peer relationships, CLIs, loaders, presets, plugins, and package-manager hooks. Do not change a manifest or regenerate a lockfile without explicit approval.

### Duplicates

Duplicate code is a maintenance candidate, not automatically dead. Preserve the canonical implementation, behavior differences, ownership boundaries, bundle boundaries, and import direction. Exact duplicate files remain `REVIEW` until callers can converge safely.

### Commented code and stale scaffolding

Code-like comments can document examples, protocols, queries, or migration steps. Use history and surrounding intent. Never delete licenses, security notes, compatibility workarounds, or operational instructions as “rot.”

## Proof quality

The baseline must pass before a candidate is evaluated. Choose commands that exercise the candidate’s runtime surface: a frontend build does not prove a worker is unused; unit tests do not prove packaging; typechecking does not execute side effects. Record missing coverage and rare-path risk explicitly.
