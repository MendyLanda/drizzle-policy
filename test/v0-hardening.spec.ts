import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm-v0';

import { DrizzlePolicyError, definePolicies } from '../src';
import { scopeIsolationPolicy } from '../src/recipes/scope-isolation-policy';
import { createPolicyClient } from '../src/v0';
import { createV0TestEnvironment } from './fixtures/drizzle-environments';
import { createScopedV0Db } from './fixtures/v0-policy-client';
import * as schema from './fixtures/v0-schema';

describe('v0 hardening', () => {
  test('adds read policy predicates to selectDistinct builders', () => {
    const db = createScopedV0Db();

    const query = db.selectDistinct().from(schema.projects).toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.params).toContain('tenant_1');
  });

  test('adds read policy predicates to selectDistinctOn builders', () => {
    const db = createScopedV0Db();

    const query = db
      .selectDistinctOn([schema.projects.ownerId])
      .from(schema.projects)
      .toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.params).toContain('tenant_1');
  });

  test('a later where() keeps the policy predicate', () => {
    const db = createScopedV0Db();

    const builder = db.select().from(schema.projects);
    // A terminal-property read applies the policy predicate early.
    void (builder as { then?: unknown }).then;
    const query = builder.where(eq(schema.projects.id, 'p1')).toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).toContain('"projects"."id" = $2');
  });

  test('unsupported surfaces are inert to read and throw on call', () => {
    const db = createScopedV0Db();

    for (const surface of [
      'with',
      '$with',
      'refreshMaterializedView',
      '$count',
      '$client',
    ]) {
      const value = (db as unknown as Record<string, unknown>)[surface];
      expect(typeof value).toBe('function');
      expect(value as () => unknown).toThrow(DrizzlePolicyError);
    }
  });

  test('onQueryError translates a driver error from a wrapped select', async () => {
    const translated = new Error('translated');
    const db = createScopedV0Db({ onQueryError: () => translated });

    const query = db
      .select()
      .from(schema.projects) as unknown as Promise<unknown>;

    await expect(Promise.resolve(query)).rejects.toBe(translated);
  });

  test('onQueryError preserves execution-time policy context', async () => {
    type Context = { tenantId: string };

    const environment = createV0TestEnvironment();
    const policies = definePolicies<Context, typeof schema>()(() => [
      scopeIsolationPolicy<Context, typeof schema>({
        column: 'tenantId',
        getScopeValue: context => context.tenantId,
      }),
    ]);
    const { db, policyContext } = createPolicyClient(environment.db, {
      policies,
      onQueryError: error => error,
    });

    try {
      const query = policyContext.run({ tenantId: 'tenant_a' }, () =>
        (db as any)
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, 'project_1'))
      );
      const rendered = policyContext.run({ tenantId: 'tenant_b' }, () =>
        query.toSQL()
      );

      expect(rendered.params).toEqual(['tenant_b', 'project_1']);
    } finally {
      await environment.client.close();
    }
  });

  test('onQueryError translates prepared-query execution errors', async () => {
    const translated = new Error('translated');
    const db = createScopedV0Db({ onQueryError: () => translated });
    const prepared = (db as any)
      .select()
      .from(schema.projects)
      .prepare('policy_error_translation');

    await expect(prepared.execute()).rejects.toBe(translated);
  });

  test('onQueryError translates promise rejection paths', async () => {
    const translated = new Error('translated');
    const db = createScopedV0Db({ onQueryError: () => translated });
    const makeQuery = () =>
      db.select().from(schema.projects) as unknown as Promise<unknown>;

    const recovered = await makeQuery().then(undefined, error => error);
    const caught = await makeQuery().catch(error => error);
    await expect(makeQuery().then()).rejects.toBe(translated);
    await expect(makeQuery().catch(undefined)).rejects.toBe(translated);

    let finalized = false;
    await expect(
      makeQuery().finally(() => {
        finalized = true;
      })
    ).rejects.toBe(translated);

    expect(recovered).toBe(translated);
    expect(caught).toBe(translated);
    expect(finalized).toBe(true);
    expect(Object.prototype.toString.call(makeQuery())).toBe('[object Object]');
  });

  test('onQueryError preserves successful direct execution', async () => {
    const environment = createV0TestEnvironment();
    await environment.client.exec(`
      create table countries (
        code varchar(2) primary key,
        name varchar(255) not null
      )
    `);
    const { db } = createPolicyClient(environment.db, {
      policies: [],
      onQueryError: error => error,
    });

    try {
      const result = await (db as any)
        .select()
        .from(schema.countries)
        .execute();

      expect(result).toEqual([]);
    } finally {
      await environment.client.close();
    }
  });

  test('rejects invalid insert builder results', () => {
    const rawDb = {
      insert: () => ({
        values: (_values: unknown) => null,
      }),
    };
    const { db } = createPolicyClient(rawDb, { policies: [] });

    expect(() => db.insert().values({ id: 'project_1' })).toThrow(
      'Expected Drizzle insert.values() to return an object.'
    );
  });
});
