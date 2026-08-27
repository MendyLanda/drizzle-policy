import { expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { eq as eqV0 } from 'drizzle-orm-v0';
import { drizzle as drizzleNodePgV0 } from 'drizzle-orm-v0/node-postgres';

import { createPolicyClient, definePolicies } from '../src';
import { scopeIsolationPolicy } from '../src/recipes/scope-isolation-policy';
import { softDeletePolicy } from '../src/recipes/soft-delete-policy';
import { createPolicyClient as createV0PolicyClient } from '../src/v0';
import {
  createV0TestEnvironment,
  createV1TestEnvironment,
} from './fixtures/drizzle-environments';
import * as v0Schema from './fixtures/v0-schema';
import * as schema from './fixtures/v1-schema';

type AppPolicyContext = {
  tenantId: string;
};

test('a v1 prepared read uses the policy context active at execution', async () => {
  const environment = createV1TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null,
        owner_id text,
        name text,
        is_public boolean,
        deleted_at timestamp,
        created_at timestamp,
        updated_at timestamp,
        created_by_id text,
        updated_by_id text
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createPolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any)
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .prepare('projects_by_policy_context');

    await expect(prepared.execute()).resolves.toEqual([{ id: 'project_1' }]);

    context = { tenantId: 'tenant_2' };

    await expect(prepared.execute()).resolves.toEqual([{ id: 'project_2' }]);
  } finally {
    await environment.client.close();
  }
});

test('a v0 prepared read uses the policy context active at execution', async () => {
  const environment = createV0TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null,
        owner_id text,
        name text,
        is_public boolean,
        deleted_at timestamp,
        created_at timestamp,
        updated_at timestamp,
        created_by_id text,
        updated_by_id text
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createV0PolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any)
      .select({ id: v0Schema.projects.id })
      .from(v0Schema.projects)
      .prepare('projects_by_policy_context');

    await expect(prepared.execute()).resolves.toEqual([{ id: 'project_1' }]);

    context = { tenantId: 'tenant_2' };

    await expect(prepared.execute()).resolves.toEqual([{ id: 'project_2' }]);
  } finally {
    await environment.client.close();
  }
});

test('a v1 prepared join uses the policy context active at execution', async () => {
  const environment = createV1TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      create table tasks (
        id text primary key,
        tenant_id text not null,
        project_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
      insert into tasks (id, tenant_id, project_id) values
        ('task_1', 'tenant_1', 'project_1'),
        ('task_2', 'tenant_2', 'project_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createPolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any)
      .select({ projectId: schema.projects.id, taskId: schema.tasks.id })
      .from(schema.projects)
      .innerJoin(schema.tasks, eq(schema.projects.id, schema.tasks.projectId))
      .prepare('joined_projects_by_policy_context');

    context = { tenantId: 'tenant_2' };

    await expect(prepared.execute()).resolves.toEqual([
      { projectId: 'project_2', taskId: 'task_2' },
    ]);
  } finally {
    await environment.client.close();
  }
});

test('a v0 prepared join uses the policy context active at execution', async () => {
  const environment = createV0TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      create table tasks (
        id text primary key,
        tenant_id text not null,
        project_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
      insert into tasks (id, tenant_id, project_id) values
        ('task_1', 'tenant_1', 'project_1'),
        ('task_2', 'tenant_2', 'project_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createV0PolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any)
      .select({ projectId: v0Schema.projects.id, taskId: v0Schema.tasks.id })
      .from(v0Schema.projects)
      .innerJoin(
        v0Schema.tasks,
        eqV0(v0Schema.projects.id, v0Schema.tasks.projectId)
      )
      .prepare('joined_projects_by_policy_context');

    context = { tenantId: 'tenant_2' };

    await expect(prepared.execute()).resolves.toEqual([
      { projectId: 'project_2', taskId: 'task_2' },
    ]);
  } finally {
    await environment.client.close();
  }
});

test('a v1 prepared aliased subquery uses the policy context active at execution', async () => {
  const environment = createV1TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createPolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const scopedProjects = (db as any)
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .as('scoped_projects');
    const prepared = (db as any)
      .select({ id: scopedProjects.id })
      .from(scopedProjects)
      .prepare('aliased_projects_by_policy_context');

    context = { tenantId: 'tenant_2' };

    await expect(prepared.execute()).resolves.toEqual([{ id: 'project_2' }]);
  } finally {
    await environment.client.close();
  }
});

test('a v0 prepared aliased subquery uses the policy context active at execution', async () => {
  const environment = createV0TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createV0PolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const scopedProjects = (db as any)
      .select({ id: v0Schema.projects.id })
      .from(v0Schema.projects)
      .as('scoped_projects');
    const prepared = (db as any)
      .select({ id: scopedProjects.id })
      .from(scopedProjects)
      .prepare('aliased_projects_by_policy_context');

    context = { tenantId: 'tenant_2' };

    await expect(prepared.execute()).resolves.toEqual([{ id: 'project_2' }]);
  } finally {
    await environment.client.close();
  }
});

test('a v1 prepared cross join enforces the active policy context', async () => {
  const environment = createV1TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      create table tasks (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
      insert into tasks (id, tenant_id) values
        ('task_1', 'tenant_1'),
        ('task_2', 'tenant_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createPolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any)
      .select({ projectId: schema.projects.id, taskId: schema.tasks.id })
      .from(schema.projects)
      .crossJoin(schema.tasks)
      .prepare('cross_joined_projects_by_policy_context');

    context = { tenantId: 'tenant_2' };

    await expect(prepared.execute()).resolves.toEqual([
      { projectId: 'project_2', taskId: 'task_2' },
    ]);
  } finally {
    await environment.client.close();
  }
});

test('a v0 prepared cross join enforces the active policy context', async () => {
  const environment = createV0TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      create table tasks (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
      insert into tasks (id, tenant_id) values
        ('task_1', 'tenant_1'),
        ('task_2', 'tenant_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createV0PolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any)
      .select({ projectId: v0Schema.projects.id, taskId: v0Schema.tasks.id })
      .from(v0Schema.projects)
      .crossJoin(v0Schema.tasks)
      .prepare('cross_joined_projects_by_policy_context');

    context = { tenantId: 'tenant_2' };

    await expect(prepared.execute()).resolves.toEqual([
      { projectId: 'project_2', taskId: 'task_2' },
    ]);
  } finally {
    await environment.client.close();
  }
});

test('a v1 prepared insert uses the policy context active at execution', async () => {
  const environment = createV1TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null,
        owner_id text,
        name text,
        is_public boolean,
        deleted_at timestamp,
        created_at timestamp,
        updated_at timestamp,
        created_by_id text,
        updated_by_id text
      );
    `);

    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createPolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any)
      .insert(schema.projects)
      .values({ id: 'project_2' })
      .returning({ tenantId: schema.projects.tenantId })
      .prepare('insert_project_by_policy_context');

    context = { tenantId: 'tenant_2' };

    const inserted = await prepared.execute();

    expect(inserted).toEqual([{ tenantId: 'tenant_2' }]);
  } finally {
    await environment.client.close();
  }
});

test('a v0 prepared insert uses the policy context active at execution', async () => {
  const environment = createV0TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null,
        owner_id text,
        name text,
        is_public boolean,
        deleted_at timestamp,
        created_at timestamp,
        updated_at timestamp,
        created_by_id text,
        updated_by_id text
      );
    `);

    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createV0PolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any)
      .insert(v0Schema.projects)
      .values({ id: 'project_2' })
      .returning({ tenantId: v0Schema.projects.tenantId })
      .prepare('insert_project_by_policy_context');

    context = { tenantId: 'tenant_2' };

    const inserted = await prepared.execute();

    expect(inserted).toEqual([{ tenantId: 'tenant_2' }]);
  } finally {
    await environment.client.close();
  }
});

test('a v1 prepared update uses the policy context active at execution', async () => {
  const environment = createV1TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null,
        owner_id text,
        name text,
        is_public boolean,
        deleted_at timestamp,
        created_at timestamp,
        updated_at timestamp,
        created_by_id text,
        updated_by_id text
      );
      insert into projects (id, tenant_id, name) values
        ('project_1', 'tenant_1', 'Project 1'),
        ('project_2', 'tenant_2', 'Project 2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createPolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any)
      .update(schema.projects)
      .set({ name: 'Renamed' })
      .returning({ id: schema.projects.id })
      .prepare('update_project_by_policy_context');

    context = { tenantId: 'tenant_2' };

    const updated = await prepared.execute();

    expect(updated).toEqual([{ id: 'project_2' }]);
  } finally {
    await environment.client.close();
  }
});

test('a v0 prepared update uses the policy context active at execution', async () => {
  const environment = createV0TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null,
        owner_id text,
        name text,
        is_public boolean,
        deleted_at timestamp,
        created_at timestamp,
        updated_at timestamp,
        created_by_id text,
        updated_by_id text
      );
      insert into projects (id, tenant_id, name) values
        ('project_1', 'tenant_1', 'Project 1'),
        ('project_2', 'tenant_2', 'Project 2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createV0PolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any)
      .update(v0Schema.projects)
      .set({ name: 'Renamed' })
      .returning({ id: v0Schema.projects.id })
      .prepare('update_project_by_policy_context');

    context = { tenantId: 'tenant_2' };

    const updated = await prepared.execute();

    expect(updated).toEqual([{ id: 'project_2' }]);
  } finally {
    await environment.client.close();
  }
});

test('a v1 prepared delete uses the policy context active at execution', async () => {
  const environment = createV1TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null,
        owner_id text,
        name text,
        is_public boolean,
        deleted_at timestamp,
        created_at timestamp,
        updated_at timestamp,
        created_by_id text,
        updated_by_id text
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createPolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any)
      .delete(schema.projects)
      .returning({ id: schema.projects.id })
      .prepare('delete_project_by_policy_context');

    context = { tenantId: 'tenant_2' };

    const deleted = await prepared.execute();

    expect(deleted).toEqual([{ id: 'project_2' }]);
  } finally {
    await environment.client.close();
  }
});

test('a v0 prepared delete uses the policy context active at execution', async () => {
  const environment = createV0TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null,
        owner_id text,
        name text,
        is_public boolean,
        deleted_at timestamp,
        created_at timestamp,
        updated_at timestamp,
        created_by_id text,
        updated_by_id text
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createV0PolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any)
      .delete(v0Schema.projects)
      .returning({ id: v0Schema.projects.id })
      .prepare('delete_project_by_policy_context');

    context = { tenantId: 'tenant_2' };

    const deleted = await prepared.execute();

    expect(deleted).toEqual([{ id: 'project_2' }]);
  } finally {
    await environment.client.close();
  }
});

test('a v1 prepared read uses policy-disable state active at execution', async () => {
  const environment = createV1TestEnvironment();

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createPolicyClient(environment.db, {
      getContext: () => ({ tenantId: 'tenant_1' }),
      policies,
    });
    const prepared = (db as any)
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .prepare('projects_by_policy_disable_state');

    await expect(prepared.execute()).resolves.toEqual([{ id: 'project_1' }]);
    await expect(
      (db as any).withPoliciesDisabled(['scope-isolation'], () =>
        prepared.execute()
      )
    ).resolves.toEqual([{ id: 'project_1' }, { id: 'project_2' }]);
    await expect(prepared.execute()).resolves.toEqual([{ id: 'project_1' }]);
  } finally {
    await environment.client.close();
  }
});

test('a v0 prepared read uses policy-disable state active at execution', async () => {
  const environment = createV0TestEnvironment();

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createV0PolicyClient(environment.db, {
      getContext: () => ({ tenantId: 'tenant_1' }),
      policies,
    });
    const prepared = (db as any)
      .select({ id: v0Schema.projects.id })
      .from(v0Schema.projects)
      .prepare('projects_by_policy_disable_state');

    await expect(prepared.execute()).resolves.toEqual([{ id: 'project_1' }]);
    await expect(
      (db as any).withPoliciesDisabled(['scope-isolation'], () =>
        prepared.execute()
      )
    ).resolves.toEqual([{ id: 'project_1' }, { id: 'project_2' }]);
    await expect(prepared.execute()).resolves.toEqual([{ id: 'project_1' }]);
  } finally {
    await environment.client.close();
  }
});

test('a v1 prepared delete can switch between soft and hard delete at execution', async () => {
  const environment = createV1TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null,
        deleted_at timestamp
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
      softDeletePolicy<typeof schema>({
        deleteBehavior: 'softDelete',
        deletedValue: () => new Date('2024-01-01T00:00:00.000Z'),
      }),
    ]);
    const { db } = createPolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any)
      .delete(schema.projects)
      .returning({ id: schema.projects.id })
      .prepare('delete_project_by_active_policy_state');

    context = { tenantId: 'tenant_2' };
    await expect(prepared.execute()).resolves.toEqual([{ id: 'project_2' }]);

    context = { tenantId: 'tenant_1' };
    await expect(
      (db as any).withPoliciesDisabled(['soft-delete'], () =>
        prepared.execute()
      )
    ).resolves.toEqual([{ id: 'project_1' }]);

    const remaining = await (environment.db as any)
      .select({
        id: schema.projects.id,
        deletedAt: schema.projects.deletedAt,
      })
      .from(schema.projects);

    expect(remaining).toEqual([
      { id: 'project_2', deletedAt: new Date('2024-01-01T00:00:00.000Z') },
    ]);
  } finally {
    await environment.client.close();
  }
});

test('a v0 prepared delete can switch between soft and hard delete at execution', async () => {
  const environment = createV0TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null,
        deleted_at timestamp
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
      softDeletePolicy<typeof v0Schema>({
        deleteBehavior: 'softDelete',
        deletedValue: () => new Date('2024-01-01T00:00:00.000Z'),
      }),
    ]);
    const { db } = createV0PolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any)
      .delete(v0Schema.projects)
      .returning({ id: v0Schema.projects.id })
      .prepare('delete_project_by_active_policy_state');

    context = { tenantId: 'tenant_2' };
    await expect(prepared.execute()).resolves.toEqual([{ id: 'project_2' }]);

    context = { tenantId: 'tenant_1' };
    await expect(
      (db as any).withPoliciesDisabled(['soft-delete'], () =>
        prepared.execute()
      )
    ).resolves.toEqual([{ id: 'project_1' }]);

    const remaining = await (environment.db as any)
      .select({
        id: v0Schema.projects.id,
        deletedAt: v0Schema.projects.deletedAt,
      })
      .from(v0Schema.projects);

    expect(remaining).toEqual([
      { id: 'project_2', deletedAt: new Date('2024-01-01T00:00:00.000Z') },
    ]);
  } finally {
    await environment.client.close();
  }
});

test('a v1 relational prepared read uses the policy context active at execution', async () => {
  const environment = createV1TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createPolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any).query.projects
      .findMany({ columns: { id: true } })
      .prepare('relational_projects_by_policy_context');

    context = { tenantId: 'tenant_2' };

    await expect(prepared.execute()).resolves.toEqual([{ id: 'project_2' }]);
  } finally {
    await environment.client.close();
  }
});

test('a v0 relational prepared read uses the policy context active at execution', async () => {
  const environment = createV0TestEnvironment();
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    await environment.client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createV0PolicyClient(environment.db, {
      getContext: () => context,
      policies,
    });
    const prepared = (db as any).query.projects
      .findMany({ columns: { id: true } })
      .prepare('relational_projects_by_policy_context');

    context = { tenantId: 'tenant_2' };

    await expect(prepared.execute()).resolves.toEqual([{ id: 'project_2' }]);
  } finally {
    await environment.client.close();
  }
});

test('a named prepared query can change SQL shape with active policy state', async () => {
  const statements = new Map<string, string>();
  const client = {
    async query(config: { name?: string; text: string }) {
      if (config.name) {
        const previousSql = statements.get(config.name);
        if (previousSql !== undefined && previousSql !== config.text) {
          throw new Error(
            `Prepared statement ${config.name} was reused with different SQL.`
          );
        }

        statements.set(config.name, config.text);
      }

      return { rows: [] };
    },
  };
  const rawDb = drizzleNodePg({ client: client as any });
  const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
    scopeIsolationPolicy<AppPolicyContext, typeof schema>({
      column: 'tenantId',
      getScopeValue: ctx => ctx.tenantId,
    }),
  ]);
  const { db } = createPolicyClient(rawDb, {
    getContext: () => ({ tenantId: 'tenant_1' }),
    policies,
  });
  const prepared = db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .prepare('projects_by_active_policy_shape');

  await prepared.execute();
  await (db as any).withPoliciesDisabled(['scope-isolation'], () =>
    prepared.execute()
  );

  expect(statements.size).toBe(2);
});

test('a v0 named prepared query can change SQL shape with active policy state', async () => {
  const statements = new Map<string, string>();
  const client = {
    async query(config: { name?: string; text: string }) {
      if (config.name) {
        const previousSql = statements.get(config.name);
        if (previousSql !== undefined && previousSql !== config.text) {
          throw new Error(
            `Prepared statement ${config.name} was reused with different SQL.`
          );
        }

        statements.set(config.name, config.text);
      }

      return { rows: [] };
    },
  };
  const rawDb = drizzleNodePgV0(client as any);
  const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
    scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
      column: 'tenantId',
      getScopeValue: ctx => ctx.tenantId,
    }),
  ]);
  const { db } = createV0PolicyClient(rawDb, {
    getContext: () => ({ tenantId: 'tenant_1' }),
    policies,
  });
  const prepared = db
    .select({ id: v0Schema.projects.id })
    .from(v0Schema.projects)
    .prepare('projects_by_active_policy_shape');

  await prepared.execute();
  await (db as any).withPoliciesDisabled(['scope-isolation'], () =>
    prepared.execute()
  );

  expect(statements.size).toBe(2);
});
