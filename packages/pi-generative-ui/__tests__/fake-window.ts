import { EventEmitter } from 'node:events';
import type { GlimpseWindowLike } from '../src/glimpse-window.js';

/**
 * In-memory stand-in for a glimpse window. Captures every `send(js)` call
 * and lets tests:
 *   - Emit `ready`, `message`, `closed`, `error` like the real thing.
 *   - Inspect the eval'd payloads sent host→page (parseDelivered).
 *
 * The real host code emits messages as:
 *     window.__glimpseUI&&window.__glimpseUI.deliver(<json>)
 * We don't run that JS — we just parse the JSON back out so tests can
 * assert on the structured payload directly.
 */
export class FakeWindow extends EventEmitter implements GlimpseWindowLike {
  readonly sent: string[] = [];
  closed = false;

  send(js: string): void {
    this.sent.push(js);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit('closed'));
  }

  // Convenience: drive lifecycle from tests
  emitReady(): void {
    this.emit('ready');
  }
  emitMessage(data: unknown): void {
    this.emit('message', data);
  }
  emitError(err: Error): void {
    this.emit('error', err);
  }

  /** Decode the JSON payload of a `__glimpseUI.deliver(...)` eval. */
  parseDelivered(index = -1): unknown {
    const js = index < 0 ? this.sent.at(index) : this.sent[index];
    if (!js) throw new Error(`No sent payload at index ${index}`);
    const m = js.match(/__glimpseUI\.deliver\((.*)\)$/);
    if (!m) throw new Error(`Sent payload is not a deliver() call: ${js}`);
    return JSON.parse(m[1]);
  }

  /** All decoded deliver() payloads, in send order. */
  allDelivered(): unknown[] {
    return this.sent
      .map((js) => js.match(/__glimpseUI\.deliver\((.*)\)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => JSON.parse(m[1]));
  }
}
