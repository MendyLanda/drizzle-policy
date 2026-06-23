import type { MaybeSchema, SchemaTable } from '../core/types.js';
import { combinePredicates } from './predicate.js';
import { evaluateReadPolicies, type PolicyRuntime } from './policy-engine.js';
import type { ResolvedTable, TableRegistry } from './table-registry.js';

/**
 * Drizzle v1 relational `where` object shape.
 */
type RelationalWhere = Record<string, unknown>;

/**
 * Adds read policies to Drizzle v1 relational queries.
 *
 * `findMany`, `findFirst`, and nested `with` relations receive the applicable
 * read predicates.
 *
 * The wrapper preserves the original query API while decorating config objects
 * passed into relational queries.
 */
export const wrapRelationalQueryRoot = <TContext, TSchema extends MaybeSchema>(
  queryRoot: object,
  runtime: PolicyRuntime<TContext, TSchema>,
  tables: TableRegistry<TSchema>
): object => {
  return new Proxy(queryRoot, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (!isObject(value) || typeof prop !== 'string') {
        return value;
      }

      return wrapRelationalTableBuilder(
        value,
        prop,
        queryRoot,
        runtime,
        tables
      );
    },
  });
};

/**
 * Adds read policies to one table-specific relational query builder.
 *
 * The table key is taken from the `db.query` property name whenever possible so
 * callbacks receive schema export names instead of only SQL table names.
 */
const wrapRelationalTableBuilder = <TContext, TSchema extends MaybeSchema>(
  builder: object,
  tableKey: string,
  queryRoot: object,
  runtime: PolicyRuntime<TContext, TSchema>,
  tables: TableRegistry<TSchema>
): object => {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (
        typeof value !== 'function' ||
        (prop !== 'findMany' && prop !== 'findFirst')
      ) {
        return value;
      }

      return (config?: unknown, ...args: readonly unknown[]) => {
        const table = getBuilderTable(target);
        const resolved = tables.resolve(table, tableKey);
        const nextConfig = decorateRelationalConfig(
          config,
          resolved,
          target,
          queryRoot,
          runtime,
          tables
        );

        return Reflect.apply(value, target, [nextConfig, ...args]);
      };
    },
  });
};

/**
 * Returns a relational config with policy predicates added.
 *
 * Existing user `where` config is preserved and combined with the policy
 * predicate using `AND`.
 */
const decorateRelationalConfig = <TContext, TSchema extends MaybeSchema>(
  config: unknown,
  table: ResolvedTable<TSchema>,
  builder: object,
  queryRoot: object,
  runtime: PolicyRuntime<TContext, TSchema>,
  tables: TableRegistry<TSchema>
): Record<string, unknown> => {
  const source = isRecord(config) ? config : {};
  const next: Record<string, unknown> = {
    ...source,
    where: createPolicyWhere(runtime, table, source.where),
  };

  const withConfig = decorateWithConfig(
    source.with,
    builder,
    queryRoot,
    runtime,
    tables
  );

  if (withConfig !== undefined) {
    next.with = withConfig;
  }

  return next;
};

/**
 * Creates a Drizzle v1 relational filter that combines policy predicates with
 * the original filter.
 *
 * The `RAW` callback receives the table alias from Drizzle, so policy
 * predicates target the aliased table used by the relational query.
 */
const createPolicyWhere = <TContext, TSchema extends MaybeSchema>(
  runtime: PolicyRuntime<TContext, TSchema>,
  table: ResolvedTable<TSchema>,
  originalWhere: unknown
): RelationalWhere => {
  const policyWhere = {
    RAW: (tableArg: unknown) => {
      const plan = evaluateReadPolicies(runtime, {
        ...table,
        table: tableArg as SchemaTable<TSchema>,
      });

      return combinePredicates(...plan.predicates);
    },
  };

  return isRecord(originalWhere)
    ? {
        AND: [policyWhere, originalWhere],
      }
    : policyWhere;
};

/**
 * Adds read policies to nested relational `with` entries when their tables can
 * be identified.
 *
 * If a relation target cannot be resolved, the original nested config is
 * preserved rather than guessed.
 */
const decorateWithConfig = <TContext, TSchema extends MaybeSchema>(
  withConfig: unknown,
  builder: object,
  queryRoot: object,
  runtime: PolicyRuntime<TContext, TSchema>,
  tables: TableRegistry<TSchema>
): unknown => {
  if (!isRecord(withConfig)) {
    return withConfig;
  }

  const relations = getBuilderRelations(builder);
  const next: Record<string, unknown> = {};

  for (const [relationKey, relationConfig] of Object.entries(withConfig)) {
    const relation = relations[relationKey];
    const relatedTable = getRelationTable(relation);
    if (!relatedTable) {
      next[relationKey] = relationConfig;
      continue;
    }

    const related = tables.resolve(relatedTable, getRelationTableKey(relation));
    const relatedBuilder = getRelatedBuilder(queryRoot, related);
    if (!relatedBuilder) {
      next[relationKey] = relationConfig;
      continue;
    }

    next[relationKey] = decorateRelationalConfig(
      relationConfig === true ? {} : relationConfig,
      related,
      relatedBuilder,
      queryRoot,
      runtime,
      tables
    );
  }

  return next;
};

/**
 * Reads the table object from a relational table builder.
 */
const getBuilderTable = (builder: object): unknown => {
  return 'table' in builder ? builder.table : undefined;
};

/**
 * Reads relation metadata from a relational table builder.
 */
const getBuilderRelations = (builder: object): Record<string, unknown> => {
  if (!('tableConfig' in builder) || !isRecord(builder.tableConfig)) {
    return {};
  }

  return isRecord(builder.tableConfig.relations)
    ? builder.tableConfig.relations
    : {};
};

/**
 * Reads the referenced table from a Drizzle v1 relation object.
 */
const getRelationTable = (relation: unknown): unknown => {
  return isRecord(relation) && 'targetTable' in relation
    ? relation.targetTable
    : undefined;
};

/**
 * Reads the schema/query-root key of a Drizzle v1 relation target.
 */
const getRelationTableKey = (relation: unknown): string | undefined => {
  return isRecord(relation) && typeof relation.targetTableName === 'string'
    ? relation.targetTableName
    : undefined;
};

/**
 * Finds the relational builder for a resolved related table.
 */
const getRelatedBuilder = <TSchema extends MaybeSchema>(
  queryRoot: object,
  table: ResolvedTable<TSchema>
): object | undefined => {
  const builder = Reflect.get(queryRoot, table.tableKey);
  return isObject(builder) ? builder : undefined;
};

/**
 * Narrows any non-null object.
 */
const isObject = (value: unknown): value is object => {
  return typeof value === 'object' && value !== null;
};

/**
 * Narrows any non-array record.
 */
const isRecord = (value: unknown): value is Record<string, unknown> => {
  return isObject(value) && !Array.isArray(value);
};
