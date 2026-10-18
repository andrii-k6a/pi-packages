import type { Extension } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { RESERVED_EXTENSION_PREFIX } from './providers.js';
import { SUBAGENT_EXTENSION_NAME } from './subagent.js';

// Internal namespaces are admitted by object identity, not by a provider's claimed name or prefix.
// This allowance is only for extensions constructed by this package (currently the MCP bridge).
const internalExtensions = new WeakMap<Extension, string>();

export function ownInternalExtension(extension: Extension): Extension {
  internalExtensions.set(extension, extension.name);
  return extension;
}

/** The same admission rule applies to static and provider-supplied extensions. */
export function extensionAdmissionError(extension: Extension): string | undefined {
  const name = extension.name;
  if (typeof name !== 'string' || !name.trim()) return 'workflow extension name must not be blank';
  if (
    name === CodingTools.name ||
    name === SUBAGENT_EXTENSION_NAME ||
    (name.startsWith(RESERVED_EXTENSION_PREFIX) && internalExtensions.get(extension) !== name)
  ) {
    return `workflow extension name ${JSON.stringify(name)} is reserved; choose a name that does not start with "${RESERVED_EXTENSION_PREFIX}" or replace a built-in`;
  }
  return undefined;
}

export function validateHostExtensions(extensions: readonly Extension[]): void {
  const seen = new Set<string>();
  for (const extension of extensions) {
    const error = extensionAdmissionError(extension);
    if (error) throw new Error(error);
    if (seen.has(extension.name)) {
      throw new Error(`workflow extension ${JSON.stringify(extension.name)} is listed twice`);
    }
    seen.add(extension.name);
  }
}
