/**
 * Returns whether an update hook result contains `where` or `set`.
 *
 * A bare predicate does not have either key, so policy evaluation can
 * distinguish "add this predicate" from "replace set values and/or add where".
 */
export const isUpdateResult = (
  value: unknown
): value is { readonly where?: unknown; readonly set?: unknown } => {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('where' in value || 'set' in value)
  );
};

/**
 * Returns whether a delete hook result converts the delete into an update.
 *
 * The guard requires a non-array object `set` payload so accidental primitives
 * are not treated as replacement update values.
 */
export const isDeleteUpdateAction = (
  value: unknown
): value is {
  readonly action: 'update';
  readonly set: Record<string, unknown>;
} => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'action' in value &&
    value.action === 'update' &&
    'set' in value &&
    typeof value.set === 'object' &&
    value.set !== null &&
    !Array.isArray(value.set)
  );
};
