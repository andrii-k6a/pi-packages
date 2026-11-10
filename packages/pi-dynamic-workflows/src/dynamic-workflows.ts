import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { WorkflowHost } from './durable/host.js';
import { loadWorkflowMcpAllowlist } from './durable/mcp/config.js';
import { createMcpProvider } from './durable/mcp/provider.js';
import { WorkflowBackgroundRuns } from './pi/background.js';
import { registerBuiltinWorkflowCommands } from './pi/builtin-commands.js';
import { loadWorkflowMaxAgents } from './pi/limits.js';
import { openWorkflowProfileManager } from './pi/profiles/manager.js';
import { openWorkflowRuns } from './pi/runs-command.js';
import { createWorkflowTool } from './pi/workflow-tool.js';
import { loadWorkflowProfiles } from './profiles/config.js';
import { terminalLine } from './shared/terminal-text.js';

/** Pi registration only. The supported embedding API is exported separately by library.ts. */
export default function extension(pi: ExtensionAPI) {
  // One durable runtime per extension instance; each run is its own Pi Durable Session.
  // Subagents get MCP tools only from servers the user approved in pi-dynamic-workflows/mcp.json.
  const mcpAllowlist = loadWorkflowMcpAllowlist();
  const maxAgents = loadWorkflowMaxAgents();
  const host = new WorkflowHost({
    providers: Object.keys(mcpAllowlist.servers).length
      ? [createMcpProvider({ allowlist: mcpAllowlist })]
      : [],
    ...(maxAgents === undefined ? {} : { maxAgents })
  });
  const backgroundRuns = new WorkflowBackgroundRuns(pi, host);
  const options = { profiles: loadWorkflowProfiles(), host, backgroundRuns };
  const workflowTool = createWorkflowTool(options);
  pi.registerTool(workflowTool);
  registerBuiltinWorkflowCommands(pi, options);
  pi.registerCommand('workflow-profiles', {
    description:
      'Create, edit, delete, enable or disable, and reload approved workflow routing profiles',
    handler: async (_args, ctx) => openWorkflowProfileManager(ctx)
  });
  pi.registerCommand('workflows', {
    description:
      'Inspect, resume, abort, or delete workflow runs. Use <run-id> --report for a saved report.',
    handler: async (args, ctx) => openWorkflowRuns(pi, ctx, host, args)
  });

  pi.on('session_start', async (_event, ctx) => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
    await backgroundRuns.recover(ctx);
    if (!ctx.hasUI) return;
    const interrupted = host
      .list()
      .filter((run) => run.status === 'interrupted' && run.cwd === ctx.cwd);
    if (interrupted.length > 0) {
      const latest = interrupted[0];
      ctx.ui.notify(
        interrupted.length === 1
          ? `Workflow ${terminalLine(latest.name)} was interrupted (${latest.agents.done}/${latest.agents.total} agents done, run ${terminalLine(latest.runId)}). Use /workflows to inspect or resume it.`
          : `${interrupted.length} workflow runs were interrupted in this project. Use /workflows to inspect or resume them.`,
        'warning'
      );
    }
  });

  // message_end is too early: Pi appends the tool result after dispatching that event.
  pi.on('turn_end', async (_event, ctx) => {
    await host.settleDeliveries(ctx.sessionManager.getSessionFile());
  });

  pi.on('agent_before_settle', (event, ctx) => {
    if (event.outcome !== 'completed') return;
    const notifications = backgroundRuns.notificationEntries(ctx);
    if (notifications.length > 0) {
      return { entries: [...event.entries, ...notifications], continue: true };
    }
  });

  pi.on('agent_settled', (event, ctx) => {
    backgroundRuns.settleNotifications(ctx);
    if (event.aborted) backgroundRuns.cancelNotificationFlush();
    else backgroundRuns.sendNotifications(ctx);
  });

  pi.on('session_compact', (event, ctx) => {
    if (event.reason === 'manual') backgroundRuns.scheduleNotificationFlush(ctx);
  });

  pi.on('session_compact_failed', (event, ctx) => {
    if (event.reason !== 'manual') return;
    if (event.aborted) backgroundRuns.cancelNotificationFlush();
    else backgroundRuns.scheduleNotificationFlush(ctx);
  });

  // Quit, reload, and session switches close runs without aborting them: unfinished work stays
  // committed in each run's Session and continues on `resume`.
  pi.on('session_shutdown', async (_event, ctx) => {
    await backgroundRuns.close(ctx);
  });
}
