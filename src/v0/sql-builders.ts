import type { MaybeSchema } from '../core/types.js';
import { combinePredicates } from './predicate.js';
import {
  evaluateInsertPolicies,
  evaluateReadPolicies,
  evaluateUpdatePolicies,
  type PolicyRuntime,
} from './policy-engine.js';
import type { ResolvedTable, TableRegistry } from './table-registry.js';

/**
 * Adds read policies to a Drizzle v0 select builder after `.from()`.
 *
 * Drizzle does not know the target table until `.from(table)` is called, so
 * policy predicates are attached to the query returned from `.from(...)`.
 */
export const wrapSelectBuilder = <TContext, TSchema extends MaybeSchema>(
  builder: object,
  runtime: PolicyRuntime<TContext, TSchema>,
  tables: TableRegistry<TSchema>
): object => {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (prop !== 'from' || typeof value !== 'function') {
        return value;
      }

      return (table: unknown, ...args: readonly unknown[]) => {
        const query = Reflect.apply(value, target, [table, ...args]);
        if (!isObject(query)) {
          throw new Error(
            'Expected Drizzle select.from() to return an object.'
          );
        }

        return wrapReadQuery(query, runtime, tables, tables.resolve(table));
      };
    },
  });
};

/**
 * Adds insert policies to a Drizzle v0 insert builder's `.values()` call.
 *
 * Policies may replace the values before Drizzle receives them, for example by
 * injecting a scope column.
 */
export const wrapInsertBuilder = <TContext, TSchema extends MaybeSchema>(
  builder: object,
  runtime: PolicyRuntime<TContext, TSchema>,
  table: ResolvedTable<TSchema>
): object => {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (prop !== 'values' || typeof value !== 'function') {
        return value;
      }

      return (values: unknown, ...args: readonly unknown[]) => {
        const plan = evaluateInsertPolicies(runtime, table, values);
        return Reflect.apply(value, target, [plan.values, ...args]);
      };
    },
  });
};

/**
 * Adds update policies to a Drizzle v0 update builder.
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
  return new Proxy(builder, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (prop !== 'set' || typeof value !== 'function') {
        return value;
      }

      return (set: unknown, ...args: readonly unknown[]) => {
        const plan = evaluateUpdatePolicies(runtime, table, set);
        const query = Reflect.apply(value, target, [plan.set, ...args]);
        if (!isObject(query)) {
          throw new Error('Expected Drizzle update.set() to return an object.');
        }

        return wrapWhereQuery(query, plan.predicates);
      };
    },
  });
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
  table: ResolvedTable<TSchema>
): object => {
  return wrapWhereQuery(
    query,
    () => {
      return evaluateReadPolicies(runtime, table).predicates;
    },
    {
      interceptCall(prop, target, args) {
        if (!isJoinMethod(prop)) {
          return undefined;
        }

        const [joinTable, joinOn, ...rest] = args;
        const plan = evaluateReadPolicies(runtime, tables.resolve(joinTable));
        const nextJoinOn = combinePredicates(...plan.predicates, joinOn);

        return {
          handled: true,
          result: callMethod(target, prop, [joinTable, nextJoinOn, ...rest]),
        };
      },
    }
  );
};

/**
 * Options for `wrapWhereQuery`.
 *
 * Used for query methods, such as joins, that need to modify arguments before
 * delegating to Drizzle.
 */
interface WhereQueryOptions {
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
  let proxy: object;

  const applyPolicies = () => {
    if (applied) {
      return;
    }

    const nextPredicates =
      typeof predicates === 'function' ? predicates() : predicates;
    const config = getConfig(query);
    config.where = combinePredicates(...nextPredicates, config.where);
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
        const intercepted = options.interceptCall?.(prop, target, args);
        if (intercepted?.handled) {
          return intercepted.result === target ? proxy : intercepted.result;
        }

        const result = Reflect.apply(value, target, args);
        return result === target ? proxy : result;
      };
    },
  });

  return proxy;
};

/**
 * Returns whether the query is about to be executed or converted to SQL.
 */
const shouldApplyBefore = (prop: string | symbol): boolean => {
  return (
    prop === 'toSQL' ||
    prop === 'getSQL' ||
    prop === 'execute' ||
    prop === 'then' ||
    prop === 'catch' ||
    prop === 'finally' ||
    prop === 'prepare' ||
    prop === '_prepare'
  );
};

/**
 * Returns whether a builder method joins another table into the query.
 */
const isJoinMethod = (prop: string | symbol): boolean => {
  return (
    prop === 'leftJoin' ||
    prop === 'rightJoin' ||
    prop === 'innerJoin' ||
    prop === 'fullJoin'
  );
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
