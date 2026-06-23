import { createPolicyContext } from '../core/context.js';
import {
  createPolicyDisableScope,
  normalizeUnsafePermissions,
} from '../core/policy-disable.js';
import type {
  CreatePolicyClientOptions,
  CreatePolicyClientResult,
  PolicyClient,
  PolicyClientHelpers,
  PolicyContextFromPolicies,
  PolicySchemaFromPolicies,
  PolicyUnsafeClient,
  RawExecutionAllowedByOptions,
  RawExecutionOption,
  UnsafePolicyInput,
} from '../core/client.js';
import type {
  MaybeSchema,
  PolicyContext,
  PolicyNameInput,
  PolicyNames,
  PolicySet,
} from '../core/types.js';
import {
  enforceRawExecution,
  evaluateDeletePolicies,
} from './policy-engine.js';
import { wrapRelationalQueryRoot } from './relational.js';
import { createTableRegistry } from './table-registry.js';
import { emitTrace, type V1PolicyTraceSink } from './trace.js';
import {
  wrapInsertBuilder,
  wrapSelectBuilder,
  wrapUpdateBuilder,
  wrapWhereQuery,
} from './sql-builders.js';

/**
 * Options for wrapping a Drizzle v1 client with policies.
 *
 * These extend the shared policy-client options with v1 trace support. The
 * root `drizzle-policy` import uses this wrapper.
 *
 * @example
 * ```ts
 * const { db, policyContext } = createPolicyClient(rawDb, {
 *   policies,
 *   onNoPolicyMatched: 'throw',
 *   trace: event => console.debug(event),
 * });
 * ```
 */
export interface CreateV1PolicyClientOptions<
  TContext,
  TSchema extends MaybeSchema,
  TPolicies extends readonly unknown[] = PolicySet<TContext, TSchema>,
> extends CreatePolicyClientOptions<TContext, TSchema, TPolicies> {
  /**
   * Optional callback for policy trace events.
   *
   * Use this while configuring policies to see which client calls are checked
   * and which policy decisions are made.
   *
   * @defaultValue `undefined`
   */
  readonly trace?: V1PolicyTraceSink;
}

/**
 * Options used when a transaction client inherits policy state.
 *
 * Internal wrapper calls use this shape so transactions and unsafe clients keep
 * the same context, disabled-policy names, and raw-execution allowance as the
 * outer client.
 */
interface InternalV1PolicyClientOptions<
  TContext,
  TSchema extends MaybeSchema,
  TPolicies extends readonly unknown[] = PolicySet<TContext, TSchema>,
> extends CreateV1PolicyClientOptions<TContext, TSchema, TPolicies> {
  /**
   * Async-local policy context used by public `policyContext` bundles.
   *
   * @defaultValue a new context store is created when omitted.
   */
  readonly policyContext?: PolicyContext<TContext>;
  /**
   * Policy names already disabled by an outer policy scope.
   *
   * @defaultValue an empty set.
   */
  readonly getDisabledPolicyNames?: () => ReadonlySet<string>;
  /**
   * Whether raw execution is allowed by an outer unsafe scope.
   *
   * @defaultValue `false`.
   */
  readonly isRawExecutionAllowed?: () => boolean;
}

/**
 * Wraps a Drizzle v1 client so supported queries enforce policies.
 *
 * The returned object includes the wrapped Drizzle client and, unless an
 * external context reader is supplied, a generated async-local policy context.
 *
 * Supported v1 surfaces include fluent select/insert/update/delete builders,
 * `db.query.*.findMany/findFirst` relational queries, nested relational
 * `with` entries when their table can be resolved, transactions, and direct
 * raw execution checks for `execute`.
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
export function createPolicyClient<
  TClient extends object,
  TPolicies extends readonly unknown[],
  TSchema extends MaybeSchema = PolicySchemaFromPolicies<TPolicies>,
  TContext = PolicyContextFromPolicies<TPolicies>,
  TOptions extends CreateV1PolicyClientOptions<TContext, TSchema, TPolicies> =
    CreateV1PolicyClientOptions<TContext, TSchema, TPolicies>,
>(
  db: TClient,
  options: TOptions & CreateV1PolicyClientOptions<TContext, TSchema, TPolicies>
): CreatePolicyClientResult<
  TClient,
  TContext,
  PolicyNames<TPolicies>,
  RawExecutionAllowedByOptions<TOptions>,
  TOptions
> {
  const policyContext = createPolicyContext<TContext>();
  const policyDb = createPolicyClientCore(db, {
    ...options,
    policyContext,
  } as InternalV1PolicyClientOptions<TContext, TSchema, TPolicies> & TOptions);

  return (
    typeof options.getContext === 'function'
      ? { db: policyDb }
      : { db: policyDb, policyContext }
  ) as CreatePolicyClientResult<
    TClient,
    TContext,
    PolicyNames<TPolicies>,
    RawExecutionAllowedByOptions<TOptions>,
    TOptions
  >;
}

/**
 * Creates the protected Drizzle client used by public bundles and nested scopes.
 *
 * This internal helper returns the proxied client directly. Public callers
 * should use `createPolicyClient`, which also returns `policyContext` when it
 * owns context storage.
 */
function createPolicyClientCore<
  TClient extends object,
  TContext = unknown,
  TSchema extends MaybeSchema = undefined,
  TPolicies extends readonly unknown[] = PolicySet<TContext, TSchema>,
  TOptions extends { readonly rawExecution?: RawExecutionOption<TContext> } =
    {},
>(
  db: TClient,
  options: InternalV1PolicyClientOptions<TContext, TSchema, TPolicies> &
    TOptions
): PolicyClient<
  TClient,
  TContext,
  PolicyNames<TPolicies>,
  RawExecutionAllowedByOptions<TOptions>
> {
  const internalOptions = options as InternalV1PolicyClientOptions<
    TContext,
    TSchema,
    TPolicies
  >;
  const explicitContext =
    internalOptions.policyContext ?? createPolicyContext<TContext>();
  const tables = createTableRegistry<TSchema>(getQueryRoot(db));
  const policyDisableScope = createPolicyDisableScope<
    PolicyClient<
      TClient,
      TContext,
      PolicyNames<TPolicies>,
      RawExecutionAllowedByOptions<TOptions>
    >
  >(
    internalOptions.getDisabledPolicyNames,
    internalOptions.isRawExecutionAllowed
  );

  const getPolicyContext = () => {
    return explicitContext.get() ?? options.getContext?.();
  };

  const runtime = {
    options: options as CreatePolicyClientOptions<TContext, TSchema>,
    trace: options.trace,
    getContext: getPolicyContext,
    getDisabledPolicyNames: policyDisableScope.getDisabledPolicyNames,
    isRawExecutionAllowed: policyDisableScope.isRawExecutionAllowed,
  };

  let proxy: PolicyClient<
    TClient,
    TContext,
    PolicyNames<TPolicies>,
    RawExecutionAllowedByOptions<TOptions>
  >;

  const helpers: PolicyClientHelpers<
    TContext,
    TClient,
    PolicyNames<TPolicies>,
    RawExecutionAllowedByOptions<TOptions>
  > = {
    withPolicyContext<TResult>(
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
      return explicitContext.run(ctx, () => fn(proxy));
    },
    unsafe(
      permissions: UnsafePolicyInput<PolicyNames<TPolicies>>
    ): PolicyUnsafeClient<
      TClient,
      TContext,
      PolicyNames<TPolicies>,
      UnsafePolicyInput<PolicyNames<TPolicies>>,
      RawExecutionAllowedByOptions<TOptions>
    > {
      const normalized = normalizeUnsafePermissions(permissions);

      const getDisabledPolicyNames = (): ReadonlySet<string> => {
        const inheritedPolicyNames =
          policyDisableScope.getDisabledPolicyNames();

        return normalized.policyNames.length === 0
          ? inheritedPolicyNames
          : new Set([...inheritedPolicyNames, ...normalized.policyNames]);
      };

      const isRawExecutionAllowed = (): boolean => {
        return policyDisableScope.isRawExecutionAllowed() || normalized.execute;
      };

      return createPolicyClientCore(db, {
        ...runtime.options,
        trace: runtime.trace,
        getContext: getPolicyContext,
        getDisabledPolicyNames,
        isRawExecutionAllowed,
      } as InternalV1PolicyClientOptions<
        TContext,
        TSchema,
        TPolicies
      >) as unknown as PolicyUnsafeClient<
        TClient,
        TContext,
        PolicyNames<TPolicies>,
        UnsafePolicyInput<PolicyNames<TPolicies>>,
        RawExecutionAllowedByOptions<TOptions>
      >;
    },
    withPoliciesDisabled<TResult>(
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
      return policyDisableScope.withPoliciesDisabled(policyNames, proxy, () =>
        fn(proxy)
      );
    },
    getPolicyContext,
  };

  proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'withPolicyContext') {
        return helpers.withPolicyContext;
      }

      if (prop === 'getPolicyContext') {
        return helpers.getPolicyContext;
      }

      if (prop === 'unsafe') {
        return helpers.unsafe;
      }

      if (prop === 'withPoliciesDisabled') {
        return helpers.withPoliciesDisabled;
      }

      const value = Reflect.get(target, prop, receiver);

      if (prop === 'query' && assertMaybeObject(value)) {
        return wrapRelationalQueryRoot(value, runtime, tables);
      }

      if (prop === 'execute' && typeof value === 'function') {
        return (...args: readonly unknown[]) => {
          emitClientCall(runtime.trace, 'execute');
          enforceRawExecution(runtime, 'execute', args);
          return Reflect.apply(value, target, args);
        };
      }

      if (prop === 'transaction' && typeof value === 'function') {
        return (callback: unknown, ...args: readonly unknown[]) => {
          emitClientCall(runtime.trace, 'transaction');
          if (typeof callback !== 'function') {
            return Reflect.apply(value, target, [callback, ...args]);
          }

          const wrappedCallback = (
            tx: unknown,
            ...callbackArgs: readonly unknown[]
          ) => {
            const policyTx = createPolicyClientCore(assertObject(tx), {
              ...runtime.options,
              getContext: getPolicyContext,
              getDisabledPolicyNames: policyDisableScope.getDisabledPolicyNames,
              isRawExecutionAllowed: policyDisableScope.isRawExecutionAllowed,
            } as InternalV1PolicyClientOptions<TContext, TSchema, TPolicies>);

            return Reflect.apply(callback, undefined, [
              policyTx,
              ...callbackArgs,
            ]);
          };

          return Reflect.apply(value, target, [wrappedCallback, ...args]);
        };
      }

      if (isSelectMethod(prop) && typeof value === 'function') {
        return (...args: readonly unknown[]) => {
          emitClientCall(runtime.trace, String(prop));
          const builder = Reflect.apply(value, target, args);
          return wrapSelectBuilder(builder, runtime, tables);
        };
      }

      if (prop === 'insert' && typeof value === 'function') {
        return (table: unknown, ...args: readonly unknown[]) => {
          emitClientCall(runtime.trace, 'insert');
          const builder = Reflect.apply(value, target, [table, ...args]);
          return wrapInsertBuilder(builder, runtime, tables.resolve(table));
        };
      }

      if (prop === 'update' && typeof value === 'function') {
        return (table: unknown, ...args: readonly unknown[]) => {
          emitClientCall(runtime.trace, 'update');
          const builder = Reflect.apply(value, target, [table, ...args]);
          return wrapUpdateBuilder(builder, runtime, tables.resolve(table));
        };
      }

      if (prop === 'delete' && typeof value === 'function') {
        return (table: unknown, ...args: readonly unknown[]) => {
          emitClientCall(runtime.trace, 'delete');
          const resolved = tables.resolve(table);
          const plan = evaluateDeletePolicies(runtime, resolved);

          if (plan.updateSet) {
            const updateBuilder = createUpdateBuilder(target, table);
            const updateQuery = callBuilderMethod(updateBuilder, 'set', [
              plan.updateSet,
            ]);

            return wrapWhereQuery(updateQuery, plan.predicates);
          }

          const builder = Reflect.apply(value, target, [table, ...args]);
          return wrapWhereQuery(assertObject(builder), plan.predicates);
        };
      }

      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PolicyClient<
    TClient,
    TContext,
    PolicyNames<TPolicies>,
    RawExecutionAllowedByOptions<TOptions>
  >;

  return proxy;
}

/**
 * Returns `db.query` when the Drizzle client exposes relational queries.
 *
 * Drizzle clients without relational query builders still support fluent
 * builders through the other proxy branches.
 */
const getQueryRoot = (db: object): object | undefined => {
  const query = Reflect.get(db, 'query');
  return assertMaybeObject(query) ? query : undefined;
};

/**
 * Sends a trace event for a top-level Drizzle client method.
 *
 * This helps users verify that a call went through the wrapped client rather
 * than a raw client reference.
 */
const emitClientCall = (
  trace: V1PolicyTraceSink | undefined,
  method: string
): void => {
  emitTrace(trace, {
    kind: 'client-call',
    method,
  });
};

/**
 * Returns whether a client method starts a select query.
 *
 * Drizzle v1 exposes both `select` and `selectDistinct`; both receive read
 * policy predicates after `.from(...)`.
 */
const isSelectMethod = (prop: string | symbol): boolean => {
  return prop === 'select' || prop === 'selectDistinct';
};

/**
 * Creates the update query used when a delete policy returns
 * `{ action: 'update', set }`.
 */
const createUpdateBuilder = (target: object, table: unknown): object => {
  const update = Reflect.get(target, 'update');
  if (typeof update !== 'function') {
    throw new Error('Drizzle client does not expose update().');
  }

  return assertObject(Reflect.apply(update, target, [table]));
};

/**
 * Calls a Drizzle query method that should return another query object.
 */
const callBuilderMethod = (
  target: object,
  method: string,
  args: readonly unknown[]
): object => {
  const value = Reflect.get(target, method);
  if (typeof value !== 'function') {
    throw new Error(`Drizzle builder does not expose ${method}().`);
  }

  return assertObject(Reflect.apply(value, target, args));
};

/**
 * Asserts that a Drizzle query method returned an object.
 */
const assertObject = (value: unknown): object => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected Drizzle builder method to return an object.');
  }

  return value;
};

/**
 * Returns whether a value is an object.
 */
const assertMaybeObject = (value: unknown): value is object => {
  return typeof value === 'object' && value !== null;
};
