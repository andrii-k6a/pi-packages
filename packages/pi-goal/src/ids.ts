import { randomUUID } from 'node:crypto';

export type IdKind = 'goal' | 'claim' | 'attempt' | 'dispatch';

export interface IdProvider {
  nextId(kind: IdKind): string;
}

export interface Clock {
  now(): Date;
  nowIso(): string;
}

export const systemIdProvider: IdProvider = {
  nextId(kind) {
    return `${kind}_${randomUUID()}`;
  }
};

export const systemClock: Clock = {
  now() {
    return new Date();
  },
  nowIso() {
    return new Date().toISOString();
  }
};

export function fixedClock(iso: string): Clock {
  return {
    now() {
      return new Date(iso);
    },
    nowIso() {
      return iso;
    }
  };
}

export function sequenceIds(ids: string[]): IdProvider {
  let index = 0;
  return {
    nextId(kind) {
      const value = ids[index++] ?? `${kind}_${index}`;
      return value.includes('_') ? value : `${kind}_${value}`;
    }
  };
}
