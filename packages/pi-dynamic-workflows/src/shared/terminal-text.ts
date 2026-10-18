import { stripVTControlCharacters } from 'node:util';

/**
 * Plain terminal text, not ANSI-styled output or secret redaction. Apply before adding theme
 * escapes, at rendering boundaries; never rewrite durable records just to make them displayable.
 */
function plainText(value: string): string {
  // Node's stripper recognizes CSI in C1 form, but not C1 OSC/ST. Normalize the latter
  // to their seven-bit forms so a hyperlink/title payload is removed along with its controls.
  const normalized = value.replace(/\u009d/g, '\u001b]').replace(/\u009c/g, '\u001b\\');
  return stripVTControlCharacters(normalized).replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
}

/** Keeps words separated but removes controls and collapses all whitespace to single spaces. */
export function terminalLine(value: string): string {
  return plainText(value)
    .replace(/\s+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
}

/** Preserves line breaks, normalizes CRLF, expands tabs, and removes other terminal controls. */
export function terminalMultiline(value: string): string {
  return plainText(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .split('\n')
    .map((line) => line.replace(/\p{Cc}/gu, ''))
    .join('\n');
}

/** Removes controls without trimming/collapsing user input, including leading/trailing spaces. */
export function terminalInput(value: string): string {
  return plainText(value).replace(/\p{Cc}/gu, '');
}
