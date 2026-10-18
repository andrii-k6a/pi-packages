import type { JsonValue } from '@earendil-works/chord';

/** Convert cross-realm values to plain host JSON; retain JSON.stringify's validation/errors. */
export function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Omitted arguments stay omitted, rather than becoming an explicit null input. */
export function optionalJsonArgument(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : jsonValue(value);
}

/** A script without a return value has a null durable result (not an omitted field). */
export function jsonWorkflowResult(value: unknown): JsonValue {
  return value === undefined ? null : jsonValue(value);
}
