import type { Extension } from '@earendil-works/pi-durable';

/**
 * Extensions that give workflow subagents more than the built-in coding tools.
 *
 * Pi Durable keeps extension *code* in an application-owned, process-local registry and stores only
 * extension *names* in each conversation (spec §7.1). A provider is how this package fills that
 * registry for a run: it opens whatever the extensions need (connections, files), returns the
 * extensions, and releases the resources when the run closes. After a restart the host opens the
 * providers again and the stored names resolve against the new objects.
 */
export interface WorkflowExtensionProvider {
  /** Short identifier used in notes and reports. */
  readonly name: string;
  /**
   * Open the provider for one run. Must not throw for ordinary unavailability (an unreachable
   * server, a missing config entry): report it in `notes` and return what works.
   */
  open(context: WorkflowProviderContext): Promise<WorkflowProviderLease>;
}

export interface WorkflowProviderContext {
  /** The run's working directory. */
  cwd: string;
  /** Whether the project at `cwd` is trusted; project-level configuration is read only when it is. */
  projectTrusted: boolean;
  /** Aborted when the workflow tool call is cancelled while the run is being opened. */
  signal?: AbortSignal;
}

export interface WorkflowProviderLease {
  /** Extensions to offer to subagents. Host admission rejects reserved names from every source. */
  extensions: Extension[];
  /**
   * Curated one-line availability messages persisted in run logs. Providers must omit credentials
   * and raw server diagnostics; terminal sanitization is not secret redaction.
   */
  notes: string[];
  /** Release everything the lease holds. Called once, after the run's Session has closed. */
  close(): Promise<void>;
}

/** Name prefix reserved for this package's own extensions. */
export const RESERVED_EXTENSION_PREFIX = 'workflow.';
