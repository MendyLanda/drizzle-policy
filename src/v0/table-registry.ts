import { getTableName } from 'drizzle-orm';

import type { MaybeSchema, TableKey, SchemaTable } from '../core/types.js';

/**
 * Table details used when applying policies.
 *
 * The registry resolves both the schema export key used by callbacks and the
 * SQL table name used in errors and trace events.
 */
export interface ResolvedTable<TSchema extends MaybeSchema = MaybeSchema> {
  /**
   * Key of the table in your Drizzle schema object or `db.query` root.
   *
   * Example: `projectMembers`.
   */
  readonly tableKey: TableKey<TSchema>;
  /**
   * SQL-facing table name reported by Drizzle.
   *
   * Example: `project_members`.
   */
  readonly tableName: string;
  /**
   * Drizzle table export for the operation.
   */
  readonly table: SchemaTable<TSchema>;
}

/**
 * Resolves the table details for a Drizzle query.
 *
 * Wrappers call this before evaluating policies so hooks and trace events have
 * consistent table identity.
 */
export interface TableRegistry<TSchema extends MaybeSchema = MaybeSchema> {
  /**
   * Resolves table details, optionally using a schema or `db.query` key as a
   * hint.
   *
   * The hint is used for relational queries, where the property name often
   * carries the schema export key.
   */
  resolve(table: unknown, tableKeyHint?: string): ResolvedTable<TSchema>;
}

/**
 * Creates a table resolver from Drizzle's relational query root.
 *
 * Passing `db.query` improves table names and schema keys in policy callbacks.
 *
 * When a table cannot be found in the query root, Drizzle Policy falls back to
 * Drizzle's SQL table name or the provided hint.
 */
export const createTableRegistry = <TSchema extends MaybeSchema>(
  queryRoot?: object
): TableRegistry<TSchema> => {
  const tablesByName = new Map<string, ResolvedTable<TSchema>>();
  const tablesByValue = new WeakMap<object, ResolvedTable<TSchema>>();

  if (queryRoot) {
    for (const [tableKey, builder] of Object.entries(queryRoot)) {
      const table = getBuilderTable(builder);
      if (!table) {
        continue;
      }

      const tableName = tryGetTableName(table);
      if (!tableName) {
        continue;
      }

      const resolved: ResolvedTable<TSchema> = {
        tableKey: tableKey as TableKey<TSchema>,
        tableName,
        table: table as SchemaTable<TSchema>,
      };

      tablesByName.set(tableKey, resolved);
      tablesByName.set(tableName, resolved);

      const uniqueName = getUniqueTableName(table, tableName);
      tablesByName.set(uniqueName, resolved);
      tablesByValue.set(table, resolved);
    }
  }

  return {
    resolve(table, tableKeyHint) {
      if (tableKeyHint) {
        const resolved = tablesByName.get(tableKeyHint);
        if (resolved) {
          return resolved;
        }
      }

      if (typeof table === 'object' && table !== null) {
        const resolved = tablesByValue.get(table);
        if (resolved) {
          return resolved;
        }
      }

      const tableName = tryGetTableName(table) ?? tableKeyHint ?? 'unknown';

      return {
        tableKey: (tableKeyHint ?? tableName) as TableKey<TSchema>,
        tableName,
        table: table as SchemaTable<TSchema>,
      };
    },
  };
};

/**
 * Reads a table object from a Drizzle v0 relational builder.
 */
const getBuilderTable = (builder: unknown): object | undefined => {
  if (!isRecord(builder)) {
    return undefined;
  }

  if (typeof builder.table === 'object' && builder.table !== null) {
    return builder.table;
  }

  const tableConfig = builder.tableConfig;
  if (
    isRecord(tableConfig) &&
    typeof tableConfig.table === 'object' &&
    tableConfig.table !== null
  ) {
    return tableConfig.table;
  }

  return undefined;
};

/**
 * Reads a table's SQL name when Drizzle can provide it.
 */
const tryGetTableName = (value: unknown): string | undefined => {
  try {
    return getTableName(value as never);
  } catch {
    return undefined;
  }
};

/**
 * Builds a schema-qualified table name for tables with the same SQL name.
 */
const getUniqueTableName = (table: object, tableName: string): string => {
  const schema = Reflect.get(table, Symbol.for('drizzle:Schema'));
  return `${typeof schema === 'string' ? schema : 'public'}.${tableName}`;
};

/**
 * Narrows any non-array record.
 */
const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};
