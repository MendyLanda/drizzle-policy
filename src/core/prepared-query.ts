/**
 * Prepared-query methods that execute SQL immediately.
 */
const PREPARED_EXECUTION_METHODS: ReadonlySet<string> = new Set([
  'execute',
  'all',
  'get',
  'values',
  'run',
]);

/**
 * Creates a resolver that keeps PostgreSQL statement names unique per SQL
 * shape while preserving the caller's name for the first shape.
 */
export const createExecutionTimePrepareArgs = (): ((
  query: object,
  args: readonly unknown[]
) => readonly unknown[]) => {
  const namesByShape = new Map<string, string>();
  const shapesByName = new Map<string, string>();
  let unknownShapeIndex = 0;

  return (query, args) => {
    const [baseName, ...rest] = args;
    if (typeof baseName !== 'string') {
      return args;
    }

    const sql = getQuerySql(query);
    const shape = sql ?? `unknown:${unknownShapeIndex++}`;
    const existingName = namesByShape.get(shape);
    if (existingName !== undefined) {
      return [existingName, ...rest];
    }

    let name = baseName;
    if (namesByShape.size > 0) {
      const suffix = hashSqlShape(shape);
      name = `${baseName}__drizzle_policy_${suffix}`;

      let collisionIndex = 2;
      while (shapesByName.has(name) && shapesByName.get(name) !== shape) {
        name = `${baseName}__drizzle_policy_${suffix}_${collisionIndex++}`;
      }
    }

    namesByShape.set(shape, name);
    shapesByName.set(name, shape);
    return [name, ...rest];
  };
};

/**
 * Returns a prepared query whose execution is rebuilt for the active policy
 * state.
 */
export const createExecutionTimePreparedQuery = <TPrepared extends object>(
  prepared: TPrepared,
  prepareForExecution: () => object
): TPrepared => {
  return new Proxy(prepared, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof prop !== 'string' ||
        !PREPARED_EXECUTION_METHODS.has(prop) ||
        typeof value !== 'function'
      ) {
        return value;
      }

      return (...args: readonly unknown[]) => {
        const current = prepareForExecution();
        const executeMethod = Reflect.get(current, prop);
        if (typeof executeMethod !== 'function') {
          throw new Error(`Prepared query does not expose ${prop}().`);
        }

        return Reflect.apply(executeMethod, current, args);
      };
    },
  });
};

/**
 * Reads the SQL text used to distinguish prepared-statement plan shapes.
 */
const getQuerySql = (query: object): string | undefined => {
  const toSQL = Reflect.get(query, 'toSQL');
  if (typeof toSQL !== 'function') {
    return undefined;
  }

  const result = Reflect.apply(toSQL, query, []);
  return isRecord(result) && typeof result.sql === 'string'
    ? result.sql
    : undefined;
};

/**
 * Produces a short deterministic suffix for one SQL shape.
 */
const hashSqlShape = (sql: string): string => {
  let hash = 2_166_136_261;
  for (let index = 0; index < sql.length; index += 1) {
    hash = Math.imul(hash ^ sql.charCodeAt(index), 16_777_619);
  }

  return (hash >>> 0).toString(36);
};

/**
 * Narrows any non-array record.
 */
const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};
