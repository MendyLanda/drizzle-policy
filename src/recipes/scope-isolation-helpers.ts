import { eq, isNull, or } from 'drizzle-orm';

import { isRecord } from '../core/decision.js';
import { DrizzlePolicyError } from '../core/types.js';

/**
 * Options for comparing a scope column to the current scope value.
 *
 * This is used by the scope-isolation recipe to build read/update/delete
 * predicates.
 */
export interface ScopePredicateOptions {
  /**
   * Column that stores the scope value.
   *
   * Example values include `tenantId`, `workspaceId`, or `organizationId`.
   */
  readonly column: string;
  /**
   * Whether `null` scope values should also be visible for read, update, and
   * delete predicates.
   *
   * @defaultValue `false`
   */
  readonly allowGlobalRows?: boolean;
}

/**
 * Creates a Drizzle condition for the current scope value.
 *
 * When `allowGlobalRows` is true, the condition is equivalent to
 * `isNull(scopeColumn) OR eq(scopeColumn, value)`. Otherwise it is equivalent
 * to `eq(scopeColumn, value)`.
 */
export const makeScopePredicate = (
  table: unknown,
  value: unknown,
  options: ScopePredicateOptions
) => {
  const column = getPolicyColumn(table, options.column);
  const scoped = eq(column as never, value as never);

  return options.allowGlobalRows ? or(isNull(column as never), scoped) : scoped;
};

/**
 * Adds the current scope value to one insert/update payload object.
 *
 * Returns `throw` when the payload explicitly provides a conflicting scope
 * value.
 *
 * Non-object payloads are returned unchanged so Drizzle can handle the shape it
 * received.
 */
export const injectScopeValue = (
  value: unknown,
  scopeValue: unknown,
  column: string
) => {
  if (!isRecord(value)) {
    return value;
  }

  if (
    column in value &&
    value[column] !== undefined &&
    value[column] !== scopeValue
  ) {
    return 'throw' as const;
  }

  return {
    ...value,
    [column]: scopeValue,
  };
};

/**
 * Reads a configured column from a Drizzle table export.
 */
const getPolicyColumn = (table: unknown, column: string): unknown => {
  if (!isRecord(table) || !(column in table)) {
    throw new DrizzlePolicyError(
      `Policy references missing column "${column}".`
    );
  }

  return table[column];
};
