import { type ExtensionCommandContext, SessionManager } from '@earendil-works/pi-coding-agent';

/** Pi does not persist custom entries until the first user or assistant message exists. */
export function persistWorkflowCommand(ctx: ExtensionCommandContext, text: string): void {
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
    if (!(parent instanceof SessionManager)) {
      throw new Error(
        'Workflow command requires Pi SessionManager to persist initiation before launch'
      );
    }
    parent.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
  }
}
