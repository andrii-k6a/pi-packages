import { describe, expect, it } from 'vitest';
import { isHostToPage, isPageToHost } from '../src/protocol.js';

describe('protocol guards', () => {
  describe('isHostToPage', () => {
    it('accepts content messages', () => {
      expect(isHostToPage({ type: 'content', html: '<p/>', final: false })).toBe(true);
      expect(isHostToPage({ type: 'content', html: '', final: true })).toBe(true);
    });
    it('accepts rpc-result messages', () => {
      expect(isHostToPage({ type: 'rpc-result', id: 'r1', ok: true })).toBe(true);
      expect(isHostToPage({ type: 'rpc-result', id: 'r1', ok: false, error: 'x' })).toBe(true);
    });
    it('rejects non-objects', () => {
      expect(isHostToPage(null)).toBe(false);
      expect(isHostToPage(undefined)).toBe(false);
      expect(isHostToPage('content')).toBe(false);
      expect(isHostToPage(42)).toBe(false);
    });
    it('rejects unknown discriminators', () => {
      expect(isHostToPage({ type: 'rpc-call', id: 'r1' })).toBe(false);
      expect(isHostToPage({ type: 'user-message' })).toBe(false);
      expect(isHostToPage({})).toBe(false);
    });
  });

  describe('isPageToHost', () => {
    it('accepts rpc-call', () => {
      expect(isPageToHost({ type: 'rpc-call', id: 'r1', method: 'x', params: null })).toBe(true);
    });
    it('rejects host→page discriminators', () => {
      expect(isPageToHost({ type: 'content', html: '', final: false })).toBe(false);
      expect(isPageToHost({ type: 'rpc-result', id: 'r1', ok: true })).toBe(false);
    });
    it('rejects everything else (including unstructured widget payloads)', () => {
      expect(isPageToHost({ type: 'user-message', data: { choice: 'yes' } })).toBe(false);
      expect(isPageToHost({ choice: 'yes' })).toBe(false);
      expect(isPageToHost(null)).toBe(false);
      expect(isPageToHost([])).toBe(false);
      expect(isPageToHost('x')).toBe(false);
    });
  });
});
