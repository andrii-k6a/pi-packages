import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { viewInExternalEditor } from '../../src/pi/external-editor.js';

vi.mock('node:child_process', { spy: true });

afterEach(() => {
  vi.restoreAllMocks();
});

function tuiStub(events: string[]) {
  return {
    stop: () => events.push('stop'),
    start: () => events.push('start'),
    requestRender: (force?: boolean) => events.push(`render:${force}`)
  };
}

test('opens the text in the editor with the terminal released, then cleans up', async () => {
  const events: string[] = [];
  let file = '';
  let content = '';
  vi.spyOn(childProcess, 'spawn').mockImplementation(((
    command: string,
    args: string[],
    options: { stdio: string }
  ) => {
    file = args.at(-1) ?? '';
    content = readFileSync(file, 'utf8');
    events.push(`spawn:${command} ${args.slice(0, -1).join(' ')}:${options.stdio}`);
    assert.equal(statSync(dirname(file)).mode & 0o077, 0, 'the directory is private');
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 1));
    return child;
  }) as unknown as typeof childProcess.spawn);

  await viewInExternalEditor(tuiStub(events), '# transcript', {
    command: 'nvim -R',
    filename: 'run-1-transcript.md'
  });

  assert.deepEqual(events, ['stop', 'spawn:nvim -R:inherit', 'start', 'render:true']);
  assert.equal(content, '# transcript');
  assert.equal(basename(file), 'run-1-transcript.md');
  assert.ok(!existsSync(dirname(file)), 'the temporary directory is removed');
});

test('restores the terminal and cleans up when the editor cannot start', async () => {
  const events: string[] = [];
  let file = '';
  vi.spyOn(childProcess, 'spawn').mockImplementation(((_command: string, args: string[]) => {
    file = args.at(-1) ?? '';
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('spawn nope ENOENT')));
    return child;
  }) as unknown as typeof childProcess.spawn);

  await expect(
    viewInExternalEditor(tuiStub(events), 'text', { command: 'nope', filename: 't.md' })
  ).rejects.toThrow('spawn nope ENOENT');
  assert.deepEqual(events, ['stop', 'start', 'render:true']);
  assert.ok(!existsSync(dirname(file)));
});
