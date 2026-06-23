import type { DecisionHandler } from './types.js';

/**
 * Resolves a decision option for the current operation.
 *
 * Decision options may be a single decision, a `tableKey` map, or a callback.
 * When no handler is configured, or a table-keyed map has no matching entry,
 * the supplied fallback is returned.
 */
export const resolveDecision = <
  TDecision extends string,
  TArgs extends { readonly tableKey?: string },
  TKey extends string = string,
>(
  handler: DecisionHandler<TDecision, TArgs, TKey> | undefined,
  args: TArgs,
  fallback: TDecision
): TDecision => {
  if (!handler) {
    return fallback;
  }

  if (typeof handler === 'function') {
    return handler(args);
  }

  if (typeof handler === 'string') {
    return handler;
  }

  const key = args.tableKey as TKey | undefined;
  if (key && Object.prototype.hasOwnProperty.call(handler, key)) {
    return handler[key] ?? fallback;
  }

  return fallback;
};

/**
 * Returns whether a Drizzle table export contains `column`.
 *
 * Recipe policies use this before attempting to read a configured column from
 * a table object.
 */
export const hasColumn = (table: unknown, column: string): boolean => {
  return typeof table === 'object' && table !== null && column in table;
};

/**
 * Narrows a value to a plain record-like object.
 *
 * Arrays are excluded because policy insert/update value objects are expected
 * to be inspected one item at a time.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};
