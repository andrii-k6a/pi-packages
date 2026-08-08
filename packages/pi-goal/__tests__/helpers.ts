import type { Clock, IdKind, IdProvider } from '../src/ids.js';

export class MutableClock implements Clock {
  #time: number;

  constructor(iso = '2026-01-01T00:00:00.000Z') {
    this.#time = Date.parse(iso);
  }

  now(): Date {
    return new Date(this.#time);
  }

  nowIso(): string {
    return new Date(this.#time).toISOString();
  }

  advance(ms: number): void {
    this.#time += ms;
  }
}

export function ids(...values: string[]): IdProvider {
  let index = 0;
  return {
    nextId(kind: IdKind) {
      return values[index++] ?? `${kind}_${index}`;
    }
  };
}
