import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Opener } from '../src/glimpse-window.js';

const require = createRequire(import.meta.url);
const GLIMPSE_MJS = require.resolve('glimpseui');
const GLIMPSE_BINARY = join(dirname(GLIMPSE_MJS), 'glimpse');

// Skip integration tests when the native binary isn't compiled (sandboxes,
// CI without the toolchain). Set FORCE_INTEGRATION=1 to require them.
const canRun = existsSync(GLIMPSE_BINARY);
const shouldSkip = !canRun && !process.env.FORCE_INTEGRATION;
const describeMaybe = shouldSkip ? describe.skip : describe;

describeMaybe('integration: real glimpse window', () => {
  it('opens a window, streams content, and runs scripts on the final chunk', async () => {
    // Proves the host→page content path end-to-end. The page calls back via
    // RPC so we can observe that scripts ran and the DOM was populated.
    const { WidgetSession } = await import('../src/session.js');
    const { attach } = await import('../src/rpc.js');
    const { open } = (await import(GLIMPSE_MJS)) as { open: Opener };

    const session = new WidgetSession(open, {
      title: 'stream-test',
      width: 320,
      height: 200,
      hidden: true
    });

    try {
      // Register a test-only RPC method to receive the page's signal.
      const got = new Promise<unknown>((resolve) => {
        // WidgetSession already attached its own RpcHost; attach() is
        // idempotent so this returns the same instance.
        attach(session.win).handle('test.report', (params) => {
          resolve(params);
          return { ok: true };
        });
      });

      session.onChunk('<p>Loading…</p>'.padEnd(40, ' '));
      await session.onComplete(`
        <div id="ready">final</div>
        <script>
          window.__glimpseUI.rpc('test.report', {
            ready: document.getElementById('ready')?.textContent,
            scriptRan: true,
          });
        </script>
      `);

      const reported = await Promise.race([
        got,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 8_000))
      ]);
      expect(reported).toEqual({ ready: 'final', scriptRan: true });
    } finally {
      session.close();
    }
  }, 15_000);

  it('services an RPC call from the page via the public __glimpseUI.rpc API', async () => {
    // Exercises the full host↔page loop: page calls __glimpseUI.rpc("svg.copy"),
    // host handler runs (possibly failing if no clipboard tool is installed),
    // the result rides back as an rpc-result, and the page reports the
    // outcome via a second RPC.
    const { WidgetSession } = await import('../src/session.js');
    const { attach } = await import('../src/rpc.js');
    const { open } = (await import(GLIMPSE_MJS)) as { open: Opener };

    const session = new WidgetSession(open, {
      title: 'rpc-test',
      width: 320,
      height: 200,
      hidden: true
    });

    try {
      const got = new Promise<unknown>((resolve) => {
        attach(session.win).handle('test.report', (params) => {
          resolve(params);
          return { ok: true };
        });
      });

      await session.onComplete(`
        <svg id="s" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" fill="#0a0"/></svg>
        <script>
          (async () => {
            try {
              const svg = new XMLSerializer().serializeToString(document.getElementById('s'));
              const result = await window.__glimpseUI.rpc('svg.copy', { svg });
              window.__glimpseUI.rpc('test.report', { ok: true, result });
            } catch (e) {
              window.__glimpseUI.rpc('test.report', { ok: false, error: String(e && e.message || e) });
            }
          })();
        </script>
      `);

      const reported = await Promise.race([
        got,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 8_000))
      ]);
      // ok may be true (clipboard available) or false (no tool installed).
      // Both prove the RPC round-tripped.
      expect(reported).toMatchObject({ ok: expect.any(Boolean) });
    } finally {
      session.close();
    }
  }, 15_000);
});
