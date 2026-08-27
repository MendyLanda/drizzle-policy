import type { MaybeSchema } from '../core/types.js';
import {
  createExecutionTimePrepareArgs,
  createExecutionTimePreparedQuery,
} from '../core/prepared-query.js';
import {
  protectQuerySurface,
  rejectQuerySurface,
} from '../core/query-surface.js';
import { combinePredicates } from './predicate.js';
import {
  evaluateInsertPolicies,
  evaluateReadPolicies,
  evaluateUpdatePolicies,
  type PolicyRuntime,
} from './policy-engine.js';
import type { ResolvedTable, TableRegistry } from './table-registry.js';

/**
 * Adds read policies to a Drizzle v1 select builder after `.from()`.
 *
 * Drizzle does not know the target table until `.from(table)` is called, so
 * policy predicates are attached to the query returned from `.from(...)`.
 */
export const wrapSelectBuilder = <TContext, TSchema extends MaybeSchema>(
  builder: object,
  runtime: PolicyRuntime<TContext, TSchema>,
  tables: TableRegistry<TSchema>
): object => {
  const proxy = new Proxy(builder, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (prop !== 'from' || typeof value !== 'function') {
        return value;
      }

      return (table: unknown, ...args: readonly unknown[]) => {
        const createQuery = (source: unknown) => {
          const query = Reflect.apply(value, target, [source, ...args]);
          if (!isObject(query)) {
            throw new Error(
              'Expected Drizzle select.from() to return an object.'
            );
          }

          return query;
        };
        const rebuild = () => {
          const source = tables.rebuildProtectedSource(table) ?? table;
          return createQuery(source);
        };

        return wrapReadQuery(
          rebuild(),
          runtime,
          tables,
          tables.resolve(table),
          rebuild
        );
      };
    },
  });

  return protectQuerySurface(proxy);
};

/**
 * Adds insert policies to a Drizzle v1 insert builder's `.values()` call.
 *
 * Policies may replace the values before Drizzle receives them, for example by
 * injecting a scope column.
 */
export const wrapInsertBuilder = <TContext, TSchema extends MaybeSchema>(
  builder: object,
  runtime: PolicyRuntime<TContext, TSchema>,
  table: ResolvedTable<TSchema>
): object => {
  const proxy = new Proxy(builder, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (prop === 'select' && typeof value === 'function') {
        return () => rejectQuerySurface('select');
      }

      if (prop !== 'values' || typeof value !== 'function') {
        return value;
      }

      return (values: unknown, ...args: readonly unknown[]) => {
        const rebuild = () => {
          const plan = evaluateInsertPolicies(runtime, table, values);
          const query = Reflect.apply(value, target, [plan.values, ...args]);
          if (!isObject(query)) {
            throw new Error(
              'Expected Drizzle insert.values() to return an object.'
            );
          }

          return query;
        };

        return protectQuerySurface(rebuild(), { rebuild });
      };
    },
  });

  return protectQuerySurface(proxy);
};

/**
 * Adds update policies to a Drizzle v1 update builder.
 *
 * Policies run when `.set(...)` is called. Returned predicates are applied
 * later, right before execution or SQL generation, so normal chaining remains
 * available.
 */
export const wrapUpdateBuilder = <TContext, TSchema extends MaybeSchema>(
  builder: object,
  runtime: PolicyRuntime<TContext, TSchema>,
  table: ResolvedTable<TSchema>
): object => {
  const proxy = new Proxy(builder, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (prop !== 'set' || typeof value !== 'function') {
        return value;
      }

      return (set: unknown, ...args: readonly unknown[]) => {
        const rebuild = (): RebuiltWhereQuery => {
          const plan = evaluateUpdatePolicies(runtime, table, set);
          const query = Reflect.apply(value, target, [plan.set, ...args]);
          if (!isObject(query)) {
            throw new Error(
              'Expected Drizzle update.set() to return an object.'
            );
          }

          return { query, predicates: plan.predicates };
        };

        const initial = rebuild();
        return wrapWhereQuery(initial.query, initial.predicates, {
          rebuild,
          rejectUpdateSources: true,
        });
      };
    },
  });

  return protectQuerySurface(proxy);
};

/**
 * Adds read policies to a query returned by `select.from()`.
 *
 * Policy predicates are added when the query is executed or converted to SQL.
 * Join predicates are applied immediately to the join condition so joined
 * tables receive their own read policies.
 */
const wrapReadQuery = <TContext, TSchema extends MaybeSchema>(
  query: object,
  runtime: PolicyRuntime<TContext, TSchema>,
  tables: TableRegistry<TSchema>,
  table: ResolvedTable<TSchema>,
  rebuildQuery?: () => object
): object => {
  const sourceIsProtected = tables.isProtectedSource(table.table);
  const crossJoinSources: unknown[] = [];
  const resolvePredicates = () => {
    const sourcePredicates = sourceIsProtected
      ? []
      : evaluateReadPolicies(runtime, table).predicates;
    const crossJoinPredicates = crossJoinSources.flatMap(source => {
      return tables.isProtectedSource(source)
        ? []
        : evaluateReadPolicies(runtime, tables.resolve(source)).predicates;
    });

    return [...sourcePredicates, ...crossJoinPredicates];
  };
  const interceptCall = (
    prop: string | symbol,
    target: object,
    args: readonly unknown[],
    rebuildSources = false
  ): { readonly handled: true; readonly result: unknown } | undefined => {
    if (prop === 'as') {
      const result = callMethod(target, prop, args);
      if (!isObject(result)) {
        throw new Error('Expected Drizzle select.as() to return an object.');
      }

      tables.markProtectedSource(result);
      return { handled: true, result };
    }

    if (isCrossJoinMethod(prop)) {
      const [joinTable, ...rest] = args;
      const nextJoinTable =
        tables.rebuildProtectedSource(joinTable) ?? joinTable;
      if (!rebuildSources) {
        crossJoinSources.push(joinTable);
      }

      return {
        handled: true,
        result: callMethod(target, prop, [nextJoinTable, ...rest]),
      };
    }

    if (!isJoinMethod(prop)) {
      return undefined;
    }

    const [joinTable, joinOn, ...rest] = args;
    const nextJoinTable = tables.rebuildProtectedSource(joinTable) ?? joinTable;
    const predicates = tables.isProtectedSource(joinTable)
      ? []
      : evaluateReadPolicies(runtime, tables.resolve(nextJoinTable)).predicates;
    const nextJoinOn = combinePredicates(...predicates, joinOn);

    return {
      handled: true,
      result: callMethod(target, prop, [nextJoinTable, nextJoinOn, ...rest]),
    };
  };

  return wrapWhereQuery(query, resolvePredicates, {
    interceptCall,
    rebuild: rebuildQuery
      ? () => ({
          query: rebuildQuery(),
          predicates: resolvePredicates(),
        })
      : undefined,
    replayRebuilt: rebuildQuery
      ? (target, prop, args) => {
          const intercepted = interceptCall(prop, target, args, true);
          return intercepted?.handled
            ? intercepted.result
            : callMethod(target, prop, args);
        }
      : undefined,
    onDerivedQuery: rebuildQuery
      ? (source, prop, rebuild) => {
          if (prop === 'as') {
            tables.markProtectedSource(source, rebuild);
          }
        }
      : undefined,
  });
};

/**
 * Options for `wrapWhereQuery`.
 *
 * Used for query methods, such as joins, that need to modify arguments before
 * delegating to Drizzle.
 */
interface WhereQueryOptions {
  /**
   * Rejects update-from and update-join methods until their reads are planned.
   */
  readonly rejectUpdateSources?: boolean;
  /**
   * Rebuilds a write query and its predicates for a prepared execution.
   */
  readonly rebuild?: () => RebuiltWhereQuery;
  /**
   * Replays a fluent call whose arguments require execution-time policies.
   */
  readonly replayRebuilt?: (
    query: object,
    prop: string | symbol,
    args: readonly unknown[]
  ) => unknown;
  /**
   * Records a derived source and its execution-time rebuild recipe.
   */
  readonly onDerivedQuery?: (
    query: object,
    prop: string | symbol,
    rebuild: () => object
  ) => void;
  /**
   * Optional handler for query methods that need policy predicates before the
   * original method runs.
   */
  readonly interceptCall?: (
    prop: string | symbol,
    target: object,
    args: readonly unknown[]
  ) => { readonly handled: true; readonly result: unknown } | undefined;
}

/**
 * Fresh write query and the policy predicates produced for the same context.
 */
interface RebuiltWhereQuery {
  /** Query rebuilt from the write builder. */
  readonly query: object;
  /** Policy predicates evaluated with the same runtime state. */
  readonly predicates: readonly unknown[];
}

/**
 * Adds policy predicates to a query before execution or SQL generation.
 *
 * Normal Drizzle chaining still works before the query is finalized.
 * Policy predicates are applied only once even if multiple terminal methods are
 * read.
 */
export const wrapWhereQuery = (
  query: object,
  predicates: readonly unknown[] | (() => readonly unknown[]),
  options: WhereQueryOptions = {}
): object => {
  let applied = false;
  let hasUserWhere = false;
  let userWhere: unknown;
  let proxy: object;

  const resolvePredicates = () => {
    return typeof predicates === 'function' ? predicates() : predicates;
  };

  const resolveUserWhere = (config: Record<string, unknown>): unknown => {
    if (!hasUserWhere) {
      userWhere = config.where;
      hasUserWhere = true;
    }

    return userWhere;
  };

  const applyPolicies = () => {
    if (applied) {
      return;
    }

    const config = getConfig(query);
    config.where = combinePredicates(
      ...resolvePredicates(),
      resolveUserWhere(config)
    );
    applied = true;
  };

  proxy = new Proxy(query, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (shouldApplyBefore(prop)) {
        applyPolicies();
      }

      if (typeof value !== 'function') {
        return value;
      }

      return (...args: readonly unknown[]) => {
        if (options.rejectUpdateSources) {
          rejectUnsupportedUpdateCall(prop);
        }

        if (prop === 'prepare' || prop === '_prepare') {
          const resolvePrepareArgs = createExecutionTimePrepareArgs();
          const prepareForExecution = () => {
            const config = getConfig(query);
            const previousWhere = config.where;
            config.where = combinePredicates(
              ...resolvePredicates(),
              resolveUserWhere(config)
            );

            try {
              const prepared = Reflect.apply(
                value,
                target,
                resolvePrepareArgs(query, args)
              );
              if (!isObject(prepared)) {
                throw new Error(
                  'Expected Drizzle prepare() to return an object.'
                );
              }

              return prepared;
            } finally {
              config.where = previousWhere;
            }
          };

          return createExecutionTimePreparedQuery(
            prepareForExecution(),
            prepareForExecution
          );
        }

        const intercepted = options.interceptCall?.(prop, target, args);
        if (intercepted?.handled) {
          return intercepted.result === target ? proxy : intercepted.result;
        }

        const result = Reflect.apply(value, target, args);
        if (prop === 'where') {
          const config = getConfig(query);
          userWhere = config.where;
          hasUserWhere = true;
          applied = false;
        }

        return result === target ? proxy : result;
      };
    },
  });

  let rebuiltPredicates: readonly unknown[] = [];
  const rebuild = options.rebuild
    ? () => {
        const rebuilt = options.rebuild!();
        rebuiltPredicates = rebuilt.predicates;
        return rebuilt.query;
      }
    : undefined;

  return protectQuerySurface(proxy, {
    rebuild,
    finalizeRebuilt: rebuild
      ? rebuilt => {
          const config = getConfig(rebuilt);
          config.where = combinePredicates(...rebuiltPredicates, config.where);
        }
      : undefined,
    replayRebuilt: options.replayRebuilt,
    onDerivedQuery: options.onDerivedQuery,
  });
};

/**
 * Returns whether the query is about to be executed or converted to SQL.
 */
const shouldApplyBefore = (prop: string | symbol): boolean => {
  return (
    prop === 'toSQL' ||
    prop === 'getSQL' ||
    prop === 'execute' ||
    prop === 'all' ||
    prop === 'get' ||
    prop === 'values' ||
    prop === 'run' ||
    prop === 'then' ||
    prop === 'catch' ||
    prop === 'finally' ||
    prop === 'as'
  );
};

/**
 * Returns whether a builder method joins another table into the query.
 */
const isJoinMethod = (prop: string | symbol): boolean => {
  return (
    prop === 'leftJoin' ||
    prop === 'leftJoinLateral' ||
    prop === 'rightJoin' ||
    prop === 'innerJoin' ||
    prop === 'innerJoinLateral' ||
    prop === 'fullJoin'
  );
};

/**
 * Returns whether a builder method adds a cross-joined source.
 */
const isCrossJoinMethod = (prop: string | symbol): boolean => {
  return prop === 'crossJoin' || prop === 'crossJoinLateral';
};

/**
 * Rejects update sources whose read policies cannot yet be planned safely.
 */
const rejectUnsupportedUpdateCall = (prop: string | symbol): undefined => {
  if (prop === 'from' || isJoinMethod(prop) || isCrossJoinMethod(prop)) {
    rejectQuerySurface(String(prop));
  }

  return undefined;
};

/**
 * Calls a Drizzle query method.
 */
const callMethod = (
  target: object,
  prop: string | symbol,
  args: readonly unknown[]
): unknown => {
  const value = Reflect.get(target, prop);
  if (typeof value !== 'function') {
    throw new Error(`Expected Drizzle builder method ${String(prop)}().`);
  }

  return Reflect.apply(value, target, args);
};

/**
 * Reads the query configuration object used by Drizzle.
 */
const getConfig = (value: object): Record<string, unknown> => {
  if (
    !('config' in value) ||
    typeof value.config !== 'object' ||
    value.config === null
  ) {
    throw new Error('Unable to inspect Drizzle query builder config.');
  }

  return value.config as Record<string, unknown>;
};

/**
 * Narrows any non-null object.
 */
const isObject = (value: unknown): value is object => {
  return typeof value === 'object' && value !== null;
};
