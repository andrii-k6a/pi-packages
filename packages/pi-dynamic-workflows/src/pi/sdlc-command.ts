import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { terminalLine } from '../shared/terminal-text.js';
import { resolveBuiltinWorkflow } from '../workflow/builtins.js';
import type { ContinueSdlcOptions } from '../workflow/sdlc/contracts.js';
import { persistWorkflowCommand } from './command-session.js';
import { compactSdlc, renderSdlcStatusLines, sdlcStartWorkspaceNotice } from './sdlc-display.js';
import { parseSdlcCommand, prepareSdlcArgs, SDLC_COMMAND_USAGE } from './sdlc-input.js';
import { createWorkflowRunBinding, type WorkflowToolOptions } from './workflow-tool.js';

export function registerSdlcCommand(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  options: Required<Pick<WorkflowToolOptions, 'host' | 'backgroundRuns'>> &
    Pick<WorkflowToolOptions, 'profiles' | 'promptContext'>
): void {
  pi.registerCommand('sdlc', {
    description: `Implement and independently verify a goal. Foreground by default. ${SDLC_COMMAND_USAGE}. Continuation JSON accepts answers, additive checks, explicit limits, resumeProfile, or authorized goalRevision changes.`,
    async handler(input, ctx) {
      try {
        if (ctx.mode !== 'tui' && ctx.mode !== 'rpc') {
          throw new Error(
            '/sdlc requires TUI or RPC mode. Use workflow with name: sdlc in foreground mode.'
          );
        }
        const command = parseSdlcCommand(input);
        if (command.action === 'cancel') {
          const cancelled = await options.host.abort(command.runId);
          ctx.ui.notify(
            cancelled === 'aborted'
              ? 'Cancellation requested. Completed work is kept.'
              : 'No live work to cancel.',
            'info'
          );
          return;
        }
        if (command.action === 'status' || command.action === 'answer') {
          if (command.action === 'answer') {
            const { action: _action, runId, ...answer } = command;
            await options.host.answerSdlc(runId, answer);
            ctx.ui.notify(
              `Answer recorded for ${answer.questionId}. No work started. Use /sdlc continue ${runId} when ready.`,
              'info'
            );
          } else {
            const state = await options.host.inspectSdlc(command.runId);
            ctx.ui.notify(renderSdlcStatusLines(compactSdlc(state)).join('\n'), 'info');
          }
          return;
        }
        if (!ctx.model)
          throw new Error('SDLC requires an active session model. Select one with /model.');
        const args =
          command.action === 'start'
            ? prepareSdlcArgs(command.args, command.background)
            : undefined;
        const script = args ? resolveBuiltinWorkflow('sdlc', args) : undefined;
        persistWorkflowCommand(ctx, `/sdlc ${input.trim()}`);
        const binding = createWorkflowRunBinding(ctx, { ...options, signal: ctx.signal });
        if (args) ctx.ui.notify(await sdlcStartWorkspaceNotice(args, ctx.cwd), 'info');
        const handle =
          command.action === 'continue'
            ? await options.host.continueSdlc(
                command.runId,
                command.options as ContinueSdlcOptions,
                binding
              )
            : await options.host.start({ script: script as string, args, cwd: ctx.cwd }, binding);
        try {
          if (ctx.signal?.aborted) {
            await handle.abort();
            throw new Error(`Workflow was aborted (run ${handle.runId})`);
          }
          options.backgroundRuns.start(handle, ctx);
        } catch (error) {
          await handle.close();
          throw error;
        }
        ctx.ui.notify(
          `SDLC ${command.background ? 'started in the background' : 'started'}. Run id: ${handle.runId}. Use /sdlc status ${handle.runId} to inspect it. The main agent retrieves the result and usage when ready.`,
          'info'
        );
        if (!command.background) {
          const abort = () => void handle.abort().catch(() => {});
          ctx.signal?.addEventListener('abort', abort, { once: true });
          if (ctx.signal?.aborted) abort();
          try {
            // The background helper owns closing, result-ready notification, and receipt recovery.
            // Waiting here does not acknowledge or discard command-launched spend.
            await options.backgroundRuns.wait(handle.runId);
          } finally {
            ctx.signal?.removeEventListener('abort', abort);
          }
        }
      } catch (error) {
        if (!ctx.hasUI) throw error;
        ctx.ui.notify(
          terminalLine(error instanceof Error ? error.message : String(error)).slice(0, 1000),
          'error'
        );
      }
    }
  });
}
