/**
 * Untyped schema shape used when you do not pass a Drizzle schema generic.
 *
 * Pass your Drizzle schema as the optional `TSchema` generic when you want
 * table names and table-specific decision maps to autocomplete.
 *
 * @example
 * ```ts
 * import type * as schema from './schema';
 *
 * definePolicies<AppPolicyContext, typeof schema>()(policy => []);
 * ```
 */
export type UnknownSchema = Record<string, unknown>;

/**
 * Schema generic accepted by Drizzle Policy APIs.
 *
 * Use your Drizzle schema object type for stronger autocomplete, or leave it
 * unset when a policy should work with any schema.
 *
 * @defaultValue `undefined`
 */
export type MaybeSchema = UnknownSchema | undefined;

/**
 * Drizzle table shape exposed to policy callbacks.
 *
 * Drizzle Policy intentionally depends only on the stable metadata needed to
 * identify a table and its columns. In policy hooks, cast `table` to a concrete
 * schema export when you need column autocomplete.
 */
export interface DrizzleTableLike {
  /**
   * Drizzle table metadata that includes the SQL table name and columns.
   *
   * This is provided by Drizzle table exports and is read by Drizzle Policy for
   * table-name and column-existence checks.
   */
  readonly _: {
    readonly brand: 'Table';
    readonly name: string;
    readonly columns: Record<string, unknown>;
  };
}

/**
 * Key of a table export in your Drizzle schema object.
 *
 * For example, this may be `projectMembers` even when the SQL table name is
 * `project_members`.
 *
 * When no schema generic is supplied, this falls back to `string`.
 */
export type TableKey<TSchema extends MaybeSchema> =
  TSchema extends UnknownSchema
    ? {
        [TKey in keyof TSchema]: TSchema[TKey] extends DrizzleTableLike
          ? TKey
          : never;
      }[keyof TSchema] &
        string
    : string;

/**
 * Table value passed to policy hooks.
 *
 * Cast this to a specific table export when a policy needs column-specific
 * autocomplete inside a hook.
 *
 * @example
 * ```ts
 * read: ({ table, ctx }) => {
 *   const projects = table as typeof schema.projects;
 *   return eq(projects.ownerId, ctx.userId);
 * }
 * ```
 */
export type SchemaTable<_TSchema extends MaybeSchema> = DrizzleTableLike;

/**
 * Table export type for a schema key when a schema generic is available.
 *
 * This is mostly useful for library authors who build typed recipe helpers.
 * App policies usually receive the broader `SchemaTable<TSchema>` and cast
 * inside the hook when needed.
 */
export type TableForKey<
  TSchema extends MaybeSchema,
  TTableKey extends string,
> = TSchema extends UnknownSchema
  ? TTableKey extends TableKey<TSchema> & keyof TSchema
    ? TSchema[TTableKey]
    : unknown
  : unknown;

/**
 * String keys available on a Drizzle table export.
 *
 * This includes column properties exposed by Drizzle and any other string keys
 * on the table object.
 */
export type ColumnKey<TTable> = Extract<keyof TTable, string>;

/**
 * Union of column-like string keys available across a typed schema.
 *
 * When no schema generic is provided, this falls back to `string`.
 *
 * Recipe options use this to autocomplete column names such as `tenantId` or
 * `deletedAt`.
 */
export type SchemaColumnKey<TSchema extends MaybeSchema> =
  TSchema extends UnknownSchema
    ? {
        [TKey in TableKey<TSchema> & keyof TSchema]: Extract<
          keyof TSchema[TKey],
          string
        >;
      }[TableKey<TSchema> & keyof TSchema]
    : string;

/**
 * Schema table keys whose table export contains `TColumn`.
 *
 * Use this for table-keyed options that should only mention tables with a
 * specific column.
 *
 * When no schema generic is supplied, this falls back to `string`.
 */
export type TableKeysWithColumn<
  TSchema extends MaybeSchema,
  TColumn extends string,
> = TSchema extends UnknownSchema
  ? {
      [TKey in TableKey<TSchema> &
        keyof TSchema]: TColumn extends keyof TSchema[TKey] ? TKey : never;
    }[TableKey<TSchema> & keyof TSchema] &
      string
  : string;

/**
 * Schema table keys whose table export does not contain `TColumn`.
 *
 * Use this for options such as `onTableWithoutScopeColumn`, where the relevant
 * tables are the ones missing a column.
 *
 * When no schema generic is supplied, this falls back to `string`.
 */
export type TableKeysWithoutColumn<
  TSchema extends MaybeSchema,
  TColumn extends string,
> = TSchema extends UnknownSchema
  ? {
      [TKey in TableKey<TSchema> &
        keyof TSchema]: TColumn extends keyof TSchema[TKey] ? never : TKey;
    }[TableKey<TSchema> & keyof TSchema] &
      string
  : string;

/**
 * Table operation seen by a policy hook.
 *
 * The operation is policy-level intent, not a one-to-one Drizzle method name.
 * For example, relational `findMany` and fluent `select().from(...)` both map
 * to `read`.
 */
export type PolicyOperation = 'read' | 'insert' | 'update' | 'delete';

/**
 * Keeps literal policy names while dropping broad `string` names.
 */
type KnownPolicyName<TName extends string> = string extends TName
  ? never
  : TName;

/**
 * Names available in a policy set.
 */
declare const knownPolicyName: unique symbol;

/**
 * Type-only marker for literal policy names that survive array inference.
 */
type PolicyKnownName<TPolicy> = TPolicy extends {
  readonly [knownPolicyName]?: unknown;
}
  ? NonNullable<TPolicy[typeof knownPolicyName]> extends infer TName extends
      string
    ? TName
    : never
  : never;

/**
 * Literal policy name available from the public `name` property.
 */
type PolicyDeclaredName<TPolicy> = TPolicy extends {
  readonly name: infer TName extends string;
}
  ? KnownPolicyName<TName>
  : never;

/**
 * Literal names carried by one policy.
 */
type PolicyKnownNames<TPolicy> =
  | PolicyKnownName<TPolicy>
  | PolicyDeclaredName<TPolicy>;

/**
 * Literal names carried by a policy set.
 */
type PolicySetKnownNames<TPolicies extends readonly unknown[]> =
  PolicyKnownNames<TPolicies[number]>;

/**
 * Literal-name marker used by a policy set.
 */
type PolicySetKnownName<TName extends string> = string extends TName
  ? any
  : KnownPolicyName<TName>;

/**
 * Names available in a policy set.
 *
 * Literal names autocomplete in `unsafe({ policies: [...] })` when policies
 * are defined with `definePolicies` and the name is not widened to `string`.
 * If no literal names can be inferred, this falls back to `string`.
 */
export type PolicyNames<TPolicies extends readonly unknown[]> = [
  PolicySetKnownNames<TPolicies>,
] extends [never]
  ? string
  : PolicySetKnownNames<TPolicies>;

/**
 * Policy-name input used by `unsafe({ policies: [...] })`.
 *
 * Known policy names autocomplete when available.
 *
 * The widened string branch still allows custom names from dynamically built
 * policies.
 */
export type PolicyNameInput<TPolicyName extends string> =
  | TPolicyName
  | (string & {});

/**
 * Local decision returned by a policy hook.
 *
 * Use `ignore` when this policy should not affect the current operation. Use
 * `throw` to reject the operation.
 *
 * `ignore` is policy-local: another matching policy may still constrain or
 * reject the same operation.
 */
export type PolicyLocalDecision = 'ignore' | 'throw';

/**
 * Decision used when no policy matched a table operation.
 *
 * `allow` lets the original Drizzle call continue. `throw` rejects it.
 *
 * @defaultValue `'allow'`
 */
export type OperationFallbackDecision = 'allow' | 'throw';

/**
 * Decision used when incoming values conflict with a scope recipe's required
 * scope value.
 *
 * `allow` keeps the caller-provided value. `throw` rejects the insert or
 * update.
 *
 * @defaultValue `'throw'` in `scopeIsolationPolicy`
 */
export type ScopeValueMismatchDecision = 'allow' | 'throw';

/**
 * Decision used when code calls a raw execution API such as `execute`.
 *
 * @defaultValue `'throw'`
 */
export type RawExecutionDecision = 'allow' | 'throw';

/**
 * Table-keyed map of explicit decisions.
 *
 * Use this when most tables should use the default and only a few tables need
 * a different decision.
 *
 * @example
 * ```ts
 * {
 *   countries: 'allow',
 *   auditLogs: 'throw',
 * }
 * ```
 */
export type DecisionMap<
  TKey extends string,
  TDecision extends string,
> = Partial<Record<TKey, TDecision>>;

/**
 * Function form of a decision handler.
 *
 * Use this when the decision depends on the table, operation, context, or
 * values from the current query.
 *
 * @example
 * ```ts
 * ({ tableKey, operation }) =>
 *   tableKey === 'auditLogs' && operation === 'read' ? 'allow' : 'throw'
 * ```
 */
export type DecisionCallback<TArgs, TDecision extends string> = (
  args: TArgs
) => TDecision;

/**
 * Flexible decision input accepted by policy options.
 *
 * Pass a single decision for all operations, a table-keyed decision map, or a
 * callback for per-operation logic.
 *
 * When a table-keyed map does not contain the current `tableKey`, Drizzle
 * Policy uses the option's documented default.
 */
export type DecisionHandler<
  TDecision extends string,
  TArgs,
  TKey extends string = string,
> =
  | TDecision
  | DecisionMap<TKey, TDecision>
  | DecisionCallback<TArgs, TDecision>;

/**
 * Drizzle SQL condition returned by read, update, and delete hooks.
 *
 * Return the result of Drizzle helpers such as `eq`, `and`, `or`, `isNull`, or
 * `sql`.
 *
 * @example
 * ```ts
 * read: ({ table, ctx }) => {
 *   const projects = table as typeof schema.projects;
 *   return eq(projects.ownerId, ctx.userId);
 * }
 * ```
 */
export interface PolicyPredicate<T = unknown> {
  /**
   * Drizzle SQL metadata used only for structural typing.
   *
   * You should not construct this object manually; return a Drizzle SQL
   * expression from `drizzle-orm` instead.
   */
  readonly _: {
    readonly brand: 'SQL';
    readonly type: T;
  };
}

/**
 * Result accepted from a read or delete predicate hook.
 *
 * Return a Drizzle SQL condition to constrain the operation, `ignore` to let
 * this policy contribute nothing, `throw` to reject, or `undefined`/`void` to
 * behave like `ignore`.
 *
 * Multiple matching read/delete predicates are combined with `and(...)`.
 */
export type PolicyPredicateResult =
  | PolicyPredicate
  | PolicyLocalDecision
  | undefined
  | void;

/**
 * Result accepted from an insert hook.
 *
 * Return replacement values to pass to Drizzle's `.values()`, `ignore` to keep
 * the current values unchanged, or `throw` to reject the insert.
 *
 * When several policies transform values, each policy receives the previous
 * policy's returned value.
 */
export type PolicyInsertResult<TValues = unknown> =
  | TValues
  | PolicyLocalDecision
  | undefined
  | void;

/**
 * Result accepted from an update hook.
 *
 * Return a Drizzle SQL condition to constrain the update, an object with
 * `where` and/or `set` to constrain and transform the update, `ignore` to
 * leave the operation unchanged, or `throw` to reject it.
 *
 * @example
 * ```ts
 * update: ({ table, set }) => ({
 *   where: eq((table as typeof schema.projects).archived, false),
 *   set: { ...set, updatedAt: new Date() },
 * })
 * ```
 */
export type PolicyUpdateResult<TSet = unknown> =
  | PolicyPredicate
  | {
      /**
       * Optional Drizzle SQL predicate to add to the update query.
       */
      where?: PolicyPredicate;
      /**
       * Replacement values passed to Drizzle's `.set()` call.
       */
      set?: TSet;
    }
  | PolicyLocalDecision
  | undefined
  | void;

/**
 * Result accepted from a delete hook.
 *
 * Return a Drizzle SQL condition to constrain the delete, `{ action: 'update',
 * set }` to convert the delete into an update, `ignore` to leave it unchanged,
 * or `throw` to reject it.
 *
 * @example
 * ```ts
 * delete: () => ({
 *   action: 'update',
 *   set: { deletedAt: new Date() },
 * })
 * ```
 */
export type PolicyDeleteResult<TSet = unknown> =
  | PolicyPredicate
  | {
      /**
       * Converts the delete into an update operation.
       */
      action: 'update';
      /**
       * Values passed to the replacement update's `.set()` call.
       */
      set: TSet;
    }
  | PolicyLocalDecision
  | undefined
  | void;

/**
 * Shared arguments passed to table-operation policy callbacks.
 *
 * Operation-specific argument types extend this base shape and add values such
 * as `values` for inserts or `set` for updates.
 */
export interface TableOperationArgs<
  TContext,
  TSchema extends MaybeSchema,
  TTable = SchemaTable<TSchema>,
> {
  /**
   * Key of the table in your Drizzle schema object.
   *
   * Example: `projectMembers`. This may differ from the SQL table name.
   */
  readonly tableKey: TableKey<TSchema>;
  /**
   * SQL-facing table name reported by Drizzle.
   *
   * Example: `project_members`.
   */
  readonly tableName: string;
  /**
   * Drizzle table export for the table being queried.
   *
   * Cast it to a concrete schema table in app-local policy hooks when you need
   * typed columns.
   */
  readonly table: TTable;
  /**
   * Operation currently being checked.
   */
  readonly operation: PolicyOperation;
  /**
   * Current policy context. If the policy did not declare `onMissingContext`,
   * this may be `undefined`; if it did, hooks receive a defined context after
   * missing-context handling has succeeded.
   *
   * Use the required-context policy option form when a hook cannot safely run
   * without context.
   */
  readonly ctx: TContext;
}

/**
 * Arguments passed to `appliesTo`.
 *
 * `ctx` can be `undefined` here even when the policy requires context, because
 * `appliesTo` runs before operation hooks.
 *
 * Use `appliesTo` for table classification, not for reading values from an
 * insert/update payload.
 */
export type AppliesToArgs<
  TContext,
  TSchema extends MaybeSchema,
  TTable = SchemaTable<TSchema>,
> = TableOperationArgs<TContext | undefined, TSchema, TTable>;

/**
 * Arguments passed to a policy's `read` hook.
 *
 * Return a Drizzle SQL predicate to filter reads, `ignore` to let this policy
 * stand aside, or `throw` to reject the read.
 */
export interface ReadPolicyArgs<
  TContext,
  TSchema extends MaybeSchema,
  TTable = SchemaTable<TSchema>,
> extends TableOperationArgs<TContext, TSchema, TTable> {
  /**
   * Literal operation for read hooks.
   */
  readonly operation: 'read';
}

/**
 * Arguments passed to a policy's `insert` hook.
 *
 * Return replacement values to inject safe fields or normalize input before it
 * reaches Drizzle's `.values()`.
 */
export interface InsertPolicyArgs<
  TContext,
  TSchema extends MaybeSchema,
  TValues = unknown,
  TTable = SchemaTable<TSchema>,
> extends TableOperationArgs<TContext, TSchema, TTable> {
  /**
   * Literal operation for insert hooks.
   */
  readonly operation: 'insert';
  /**
   * Values being passed to Drizzle's `.values()`.
   *
   * When multiple policies transform values, each policy receives the values
   * returned by the previous matching policy.
   *
   * This may be a single object or an array, matching the shape passed to
   * Drizzle.
   */
  readonly values: TValues;
}

/**
 * Arguments passed to a policy's `update` hook.
 *
 * Return a predicate, replacement `set` values, both, `ignore`, or `throw`.
 */
export interface UpdatePolicyArgs<
  TContext,
  TSchema extends MaybeSchema,
  TSet = unknown,
  TTable = SchemaTable<TSchema>,
> extends TableOperationArgs<TContext, TSchema, TTable> {
  /**
   * Literal operation for update hooks.
   */
  readonly operation: 'update';
  /**
   * Current update set object.
   *
   * When multiple policies transform the set, each policy receives the set
   * returned by the previous matching policy.
   *
   * This is `undefined` until Drizzle's `.set(...)` arguments are observed.
   */
  readonly set?: TSet;
}

/**
 * Arguments passed to a policy's `delete` hook.
 *
 * Return a predicate to constrain the delete, or return an update action to
 * convert the delete into an update.
 */
export interface DeletePolicyArgs<
  TContext,
  TSchema extends MaybeSchema,
  TTable = SchemaTable<TSchema>,
> extends TableOperationArgs<TContext, TSchema, TTable> {
  /**
   * Literal operation for delete hooks.
   */
  readonly operation: 'delete';
}

/**
 * Arguments passed to `onMissingContext`.
 *
 * The callback runs when a policy declared `onMissingContext`, a matching
 * operation hook is about to run, and no policy context is active.
 */
export interface MissingContextArgs<TSchema extends MaybeSchema> {
  /**
   * Key of the table in your Drizzle schema object.
   */
  readonly tableKey: TableKey<TSchema>;
  /**
   * SQL-facing table name reported by Drizzle.
   */
  readonly tableName: string;
  /**
   * Drizzle table export for the operation.
   */
  readonly table: SchemaTable<TSchema>;
  /**
   * Operation that needed context.
   */
  readonly operation: PolicyOperation;
}

/**
 * Shared options for policies with and without required context.
 */
interface DefinePolicyOptionsBase<
  TContext,
  TSchema extends MaybeSchema,
  TName extends string = string,
> {
  /**
   * Human-readable policy name used in thrown errors and trace events.
   *
   * Pick a stable name, such as `scope-isolation` or `no-self-delete`, so
   * production logs are easy to connect back to policy code.
   *
   * Literal names also drive autocomplete for `unsafe({ policies: [...] })`.
   */
  readonly name: TName;
  /**
   * Optional table classifier for the policy.
   *
   * Return `true` when this policy should evaluate for the table, `false` or
   * `ignore` when it should not, and `throw` when seeing this table should be
   * treated as a policy violation.
   *
   * @defaultValue `undefined`, which means the policy applies to every table
   * for operations where it defines a hook.
   *
   * @example
   * ```ts
   * appliesTo: ({ tableKey }) => tableKey === 'projects'
   * ```
   */
  readonly appliesTo?: (
    args: AppliesToArgs<TContext, TSchema>
  ) => boolean | PolicyLocalDecision;
}

/**
 * Policy options for policies that can run without context.
 *
 * When `onMissingContext` is omitted, operation hooks receive
 * `ctx: TContext | undefined`.
 *
 * Use this form for context-free policies such as soft delete, public lookup
 * tables, or policies that already handle anonymous access.
 */
export interface DefinePolicyOptionsWithOptionalContext<
  TContext,
  TSchema extends MaybeSchema,
  TName extends string = string,
> extends DefinePolicyOptionsBase<TContext, TSchema, TName> {
  /**
   * Leave unset when the policy can safely run with `ctx` as `undefined`.
   *
   * @defaultValue `undefined`
   */
  readonly onMissingContext?: undefined;
  /**
   * Adds a predicate to read operations.
   *
   * Return a native Drizzle SQL condition, `ignore`, `throw`, or nothing.
   *
   * @defaultValue `undefined`, meaning this policy does not participate in
   * reads.
   */
  readonly read?: (
    args: ReadPolicyArgs<TContext | undefined, TSchema>
  ) => PolicyPredicateResult;
  /**
   * Transforms or rejects insert values.
   *
   * @defaultValue `undefined`, meaning this policy does not participate in
   * inserts.
   */
  readonly insert?: (
    args: InsertPolicyArgs<TContext | undefined, TSchema>
  ) => PolicyInsertResult;
  /**
   * Adds an update predicate, transforms update values, or rejects updates.
   *
   * @defaultValue `undefined`, meaning this policy does not participate in
   * updates.
   */
  readonly update?: (
    args: UpdatePolicyArgs<TContext | undefined, TSchema>
  ) => PolicyUpdateResult;
  /**
   * Adds a delete predicate, converts deletes to updates, or rejects deletes.
   *
   * @defaultValue `undefined`, meaning this policy does not participate in
   * deletes.
   */
  readonly delete?: (
    args: DeletePolicyArgs<TContext | undefined, TSchema>
  ) => PolicyDeleteResult;
}

/**
 * Policy options for policies that require context before operation hooks run.
 *
 * Add `onMissingContext` when a policy should not run unless request or job
 * context is active. Operation hooks then receive a defined `ctx`.
 *
 * @example
 * ```ts
 * policy.define({
 *   name: 'owner-only',
 *   onMissingContext: 'throw',
 *   read: ({ table, ctx }) =>
 *     eq((table as typeof schema.projects).ownerId, ctx.userId),
 * })
 * ```
 */
export interface DefinePolicyOptionsWithRequiredContext<
  TContext,
  TSchema extends MaybeSchema,
  TName extends string = string,
> extends DefinePolicyOptionsBase<TContext, TSchema, TName> {
  /**
   * Decision used when the policy needs context but none is active.
   *
   * May be a single decision, a `tableKey` decision map, or a callback.
   *
   * `ignore` lets this policy stand aside for the operation. `throw` rejects
   * the operation with a `DrizzlePolicyError`.
   */
  readonly onMissingContext: DecisionHandler<
    PolicyLocalDecision,
    MissingContextArgs<TSchema>,
    TableKey<TSchema>
  >;
  /**
   * Adds a predicate to read operations. `ctx` is guaranteed to be present.
   *
   * @defaultValue `undefined`, meaning this policy does not participate in
   * reads.
   */
  readonly read?: (
    args: ReadPolicyArgs<TContext, TSchema>
  ) => PolicyPredicateResult;
  /**
   * Transforms or rejects insert values. `ctx` is guaranteed to be present.
   *
   * @defaultValue `undefined`, meaning this policy does not participate in
   * inserts.
   */
  readonly insert?: (
    args: InsertPolicyArgs<TContext, TSchema>
  ) => PolicyInsertResult;
  /**
   * Adds an update predicate, transforms update values, or rejects updates.
   * `ctx` is guaranteed to be present.
   *
   * @defaultValue `undefined`, meaning this policy does not participate in
   * updates.
   */
  readonly update?: (
    args: UpdatePolicyArgs<TContext, TSchema>
  ) => PolicyUpdateResult;
  /**
   * Adds a delete predicate, converts deletes to updates, or rejects deletes.
   * `ctx` is guaranteed to be present.
   *
   * @defaultValue `undefined`, meaning this policy does not participate in
   * deletes.
   */
  readonly delete?: (
    args: DeletePolicyArgs<TContext, TSchema>
  ) => PolicyDeleteResult;
}

/**
 * Options accepted by `definePolicy`.
 *
 * Add `onMissingContext` when hooks require `ctx`; omit it for policies that
 * can safely run without context.
 *
 * @see {@link DefinePolicyOptionsWithOptionalContext}
 * @see {@link DefinePolicyOptionsWithRequiredContext}
 */
export type DefinePolicyOptions<
  TContext,
  TSchema extends MaybeSchema = undefined,
  TName extends string = string,
> =
  | DefinePolicyOptionsWithOptionalContext<TContext, TSchema, TName>
  | DefinePolicyOptionsWithRequiredContext<TContext, TSchema, TName>;

/**
 * Policy definition created by `definePolicy` or a recipe.
 *
 * Policy objects are frozen, reusable values. Pass them through
 * `definePolicies(...)` and then into `createPolicyClient`.
 */
export interface Policy<
  TContext = unknown,
  TSchema extends MaybeSchema = undefined,
  TName extends string = string,
  TKnownName extends string = KnownPolicyName<TName>,
> {
  /**
   * Type-only literal-name metadata for autocomplete.
   *
   * This property is never read at runtime.
   */
  readonly [knownPolicyName]?: TKnownName;
  /**
   * Marker used to recognize Drizzle Policy definitions.
   */
  readonly __drizzlePolicy: true;
  /**
   * Human-readable policy name used in errors and trace output.
   */
  readonly name: TName;
  /**
   * Options and hooks supplied when the policy was defined.
   *
   * This is public primarily for advanced tooling, inspection, and recipe
   * authors. Application code normally treats policies as opaque values.
   */
  readonly options: DefinePolicyOptions<TContext, TSchema, TName>;
}

/**
 * Policy value that can be included in a policy set for the current context
 * and optional schema generic.
 *
 * This lets schema-blind recipes and typed app policies live in one policy
 * set.
 *
 * You rarely need to name this type directly; it powers `PolicySet`.
 */
export type CompatiblePolicy<
  TContext = unknown,
  TSchema extends MaybeSchema = undefined,
  TName extends string = string,
  TKnownName extends string = KnownPolicyName<TName>,
> =
  | Policy<TContext, TSchema, TName, TKnownName>
  | Policy<TContext, TSchema | undefined, TName, TKnownName>
  | Policy<TContext, undefined, TName, TKnownName>
  | Policy<unknown, TSchema, TName, TKnownName>
  | Policy<unknown, TSchema | undefined, TName, TKnownName>
  | Policy<unknown, undefined, TName, TKnownName>;

/**
 * Readonly collection of policies passed to `createPolicyClient`.
 *
 * Create policy sets with `definePolicies(...)` so context, schema, and
 * literal policy-name inference stay intact.
 *
 * @example
 * ```ts
 * const policies = definePolicies<AppPolicyContext>()(policy => [
 *   policy.define({ name: 'no-deletes', delete: () => 'throw' }),
 * ]);
 * ```
 */
export type PolicySet<
  TContext = unknown,
  TSchema extends MaybeSchema = undefined,
  TName extends string = string,
  TKnownName extends string = PolicySetKnownName<TName>,
> = readonly CompatiblePolicy<TContext, TSchema, TName, TKnownName>[];

/**
 * Builder object passed to the callback form of `definePolicies`.
 *
 * It applies the policy set's context and schema generics to each
 * `policy.define(...)` call.
 */
export interface PolicyBuilder<TContext, TSchema extends MaybeSchema> {
  /**
   * Define one policy using the policy set's context and schema generics.
   *
   * @example
   * ```ts
   * policy.define({
   *   name: 'visible-projects',
   *   read: ({ table, ctx }) =>
   *     eq((table as typeof schema.projects).ownerId, ctx?.userId),
   * })
   * ```
   */
  define<TName extends string>(
    options: DefinePolicyOptions<TContext, TSchema, TName>
  ): Policy<TContext, TSchema, TName>;
}

/**
 * Async-local policy context helper.
 *
 * Use this directly when you want context management without wrapping a
 * Drizzle client, or indirectly through `withPolicyContext` on a policy client.
 *
 * @example
 * ```ts
 * const policyContext = createPolicyContext<{ tenantId: string }>();
 *
 * await policyContext.run({ tenantId: 'tenant_123' }, async () => {
 *   return handler();
 * });
 * ```
 */
export interface PolicyContext<TContext> {
  /**
   * Runs `fn` with `ctx` available to policy hooks in the current async call
   * chain.
   *
   * The return value, including a promise, is returned unchanged from `run`.
   */
  run<TResult>(ctx: TContext, fn: () => TResult): TResult;
  /**
   * Returns the current context, or `undefined` when no context is active.
   */
  get(): TContext | undefined;
  /**
   * Returns the current context or throws `MissingPolicyContextError`.
   *
   * Use this in application code that wants to fail immediately when called
   * outside a request/job context.
   */
  getOrThrow(): TContext;
}

/**
 * Error thrown by `PolicyContext.getOrThrow()` when no context is active.
 *
 * Policy enforcement itself throws `DrizzlePolicyError`; this error is for
 * direct use of the context helper.
 */
export class MissingPolicyContextError extends Error {
  /**
   * Creates a missing-context error with a stable name for application-level
   * error handling.
   */
  constructor() {
    super('No Drizzle Policy context is active.');
    this.name = 'MissingPolicyContextError';
  }
}

/**
 * Error thrown when drizzle-policy rejects or cannot safely plan a Drizzle
 * operation.
 *
 * Examples include a policy returning `throw`, missing required context, raw
 * execution being rejected, or a recipe referencing a missing column.
 */
export class DrizzlePolicyError extends Error {
  /**
   * Creates a policy error with a stable name for application-level error
   * handling.
   */
  constructor(message: string) {
    super(message);
    this.name = 'DrizzlePolicyError';
  }
}
