import { and } from 'drizzle-orm';

/**
 * Predicate type accepted by Drizzle's `and` helper.
 *
 * Kept local so the wrapper can combine policy predicates without exporting a
 * dialect-specific SQL type.
 */
type DrizzlePredicate = Parameters<typeof and>[number];

/**
 * Combines policy predicates and query predicates into one Drizzle condition.
 *
 * Empty values are ignored, one predicate is returned as-is, and multiple
 * predicates are wrapped with Drizzle's `and`.
 *
 * @returns `undefined` when every predicate is `undefined` or `null`.
 */
export const combinePredicates = (
  ...predicates: readonly unknown[]
): unknown => {
  const present = predicates.filter(
    predicate => predicate !== undefined && predicate !== null
  ) as DrizzlePredicate[];

  if (present.length === 0) {
    return undefined;
  }

  if (present.length === 1) {
    return present[0];
  }

  return and(...present);
};
