import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tokenizer } from 'acorn';
import { test } from 'vitest';

const sourceRoot = resolve(import.meta.dirname, '../src');
const allowedDependencies: Record<string, readonly string[]> = {
  entrypoint: ['pi', 'durable', 'workflow', 'profiles', 'shared'],
  pi: ['pi', 'durable', 'workflow', 'profiles', 'shared'],
  durable: ['durable', 'workflow', 'profiles', 'shared'],
  workflow: ['workflow', 'profiles', 'shared'],
  profiles: ['profiles', 'shared'],
  shared: ['shared']
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

function layer(file: string): string {
  const parts = relative(sourceRoot, file).split(sep);
  return parts.length === 1 ? 'entrypoint' : parts[0];
}

/** Tokenize rather than matching source strings/comments; include type imports and re-exports. */
function moduleReferences(source: string): string[] {
  const tokens = [...tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module' })];
  const references: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const specifier =
      token.type.label === 'name' && source.slice(token.start, token.end) === 'from'
        ? next
        : token.type.label === 'import'
          ? next?.type.label === '('
            ? tokens[index + 2]
            : next
          : undefined;
    if (specifier?.type.label === 'string') {
      references.push(source.slice(specifier.start + 1, specifier.end - 1));
    }
  }
  return references;
}

const files = sourceFiles(sourceRoot);
const graph = new Map(files.map((file) => [file, moduleReferences(readFileSync(file, 'utf8'))]));

function localDependencies(file: string): string[] {
  return (graph.get(file) ?? [])
    .filter((reference) => reference.startsWith('.'))
    .map((reference) => resolve(dirname(file), reference).replace(/\.js$/, '.ts'));
}

test('source root contains only the Pi entrypoint and the supported library facade', () => {
  const rootFiles = files
    .filter((file) => dirname(file) === sourceRoot)
    .map((file) => relative(sourceRoot, file));
  assert.deepEqual(rootFiles.sort(), ['dynamic-workflows.ts', 'library.ts']);
});

test('module dependencies follow the documented layers, including type-only imports', () => {
  for (const file of files) {
    const from = layer(file);
    assert.ok(allowedDependencies[from], `Undocumented source layer: ${from}`);
    for (const dependency of localDependencies(file)) {
      assert.ok(
        graph.has(dependency),
        `${relative(sourceRoot, file)} imports a missing module: ${dependency}`
      );
      assert.ok(
        allowedDependencies[from].includes(layer(dependency)),
        `${relative(sourceRoot, file)} must not depend on ${relative(sourceRoot, dependency)}`
      );
      if (from === 'workflow' && layer(dependency) === 'profiles') {
        assert.equal(
          relative(sourceRoot, dependency),
          join('profiles', 'contracts.ts'),
          'Workflow execution consumes injected profile contracts, not configuration or UI'
        );
      }
    }
    for (const reference of graph.get(file) ?? []) {
      if (reference.startsWith('@earendil-works/pi-durable')) {
        assert.equal(from, 'durable', `Pi Durable APIs belong under durable/: ${file}`);
      }
      if (
        ['workflow', 'shared'].includes(from) ||
        file.endsWith(join('profiles', 'contracts.ts')) ||
        file.endsWith(join('profiles', 'routing.ts'))
      ) {
        assert.ok(
          !reference.startsWith('@earendil-works/pi-coding-agent') &&
            !reference.startsWith('@earendil-works/pi-tui'),
          `Headless module must not import Pi UI/session APIs: ${file}`
        );
      }
    }
  }
});

test('internal module imports are acyclic', () => {
  const visited = new Set<string>();
  const visit = (file: string, trail: string[]) => {
    assert.ok(
      !trail.includes(file),
      `Module cycle: ${[...trail, file].map((path) => relative(sourceRoot, path)).join(' → ')}`
    );
    if (visited.has(file)) return;
    for (const dependency of localDependencies(file)) visit(dependency, [...trail, file]);
    visited.add(file);
  };
  for (const file of files) visit(file, []);
});
