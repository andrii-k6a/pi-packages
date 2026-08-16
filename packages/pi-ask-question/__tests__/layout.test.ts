import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import {
  boxLines,
  COLUMN_GAP,
  clampLines,
  computePreviewLayout,
  joinColumns,
  MIN_SIDE_BY_SIDE_WIDTH,
  padToWidth,
  wrapWithPrefix
} from '../src/layout.js';

describe('wrapWithPrefix', () => {
  it('indents continuation lines under the prefix', () => {
    const lines = wrapWithPrefix('> ', 'alpha beta gamma delta', 12);

    expect(lines[0].startsWith('> ')).toBe(true);
    for (const line of lines.slice(1)) {
      expect(line.startsWith('  ')).toBe(true);
    }
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(12);
    }
  });

  it('falls back to plain wrapping when the prefix fills the width', () => {
    expect(wrapWithPrefix('    ', 'ab', 3).length).toBeGreaterThan(0);
  });
});

describe('padToWidth', () => {
  it('pads short lines', () => {
    expect(padToWidth('ab', 5)).toBe('ab   ');
  });

  it('leaves exact-width lines untouched', () => {
    expect(padToWidth('abcde', 5)).toBe('abcde');
  });

  it('truncates long lines', () => {
    expect(visibleWidth(padToWidth('abcdefgh', 4))).toBeLessThanOrEqual(4);
  });

  it('ignores ANSI codes when measuring', () => {
    expect(padToWidth('\u001b[31mab\u001b[0m', 4)).toBe('\u001b[31mab\u001b[0m  ');
  });
});

describe('joinColumns', () => {
  it('aligns the right column at a fixed offset', () => {
    const lines = joinColumns(['a', 'bb'], ['R1', 'R2'], 6, 2);

    expect(lines).toEqual(['a     ' + '  ' + 'R1', 'bb    ' + '  ' + 'R2']);
  });

  it('pads the shorter column', () => {
    const lines = joinColumns(['only left'], ['r1', 'r2', 'r3'], 12);

    expect(lines).toHaveLength(3);
    expect(lines[1].endsWith('r2')).toBe(true);
    expect(lines[2].endsWith('r3')).toBe(true);
  });

  it('does not leave trailing padding when the right column is empty', () => {
    const lines = joinColumns(['left'], [], 20);

    expect(lines).toEqual(['left']);
  });
});

describe('boxLines', () => {
  it('frames content at innerWidth + 2 columns', () => {
    const lines = boxLines(['hi', 'there'], 8, (text) => text);

    expect(lines).toEqual(['┌────────┐', '│hi      │', '│there   │', '└────────┘']);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(10);
    }
  });
});

describe('computePreviewLayout', () => {
  it('returns undefined below the side-by-side threshold', () => {
    expect(computePreviewLayout(MIN_SIDE_BY_SIDE_WIDTH - 1)).toBeUndefined();
  });

  it('splits the row so both columns fit exactly', () => {
    for (const width of [76, 80, 100, 120, 200]) {
      const layout = computePreviewLayout(width);
      expect(layout).toBeDefined();
      if (!layout) continue;
      expect(layout.leftWidth + COLUMN_GAP + layout.previewInnerWidth + 2).toBe(width);
      expect(layout.previewInnerWidth).toBeGreaterThanOrEqual(24);
    }
  });
});

describe('clampLines', () => {
  it('returns short input unchanged', () => {
    expect(clampLines(['a', 'b'], 4, () => 'note')).toEqual(['a', 'b']);
  });

  it('replaces the tail with a note about hidden lines', () => {
    const lines = clampLines(['a', 'b', 'c', 'd', 'e'], 3, (hidden) => `+${hidden}`);

    expect(lines).toEqual(['a', 'b', '+3']);
  });

  it('returns nothing when no lines are allowed', () => {
    expect(clampLines(['a'], 0, () => 'note')).toEqual([]);
  });
});
