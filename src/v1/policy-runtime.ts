import type { CreatePolicyClientOptions } from '../core/client.js';
import { resolveDecision } from '../core/decision.js';
import {
  DrizzlePolicyError,
  type MaybeSchema,
  type Policy,
  type PolicyOperation,
} from '../core/types.js';
import type { ResolvedTable } from './table-registry.js';
import { emitTrace, type V1PolicyTraceSink } from './trace.js';

/**
 * State available while enforcing policies for one v1 client.
 *
 * Runtime state is shared by fluent builders, relational query wrappers,
 * transaction clients, and unsafe clients created from the same wrapped client.
 */
export interface PolicyRuntime<TContext, TSchema extends MaybeSchema> {
  /**
   * Client options supplied when the policy client was created.
   *
   * Includes the policy set and fallback decisions.
   */
  readonly options: CreatePolicyClientOptions<TContext, TSchema>;
  /**
   * Optional callback for policy trace events.
   *
   * @defaultValue `undefined`
   */
  readonly trace?: V1PolicyTraceSink;
  /**
   * Reads the current policy context.
   *
   * Explicit `withPolicyContext` scopes take precedence over an application
   * `getContext` reader.
   */
  getContext(): TContext | undefined;
  /**
   * Reads policy names disabled in the current async call chain.
   */
  getDisabledPolicyNames(): ReadonlySet<string>;
  /**
   * Returns whether raw execution is allowed in the current async call chain.
   */
  isRawExecutionAllowed(): boolean;
}

/**
 * Options used while deciding whether a policy applies.
 */
interface PolicyAppliesOptions {
  /**
   * Whether the policy is currently disabled for the active callback.
   */
  readonly disabled?: boolean;
}

/**
 * Returns the Drizzle Policy definitions from a policy collection.
 *
 * Non-policy values are ignored so policy-set helper types can be permissive at
 * compile time without affecting runtime enforcement.
 */
export const getPolicies = <TContext, TSchema extends MaybeSchema>(
  policies: CreatePolicyClientOptions<TContext, TSchema>['policies']
): readonly Policy<TContext, TSchema>[] => {
  return policies.filter(isPolicy) as unknown as readonly Policy<
    TContext,
    TSchema
  >[];
};

/**
 * Determines whether a policy applies to the current table operation.
 *
 * A missing `appliesTo` callback means the policy applies. Returning `ignore`
 * or `false` skips the policy. Returning `throw` rejects the operation.
 *
 * Disabled policies still count as handling the operation when their
 * `appliesTo` callback would reject, preventing `onNoPolicyMatched` from
 * treating an intentionally disabled policy as no coverage.
 */
export const policyApplies = <TContext, TSchema extends MaybeSchema>(
  runtime: PolicyRuntime<TContext, TSchema>,
  policy: Policy<TContext, TSchema>,
  table: ResolvedTable<TSchema>,
  operation: PolicyOperation,
  options: PolicyAppliesOptions = {}
): boolean => {
  const result = policy.options.appliesTo?.({
    ...table,
    operation,
    ctx: runtime.getContext(),
  });

  if (result === 'throw') {
    if (options.disabled) {
      return true;
    }

    throw new DrizzlePolicyError(
      `Policy "${policy.name}" rejected ${operation}.`
    );
  }

  if (result === 'ignore') {
    return false;
  }

  return result ?? true;
};

/**
 * Resolves the context value that should be passed to a policy hook.
 *
 * If a policy declares `onMissingContext` and no context is active, the
 * missing-context decision is applied before the hook runs.
 *
 * A missing `onMissingContext` means hooks receive `ctx` as `undefined`.
 */
export const getHookContext = <TContext, TSchema extends MaybeSchema>(
  runtime: PolicyRuntime<TContext, TSchema>,
  policy: Policy<TContext, TSchema>,
  table: ResolvedTable<TSchema>,
  operation: PolicyOperation
):
  | { readonly decision: 'use'; readonly value: TContext }
  | { readonly decision: 'ignore' } => {
  const ctx = runtime.getContext();
  if (ctx !== undefined) {
    return { decision: 'use', value: ctx };
  }

  const onMissingContext = policy.options.onMissingContext;
  if (!onMissingContext) {
    return { decision: 'use', value: undefined as TContext };
  }

  const decision = resolveDecision(
    onMissingContext,
    {
      ...table,
      operation,
    },
    'throw'
  );

  if (decision === 'ignore') {
    return { decision: 'ignore' };
  }

  throw new DrizzlePolicyError(`Policy "${policy.name}" requires context.`);
};

/**
 * Applies the client's `onNoPolicyMatched` setting for one table operation.
 *
 * @defaultValue `'allow'`
 */
export const enforceNoPolicyMatched = <TContext, TSchema extends MaybeSchema>(
  runtime: PolicyRuntime<TContext, TSchema>,
  table: ResolvedTable<TSchema>,
  operation: PolicyOperation
): void => {
  const decision = resolveDecision(
    runtime.options.onNoPolicyMatched,
    {
      ...table,
      operation,
      ctx: runtime.getContext(),
    },
    'allow'
  );

  if (decision === 'throw') {
    throw new DrizzlePolicyError(
      `No policy matched ${operation} on "${table.tableName}".`
    );
  }
};

/**
 * Sends a trace event describing the policy result for one operation.
 *
 * The event includes whether a policy matched and how many predicates were
 * produced for the operation.
 */
export const emitPolicyPlan = <TContext, TSchema extends MaybeSchema>(
  runtime: PolicyRuntime<TContext, TSchema>,
  table: ResolvedTable<TSchema>,
  operation: PolicyOperation,
  matched: boolean,
  predicateCount: number
): void => {
  emitTrace(runtime.trace, {
    kind: 'policy-plan',
    operation,
    tableKey: table.tableKey,
    tableName: table.tableName,
    matched,
    predicateCount,
  });
};

/**
 * Applies the active unsafe scope or the client's `rawExecution` setting.
 *
 * Direct raw execution is rejected unless it was explicitly allowed.
 *
 * @defaultValue `'throw'`
 */
export const enforceRawExecution = <TContext, TSchema extends MaybeSchema>(
  runtime: PolicyRuntime<TContext, TSchema>,
  method: string,
  args: readonly unknown[]
): void => {
  const decision = runtime.isRawExecutionAllowed()
    ? 'allow'
    : resolveRawExecutionDecision(runtime, method, args);

  emitTrace(runtime.trace, {
    kind: 'raw-execution',
    method,
    decision,
  });

  if (decision === 'throw') {
    throw new DrizzlePolicyError(
      'Raw execution through Drizzle Policy is not allowed.'
    );
  }
};

/**
 * Resolves the fallback raw-execution decision from client options.
 */
const resolveRawExecutionDecision = <TContext, TSchema extends MaybeSchema>(
  runtime: PolicyRuntime<TContext, TSchema>,
  method: string,
  args: readonly unknown[]
) => {
  const option = runtime.options.rawExecution ?? 'throw';

  return typeof option === 'function'
    ? option({
        method,
        args,
        ctx: runtime.getContext(),
      })
    : option;
};

/**
 * Returns whether a value is a Drizzle Policy definition.
 */
const isPolicy = (value: unknown): value is Policy => {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__drizzlePolicy' in value &&
    value.__drizzlePolicy === true
  );
};
