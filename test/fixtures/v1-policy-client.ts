import { afterAll } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';

import {
  createPolicyClient,
  definePolicies,
  type NoPolicyMatchedOption,
  type PolicySet,
  type RawExecutionOption,
} from '../../src';
import { scopeIsolationPolicy } from '../../src/recipes/scope-isolation-policy';
import { softDeletePolicy } from '../../src/recipes/soft-delete-policy';
import { createV1TestEnvironment } from './drizzle-environments';
import * as schema from './v1-schema';

export type AppPolicyContext = {
  tenantId: string;
  userId: string;
};

export type SqlQuery = {
  toSQL(): {
    sql: string;
    params: unknown[];
  };
};

export type V1SqlClient = {
  query: {
    projects: {
      findMany(config?: unknown): SqlQuery;
      findFirst(config?: unknown): SqlQuery;
    };
  };
  select(): {
    from(table: unknown): SqlQuery & {
      innerJoin(table: unknown, on: unknown): SqlQuery;
    };
  };
  insert(table: unknown): {
    values(values: unknown): SqlQuery;
  };
  update(table: unknown): {
    set(values: unknown): SqlQuery & {
      where(predicate: unknown): SqlQuery;
    };
  };
  delete(table: unknown): SqlQuery & {
    where(predicate: unknown): SqlQuery;
  };
  execute(query: unknown): unknown;
  transaction<TResult>(
    callback: (tx: V1SqlClient) => TResult
  ): Promise<Awaited<TResult>>;
  unsafe(permissions: {
    readonly policies?: readonly string[];
    readonly execute?: true;
  }): V1SqlClient;
  withPoliciesDisabled<TResult>(
    policyNames: readonly string[],
    fn: (db: V1SqlClient) => TResult
  ): TResult;
};

export type ScopedV1DbOptions = {
  readonly policies?: PolicySet<AppPolicyContext, typeof schema>;
  readonly softDelete?: false | 'throw' | 'softDelete';
  readonly onNoPolicyMatched?: NoPolicyMatchedOption<
    AppPolicyContext,
    typeof schema
  >;
  readonly rawExecution?: RawExecutionOption<AppPolicyContext>;
};

export interface ScopedV1Environment {
  readonly client: PGlite;
  readonly db: V1SqlClient;
  readonly schema: typeof schema;
}

interface SharedV1Environment {
  readonly client: PGlite;
  readonly db: object;
  readonly schema: typeof schema;
}

const appContext: AppPolicyContext = {
  tenantId: 'tenant_1',
  userId: 'user_1',
};

export const now = new Date('2026-01-02T03:04:05.000Z');

let sharedEnvironment: SharedV1Environment | undefined;

afterAll(async () => {
  await sharedEnvironment?.client.close();
  sharedEnvironment = undefined;
});

export const createScopedV1Environment = (
  options: ScopedV1DbOptions = {}
): ScopedV1Environment => {
  const environment = getSharedEnvironment();

  const policies =
    options.policies ??
    definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
        onTableWithoutScopeColumn: {
          auditLogs: 'ignore',
          countries: 'ignore',
        },
      }),
      ...(options.softDelete === false
        ? []
        : [
            softDeletePolicy({
              deleteBehavior:
                options.softDelete === 'softDelete' ? 'softDelete' : 'throw',
              deletedValue: () => now,
            }),
          ]),
    ]);

  const { db } = createPolicyClient(environment.db, {
    getContext: () => appContext,
    policies,
    onNoPolicyMatched: options.onNoPolicyMatched,
    rawExecution: options.rawExecution,
  });

  return {
    ...environment,
    db: db as unknown as V1SqlClient,
  };
};

export const createScopedV1Db = (options: ScopedV1DbOptions = {}) => {
  return createScopedV1Environment(options).db;
};

const getSharedEnvironment = (): SharedV1Environment => {
  if (!sharedEnvironment) {
    sharedEnvironment = createV1TestEnvironment();
  }

  return sharedEnvironment;
};
