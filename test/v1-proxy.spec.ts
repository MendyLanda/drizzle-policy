import { describe, expect, test } from 'bun:test';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { definePolicies } from '../src';
import {
  createScopedV1Db,
  createScopedV1Environment,
  type AppPolicyContext,
  now,
} from './fixtures/v1-policy-client';
import { softDeletePolicy } from '../src/recipes/soft-delete-policy';
import * as schema from './fixtures/v1-schema';

describe('v1 proxy enforcement', () => {
  test('adds read policy predicates to v1 select builders', () => {
    const db = createScopedV1Db();

    const query = db.select().from(schema.projects).toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).toContain('"projects"."deleted_at" is null');
    expect(query.params).toContain('tenant_1');
  });

  test('disables one v1 read policy for one unsafe query scope', () => {
    const db = createScopedV1Db();

    const query = db
      .unsafe({ policies: ['soft-delete'] })
      .select()
      .from(schema.projects)
      .toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).not.toContain('"projects"."deleted_at" is null');
    expect(query.params).toEqual(['tenant_1']);
  });

  test('disabled v1 policies count as handled for strict no-policy fallback', () => {
    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      softDeletePolicy(),
    ]);
    const db = createScopedV1Db({
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

  test('allows unknown v1 policy names as no-op strings', () => {
    const db = createScopedV1Db();

    const query = db
      .unsafe({ policies: ['missing-policy'] })
      .select()
      .from(schema.projects)
      .toSQL();

    expect(query.sql).toContain('"projects"."tenant_id" = $1');
    expect(query.sql).toContain('"projects"."deleted_at" is null');
    expect(query.params).toEqual(['tenant_1']);
  });

  test('accepts native Drizzle conditions from custom v1 policy hooks', () => {
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

    const db = createScopedV1Db({
      policies,
    });

    const query = db.select().from(schema.projects).toSQL();

    expect(query.sql).toContain('"projects"."is_public" = $1');
    expect(query.sql).toContain('"projects"."deleted_at" is null');
    expect(query.params).toEqual([true]);
  });

  test('injects insert policy values for v1 insert builders', () => {
    const db = createScopedV1Db();

    const query = db
      .insert(schema.projects)
      .values({
        id: 'project_1',
        ownerId: 'user_1',
        name: 'Launch',
        createdAt: now,
        updatedAt: now,
      })
      .toSQL();

    expect(query.params).toContain('tenant_1');
  });

  test('rejects mismatched insert scope values for v1 insert builders', () => {
    const db = createScopedV1Db();

    expect(() =>
      db.insert(schema.projects).values({
        id: 'project_2',
        tenantId: 'tenant_2',
        ownerId: 'user_1',
        name: 'Wrong tenant',
        createdAt: now,
        updatedAt: now,
      })
    ).toThrow('Policy "scope-isolation" rejected insert.');
  });

  test('adds update policy predicates and set values to v1 update builders', () => {
    const db = createScopedV1Db();

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

  test('constrains v1 update builders even without user where clauses', () => {
    const db = createScopedV1Db();

    const query = db
      .update(schema.projects)
      .set({
        name: 'Tenant-wide rename',
      })
      .toSQL();

    expect(query.sql).toContain('where "projects"."tenant_id" = $2');
    expect(query.params).toContain('tenant_1');
  });

  test('rejects mismatched update scope values for v1 update builders', () => {
    const db = createScopedV1Db();

    expect(() =>
      db.update(schema.projects).set({
        tenantId: 'tenant_2',
      })
    ).toThrow('Policy "scope-isolation" rejected update.');
  });

  test('adds delete policy predicates to v1 delete builders', () => {
    const db = createScopedV1Db({
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

  test('constrains v1 delete builders even without user where clauses', () => {
    const db = createScopedV1Db({
      softDelete: false,
    });

    const query = db.delete(schema.projects).toSQL();

    expect(query.sql).toContain('where "projects"."tenant_id" = $1');
    expect(query.params).toEqual(['tenant_1']);
  });

  test('rejects v1 delete builders by default when soft delete policy applies', () => {
    const db = createScopedV1Db();

    expect(() => db.delete(schema.projects)).toThrow(
      'Policy "soft-delete" rejected delete.'
    );
  });

  test('converts v1 delete builders into updates when soft delete is configured', () => {
    const db = createScopedV1Db({
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

  test('throws on v1 raw execute by default', () => {
    const db = createScopedV1Db();

    expect(() => db.execute(sql`select 1`)).toThrow(
      'Raw execution through Drizzle Policy is not allowed.'
    );
  });

  test('allows v1 raw execute when rawExecution allows it', () => {
    const db = createScopedV1Db({
      rawExecution: 'allow',
    });

    expect(() => db.execute(sql`select 1`)).not.toThrow();
  });

  test('allows v1 raw execute inside an unsafe execute scope', () => {
    const db = createScopedV1Db();

    expect(() =>
      db.unsafe({ execute: true }).execute(sql`select 1`)
    ).not.toThrow();
  });

  test('adds read policy predicates to v1 relational findMany queries', () => {
    const db = createScopedV1Db();

    const query = db.query.projects.findMany().toSQL();

    expect(query.sql).toContain('"d0"."tenant_id" = $1');
    expect(query.sql).toContain('"d0"."deleted_at" is null');
    expect(query.params).toEqual(['tenant_1']);
  });

  test('adds read policy predicates to v1 relational findFirst queries', () => {
    const db = createScopedV1Db();

    const query = db.query.projects.findFirst().toSQL();

    expect(query.sql).toContain('"d0"."tenant_id" = $1');
    expect(query.sql).toContain('"d0"."deleted_at" is null');
    expect(query.params).toContain('tenant_1');
  });

  test('combines v1 relational object where clauses with read policies', () => {
    const db = createScopedV1Db();

    const query = db.query.projects
      .findMany({
        where: {
          id: 'project_1',
        },
      })
      .toSQL();

    expect(query.sql).toContain('"d0"."tenant_id" = $1');
    expect(query.sql).toContain('"d0"."deleted_at" is null');
    expect(query.sql).toContain('"d0"."id" = $2');
    expect(query.params).toEqual(['tenant_1', 'project_1']);
  });

  test('adds read policies to nested v1 relational with configs', () => {
    const db = createScopedV1Db();

    const query = db.query.projects
      .findMany({
        with: {
          tasks: true,
        },
      })
      .toSQL();

    expect(query.sql).toContain('"d0"."tenant_id" = $2');
    expect(query.sql).toContain('"d1"."tenant_id" = $1');
    expect(query.sql).toContain('"d1"."deleted_at" is null');
    expect(query.params).toEqual(['tenant_1', 'tenant_1']);
  });

  test('adds read policies to joined tables in v1 select builders', () => {
    const db = createScopedV1Db();

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

  test('wraps v1 transaction clients with the same policies', async () => {
    const { db } = createScopedV1Environment();

    await db.transaction(async tx => {
      const query = tx.select().from(schema.projects).toSQL();

      expect(query.sql).toContain('"projects"."tenant_id" = $1');
      expect(query.sql).toContain('"projects"."deleted_at" is null');
      expect(query.params).toEqual(['tenant_1']);
    });
  });

  test('keeps disabled v1 policies active for transaction clients', async () => {
    const { db } = createScopedV1Environment();

    await db.unsafe({ policies: ['soft-delete'] }).transaction(async tx => {
      const query = tx.select().from(schema.projects).toSQL();

      expect(query.sql).toContain('"projects"."tenant_id" = $1');
      expect(query.sql).not.toContain('"projects"."deleted_at" is null');
      expect(query.params).toEqual(['tenant_1']);
    });
  });
});
