import { describe, expect, it } from 'vitest';
import { directionConfig, directions, parseConfig } from '../src/config.js';

describe('directions', () => {
  it('contains all four directions', () => {
    expect(directions).toEqual(['right', 'left', 'down', 'up']);
  });
});

describe('directionConfig', () => {
  it('has an entry for every direction', () => {
    for (const d of directions) {
      expect(directionConfig[d]).toBeDefined();
    }
  });

  it('uses -h split for left and right', () => {
    expect(directionConfig.left.splitFlag).toBe('-h');
    expect(directionConfig.right.splitFlag).toBe('-h');
  });

  it('uses -v split for up and down', () => {
    expect(directionConfig.up.splitFlag).toBe('-v');
    expect(directionConfig.down.splitFlag).toBe('-v');
  });
});

describe('parseConfig', () => {
  it('returns default shortcuts when settings is undefined', () => {
    const config = parseConfig(undefined);
    expect(config.shortcuts).toMatchObject({
      right: 'ctrl+shift+l',
      left: 'ctrl+shift+h',
      down: 'ctrl+shift+j',
      up: 'ctrl+shift+k'
    });
  });

  it('returns empty shortcuts when shortcutsEnabled is false', () => {
    const config = parseConfig({ shortcutsEnabled: false });
    expect(config.shortcuts).toEqual({});
  });

  it('uses defaults when settings is an empty object', () => {
    const config = parseConfig({});
    expect(Object.keys(config.shortcuts)).toHaveLength(4);
  });

  it('overrides a single shortcut', () => {
    const config = parseConfig({ shortcuts: { right: 'ctrl+shift+r' } });
    expect(config.shortcuts.right).toBe('ctrl+shift+r');
    expect(config.shortcuts.left).toBe('ctrl+shift+h');
  });

  it('removes a shortcut when set to null', () => {
    const config = parseConfig({ shortcuts: { up: null } });
    expect('up' in config.shortcuts).toBe(false);
  });

  it('removes a shortcut when set to false', () => {
    const config = parseConfig({ shortcuts: { down: false } });
    expect('down' in config.shortcuts).toBe(false);
  });

  it('falls back to defaults for invalid settings value', () => {
    const config = parseConfig('not-an-object');
    expect(config.shortcuts).toMatchObject({ right: 'ctrl+shift+l' });
  });
});
