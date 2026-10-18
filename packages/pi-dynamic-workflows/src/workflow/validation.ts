export const NONDETERMINISM_ERROR =
  'Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable';

/** Shared validation for profile names in literal metadata and runtime options. */
export function requireProfileName(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

export function throwProfileMigrationError(location: string): never {
  throw new Error(
    `${location} model selection was removed; select an approved named profile instead`
  );
}
