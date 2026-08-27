import { DrizzlePolicyError } from './types.js';
import {
  createExecutionTimePrepareArgs,
  createExecutionTimePreparedQuery,
} from './prepared-query.js';

/**
 * Query properties that expose mutable planning state or raw driver handles.
 */
const UNSUPPORTED_QUERY_SURFACES: ReadonlySet<string> = new Set([
  '_',
  'config',
  'session',
  'dialect',
  'cacheConfig',
  'joinsNotNullableMap',
  'tableName',
  'isPartialSelect',
  'usedTables',
  'schema',
  'fullSchema',
  'tableNamesMap',
  'table',
  'tableConfig',
  'mode',
  'parseJson',
  'authToken',
  'fields',
  'withList',
  'distinct',
  'tagged',
  'builder',
  'overridingSystemValue_',
  'client',
  'baseClient',
  'batchClient',
  'batchCLient',
  'clientQuery',
  'executeMethod',
  'executor',
  'httpClient',
  'pool',
  'prisma',
  'rawQuery',
  'stmt',
  'transaction',
  'tx',
  '_iterator',
  'union',
  'unionAll',
  'intersect',
  'intersectAll',
  'except',
  'exceptAll',
  'createJoin',
  'createSetOperator',
  'addSetOperators',
  'onConflictDoUpdate',
  'onDuplicateKeyUpdate',
]);

/**
 * Mutable execution state carried by prepared queries.
 */
const UNSUPPORTED_PREPARED_QUERY_SURFACES: ReadonlySet<string> = new Set([
  'query',
  'queryString',
  'params',
  'rawQueryConfig',
  'queryConfig',
  'mapper',
  'mode',
  'logger',
  'cache',
  'queryMetadata',
  'cacheConfig',
  'fastPath',
  'fields',
  'customResultMapper',
  'joinsNotNullableMap',
  'authToken',
]);

/**
 * Replaces a reflected property value without changing its visibility.
 */
export const maskPropertyDescriptor = (
  descriptor: PropertyDescriptor,
  value: unknown
): PropertyDescriptor => {
  return {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    writable: false,
    value,
  };
};

/**
 * Optional recipe for rebuilding a policy-planned query.
 */
export interface QuerySurfaceOptions {
  /**
   * Creates the query again using the policy state active at call time.
   */
  readonly rebuild?: () => object;
  /**
   * Applies policy state that depends on the completed fluent query.
   */
  readonly finalizeRebuilt?: (query: object) => void;
  /**
   * Replays one fluent call when policy planning must transform its arguments.
   */
  readonly replayRebuilt?: (
    query: object,
    prop: string | symbol,
    args: readonly unknown[]
  ) => unknown;
  /**
   * Records a derived query together with its execution-time rebuild recipe.
   */
  readonly onDerivedQuery?: (
    query: object,
    prop: string | symbol,
    rebuild: () => object
  ) => void;
}

/**
 * Protects one policy-planned query from leaking mutable config or a driver.
 *
 * Fluent methods that return the original query retain the proxy. Prepared
 * queries receive the same protection because they often carry driver handles
 * of their own.
 */
export const protectQuerySurface = <TQuery extends object>(
  query: TQuery,
  options: QuerySurfaceOptions = {}
): TQuery => {
  return protectQuerySurfaceInternal(query, false, options);
};

/**
 * Builds a query proxy and optionally hides prepared-query execution state.
 */
const protectQuerySurfaceInternal = <TQuery extends object>(
  query: TQuery,
  isPrepared: boolean,
  options: QuerySurfaceOptions = {}
): TQuery => {
  let proxy: TQuery;
  let rebuildQuery = options.rebuild;

  proxy = new Proxy(query, {
    get(target, prop, receiver) {
      if (isUnsupportedQuerySurface(prop, isPrepared)) {
        return () => rejectQuerySurface(String(prop));
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }

      return (...args: readonly unknown[]) => {
        if ((prop === 'prepare' || prop === '_prepare') && rebuildQuery) {
          const rebuildAtPrepare = rebuildQuery;
          const resolvePrepareArgs = createExecutionTimePrepareArgs();
          const prepareForExecution = () => {
            const rebuilt = rebuildAtPrepare();
            options.finalizeRebuilt?.(rebuilt);
            const prepare = Reflect.get(rebuilt, prop);
            if (typeof prepare !== 'function') {
              throw new Error('Rebuilt query does not expose prepare().');
            }

            const result = Reflect.apply(
              prepare,
              rebuilt,
              resolvePrepareArgs(rebuilt, args)
            );
            if (!isObject(result)) {
              throw new Error(
                'Expected Drizzle prepare() to return an object.'
              );
            }

            return result;
          };

          return protectQuerySurfaceInternal(
            createExecutionTimePreparedQuery(
              prepareForExecution(),
              prepareForExecution
            ),
            true
          );
        }

        const result = Reflect.apply(value, target, args);
        if (result === target) {
          if (rebuildQuery) {
            const rebuildPrevious = rebuildQuery;
            rebuildQuery = () => {
              const rebuilt = rebuildPrevious();
              const replayed = options.replayRebuilt
                ? options.replayRebuilt(rebuilt, prop, args)
                : replayQueryMethod(rebuilt, prop, args);
              return isObject(replayed) ? replayed : rebuilt;
            };
          }

          return proxy;
        }

        if (isObject(result) && rebuildQuery && options.onDerivedQuery) {
          const rebuildBeforeDerived = rebuildQuery;
          const rebuildDerived = () => {
            const rebuilt = rebuildBeforeDerived();
            options.finalizeRebuilt?.(rebuilt);
            const replayed = options.replayRebuilt
              ? options.replayRebuilt(rebuilt, prop, args)
              : replayQueryMethod(rebuilt, prop, args);
            if (!isObject(replayed)) {
              throw new Error(
                `Expected rebuilt ${String(prop)}() to return an object.`
              );
            }

            options.onDerivedQuery?.(replayed, prop, rebuildDerived);
            return replayed;
          };

          options.onDerivedQuery(result, prop, rebuildDerived);
        }

        return (prop === 'prepare' || prop === '_prepare') && isObject(result)
          ? protectQuerySurfaceInternal(result, true)
          : result;
      };
    },
    getOwnPropertyDescriptor(target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      return descriptor &&
        (isUnsupportedQuerySurface(prop, isPrepared) ||
          typeof descriptor.value === 'function')
        ? maskPropertyDescriptor(descriptor, Reflect.get(proxy, prop))
        : descriptor;
    },
    set(_target, prop) {
      return rejectQuerySurface(String(prop));
    },
    defineProperty(_target, prop) {
      return rejectQuerySurface(String(prop));
    },
    deleteProperty(_target, prop) {
      return rejectQuerySurface(String(prop));
    },
  });

  return proxy;
};

/**
 * Replays one ordinary fluent query method on a rebuilt query.
 */
const replayQueryMethod = (
  query: object,
  prop: string | symbol,
  args: readonly unknown[]
): unknown => {
  const method = Reflect.get(query, prop);
  if (typeof method !== 'function') {
    throw new Error(`Rebuilt query does not expose ${String(prop)}().`);
  }

  return Reflect.apply(method, query, args);
};

/**
 * Returns whether a property exposes mutable query state or a raw driver.
 */
const isUnsupportedQuerySurface = (
  prop: string | symbol,
  isPrepared: boolean
): boolean => {
  return (
    typeof prop === 'string' &&
    (UNSUPPORTED_QUERY_SURFACES.has(prop) ||
      (isPrepared && UNSUPPORTED_PREPARED_QUERY_SURFACES.has(prop)))
  );
};

/**
 * Throws the stable error used for blocked query internals.
 */
export const rejectQuerySurface = (prop: string): never => {
  throw new DrizzlePolicyError(
    `Drizzle Policy does not expose query surface "${prop}".`
  );
};

/**
 * Narrows any non-null object.
 */
const isObject = (value: unknown): value is object => {
  return typeof value === 'object' && value !== null;
};
