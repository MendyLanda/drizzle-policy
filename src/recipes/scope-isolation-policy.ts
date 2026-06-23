import { hasColumn, isRecord, resolveDecision } from '../core/decision.js';
import { definePolicy } from '../core/policy.js';
import type {
  DecisionHandler,
  DefinePolicyOptions,
  InsertPolicyArgs,
  MaybeSchema,
  Policy,
  PolicyLocalDecision,
  ScopeValueMismatchDecision,
  TableKey,
  TableKeysWithoutColumn,
  TableOperationArgs,
  UpdatePolicyArgs,
} from '../core/types.js';
import {
  injectScopeValue,
  makeScopePredicate,
} from './scope-isolation-helpers.js';

/**
 * Table details passed to scope-isolation decision callbacks.
 *
 * These callbacks are used by `onTableWithoutScopeColumn`,
 * `onMissingScopeValue`, and `onScopeValueMismatch` when their decision depends
 * on the current table or operation.
 */
export interface ScopeIsolationDecisionArgs<TSchema extends MaybeSchema> {
  /**
   * Key of the table in your Drizzle schema object.
   *
   * With a schema generic, this autocompletes schema export names.
   */
  readonly tableKey: TableKey<TSchema>;
  /**
   * SQL-facing table name reported by Drizzle.
   */
  readonly tableName: string;
  /**
   * Drizzle table export for the operation.
   *
   * This is typed as `unknown` because recipe decision callbacks normally only
   * need table identity; cast it if you need custom table inspection.
   */
  readonly table: unknown;
  /**
   * Operation currently being checked.
   */
  readonly operation: 'read' | 'insert' | 'update' | 'delete';
}

/**
 * Details passed to `onMissingScopeValue`.
 *
 * This fires when the table has the configured scope column, but
 * `getScopeValue(ctx)` returned `undefined` or `null`.
 */
export interface MissingScopeValueArgs<
  TSchema extends MaybeSchema,
> extends ScopeIsolationDecisionArgs<TSchema> {}

/**
 * Details passed to `onScopeValueMismatch`.
 *
 * This fires when an insert/update payload explicitly includes the configured
 * scope column with a value different from the current scope value.
 */
export interface ScopeValueMismatchArgs<
  TSchema extends MaybeSchema,
  TValues = unknown,
> extends ScopeIsolationDecisionArgs<TSchema> {
  /**
   * Scope value expected for the current context.
   *
   * This is the value returned by `getScopeValue(ctx)`.
   */
  readonly expectedValue: unknown;
  /**
   * Value supplied by the insert/update payload for the scope column.
   */
  readonly actualValue: unknown;
  /**
   * Insert or update value object that contained the mismatch.
   *
   * For batch inserts, this is the individual item currently being checked.
   */
  readonly values: TValues;
}

/**
 * Options for `scopeIsolationPolicy`.
 *
 * Use this policy for tenant, workspace, organization, account, or project
 * isolation.
 *
 * @example
 * ```ts
 * scopeIsolationPolicy<PolicyContext>({
 *   column: 'tenantId',
 *   getScopeValue: ctx => ctx.tenantId,
 * });
 * ```
 */
export interface ScopeIsolationPolicyOptions<
  TContext,
  TSchema extends MaybeSchema,
  TColumn extends string,
  TName extends string = string,
> {
  /**
   * Policy name shown in errors and trace events. Defaults to
   * `scope-isolation`.
   *
   * @defaultValue `'scope-isolation'`
   */
  readonly name?: TName;
  /**
   * Column that stores the scope value, such as `tenantId`, `workspaceId`, or
   * `organizationId`.
   *
   * Tables without this column use `onTableWithoutScopeColumn`.
   */
  readonly column: TColumn;
  /**
   * Reads the current scope value from policy context.
   *
   * Return `undefined` or `null` when there is no active scope.
   *
   * The callback is called only after a policy context exists. Missing context
   * is handled as a missing scope value before this resolver runs.
   *
   * @example
   * ```ts
   * getScopeValue: ctx => ctx.workspaceId
   * ```
   */
  readonly getScopeValue: (ctx: TContext) => unknown;
  /**
   * When true, read/update/delete predicates allow rows where the scope column
   * is `null` in addition to rows matching the current scope value.
   *
   * Inserts and updates still write or require the concrete scope value.
   *
   * @defaultValue `false`
   */
  readonly allowGlobalRows?: boolean;
  /**
   * Decision for tables that do not contain the configured scope column.
   *
   * Defaults to `ignore`, which leaves those tables to other policies or the
   * client's `onNoPolicyMatched` setting.
   *
   * @defaultValue `'ignore'`
   *
   * @example
   * ```ts
   * onTableWithoutScopeColumn: {
   *   countries: 'ignore',
   *   auditLogs: 'throw',
   * }
   * ```
   */
  readonly onTableWithoutScopeColumn?: DecisionHandler<
    PolicyLocalDecision,
    ScopeIsolationDecisionArgs<TSchema>,
    TableKeysWithoutColumn<TSchema, TColumn>
  >;
  /**
   * Decision used when `getScopeValue` returns `undefined` or `null`.
   *
   * Defaults to `throw`.
   *
   * Use `ignore` only for tables/operations where it is acceptable for this
   * policy to stand aside and let other policies or `onNoPolicyMatched` decide.
   *
   * @defaultValue `'throw'`
   */
  readonly onMissingScopeValue?: DecisionHandler<
    PolicyLocalDecision,
    MissingScopeValueArgs<TSchema>,
    TableKey<TSchema>
  >;
  /**
   * Decision used when insert or update values explicitly set the scope column
   * to a value different from the current scope.
   *
   * Defaults to `throw`.
   *
   * Use `allow` only when caller-provided scope values have already been
   * validated elsewhere.
   *
   * @defaultValue `'throw'`
   */
  readonly onScopeValueMismatch?: DecisionHandler<
    ScopeValueMismatchDecision,
    ScopeValueMismatchArgs<TSchema>,
    TableKey<TSchema>
  >;
}

/**
 * Scope-isolation options when the default policy name is used.
 *
 * This overload preserves the literal policy name `scope-isolation` for unsafe
 * policy-name autocomplete.
 */
type ScopeIsolationDefaultNamePolicyOptions<
  TContext,
  TSchema extends MaybeSchema,
  TColumn extends string,
> = Omit<
  ScopeIsolationPolicyOptions<TContext, TSchema, TColumn, string>,
  'name'
> & {
  readonly name?: undefined;
};

/**
 * Scope-isolation options when a custom policy name is provided.
 *
 * Let the recipe infer `TName` from the `name` property when you want that
 * custom name to autocomplete in unsafe policy permissions.
 */
type ScopeIsolationCustomNamePolicyOptions<
  TContext,
  TSchema extends MaybeSchema,
  TColumn extends string,
  TName extends string,
> = Omit<
  ScopeIsolationPolicyOptions<TContext, TSchema, TColumn, TName>,
  'name'
> & {
  readonly name: TName;
};

/**
 * Creates a column-based scope isolation policy.
 *
 * For tables with the configured column, reads, updates, and deletes are
 * limited to the current scope. Inserts receive the current scope value, and
 * inserts or updates for another scope are rejected by default.
 *
 * @example
 * ```ts
 * const policies = definePolicies<PolicyContext>()(() => [
 *   scopeIsolationPolicy({
 *     name: 'tenant-isolation',
 *     column: 'tenantId',
 *     getScopeValue: ctx => ctx.tenantId,
 *   }),
 * ]);
 * ```
 */
export function scopeIsolationPolicy<
  TContext = unknown,
  TSchema extends MaybeSchema = undefined,
  TColumn extends string = string,
  TName extends string = string,
>(
  options: ScopeIsolationCustomNamePolicyOptions<
    TContext,
    TSchema,
    TColumn,
    TName
  >
): Policy<TContext, TSchema, TName>;
/**
 * Creates a column-based scope isolation policy with the default name.
 *
 * @defaultValue policy name is `'scope-isolation'`
 */
export function scopeIsolationPolicy<
  TContext = unknown,
  TSchema extends MaybeSchema = undefined,
  TColumn extends string = string,
>(
  options: ScopeIsolationDefaultNamePolicyOptions<TContext, TSchema, TColumn>
): Policy<TContext, TSchema, 'scope-isolation'>;
/**
 * Creates a scope-isolation policy.
 *
 * Implementation signature for the overloads above.
 */
export function scopeIsolationPolicy<
  TContext = unknown,
  TSchema extends MaybeSchema = undefined,
  TColumn extends string = string,
>(
  options: ScopeIsolationPolicyOptions<TContext, TSchema, TColumn, string>
): Policy<TContext, TSchema, string, any> {
  const getMissingScopeDecision = (
    args: ScopeIsolationDecisionArgs<TSchema>
  ): PolicyLocalDecision => {
    return resolveDecision(options.onMissingScopeValue, args, 'throw');
  };

  const getScopeValue = (
    ctx: TContext,
    args: MissingScopeValueArgs<TSchema>
  ): PolicyLocalDecision | unknown => {
    const value = options.getScopeValue(ctx);
    if (value === undefined || value === null) {
      return getMissingScopeDecision(args);
    }

    return value;
  };

  const policyOptions: DefinePolicyOptions<TContext, TSchema, string> = {
    name: options.name ?? 'scope-isolation',
    onMissingContext(args: ScopeIsolationDecisionArgs<TSchema>) {
      return getMissingScopeDecision(args);
    },
    appliesTo(args: ScopeIsolationDecisionArgs<TSchema>) {
      if (hasColumn(args.table, options.column)) {
        return true;
      }

      const decision = resolveDecision(
        options.onTableWithoutScopeColumn,
        args,
        'ignore'
      );
      if (decision === 'throw') {
        return 'throw';
      }

      return false;
    },
    read(args: TableOperationArgs<TContext, TSchema>) {
      const scopeValue = getScopeValue(args.ctx, args);
      if (scopeValue === 'ignore' || scopeValue === 'throw') {
        return scopeValue;
      }

      return makeScopePredicate(args.table, scopeValue, options);
    },
    insert(args: InsertPolicyArgs<TContext, TSchema>) {
      const scopeValue = getScopeValue(args.ctx, args);
      if (scopeValue === 'ignore' || scopeValue === 'throw') {
        return scopeValue;
      }

      const transformOne = (value: unknown) => {
        const transformed = injectScopeValue(value, scopeValue, options.column);
        if (transformed === 'throw') {
          const decision = resolveDecision(
            options.onScopeValueMismatch,
            {
              ...args,
              expectedValue: scopeValue,
              actualValue: isRecord(value) ? value[options.column] : undefined,
              values: value,
            },
            'throw'
          );

          return decision === 'allow' ? value : 'throw';
        }

        return transformed;
      };

      if (Array.isArray(args.values)) {
        const transformedValues = args.values.map(transformOne);
        return transformedValues.includes('throw')
          ? 'throw'
          : transformedValues;
      }

      return transformOne(args.values);
    },
    update(args: UpdatePolicyArgs<TContext, TSchema>) {
      const scopeValue = getScopeValue(args.ctx, args);
      if (scopeValue === 'ignore' || scopeValue === 'throw') {
        return scopeValue;
      }

      if (
        isRecord(args.set) &&
        options.column in args.set &&
        args.set[options.column] !== undefined &&
        args.set[options.column] !== scopeValue
      ) {
        const decision = resolveDecision(
          options.onScopeValueMismatch,
          {
            ...args,
            expectedValue: scopeValue,
            actualValue: args.set[options.column],
            values: args.set,
          },
          'throw'
        );

        if (decision === 'throw') {
          return 'throw';
        }
      }

      return {
        where: makeScopePredicate(args.table, scopeValue, options),
        set: args.set,
      };
    },
    delete(args: TableOperationArgs<TContext, TSchema>) {
      const scopeValue = getScopeValue(args.ctx, args);
      if (scopeValue === 'ignore' || scopeValue === 'throw') {
        return scopeValue;
      }

      return makeScopePredicate(args.table, scopeValue, options);
    },
  };

  return definePolicy<TContext, TSchema, string>(policyOptions) as Policy<
    TContext,
    TSchema,
    string,
    any
  >;
}
