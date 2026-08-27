import { describe, expect, test } from 'bun:test';
import { and, eq, isNull, sql } from 'drizzle-orm-v0';

import { DrizzlePolicyError, definePolicies } from '../src';
import {
  createScopedV0Db,
  createScopedV0Environment,
  type AppPolicyContext,
  now,
} from './fixtures/v0-policy-client';
import { softDeletePolicy } from '../src/recipes/soft-delete-policy';
import * as schema from './fixtures/v0-schema';

describe('v0 proxy enforcement', () => {
  test('adds read policy predicates to v0 select builders', () => {
    const db = createScopedV0Db();

    const query = db.select().from(schema.projects).toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).toContain('"projects"."deleted_at" is null');
    expect(query.params).toContain('tenant_1');
  });

  test('disables one v0 read policy for one unsafe query scope', () => {
    const db = createScopedV0Db();

    const query = db
      .unsafe({ policies: ['soft-delete'] })
      .select()
      .from(schema.projects)
      .toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).not.toContain('"projects"."deleted_at" is null');
    expect(query.params).toEqual(['tenant_1']);
  });

  test('disabled v0 policies count as handled for strict no-policy fallback', () => {
    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      softDeletePolicy(),
    ]);
    const db = createScopedV0Db({
      policies,
      onNoPolicyMatched: 'throw',
    });

    const query = db
      .unsafe({ policies: ['soft-delete'] })
      .select()
      .from(schema.projects)
      .toSQL();

    expect(query.sql).toContain('from "projects"');
    expect(query.sql).not.toContain('"projects"."deleted_at" is null');
    expect(query.params).toEqual([]);
  });

  test('allows unknown v0 policy names as no-op strings', () => {
    const db = createScopedV0Db();

    const query = db
      .unsafe({ policies: ['missing-policy'] })
      .select()
      .from(schema.projects)
      .toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).toContain('"projects"."deleted_at" is null');
    expect(query.params).toEqual(['tenant_1']);
  });

  test('accepts native Drizzle conditions from custom policy hooks', () => {
    const policies = definePolicies<AppPolicyContext, typeof schema>()(
      policy => [
        policy.define({
          name: 'public-project-reads',
          appliesTo: ({ tableKey }) => tableKey === 'projects',
          read: ({ table }) => {
            const projects = table as typeof schema.projects;

            return and(eq(projects.isPublic, true), isNull(projects.deletedAt));
          },
        }),
      ]
    );

    const db = createScopedV0Db({
      policies,
    });

    const query = db.select().from(schema.projects).toSQL();

    expect(query.sql).toContain('"projects"."is_public" = $1');
    expect(query.sql).toContain('"projects"."deleted_at" is null');
    expect(query.params).toEqual([true]);
  });

  test('injects insert policy values for v0 insert builders', () => {
    const db = createScopedV0Db();

    const query = db
      .insert(schema.projects)
      .values({
        id: 'project_1',
        ownerId: 'user_1',
        name: 'Launch',
      })
      .toSQL();

    expect(query.params).toContain('tenant_1');
  });

  test('rejects mismatched insert scope values for v0 insert builders', () => {
    const db = createScopedV0Db();

    expect(() =>
      db.insert(schema.projects).values({
        id: 'project_2',
        tenantId: 'tenant_2',
        ownerId: 'user_1',
        name: 'Wrong tenant',
      })
    ).toThrow('Policy "scope-isolation" rejected insert.');
  });

  test('rejects v0 conflict updates that bypass update policies', () => {
    const db = createScopedV0Db();

    expect(() =>
      (
        db.insert(schema.projects).values({
          id: 'project_1',
          ownerId: 'user_1',
          name: 'Launch',
        }) as any
      ).onConflictDoUpdate({
        target: schema.projects.id,
        set: { name: 'Changed without update policies' },
      })
    ).toThrow(DrizzlePolicyError);
  });

  test('rejects v0 insert-from-select without row policy planning', () => {
    const { db, rawDb } = createScopedV0Environment();
    const source = rawDb.select().from(schema.projects);

    expect(() => (db as any).insert(schema.projects).select(source)).toThrow(
      DrizzlePolicyError
    );
  });

  test('adds update policy predicates and set values to v0 update builders', () => {
    const db = createScopedV0Db();

    const query = db
      .update(schema.projects)
      .set({
        name: 'Renamed',
      })
      .where(eq(schema.projects.id, 'project_1'))
      .toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $2');
    expect(query.sql).toContain('"projects"."id" = $3');
    expect(query.params).toEqual(['Renamed', 'tenant_1', 'project_1']);
  });

  test('rejects v0 update sources that bypass their read policies', () => {
    const db = createScopedV0Db();

    expect(() =>
      (db.update(schema.projects).set({ name: 'Renamed' }) as any).from(
        schema.tasks
      )
    ).toThrow(DrizzlePolicyError);

    expect(() =>
      (db.update(schema.projects).set({ name: 'Renamed' }) as any).innerJoin(
        schema.tasks,
        eq(schema.tasks.projectId, schema.projects.id)
      )
    ).toThrow(DrizzlePolicyError);
  });

  test('constrains v0 update builders even without user where clauses', () => {
    const db = createScopedV0Db();

    const query = db
      .update(schema.projects)
      .set({
        name: 'Tenant-wide rename',
      })
      .toSQL();

    expect(query.sql).toContain('where "projects"."tenant_id" = $2');
    expect(query.params).toContain('tenant_1');
  });

  test('rejects mismatched update scope values for v0 update builders', () => {
    const db = createScopedV0Db();

    expect(() =>
      db.update(schema.projects).set({
        tenantId: 'tenant_2',
      })
    ).toThrow('Policy "scope-isolation" rejected update.');
  });

  test('adds delete policy predicates to v0 delete builders', () => {
    const db = createScopedV0Db({
      softDelete: false,
    });

    const query = db
      .delete(schema.projects)
      .where(eq(schema.projects.id, 'project_1'))
      .toSQL();

    expect(query.sql).toContain('delete from "projects"');
    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).toContain('"projects"."id" = $2');
    expect(query.params).toEqual(['tenant_1', 'project_1']);
  });

  test('constrains v0 delete builders even without user where clauses', () => {
    const db = createScopedV0Db({
      softDelete: false,
    });

    const query = db.delete(schema.projects).toSQL();

    expect(query.sql).toContain('where "projects"."tenant_id" = $1');
    expect(query.params).toEqual(['tenant_1']);
  });

  test('rejects v0 delete builders by default when soft delete policy applies', () => {
    const db = createScopedV0Db();

    expect(() => db.delete(schema.projects)).toThrow(
      'Policy "soft-delete" rejected delete.'
    );
  });

  test('converts v0 delete builders into updates when soft delete is configured', () => {
    const db = createScopedV0Db({
      softDelete: 'softDelete',
    });

    const query = db
      .delete(schema.projects)
      .where(eq(schema.projects.id, 'project_1'))
      .toSQL();

    expect(query.sql).toContain('update "projects" set "deleted_at" = $1');
    expect(query.sql).toContain('"projects"."tenant_id" = $2');
    expect(query.sql).toContain('"projects"."id" = $3');
    expect(query.params).toEqual([now.toISOString(), 'tenant_1', 'project_1']);
  });

  test('rejects v0 sources on soft-delete update builders', () => {
    const db = createScopedV0Db({
      softDelete: 'softDelete',
    });

    expect(() =>
      (db.delete(schema.projects) as any).from(schema.tasks)
    ).toThrow(DrizzlePolicyError);
  });

  test('throws on v0 raw execute by default', () => {
    const db = createScopedV0Db();

    expect(() => db.execute(sql`select 1`)).toThrow(
      'Raw execution through Drizzle Policy is not allowed.'
    );
  });

  test('allows v0 raw execute when rawExecution allows it', () => {
    const db = createScopedV0Db({
      rawExecution: 'allow',
    });

    expect(() => db.execute(sql`select 1`)).not.toThrow();
  });

  test('allows v0 raw execute inside an unsafe execute scope', () => {
    const db = createScopedV0Db();

    expect(() =>
      db.unsafe({ execute: true }).execute(sql`select 1`)
    ).not.toThrow();
  });

  test('adds read policy predicates to v0 relational findMany queries', () => {
    const db = createScopedV0Db();

    const query = db.query.projects.findMany().toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).toContain('"projects"."deleted_at" is null');
    expect(query.params).toEqual(['tenant_1']);
  });

  test('adds read policy predicates to v0 relational findFirst queries', () => {
    const db = createScopedV0Db();

    const query = db.query.projects.findFirst().toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).toContain('"projects"."deleted_at" is null');
    expect(query.params).toContain('tenant_1');
  });

  test('combines v0 relational callback where clauses with read policies', () => {
    const db = createScopedV0Db();

    const query = db.query.projects
      .findMany({
        where: (
          projects: typeof schema.projects,
          operators: { eq: typeof eq }
        ) => operators.eq(projects.id, 'project_1'),
      })
      .toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).toContain('"projects"."deleted_at" is null');
    expect(query.sql).toContain('"projects"."id" = $2');
    expect(query.params).toEqual(['tenant_1', 'project_1']);
  });

  test('adds read policies to nested v0 relational with configs', () => {
    const db = createScopedV0Db();

    const query = db.query.projects
      .findMany({
        with: {
          tasks: true,
        },
      })
      .toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $2');
    expect(query.sql).toContain('"projects_tasks"."tenant_id" = $1');
    expect(query.sql).toContain('"projects_tasks"."deleted_at" is null');
    expect(query.params).toEqual(['tenant_1', 'tenant_1']);
  });

  test('protects v0 relational roots and table builders', () => {
    const { db, rawDb } = createScopedV0Environment();
    const queryRoot = db.query as unknown as Record<string, unknown>;
    const reflectedProjects = Reflect.getOwnPropertyDescriptor(
      queryRoot,
      'projects'
    )?.value as any;

    const query = reflectedProjects.findMany().toSQL();
    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).toContain('"projects"."deleted_at" is null');
    expect(() =>
      Reflect.set(queryRoot, 'projects', rawDb.query.projects)
    ).toThrow(DrizzlePolicyError);
    expect(() =>
      Reflect.defineProperty(queryRoot, 'projects', {
        value: rawDb.query.projects,
      })
    ).toThrow(DrizzlePolicyError);
    expect(() => Reflect.deleteProperty(queryRoot, 'projects')).toThrow(
      DrizzlePolicyError
    );

    const builder = db.query.projects as unknown as Record<string, unknown>;
    for (const surface of ['session', 'dialect', 'table', 'tableConfig']) {
      const value = builder[surface];
      expect(typeof value).toBe('function');
      expect(value as () => unknown).toThrow(DrizzlePolicyError);
    }
  });

  test('adds read policies to joined tables in v0 select builders', () => {
    const db = createScopedV0Db();

    const query = db
      .select()
      .from(schema.projects)
      .innerJoin(schema.tasks, eq(schema.tasks.projectId, schema.projects.id))
      .toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $2');
    expect(query.sql).toContain('"tasks"."tenant_id" = $1');
    expect(query.sql).toContain('"tasks"."deleted_at" is null');
    expect(query.params).toEqual(['tenant_1', 'tenant_1']);
  });

  test('rejects unverified v0 set-operation operands', () => {
    const { db, rawDb } = createScopedV0Environment();
    const rawOperand = (rawDb as any)
      .select({ id: schema.projects.id })
      .from(schema.projects);

    expect(() =>
      (db as any)
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .union(rawOperand)
    ).toThrow(DrizzlePolicyError);
  });

  test('keeps read policies when v0 select builders become subqueries', () => {
    const db = createScopedV0Db();
    const subquery = db.select().from(schema.projects).as('scoped_projects');

    const query = db.select().from(subquery).toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).toContain('"projects"."deleted_at" is null');
    expect(query.params).toEqual(['tenant_1']);
  });

  test('rebuilds policy-created v0 subqueries after alias metadata is mutated', () => {
    const { db, rawDb } = createScopedV0Environment();
    const subquery = db.select().from(schema.projects).as('scoped_projects');
    (subquery as any)._.sql.queryChunks = (
      sql`select * from ${schema.projects}` as any
    ).queryChunks;

    const unprotectedQuery = rawDb.select().from(subquery).toSQL();
    const query = db.select().from(subquery).toSQL();

    expect(unprotectedQuery.sql).not.toContain('"projects"."tenant_id" = $1');
    expect(unprotectedQuery.sql).not.toContain(
      '"projects"."deleted_at" is null'
    );
    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).toContain('"projects"."deleted_at" is null');
    expect(query.params).toEqual(['tenant_1']);
  });

  test('accepts policy-created v0 subqueries in strict mode', () => {
    const db = createScopedV0Db({ onNoPolicyMatched: 'throw' });
    const subquery = db.select().from(schema.projects).as('scoped_projects');

    const query = db.select().from(subquery).toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).toContain('"projects"."deleted_at" is null');
    expect(query.params).toEqual(['tenant_1']);
  });

  test('rejects raw v0 subqueries by alias in strict mode', () => {
    const { db, rawDb } = createScopedV0Environment({
      onNoPolicyMatched: 'throw',
    });
    const subquery = rawDb.select().from(schema.projects).as('raw_projects');

    expect(() => db.select().from(subquery).toSQL()).toThrow(
      'No policy matched read on "raw_projects".'
    );
  });

  test('hides raw internals on protected v0 query objects', () => {
    const db = createScopedV0Db({ softDelete: false });
    const builders = [
      db.select(),
      db.insert(schema.projects),
      db.update(schema.projects),
    ];
    const queries = [
      db.select().from(schema.projects),
      db.insert(schema.projects).values({
        id: 'project_1',
        ownerId: 'user_1',
        name: 'Launch',
      }),
      db.update(schema.projects).set({ name: 'Renamed' }),
      db.delete(schema.projects),
      db.query.projects.findMany(),
      (db as any).select().from(schema.projects).prepare('protected_query'),
    ];

    for (const builder of builders) {
      for (const surface of [
        'fields',
        'session',
        'dialect',
        'withList',
        'distinct',
        'tagged',
        'builder',
        'authToken',
        'table',
        'overridingSystemValue_',
      ]) {
        const value = (builder as unknown as Record<string, unknown>)[surface];
        expect(typeof value).toBe('function');
        expect(value as () => unknown).toThrow(DrizzlePolicyError);
      }
    }

    for (const query of queries) {
      for (const surface of [
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
      ]) {
        const value = (query as unknown as Record<string, unknown>)[surface];
        expect(typeof value).toBe('function');
        expect(value as () => unknown).toThrow(DrizzlePolicyError);
      }
    }

    const prepared = queries.at(-1)!;
    for (const surface of [
      'client',
      'executor',
      'query',
      'queryString',
      'params',
      'rawQueryConfig',
      'queryConfig',
    ]) {
      const value = (prepared as unknown as Record<string, unknown>)[surface];
      expect(typeof value).toBe('function');
      expect(value as () => unknown).toThrow(DrizzlePolicyError);
    }

    expect(() => Reflect.set(prepared, 'queryString', 'select 1')).toThrow(
      DrizzlePolicyError
    );
    const preparedQueryDescriptor = Reflect.getOwnPropertyDescriptor(
      prepared,
      'query'
    );
    expect(typeof preparedQueryDescriptor?.value).toBe('function');
    expect(preparedQueryDescriptor?.value).toThrow(DrizzlePolicyError);

    const select = queries[0]! as unknown as Record<string, unknown>;
    expect(() =>
      Reflect.set(select, 'toSQL', () => ({ sql: 'select 1' }))
    ).toThrow(DrizzlePolicyError);
    expect(() => Reflect.set(select, 'config', {})).toThrow(DrizzlePolicyError);
    expect(() =>
      Reflect.defineProperty(select, 'config', { value: {} })
    ).toThrow(DrizzlePolicyError);
    expect(() => Reflect.deleteProperty(select, 'config')).toThrow(
      DrizzlePolicyError
    );
    const configDescriptor = Reflect.getOwnPropertyDescriptor(select, 'config');
    expect(typeof configDescriptor?.value).toBe('function');
    expect(configDescriptor?.value).toThrow(DrizzlePolicyError);
  });

  test('wraps v0 transaction clients with the same policies', async () => {
    const { db } = createScopedV0Environment();

    await db.transaction(async tx => {
      const query = tx.select().from(schema.projects).toSQL();

      expect(query.sql).toContain('"projects"."tenant_id" = $1');
      expect(query.sql).toContain('"projects"."deleted_at" is null');
      expect(query.params).toEqual(['tenant_1']);
    });
  });

  test('keeps disabled v0 policies active for transaction clients', async () => {
    const { db } = createScopedV0Environment();

    await db.unsafe({ policies: ['soft-delete'] }).transaction(async tx => {
      const query = tx.select().from(schema.projects).toSQL();

      expect(query.sql).toContain('"projects"."tenant_id" = $1');
      expect(query.sql).not.toContain('"projects"."deleted_at" is null');
      expect(query.params).toEqual(['tenant_1']);
    });
  });

  test('emits v0 proxy trace events for inspected calls and policy plans', () => {
    const events: unknown[] = [];
    const db = createScopedV0Db({
      trace: event => events.push(event),
    });

    db.select().from(schema.projects).toSQL();

    expect(events).toContainEqual({
      kind: 'client-call',
      method: 'select',
    });
    expect(events).toContainEqual({
      kind: 'policy-plan',
      operation: 'read',
      tableKey: 'projects',
      tableName: 'projects',
      matched: true,
      predicateCount: 2,
    });
  });
});
