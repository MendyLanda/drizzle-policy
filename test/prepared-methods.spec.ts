import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle as drizzleV1 } from 'drizzle-orm/bun-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { drizzle as drizzleV0 } from 'drizzle-orm-v0/bun-sqlite';
import {
  sqliteTable as sqliteTableV0,
  text as textV0,
} from 'drizzle-orm-v0/sqlite-core';

import { createPolicyClient, definePolicies } from '../src';
import { scopeIsolationPolicy } from '../src/recipes/scope-isolation-policy';
import { createPolicyClient as createV0PolicyClient } from '../src/v0';

type AppPolicyContext = {
  tenantId: string;
};

const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().default(''),
});

const schema = { projects };

const v0Projects = sqliteTableV0('projects', {
  id: textV0('id').primaryKey(),
  tenantId: textV0('tenant_id').notNull().default(''),
});

const v0Schema = { projects: v0Projects };

test('v1 prepared read methods use the policy context active at execution', () => {
  const client = new Database(':memory:');
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const rawDb = drizzleV1({ client });
    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createPolicyClient(rawDb, {
      getContext: () => context,
      policies,
    });
    const prepared = db.select({ id: projects.id }).from(projects).prepare();

    context = { tenantId: 'tenant_2' };

    expect(prepared.all()).toEqual([{ id: 'project_2' }]);
    expect(prepared.get()).toEqual({ id: 'project_2' });
    expect(prepared.values()).toEqual([['project_2']]);
  } finally {
    client.close();
  }
});

test('v0 prepared read methods use the policy context active at execution', () => {
  const client = new Database(':memory:');
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const rawDb = drizzleV0(client);
    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createV0PolicyClient(rawDb, {
      getContext: () => context,
      policies,
    });
    const prepared = db
      .select({ id: v0Projects.id })
      .from(v0Projects)
      .prepare();

    context = { tenantId: 'tenant_2' };

    expect(prepared.all()).toEqual([{ id: 'project_2' }]);
    expect(prepared.get()).toEqual({ id: 'project_2' });
    expect(prepared.values()).toEqual([['project_2']]);
  } finally {
    client.close();
  }
});

test('v1 direct read methods apply policy predicates', () => {
  const client = new Database(':memory:');

  try {
    client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const rawDb = drizzleV1({ client });
    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createPolicyClient(rawDb, {
      getContext: () => ({ tenantId: 'tenant_2' }),
      policies,
    });

    expect(db.select({ id: projects.id }).from(projects).all()).toEqual([
      { id: 'project_2' },
    ]);
    expect(db.select({ id: projects.id }).from(projects).get()).toEqual({
      id: 'project_2',
    });
    expect(db.select({ id: projects.id }).from(projects).values()).toEqual([
      ['project_2'],
    ]);

    const query = db.select({ id: projects.id }).from(projects);
    const reflectedAll = Reflect.getOwnPropertyDescriptor(query, 'all')?.value;
    expect(typeof reflectedAll).toBe('function');
    expect((reflectedAll as () => unknown)()).toEqual([{ id: 'project_2' }]);
  } finally {
    client.close();
  }
});

test('v0 direct read methods apply policy predicates', () => {
  const client = new Database(':memory:');

  try {
    client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const rawDb = drizzleV0(client);
    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createV0PolicyClient(rawDb, {
      getContext: () => ({ tenantId: 'tenant_2' }),
      policies,
    });

    expect(db.select({ id: v0Projects.id }).from(v0Projects).all()).toEqual([
      { id: 'project_2' },
    ]);
    expect(db.select({ id: v0Projects.id }).from(v0Projects).get()).toEqual({
      id: 'project_2',
    });
    expect(db.select({ id: v0Projects.id }).from(v0Projects).values()).toEqual([
      ['project_2'],
    ]);

    const query = db.select({ id: v0Projects.id }).from(v0Projects);
    const reflectedAll = Reflect.getOwnPropertyDescriptor(query, 'all')?.value;
    expect(typeof reflectedAll).toBe('function');
    expect((reflectedAll as () => unknown)()).toEqual([{ id: 'project_2' }]);
  } finally {
    client.close();
  }
});

test('v1 direct run() applies delete policy predicates', () => {
  const client = new Database(':memory:');

  try {
    client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const rawDb = drizzleV1({ client });
    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createPolicyClient(rawDb, {
      getContext: () => ({ tenantId: 'tenant_2' }),
      policies,
    });

    db.delete(projects).run();

    expect(client.query('select id from projects order by id').all()).toEqual([
      { id: 'project_1' },
    ]);
  } finally {
    client.close();
  }
});

test('v0 direct run() applies delete policy predicates', () => {
  const client = new Database(':memory:');

  try {
    client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1'),
        ('project_2', 'tenant_2');
    `);

    const rawDb = drizzleV0(client);
    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createV0PolicyClient(rawDb, {
      getContext: () => ({ tenantId: 'tenant_2' }),
      policies,
    });

    db.delete(v0Projects).run();

    expect(client.query('select id from projects order by id').all()).toEqual([
      { id: 'project_1' },
    ]);
  } finally {
    client.close();
  }
});

test('v1 prepared run() uses the policy context active at execution', () => {
  const client = new Database(':memory:');
  let context: AppPolicyContext = { tenantId: 'tenant_1' };

  try {
    client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
    `);

    const rawDb = drizzleV1({ client });
    const policies = definePolicies<AppPolicyContext, typeof schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createPolicyClient(rawDb, {
      getContext: () => context,
      policies,
    });
    const prepared = db.insert(projects).values({ id: 'project_2' }).prepare();

    context = { tenantId: 'tenant_2' };

    prepared.run();

    expect(client.query('select tenant_id from projects').all()).toEqual([
      { tenant_id: 'tenant_2' },
    ]);
  } finally {
    client.close();
  }
});

test('v0 onQueryError translates prepared run() failures', () => {
  const client = new Database(':memory:');
  const translated = new Error('translated');

  try {
    client.exec(`
      create table projects (
        id text primary key,
        tenant_id text not null
      );
      insert into projects (id, tenant_id) values
        ('project_1', 'tenant_1');
    `);

    const rawDb = drizzleV0(client);
    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);
    const { db } = createV0PolicyClient(rawDb, {
      getContext: () => ({ tenantId: 'tenant_1' }),
      onQueryError: () => translated,
      policies,
    });
    const prepared = db
      .insert(v0Projects)
      .values({ id: 'project_1' })
      .prepare();

    expect(() => prepared.run()).toThrow(translated);
  } finally {
    client.close();
  }
});
