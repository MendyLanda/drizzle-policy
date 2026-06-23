import { createPolicyContext } from './context.js';
import {
  createPolicyDisableScope,
  normalizeUnsafePermissions,
} from './policy-disable.js';
import type {
  DecisionHandler,
  MaybeSchema,
  OperationFallbackDecision,
  Policy,
  PolicyContext,
  PolicyNameInput,
  PolicySet,
  PolicyNames,
  RawExecutionDecision,
  TableKey,
} from './types.js';

/**
 * Arguments passed to `onNoPolicyMatched`.
 *
 * Use these values when the fallback decision depends on the table, operation,
 * or current request/job context. This callback runs only after Drizzle Policy
 * sees a supported table operation and no enabled policy hook matched it.
 *
 * @example
 * ```ts
 * const onNoPolicyMatched = ({ tableKey, operation }) =>
 *   tableKey === 'auditLogs' && operation === 'insert' ? 'allow' : 'throw';
 * ```
 */
export interface NoPolicyMatchedArgs<TContext, TSchema extends MaybeSchema> {
  /**
   * Key of the table in your Drizzle schema object.
   *
   * This is the schema export name when it can be resolved, such as
   * `projectMembers`, and may differ from the SQL table name.
   */
  readonly tableKey: TableKey<TSchema>;
  /**
   * SQL-facing table name reported by Drizzle, such as `project_members`.
   */
  readonly tableName: string;
  /**
   * Drizzle table value for the operation.
   *
   * Cast this to a specific table export only when a custom callback needs
   * column metadata.
   */
  readonly table: unknown;
  /**
   * Operation that had no matching policy.
   */
  readonly operation: 'read' | 'insert' | 'update' | 'delete';
  /**
   * Current policy context, or `undefined` when no context is active.
   *
   * `onNoPolicyMatched` never triggers missing-context handling from an
   * individual policy because, by definition, no policy matched the operation.
   */
  readonly ctx: TContext | undefined;
}

/**
 * Arguments passed to a `rawExecution` callback.
 *
 * Use these values to allow a narrow raw execution escape hatch while keeping
 * raw execution rejected by default everywhere else.
 *
 * @example
 * ```ts
 * const rawExecution = ({ method, ctx }) =>
 *   method === 'execute' && ctx?.isMaintenanceJob ? 'allow' : 'throw';
 * ```
 */
export interface RawExecutionArgs<TContext> {
  /**
   * Raw execution method being called.
   *
   * Today Drizzle Policy checks `execute` on wrapped clients and transaction
   * clients.
   */
  readonly method: string;
  /**
   * Arguments passed to the raw execution method.
   *
   * They are intentionally typed as `unknown` so the callback can inspect or
   * log them without Drizzle Policy depending on a dialect-specific SQL type.
   */
  readonly args: readonly unknown[];
  /**
   * Current policy context, or `undefined` when no context is active.
   */
  readonly ctx: TContext | undefined;
}

/**
 * Configuration accepted by `onNoPolicyMatched`.
 *
 * Use a single decision for every table, a `tableKey` decision map, or a
 * callback when the fallback depends on context or operation.
 *
 * @defaultValue `'allow'`
 *
 * @example
 * ```ts
 * createPolicyClient(db, {
 *   policies,
 *   onNoPolicyMatched: {
 *     countries: 'allow',
 *     auditLogs: 'throw',
 *   },
 * });
 * ```
 */
export type NoPolicyMatchedOption<
  TContext,
  TSchema extends MaybeSchema,
> = DecisionHandler<
  OperationFallbackDecision,
  NoPolicyMatchedArgs<TContext, TSchema>,
  TableKey<TSchema>
>;

/**
 * Configuration accepted by `rawExecution`.
 *
 * Set this to `allow` or return `allow` from a callback when your app wants to
 * permit direct raw execution. Omit it to reject raw execution unless code
 * enters an explicit `unsafe({ execute: true })` scope.
 *
 * @defaultValue `'throw'`
 *
 * @example
 * ```ts
 * createPolicyClient(db, {
 *   policies,
 *   rawExecution: ({ ctx }) => (ctx?.canRunMaintenanceSql ? 'allow' : 'throw'),
 * });
 * ```
 */
export type RawExecutionOption<TContext> =
  | RawExecutionDecision
  | ((args: RawExecutionArgs<TContext>) => RawExecutionDecision);

/**
 * Whether a create-client options object statically allows raw execution.
 *
 * This is `true` only when `rawExecution` is the literal string `'allow'`.
 * Callback-based raw execution decisions stay typed as the safe client surface
 * because the callback can still return `throw` at runtime.
 */
export type RawExecutionAllowedByOptions<TOptions> = TOptions extends {
  readonly rawExecution: 'allow';
}
  ? true
  : false;

/**
 * Returns true only for the exact `unknown` type.
 */
type IsUnknown<TValue> = unknown extends TValue
  ? [keyof TValue] extends [never]
    ? true
    : false
  : false;

/**
 * Extracts the app context from one policy, ignoring context-free policies.
 */
type KnownPolicyContext<TPolicy> =
  TPolicy extends Policy<
    infer TContext,
    infer _TSchema,
    infer _TName,
    infer _TKnownName
  >
    ? IsUnknown<TContext> extends true
      ? never
      : TContext
    : never;

/**
 * Extracts the concrete schema generic from one policy, ignoring schema-free policies.
 */
type KnownPolicySchema<TPolicy> =
  TPolicy extends Policy<
    infer _TContext,
    infer TSchema,
    infer _TName,
    infer _TKnownName
  >
    ? Exclude<TSchema, undefined>
    : never;

/**
 * Context type inferred from policies that carry an application context.
 *
 * `createPolicyClient` uses this so a policy set like
 * `definePolicies<AppContext>()(...)` can infer `AppContext` without repeating
 * the generic at the client call.
 *
 * Falls back to `unknown` when no policy carries a concrete context type.
 */
export type PolicyContextFromPolicies<TPolicies extends readonly unknown[]> = [
  KnownPolicyContext<TPolicies[number]>,
] extends [never]
  ? unknown
  : KnownPolicyContext<TPolicies[number]>;

/**
 * Schema type inferred from policies that carry a Drizzle schema generic.
 *
 * `createPolicyClient` uses this to preserve table-key autocomplete from a
 * typed policy set.
 *
 * Falls back to `undefined` when no policy carries a schema type.
 */
export type PolicySchemaFromPolicies<TPolicies extends readonly unknown[]> = [
  KnownPolicySchema<TPolicies[number]>,
] extends [never]
  ? undefined
  : KnownPolicySchema<TPolicies[number]>;

/**
 * Result returned when Drizzle Policy creates the async-local context.
 *
 * This is the return shape when `createPolicyClient` is called without
 * `getContext`.
 *
 * @example
 * ```ts
 * const { db, policyContext } = createPolicyClient(rawDb, { policies });
 *
 * await policyContext.run({ tenantId: 'tenant_123' }, () =>
 *   db.query.projects.findMany()
 * );
 * ```
 */
export interface GeneratedPolicyClient<
  TClient,
  TContext,
  TPolicyName extends string = string,
  TAllowRawExecution extends boolean = false,
> {
  /**
   * Drizzle client with policy enforcement and policy helper methods.
   *
   * Use this anywhere you want policies applied before operations reach the
   * underlying Drizzle client.
   */
  readonly db: PolicyClient<TClient, TContext, TPolicyName, TAllowRawExecution>;
  /**
   * Async-local policy context created for this client.
   *
   * Use it at request, job, or test boundaries to make context available to
   * policy hooks.
   */
  readonly policyContext: PolicyContext<TContext>;
}

/**
 * Result returned when the application provides its own context reader.
 *
 * This is the return shape when `createPolicyClient` receives `getContext`.
 * Drizzle Policy does not create a `policyContext` property because your app
 * owns context storage.
 */
export interface ExternalContextPolicyClient<
  TClient,
  TContext,
  TPolicyName extends string = string,
  TAllowRawExecution extends boolean = false,
> {
  /**
   * Drizzle client with policy enforcement and policy helper methods.
   *
   * `db.withPolicyContext(...)` can still override `getContext` for a nested
   * callback, which is useful in tests and scripts.
   */
  readonly db: PolicyClient<TClient, TContext, TPolicyName, TAllowRawExecution>;
}

/**
 * Public result shape for `createPolicyClient`.
 *
 * When `getContext` is omitted, the result includes both `db` and
 * `policyContext`. When `getContext` is provided, the result includes only
 * `db`.
 */
export type CreatePolicyClientResult<
  TClient,
  TContext,
  TPolicyName extends string = string,
  TAllowRawExecution extends boolean = false,
  TOptions = unknown,
> = TOptions extends { readonly getContext: () => unknown }
  ? ExternalContextPolicyClient<
      TClient,
      TContext,
      TPolicyName,
      TAllowRawExecution
    >
  : GeneratedPolicyClient<TClient, TContext, TPolicyName, TAllowRawExecution>;

/**
 * Options for creating a policy client.
 *
 * These options are shared by the root Drizzle v1 client wrapper, the
 * `drizzle-policy/v0` wrapper, and the lower-level core wrapper.
 */
export interface CreatePolicyClientOptions<
  TContext,
  TSchema extends MaybeSchema,
  TPolicies extends readonly unknown[] = PolicySet<TContext, TSchema>,
> {
  /**
   * Optional application-owned context reader.
   *
   * Use this when your framework already has request or job context storage.
   * `withPolicyContext` takes precedence when both are available.
   *
   * @defaultValue `undefined`
   *
   * @example
   * ```ts
   * createPolicyClient(db, {
   *   policies,
   *   getContext: () => requestContext.getStore(),
   * });
   * ```
   */
  readonly getContext?: () => TContext | undefined;
  /**
   * Policies to enforce for this client.
   *
   * Pass the readonly array returned by `definePolicies(...)`. Policies are
   * evaluated in array order, so later insert/update transforms receive the
   * values returned by earlier matching policies.
   */
  readonly policies: TPolicies;
  /**
   * Fallback when no policy matched a table operation.
   *
   * Use `throw` to fail closed by default, or a table-keyed map/callback for
   * tables that intentionally have no policy.
   *
   * @defaultValue `'allow'`
   */
  readonly onNoPolicyMatched?: NoPolicyMatchedOption<TContext, TSchema>;
  /**
   * Decision for direct raw execution methods such as `execute`.
   *
   * Normal wrapped clients reject raw execution by default. Use this option
   * for a global/callback decision, or use `db.unsafe({ execute: true })` for a
   * narrow scoped exception.
   *
   * @defaultValue `'throw'`
   */
  readonly rawExecution?: RawExecutionOption<TContext>;
}

/**
 * Permission object accepted by `unsafe`.
 *
 * Use the object form when you need to disable policies and/or expose raw
 * execution for a returned unsafe client.
 *
 * @example
 * ```ts
 * const unsafeDb = db.unsafe({
 *   policies: ['soft-delete'],
 *   execute: true,
 * });
 * ```
 */
export interface UnsafePolicyPermissions<TPolicyName extends string = string> {
  /**
   * Policy names to disable for the returned client.
   *
   * Known literal names autocomplete when policies are defined with
   * `definePolicies`.
   *
   * @defaultValue `[]`
   */
  readonly policies?: readonly PolicyNameInput<TPolicyName>[];
  /**
   * Allows direct raw execution methods such as `execute` for the returned
   * client.
   *
   * @defaultValue `false`
   */
  readonly execute?: true;
}

/**
 * Input accepted by `unsafe`.
 *
 * The array shorthand disables only the named policies. The object form can
 * also grant raw execution.
 *
 * @example
 * ```ts
 * db.unsafe(['soft-delete']);
 * db.unsafe({ policies: ['scope-isolation'], execute: true });
 * ```
 */
export type UnsafePolicyInput<TPolicyName extends string = string> =
  | readonly PolicyNameInput<TPolicyName>[]
  | UnsafePolicyPermissions<TPolicyName>;

/**
 * Unsafe permission object that explicitly grants raw execution.
 *
 * This overload helper lets `db.unsafe({ execute: true })` return a client type
 * where `execute` is visible.
 */
type UnsafeExecutePermissions<TPolicyName extends string> =
  UnsafePolicyPermissions<TPolicyName> & {
    readonly execute: true;
  };

/**
 * Raw execution method keys copied back into unsafe execute scopes.
 *
 * Currently Drizzle Policy treats `execute` as the direct raw execution surface.
 */
type RawExecutionKey<TClient> = Extract<keyof TClient, 'execute'>;

/**
 * Drizzle client surface after removing or restoring raw execution methods.
 *
 * Transactions are rewritten so transaction callbacks receive the same
 * protected surface as the outer client.
 */
type PolicyClientSurface<TClient, TAllowRawExecution extends boolean> = Omit<
  {
    [TKey in keyof TClient]: TKey extends 'transaction'
      ? PolicyTransactionMethod<TClient[TKey], TAllowRawExecution>
      : TClient[TKey];
  },
  'execute'
> &
  (TAllowRawExecution extends true
    ? Pick<TClient, RawExecutionKey<TClient>>
    : {});

/**
 * Rewrites transaction callback clients to use the same protected surface.
 *
 * This keeps policies and raw-execution typing intact inside transaction
 * callbacks for both synchronous and promise-returning Drizzle transaction
 * overloads.
 */
type PolicyTransactionMethod<TMethod, TAllowRawExecution extends boolean> =
  TMethod extends <TResult>(
    callback: (
      tx: infer TTransaction,
      ...callbackArgs: infer TCallbackArgs
    ) => TResult,
    ...args: infer TArgs
  ) => TResult
    ? <TResult>(
        callback: (
          tx: PolicyClientSurface<TTransaction, TAllowRawExecution>,
          ...callbackArgs: TCallbackArgs
        ) => TResult,
        ...args: TArgs
      ) => TResult
    : TMethod extends <TResult>(
          callback: (
            tx: infer TTransaction,
            ...callbackArgs: infer TCallbackArgs
          ) => TResult,
          ...args: infer TArgs
        ) => Promise<Awaited<TResult>>
      ? <TResult>(
          callback: (
            tx: PolicyClientSurface<TTransaction, TAllowRawExecution>,
            ...callbackArgs: TCallbackArgs
          ) => TResult,
          ...args: TArgs
        ) => Promise<Awaited<TResult>>
      : TMethod extends (
            callback: (
              tx: infer TTransaction,
              ...callbackArgs: infer TCallbackArgs
            ) => infer TResult,
            ...args: infer TArgs
          ) => infer TReturn
        ? (
            callback: (
              tx: PolicyClientSurface<TTransaction, TAllowRawExecution>,
              ...callbackArgs: TCallbackArgs
            ) => TResult,
            ...args: TArgs
          ) => TReturn
        : TMethod;

/**
 * Drizzle client surface exposed outside raw-execution scopes.
 *
 * This removes direct raw execution methods such as `execute` while preserving
 * normal Drizzle query builders and transaction callbacks.
 */
export type PolicySafeClient<TClient> = PolicyClientSurface<TClient, false>;

/**
 * Drizzle client surface exposed inside `unsafe({ execute: true })`.
 *
 * This restores raw execution methods for a deliberately unsafe client while
 * keeping policy helper methods available.
 */
export type PolicyRawExecutionClient<TClient> = PolicyClientSurface<
  TClient,
  true
>;

/**
 * Whether one unsafe client should expose raw execution methods.
 */
type PolicyUnsafeAllowsRawExecution<
  TPolicyName extends string,
  TPermissions extends UnsafePolicyInput<TPolicyName>,
  TAllowRawExecution extends boolean,
> = TAllowRawExecution extends true
  ? true
  : TPermissions extends { readonly execute: true }
    ? true
    : false;

/**
 * Drizzle client exposed by one `unsafe` call.
 *
 * The returned type reflects the permissions passed to `unsafe`: disabling
 * policy names keeps raw execution hidden, while `{ execute: true }` restores
 * raw execution methods on that client.
 */
export type PolicyUnsafeClient<
  TClient,
  TContext,
  TPolicyName extends string,
  TPermissions extends UnsafePolicyInput<TPolicyName>,
  TAllowRawExecution extends boolean = false,
> = PolicyClientSurface<
  TClient,
  PolicyUnsafeAllowsRawExecution<TPolicyName, TPermissions, TAllowRawExecution>
> &
  PolicyClientHelpers<
    TContext,
    TClient,
    TPolicyName,
    PolicyUnsafeAllowsRawExecution<
      TPolicyName,
      TPermissions,
      TAllowRawExecution
    >
  >;

/**
 * Helper methods available on a wrapped Drizzle client.
 *
 * These methods are attached as non-enumerable properties so normal Drizzle
 * usage still behaves like the original client.
 */
export interface PolicyClientHelpers<
  TContext,
  TClient,
  TPolicyName extends string = string,
  TAllowRawExecution extends boolean = false,
> {
  /**
   * Runs `fn` with `ctx` available to policy hooks and returns `fn`'s result.
   *
   * Use the `db` argument inside the callback so nested calls use the same
   * policy context.
   *
   * @example
   * ```ts
   * await db.withPolicyContext({ tenantId: 'tenant_123' }, async db => {
   *   return db.query.projects.findMany();
   * });
   * ```
   */
  withPolicyContext<TResult>(
    ctx: TContext,
    fn: (
      db: PolicyClient<TClient, TContext, TPolicyName, TAllowRawExecution>
    ) => TResult
  ): TResult;
  /**
   * Returns a client with explicit unsafe permissions.
   *
   * Use this for narrow, intentional exceptions such as including
   * soft-deleted rows or running a guarded raw SQL statement.
   *
   * @example
   * ```ts
   * const maintenanceDb = db.unsafe({ execute: true });
   * await maintenanceDb.execute(sql`vacuum`);
   * ```
   */
  unsafe(
    permissions: UnsafeExecutePermissions<TPolicyName>
  ): PolicyUnsafeClient<
    TClient,
    TContext,
    TPolicyName,
    UnsafeExecutePermissions<TPolicyName>,
    TAllowRawExecution
  >;
  /**
   * Returns a client with explicit unsafe policy permissions.
   *
   * Array input is shorthand for `{ policies: [...] }`.
   *
   * @example
   * ```ts
   * const withDeletedRows = db.unsafe(['soft-delete']);
   * ```
   */
  unsafe(
    permissions: UnsafePolicyInput<TPolicyName>
  ): PolicyUnsafeClient<
    TClient,
    TContext,
    TPolicyName,
    UnsafePolicyInput<TPolicyName>,
    TAllowRawExecution
  >;
  /**
   * Runs `fn` with the named policies disabled for the current async call
   * chain.
   *
   * Use this for narrow, intentional exceptions such as an admin flow that
   * needs to include soft-deleted rows.
   *
   * @deprecated Use `unsafe({ policies: [...] })` instead.
   */
  withPoliciesDisabled<TResult>(
    policyNames: readonly PolicyNameInput<TPolicyName>[],
    fn: (
      db: PolicyClient<TClient, TContext, TPolicyName, TAllowRawExecution>
    ) => TResult
  ): TResult;
  /**
   * Returns the currently active policy context, if one exists.
   *
   * This checks an explicit `withPolicyContext` scope first, then the
   * application `getContext` reader when one was supplied.
   */
  getPolicyContext(): TContext | undefined;
}

/**
 * Drizzle client with policy helper methods attached.
 *
 * Use this type when a helper, repository, or service accepts a wrapped client
 * instead of the raw Drizzle client.
 */
export type PolicyClient<
  TClient,
  TContext,
  TPolicyName extends string = string,
  TAllowRawExecution extends boolean = false,
> = PolicyClientSurface<TClient, TAllowRawExecution> &
  PolicyClientHelpers<TContext, TClient, TPolicyName, TAllowRawExecution>;

/**
 * Adds policy helper methods to a Drizzle-like client.
 *
 * Prefer the root `createPolicyClient` export for normal Drizzle query
 * enforcement.
 *
 * This lower-level helper attaches context and unsafe-scope helpers but does
 * not install Drizzle v0/v1 query interception by itself.
 */
export function createPolicyClient<
  TClient extends object,
  TContext = unknown,
  TSchema extends MaybeSchema = undefined,
  TPolicies extends readonly unknown[] = PolicySet<TContext, TSchema>,
  TOptions extends { readonly rawExecution?: RawExecutionOption<TContext> } =
    {},
>(
  db: TClient,
  options: CreatePolicyClientOptions<TContext, TSchema, TPolicies> & TOptions
): PolicyClient<
  TClient,
  TContext,
  PolicyNames<TPolicies>,
  RawExecutionAllowedByOptions<TOptions>
> {
  const explicitContext = createPolicyContext<TContext>();
  const client = db as PolicyClient<
    TClient,
    TContext,
    PolicyNames<TPolicies>,
    RawExecutionAllowedByOptions<TOptions>
  >;
  const policyDisableScope =
    createPolicyDisableScope<
      PolicyClient<
        TClient,
        TContext,
        PolicyNames<TPolicies>,
        RawExecutionAllowedByOptions<TOptions>
      >
    >();

  const getPolicyContext = () => {
    return explicitContext.get() ?? options.getContext?.();
  };

  Object.defineProperties(client, {
    withPolicyContext: {
      configurable: true,
      enumerable: false,
      value<TResult>(
        ctx: TContext,
        fn: (
          db: PolicyClient<
            TClient,
            TContext,
            PolicyNames<TPolicies>,
            RawExecutionAllowedByOptions<TOptions>
          >
        ) => TResult
      ): TResult {
        return explicitContext.run(ctx, () => fn(client));
      },
    },
    withPoliciesDisabled: {
      configurable: true,
      enumerable: false,
      value<TResult>(
        policyNames: readonly PolicyNameInput<PolicyNames<TPolicies>>[],
        fn: (
          db: PolicyClient<
            TClient,
            TContext,
            PolicyNames<TPolicies>,
            RawExecutionAllowedByOptions<TOptions>
          >
        ) => TResult
      ): TResult {
        return policyDisableScope.withPoliciesDisabled(policyNames, client, fn);
      },
    },
    unsafe: {
      configurable: true,
      enumerable: false,
      value(
        permissions: UnsafePolicyInput<PolicyNames<TPolicies>>
      ): PolicyUnsafeClient<
        TClient,
        TContext,
        PolicyNames<TPolicies>,
        UnsafePolicyInput<PolicyNames<TPolicies>>,
        RawExecutionAllowedByOptions<TOptions>
      > {
        normalizeUnsafePermissions(permissions);

        return client as unknown as PolicyUnsafeClient<
          TClient,
          TContext,
          PolicyNames<TPolicies>,
          UnsafePolicyInput<PolicyNames<TPolicies>>,
          RawExecutionAllowedByOptions<TOptions>
        >;
      },
    },
    getPolicyContext: {
      configurable: true,
      enumerable: false,
      value: getPolicyContext,
    },
  });

  return client;
}
