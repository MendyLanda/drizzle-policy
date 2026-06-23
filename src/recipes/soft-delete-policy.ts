import { isNull } from 'drizzle-orm';

import { hasColumn, resolveDecision } from '../core/decision.js';
import { definePolicy } from '../core/policy.js';
import { DrizzlePolicyError } from '../core/types.js';
import type {
  DecisionHandler,
  DefinePolicyOptions,
  MaybeSchema,
  Policy,
  PolicyLocalDecision,
  TableKey,
  TableKeysWithoutColumn,
} from '../core/types.js';

/**
 * Delete hook result that converts a delete into an update.
 *
 * `softDeletePolicy` returns this when `deleteBehavior` is `softDelete`.
 * Custom policies may return the same shape from a `delete` hook.
 */
export interface SoftDeleteUpdateAction {
  /**
   * Converts the delete into an update.
   */
  readonly action: 'update';
  /**
   * Values to pass to the generated update's `.set()`.
   *
   * For the built-in recipe this includes the configured deleted marker column.
   */
  readonly set: Record<string, unknown>;
}

/**
 * Table details passed to soft-delete decision callbacks.
 *
 * `onTableWithoutDeletedColumn` receives this shape when a table does not have
 * the configured deleted marker column.
 */
export interface SoftDeleteDecisionArgs<TSchema extends MaybeSchema> {
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
 * Options for `softDeletePolicy`.
 *
 * Use this policy when deleted rows remain in the table and are marked by a
 * nullable column such as `deletedAt`.
 *
 * @example
 * ```ts
 * softDeletePolicy({
 *   column: 'deletedAt',
 *   deleteBehavior: 'softDelete',
 * });
 * ```
 */
export interface SoftDeletePolicyOptions<
  TSchema extends MaybeSchema,
  TColumn extends string,
  TName extends string = string,
> {
  /**
   * Policy name shown in errors and trace events. Defaults to `soft-delete`.
   *
   * @defaultValue `'soft-delete'`
   */
  readonly name?: TName;
  /**
   * Column that marks deletion. Defaults to `deletedAt`.
   *
   * Tables without this column use `onTableWithoutDeletedColumn`.
   *
   * @defaultValue `'deletedAt'`
   */
  readonly column?: TColumn;
  /**
   * Value written to the deleted column when delete behavior is `softDelete`.
   *
   * Defaults to `new Date()`.
   *
   * @defaultValue `() => new Date()`
   *
   * @example
   * ```ts
   * deletedValue: () => sql`now()`
   * ```
   */
  readonly deletedValue?: () => unknown;
  /**
   * Delete behavior for matching tables.
   *
   * `throw` rejects deletes. `softDelete` converts deletes into updates that
   * set the configured deleted column.
   *
   * @defaultValue `'throw'`
   */
  readonly deleteBehavior?: 'throw' | 'softDelete';
  /**
   * Decision for tables that do not contain the configured deleted column.
   *
   * Defaults to `ignore`, which leaves those tables to other policies or the
   * client's `onNoPolicyMatched` setting.
   *
   * @defaultValue `'ignore'`
   *
   * @example
   * ```ts
   * onTableWithoutDeletedColumn: {
   *   countries: 'ignore',
   *   auditLogs: 'throw',
   * }
   * ```
   */
  readonly onTableWithoutDeletedColumn?: DecisionHandler<
    PolicyLocalDecision,
    SoftDeleteDecisionArgs<TSchema>,
    TableKeysWithoutColumn<TSchema, TColumn>
  >;
}

/**
 * Soft-delete options when the default policy name is used.
 *
 * This overload preserves the literal policy name `soft-delete` for unsafe
 * policy-name autocomplete.
 */
type SoftDeleteDefaultNamePolicyOptions<
  TSchema extends MaybeSchema,
  TColumn extends string,
> = Omit<SoftDeletePolicyOptions<TSchema, TColumn, string>, 'name'> & {
  readonly name?: undefined;
};

/**
 * Soft-delete options when a custom policy name is provided.
 *
 * Let the recipe infer `TName` from the `name` property when you want that
 * custom name to autocomplete in unsafe policy permissions.
 */
type SoftDeleteCustomNamePolicyOptions<
  TSchema extends MaybeSchema,
  TColumn extends string,
  TName extends string,
> = Omit<SoftDeletePolicyOptions<TSchema, TColumn, TName>, 'name'> & {
  readonly name: TName;
};

/**
 * Creates a soft-delete policy.
 *
 * For tables with the configured deleted column, reads only return rows where
 * that column is `null`. Deletes are rejected by default, or converted into
 * updates when `deleteBehavior` is `softDelete`.
 *
 * @example
 * ```ts
 * const policies = definePolicies(() => [
 *   softDeletePolicy({
 *     column: 'deletedAt',
 *     deleteBehavior: 'softDelete',
 *     deletedValue: () => new Date(),
 *   }),
 * ]);
 * ```
 */
export function softDeletePolicy<
  TSchema extends MaybeSchema = undefined,
  TColumn extends string = 'deletedAt',
  TName extends string = string,
>(
  options: SoftDeleteCustomNamePolicyOptions<TSchema, TColumn, TName>
): Policy<unknown, TSchema, TName>;
/**
 * Creates a soft-delete policy with the default name.
 *
 * @defaultValue policy name is `'soft-delete'`; deleted column is
 * `'deletedAt'`
 */
export function softDeletePolicy<
  TSchema extends MaybeSchema = undefined,
  TColumn extends string = 'deletedAt',
>(
  options?: SoftDeleteDefaultNamePolicyOptions<TSchema, TColumn>
): Policy<unknown, TSchema, 'soft-delete'>;
/**
 * Creates a soft-delete policy.
 *
 * Implementation signature for the overloads above.
 */
export function softDeletePolicy<
  TSchema extends MaybeSchema = undefined,
  TColumn extends string = 'deletedAt',
>(
  options?: SoftDeletePolicyOptions<TSchema, TColumn, string>
): Policy<unknown, TSchema, string, any> {
  const column = options?.column ?? ('deletedAt' as TColumn);

  const policyOptions: DefinePolicyOptions<unknown, TSchema, string> = {
    name: options?.name ?? 'soft-delete',
    appliesTo(args) {
      if (hasColumn(args.table, column)) {
        return true;
      }

      const decision = resolveDecision(
        options?.onTableWithoutDeletedColumn,
        args,
        'ignore'
      );

      return decision === 'throw' ? 'throw' : false;
    },
    read(args) {
      return isNull(getPolicyColumn(args.table, column) as never);
    },
    delete() {
      if (options?.deleteBehavior === 'softDelete') {
        return {
          action: 'update',
          set: {
            [column]: options.deletedValue?.() ?? new Date(),
          },
        } satisfies SoftDeleteUpdateAction;
      }

      return 'throw';
    },
  };

  return definePolicy<unknown, TSchema, string>(policyOptions) as Policy<
    unknown,
    TSchema,
    string,
    any
  >;
}

/**
 * Reads the configured deleted marker column from a Drizzle table export.
 */
const getPolicyColumn = (table: unknown, column: string): unknown => {
  if (
    typeof table !== 'object' ||
    table === null ||
    Array.isArray(table) ||
    !(column in table)
  ) {
    throw new DrizzlePolicyError(
      `Policy references missing column "${column}".`
    );
  }

  return table[column as keyof typeof table];
};
