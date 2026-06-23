import { DrizzlePolicyError, type MaybeSchema } from '../core/types.js';
import {
  emitPolicyPlan,
  enforceNoPolicyMatched,
  getHookContext,
  getPolicies,
  policyApplies,
  type PolicyRuntime,
} from './policy-runtime.js';
import { isDeleteUpdateAction, isUpdateResult } from './policy-results.js';
import type { ResolvedTable } from './table-registry.js';

export type { PolicyRuntime } from './policy-runtime.js';
export { enforceRawExecution } from './policy-runtime.js';

/**
 * Result of applying read policies to one table.
 *
 * Used by the v0 query wrappers to decide which predicates should be added to
 * select and relational read queries.
 */
export interface ReadPolicyPlan {
  /**
   * Drizzle SQL predicates to add to the read query.
   *
   * Multiple predicates are combined with `and(...)` before execution.
   */
  readonly predicates: readonly unknown[];
  /**
   * Whether at least one read policy affected the operation.
   *
   * This becomes `true` when a matching enabled policy contributes a predicate.
   */
  readonly matched: boolean;
}

/**
 * Result of applying insert policies to one table.
 *
 * Insert policies run before Drizzle receives `.values(...)`.
 */
export interface InsertPolicyPlan {
  /**
   * Values to pass to Drizzle's `.values()`.
   *
   * This may be the original values or the result of one or more policy
   * transforms.
   */
  readonly values: unknown;
  /**
   * Whether at least one insert policy affected the operation.
   *
   * This becomes `true` when a matching enabled policy returns replacement
   * values.
   */
  readonly matched: boolean;
}

/**
 * Result of applying update policies to one table.
 *
 * Update policies run after `.set(...)` is observed and before the query is
 * executed or converted to SQL.
 */
export interface UpdatePolicyPlan {
  /**
   * Values to pass to Drizzle's `.set()`.
   *
   * This may be the original set object or the result of one or more policy
   * transforms.
   */
  readonly set: unknown;
  /**
   * Drizzle SQL predicates to add to the update query.
   *
   * Multiple predicates are combined with `and(...)`.
   */
  readonly predicates: readonly unknown[];
  /**
   * Whether at least one update policy affected the operation.
   *
   * This becomes `true` when a matching enabled policy contributes a predicate
   * or replacement set values.
   */
  readonly matched: boolean;
}

/**
 * Result of applying delete policies to one table.
 *
 * Delete policies may constrain a delete, reject it, or convert it into an
 * update.
 */
export interface DeletePolicyPlan {
  /**
   * Drizzle SQL predicates to add to the delete or replacement update.
   */
  readonly predicates: readonly unknown[];
  /**
   * Values for the replacement update when the delete becomes an update.
   *
   * Undefined means the original delete remains a delete.
   */
  readonly updateSet?: Record<string, unknown>;
  /**
   * Whether at least one delete policy affected the operation.
   */
  readonly matched: boolean;
}

/**
 * Applies read policies and returns predicates to add to the query.
 *
 * Throws `DrizzlePolicyError` when a matching policy rejects the read or when
 * no policy matched and `onNoPolicyMatched` resolves to `throw`.
 */
export const evaluateReadPolicies = <TContext, TSchema extends MaybeSchema>(
  runtime: PolicyRuntime<TContext, TSchema>,
  table: ResolvedTable<TSchema>
): ReadPolicyPlan => {
  const predicates: unknown[] = [];
  let matched = false;
  let handledByDisabledPolicy = false;

  for (const policy of getPolicies(runtime.options.policies)) {
    const hook = policy.options.read;
    const disabled = runtime.getDisabledPolicyNames().has(policy.name);
    if (!hook || !policyApplies(runtime, policy, table, 'read', { disabled })) {
      continue;
    }

    if (disabled) {
      handledByDisabledPolicy = true;
      continue;
    }

    const ctx = getHookContext(runtime, policy, table, 'read');
    if (ctx.decision === 'ignore') {
      continue;
    }

    const result = hook({ ...table, operation: 'read', ctx: ctx.value });
    if (result === 'throw') {
      throw new DrizzlePolicyError(`Policy "${policy.name}" rejected read.`);
    }

    if (result === undefined || result === 'ignore') {
      continue;
    }

    matched = true;
    predicates.push(result);
  }

  if (!matched && !handledByDisabledPolicy) {
    enforceNoPolicyMatched(runtime, table, 'read');
  }

  emitPolicyPlan(runtime, table, 'read', matched, predicates.length);
  return { predicates, matched };
};

/**
 * Applies insert policies and returns the values Drizzle should insert.
 *
 * Matching policy transforms are applied in policy-set order.
 */
export const evaluateInsertPolicies = <TContext, TSchema extends MaybeSchema>(
  runtime: PolicyRuntime<TContext, TSchema>,
  table: ResolvedTable<TSchema>,
  values: unknown
): InsertPolicyPlan => {
  let nextValues = values;
  let matched = false;
  let handledByDisabledPolicy = false;

  for (const policy of getPolicies(runtime.options.policies)) {
    const hook = policy.options.insert;
    const disabled = runtime.getDisabledPolicyNames().has(policy.name);
    if (
      !hook ||
      !policyApplies(runtime, policy, table, 'insert', { disabled })
    ) {
      continue;
    }

    if (disabled) {
      handledByDisabledPolicy = true;
      continue;
    }

    const ctx = getHookContext(runtime, policy, table, 'insert');
    if (ctx.decision === 'ignore') {
      continue;
    }

    const result = hook({
      ...table,
      operation: 'insert',
      ctx: ctx.value,
      values: nextValues,
    });

    if (result === 'throw') {
      throw new DrizzlePolicyError(`Policy "${policy.name}" rejected insert.`);
    }

    if (result === undefined || result === 'ignore') {
      continue;
    }

    matched = true;
    nextValues = result;
  }

  if (!matched && !handledByDisabledPolicy) {
    enforceNoPolicyMatched(runtime, table, 'insert');
  }

  emitPolicyPlan(runtime, table, 'insert', matched, 0);
  return { values: nextValues, matched };
};

/**
 * Applies update policies and returns the values and predicates for Drizzle.
 *
 * Matching policy transforms are applied in policy-set order, and predicates
 * are accumulated for the eventual `where` clause.
 */
export const evaluateUpdatePolicies = <TContext, TSchema extends MaybeSchema>(
  runtime: PolicyRuntime<TContext, TSchema>,
  table: ResolvedTable<TSchema>,
  set: unknown
): UpdatePolicyPlan => {
  const predicates: unknown[] = [];
  let nextSet = set;
  let matched = false;
  let handledByDisabledPolicy = false;

  for (const policy of getPolicies(runtime.options.policies)) {
    const hook = policy.options.update;
    const disabled = runtime.getDisabledPolicyNames().has(policy.name);
    if (
      !hook ||
      !policyApplies(runtime, policy, table, 'update', { disabled })
    ) {
      continue;
    }

    if (disabled) {
      handledByDisabledPolicy = true;
      continue;
    }

    const ctx = getHookContext(runtime, policy, table, 'update');
    if (ctx.decision === 'ignore') {
      continue;
    }

    const result = hook({
      ...table,
      operation: 'update',
      ctx: ctx.value,
      set: nextSet,
    });

    if (result === 'throw') {
      throw new DrizzlePolicyError(`Policy "${policy.name}" rejected update.`);
    }

    if (result === undefined || result === 'ignore') {
      continue;
    }

    matched = true;
    if (isUpdateResult(result)) {
      nextSet = 'set' in result ? result.set : nextSet;
      if (result.where !== undefined) {
        predicates.push(result.where);
      }
      continue;
    }

    predicates.push(result);
  }

  if (!matched && !handledByDisabledPolicy) {
    enforceNoPolicyMatched(runtime, table, 'update');
  }

  emitPolicyPlan(runtime, table, 'update', matched, predicates.length);
  return { set: nextSet, predicates, matched };
};

/**
 * Applies delete policies.
 *
 * Delete hooks may add predicates, reject the delete, or return an update
 * action that turns the delete into an update.
 *
 * When multiple policies return update actions, their `set` values are merged
 * in policy-set order.
 */
export const evaluateDeletePolicies = <TContext, TSchema extends MaybeSchema>(
  runtime: PolicyRuntime<TContext, TSchema>,
  table: ResolvedTable<TSchema>
): DeletePolicyPlan => {
  const predicates: unknown[] = [];
  let updateSet: Record<string, unknown> | undefined;
  let matched = false;
  let handledByDisabledPolicy = false;

  for (const policy of getPolicies(runtime.options.policies)) {
    const hook = policy.options.delete;
    const disabled = runtime.getDisabledPolicyNames().has(policy.name);
    if (
      !hook ||
      !policyApplies(runtime, policy, table, 'delete', { disabled })
    ) {
      continue;
    }

    if (disabled) {
      handledByDisabledPolicy = true;
      continue;
    }

    const ctx = getHookContext(runtime, policy, table, 'delete');
    if (ctx.decision === 'ignore') {
      continue;
    }

    const result = hook({ ...table, operation: 'delete', ctx: ctx.value });
    if (result === 'throw') {
      throw new DrizzlePolicyError(`Policy "${policy.name}" rejected delete.`);
    }

    if (result === undefined || result === 'ignore') {
      continue;
    }

    matched = true;
    if (isDeleteUpdateAction(result)) {
      updateSet = { ...updateSet, ...result.set };
      continue;
    }

    predicates.push(result);
  }

  if (!matched && !handledByDisabledPolicy) {
    enforceNoPolicyMatched(runtime, table, 'delete');
  }

  emitPolicyPlan(runtime, table, 'delete', matched, predicates.length);
  return { predicates, updateSet, matched };
};
