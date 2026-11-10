import { type ExtensionAPI, SessionManager } from '@earendil-works/pi-coding-agent';
import { terminalLine } from '../shared/terminal-text.js';
import { resolveBuiltinWorkflow } from '../workflow/builtins.js';
import { parseCodeReviewCommand, prepareCodeReviewInput } from './code-review-input.js';
import { createWorkflowRunBinding, type WorkflowToolOptions } from './workflow-tool.js';

export function registerBuiltinWorkflowCommands(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  options: Required<Pick<WorkflowToolOptions, 'host' | 'backgroundRuns'>> &
    Pick<WorkflowToolOptions, 'profiles' | 'promptContext'>
): void {
  pi.registerCommand('code-review', {
    description:
      'Review local changes, compare a branch with --base <ref>, or audit existing code with --files. Options: --goal <text>, --tracked-only, --profile <name>, --. Optional literal path.',
    getArgumentCompletions(prefix) {
      const match = /^(.*--profile\s+)([^\s]*)$/.exec(prefix);
      if (!match) return null;
      const profiles = (options.profiles ?? []).filter(
        (profile) => profile.enabled !== false && profile.name.startsWith(match[2])
      );
      return profiles.length
        ? profiles.map((profile) => ({
            value: match[1] + JSON.stringify(profile.name),
            label: profile.name,
            description: profile.description
          }))
        : null;
    },
    async handler(args, ctx) {
      try {
        if (ctx.mode !== 'tui' && ctx.mode !== 'rpc') {
          throw new Error(
            '/code-review requires TUI or RPC mode. Use workflow with name: code-review in foreground mode.'
          );
        }
        if (!ctx.model) {
          throw new Error('Code review requires an active session model. Select one with /model.');
        }
        const signal = ctx.signal;
        const { trackedOnly, ...parsed } = parseCodeReviewCommand(args);
        const binding = createWorkflowRunBinding(ctx, { ...options, signal });
        const request = {
          mode: parsed.mode,
          ...(parsed.mode === 'files'
            ? { path: parsed.path ?? '.' }
            : {
                trackedOnly,
                ...(parsed.path === undefined ? {} : { path: parsed.path }),
                ...(parsed.base === undefined ? {} : { base: parsed.base })
              }),
          ...(parsed.goal === undefined ? {} : { goal: parsed.goal }),
          ...(parsed.profile === undefined ? {} : { profile: parsed.profile })
        };
        const input = await prepareCodeReviewInput(
          ctx.cwd,
          request,
          binding.resolveProfile,
          signal
        );
        if ('empty' in input) {
          ctx.ui.notify(input.empty, 'info');
          return;
        }
        const workflowArgs = input.args;
        const script = resolveBuiltinWorkflow('code-review', workflowArgs);
        const parent = ctx.sessionManager;
        if (
          parent.getSessionFile() &&
          !parent
            .getEntries()
            .some(
              (entry) =>
                entry.type === 'message' &&
                (entry.message.role === 'user' || entry.message.role === 'assistant')
            )
        ) {
          // Pi keeps custom entries in memory until a user or assistant message exists.
          // Record the command without starting a parent turn so ownership can persist on launch.
          if (!(parent instanceof SessionManager)) {
            throw new Error(
              'Code review requires Pi SessionManager to persist the command before launch'
            );
          }
          parent.appendMessage({
            role: 'user',
            content: `/code-review${args.trim() ? ` ${args.trim()}` : ''}`,
            timestamp: Date.now()
          });
        }
        const handle = await options.host.start(
          { script, args: workflowArgs, cwd: input.cwd },
          binding
        );
        try {
          if (signal?.aborted) {
            await handle.abort();
            throw new Error(`Workflow was aborted (run ${handle.runId})`);
          }
          options.backgroundRuns.start(handle, ctx);
        } catch (error) {
          await handle.close();
          throw error;
        }
        ctx.ui.notify(
          `Code review started in the background. Run id: ${handle.runId}. Use /workflows to inspect it. The main agent will retrieve the result when ready.`,
          'info'
        );
      } catch (error) {
        if (!ctx.hasUI) throw error;
        const message =
          (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? 'The diff exceeds the capture limit. Select a smaller path with /code-review <path>.'
            : error instanceof Error
              ? error.message.split(/\r?\n/).slice(0, 2).join(' ')
              : String(error);
        ctx.ui.notify(terminalLine(message).slice(0, 1000), 'error');
      }
    }
  });
}
