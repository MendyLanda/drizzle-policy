import { afterAll, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm-v0';

import { definePolicies } from '../src';
import { scopeIsolationPolicy } from '../src/recipes/scope-isolation-policy';
import { createPolicyClient } from '../src/v0';
import { createV0TestEnvironment } from './fixtures/drizzle-environments';
import * as schema from './fixtures/v0-schema';

type AppPolicyContext = {
  tenantId: string;
  userId: string;
};

type V0SqlClient = {
  delete(table: unknown): {
    where(predicate: unknown): {
      toSQL(): {
        sql: string;
        params: unknown[];
      };
    };
  };
};

interface SharedV0Environment {
  readonly client: PGlite;
  readonly db: object;
  readonly schema: typeof schema;
}

const now = new Date('2026-01-02T03:04:05.000Z');
let sharedEnvironment: SharedV0Environment | undefined;

afterAll(async () => {
  await sharedEnvironment?.client.close();
  sharedEnvironment = undefined;
});

const createDb = () => {
  const environment = getSharedEnvironment();

  const policies = definePolicies<AppPolicyContext, typeof schema>()(policy => [
    scopeIsolationPolicy<AppPolicyContext, typeof schema>({
      column: 'tenantId',
      getScopeValue: ctx => ctx.tenantId,
      onTableWithoutScopeColumn: {
        auditLogs: 'ignore',
        countries: 'ignore',
      },
    }),
    policy.define({
      name: 'archive-delete',
      onMissingContext: 'throw',
      appliesTo: ({ tableKey }) => tableKey === 'projects',
      delete: ({ ctx }) => ({
        action: 'update',
        set: {
          deletedAt: now,
          updatedById: ctx.userId,
        },
      }),
    }),
  ]);

  const { db } = createPolicyClient(environment.db, {
    getContext: () => ({
      tenantId: 'tenant_1',
      userId: 'user_1',
    }),
    policies,
  });

  return db as unknown as V0SqlClient;
};

const getSharedEnvironment = (): SharedV0Environment => {
  if (!sharedEnvironment) {
    sharedEnvironment = createV0TestEnvironment();
  }

  return sharedEnvironment;
};

describe('v0 custom delete actions', () => {
  test('lets custom policies convert deletes into updates', () => {
    const db = createDb();

    const query = db
      .delete(schema.projects)
      .where(eq(schema.projects.id, 'project_1'))
      .toSQL();

    expect(query.sql).toContain(
      'update "projects" set "deleted_at" = $1, "updated_by_id" = $2'
    );
    expect(query.sql).toContain('"projects"."tenant_id" = $3');
    expect(query.sql).toContain('"projects"."id" = $4');
    expect(query.params).toEqual([
      now.toISOString(),
      'user_1',
      'tenant_1',
      'project_1',
    ]);
  });
});
