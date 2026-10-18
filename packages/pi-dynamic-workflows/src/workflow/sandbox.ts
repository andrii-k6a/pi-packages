import vm from 'node:vm';

import { NONDETERMINISM_ERROR } from './validation.js';

/**
 * A convenience execution context for trusted scripts, NOT a security boundary. Host callbacks
 * remain reachable. Runtime restrictions catch accidental clock/random use, including aliases;
 * authors must still avoid scheduling-dependent control flow and other replay-unstable behavior.
 * Scripts share Pi's event loop, so a synchronous busy loop freezes Pi; the parser rejects the
 * obvious infinite loops and the runtime bounds the first synchronous stretch.
 */
export function createWorkflowContext(globals: Record<string, unknown>): vm.Context {
  const context = vm.createContext(globals, {
    codeGeneration: { strings: false, wasm: false }
  });
  // Use this realm's intrinsics, never mutable host-owned built-ins. Keep deterministic Date
  // parsing available, but do not expose the real constructor through its prototype.
  new vm.Script(`
    (() => {
      const unavailable = () => { throw new Error(${JSON.stringify(NONDETERMINISM_ERROR)}); };
      const NativeDate = Date;
      const WorkflowDate = function () { return unavailable(); };
      Object.defineProperties(WorkflowDate, {
        now: { value: unavailable },
        parse: { value: NativeDate.parse },
        UTC: { value: NativeDate.UTC }
      });
      Object.freeze(WorkflowDate.prototype);
      Object.freeze(WorkflowDate);
      Object.defineProperty(globalThis, 'Date', { value: WorkflowDate, writable: false, configurable: false });
      Object.defineProperty(Math, 'random', { value: unavailable, writable: false, configurable: false });
      Object.freeze(Math);
      // Atomics.wait would block Pi's event loop from inside a script. Scripts have no use for
      // shared memory, so neither it nor its buffer type is provided.
      delete globalThis.Atomics;
      delete globalThis.SharedArrayBuffer;
    })();
  `).runInContext(context);
  return context;
}
