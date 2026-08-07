import { describe, expect, it } from 'vitest';
import { getGuidelines } from '../src/guidelines.js';

describe('generative UI guidelines', () => {
  it('are adapted for the display-only show_widget runtime', () => {
    const text = getGuidelines(['interactive', 'diagram']);

    expect(text).toContain('# Widget Design Guide');
    expect(text).toContain('Widgets are display-only');
    expect(text).toContain('show_widget');
    expect(text).not.toMatch(/\b(imagine_html|imagine_svg)\b/);
    expect(text).not.toMatch(/(?<!visualize_)read_me/);
    expect(text).not.toContain('sendPrompt');
    expect(text).not.toContain('openLink');
    expect(text).not.toContain('local UI controls');
    expect(text).not.toContain('Claude');
    expect(text).not.toContain('claude.ai');
  });
});
