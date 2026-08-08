import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { sanitizeStringArray, sanitizeText } from '../src/sanitize.js';

describe('sanitization', () => {
  test('strips ansi, control, and bidi characters', () => {
    const text = sanitizeText('\u001B[31mred\u001B[0m\u0000\u202Etext', {
      maxLength: 100,
      allowNewlines: false
    });

    assert.equal(text, 'redtext');
  });

  test('truncates before persistence/display', () => {
    const text = sanitizeText('abcdef', { maxLength: 5, allowNewlines: false });

    assert.equal(text, 'abcd…');
  });

  test('bounds string arrays', () => {
    assert.deepEqual(
      sanitizeStringArray([' a ', '', 'b', 'c'], {
        maxItems: 2,
        maxLength: 10,
        allowNewlines: false,
        collapseWhitespace: true
      }),
      ['a']
    );
  });
});
