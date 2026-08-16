import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

/** Narrower terminals stack the preview under the options instead of beside them. */
export const MIN_SIDE_BY_SIDE_WIDTH = 76;
export const COLUMN_GAP = 2;
export const MIN_OPTION_COLUMN_WIDTH = 28;
export const MIN_PREVIEW_INNER_WIDTH = 24;
export const OPTION_COLUMN_RATIO = 0.45;
/** Previews are clipped so a long snippet cannot flood the viewport. */
export const MAX_PREVIEW_LINES = 24;

/** Wrap `text` to `width`, indenting continuation lines under the prefix. */
export function wrapWithPrefix(prefix: string, text: string, width: number): string[] {
  const renderWidth = Math.max(1, width);
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= renderWidth) {
    return wrapTextWithAnsi(prefix + text, renderWidth);
  }
  const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
  const continuation = ' '.repeat(prefixWidth);
  return wrapped.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

/** Pad or truncate to exactly `width` visible columns, ignoring ANSI codes. */
export function padToWidth(line: string, width: number): string {
  const target = Math.max(0, width);
  const current = visibleWidth(line);
  if (current === target) return line;
  if (current > target) return truncateToWidth(line, target);
  return line + ' '.repeat(target - current);
}

/** Place two blocks of lines side by side, padding the shorter one. */
export function joinColumns(
  left: string[],
  right: string[],
  leftWidth: number,
  gap: number = COLUMN_GAP
): string[] {
  const rows = Math.max(left.length, right.length);
  const spacer = ' '.repeat(Math.max(0, gap));
  const lines: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const leftCell = padToWidth(left[index] ?? '', leftWidth);
    const rightCell = right[index] ?? '';
    // Trailing padding is plain spaces, so trimming never truncates ANSI codes.
    lines.push(`${leftCell}${spacer}${rightCell}`.replace(/ +$/, ''));
  }
  return lines;
}

/** Frame content in a single-line box. Total width is `innerWidth + 2`. */
export function boxLines(
  content: string[],
  innerWidth: number,
  colorize: (text: string) => string
): string[] {
  const inner = Math.max(1, innerWidth);
  const horizontal = '─'.repeat(inner);
  const side = colorize('│');
  return [
    colorize(`┌${horizontal}┐`),
    ...content.map((line) => `${side}${padToWidth(line, inner)}${side}`),
    colorize(`└${horizontal}┘`)
  ];
}

export interface PreviewLayout {
  /** Columns given to the option list. */
  leftWidth: number;
  /** Columns available inside the preview box borders. */
  previewInnerWidth: number;
}

/** Column split for side-by-side previews, or undefined when too narrow. */
export function computePreviewLayout(width: number): PreviewLayout | undefined {
  if (width < MIN_SIDE_BY_SIDE_WIDTH) return undefined;
  const leftWidth = Math.max(MIN_OPTION_COLUMN_WIDTH, Math.floor(width * OPTION_COLUMN_RATIO));
  const previewInnerWidth = width - leftWidth - COLUMN_GAP - 2;
  if (previewInnerWidth < MIN_PREVIEW_INNER_WIDTH) return undefined;
  return { leftWidth, previewInnerWidth };
}

/** Clip to `max` lines, replacing the tail with a note about what was hidden. */
export function clampLines(
  lines: string[],
  max: number,
  note: (hidden: number) => string
): string[] {
  if (max <= 0) return [];
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max - 1);
  return [...kept, note(lines.length - kept.length)];
}
