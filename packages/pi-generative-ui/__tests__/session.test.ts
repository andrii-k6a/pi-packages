import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetSession } from '../src/session.js';
import { FakeWindow } from './fake-window.js';

function makeOpener() {
  const wins: FakeWindow[] = [];
  const open = (_html: string, _opts: unknown) => {
    const win = new FakeWindow();
    wins.push(win);
    return win;
  };
  return { open, wins };
}

function contentMessages(win: FakeWindow): Array<{ html: string; final: boolean }> {
  return win
    .allDelivered()
    .filter(
      (m): m is { type: 'content'; html: string; final: boolean } =>
        typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'content'
    )
    .map(({ html, final }) => ({ html, final }));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('WidgetSession', () => {
  it('opens a window and waits for ready before flushing chunks', async () => {
    const { open, wins } = makeOpener();
    const s = new WidgetSession(open, { title: 't', width: 100, height: 100 });
    const win = wins[0];

    s.onChunk('<p>'.padEnd(40, '.'));
    await vi.advanceTimersByTimeAsync(160);
    // Not ready yet → nothing pushed.
    expect(contentMessages(win)).toEqual([]);

    win.emitReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(contentMessages(win)).toHaveLength(1);
    expect(contentMessages(win)[0].final).toBe(false);
  });

  it('debounces rapid chunks within 150ms', async () => {
    const { open, wins } = makeOpener();
    const s = new WidgetSession(open, { title: 't', width: 100, height: 100 });
    const win = wins[0];
    win.emitReady();

    s.onChunk('a'.repeat(40));
    s.onChunk('b'.repeat(40));
    s.onChunk('c'.repeat(40));

    await vi.advanceTimersByTimeAsync(160);
    const msgs = contentMessages(win);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].html).toBe('c'.repeat(40));
    expect(msgs[0].final).toBe(false);
  });

  it('ignores chunks shorter than the minimum or unchanged', async () => {
    const { open, wins } = makeOpener();
    const s = new WidgetSession(open, { title: 't', width: 100, height: 100 });
    const win = wins[0];
    win.emitReady();

    s.onChunk('short'); // < 20 bytes
    s.onChunk(''); // empty
    await vi.advanceTimersByTimeAsync(160);
    expect(contentMessages(win)).toEqual([]);

    const big = 'x'.repeat(40);
    s.onChunk(big);
    s.onChunk(big); // duplicate
    await vi.advanceTimersByTimeAsync(160);
    expect(contentMessages(win)).toHaveLength(1);
  });

  it('onComplete cancels pending debounce and pushes final=true', async () => {
    const { open, wins } = makeOpener();
    const s = new WidgetSession(open, { title: 't', width: 100, height: 100 });
    const win = wins[0];
    win.emitReady();

    s.onChunk('a'.repeat(40));
    // Don't advance time — debounce still pending
    await s.onComplete('z'.repeat(40));

    const msgs = contentMessages(win);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ html: 'z'.repeat(40), final: true });
  });

  it('late-arriving chunks after onComplete are ignored', async () => {
    const { open, wins } = makeOpener();
    const s = new WidgetSession(open, { title: 't', width: 100, height: 100 });
    const win = wins[0];
    win.emitReady();

    await s.onComplete('z'.repeat(40));
    s.onChunk('late'.repeat(20));
    await vi.advanceTimersByTimeAsync(200);

    expect(contentMessages(win)).toHaveLength(1);
  });

  describe('lifecycle', () => {
    it('close() closes the window and cancels any pending flush', async () => {
      const { open, wins } = makeOpener();
      const s = new WidgetSession(open, { title: 't', width: 100, height: 100 });
      const win = wins[0];
      win.emitReady();

      s.onChunk('a'.repeat(40));
      s.close();
      await vi.advanceTimersByTimeAsync(200);

      expect(win.closed).toBe(true);
      expect(contentMessages(win)).toEqual([]);
    });

    it('onComplete resolves if the window closes before ready', async () => {
      const { open, wins } = makeOpener();
      const s = new WidgetSession(open, { title: 't', width: 100, height: 100 });
      const win = wins[0];

      const done = s.onComplete('z'.repeat(40));
      win.close();
      await expect(done).resolves.toBeUndefined();
      expect(contentMessages(win)).toEqual([]);
    });

    it('onClosed fires when the window closes', async () => {
      const { open, wins } = makeOpener();
      const s = new WidgetSession(open, { title: 't', width: 100, height: 100 });
      const win = wins[0];
      win.emitReady();

      let fired = false;
      s.onClosed(() => {
        fired = true;
      });
      win.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(fired).toBe(true);
    });

    it('chunks after close are ignored', async () => {
      const { open, wins } = makeOpener();
      const s = new WidgetSession(open, { title: 't', width: 100, height: 100 });
      const win = wins[0];
      win.emitReady();

      s.close();
      s.onChunk('x'.repeat(40));
      await vi.advanceTimersByTimeAsync(200);
      expect(contentMessages(win)).toEqual([]);
    });
  });
});
