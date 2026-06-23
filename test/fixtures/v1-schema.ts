import { defineRelations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
});

export const users = pgTable('users', {
  id: varchar('id', { length: 64 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 64 })
    .notNull()
    .references(() => tenants.id),
  email: varchar('email', { length: 255 }).notNull(),
  role: varchar('role', { length: 32 }).notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const countries = pgTable('countries', {
  code: varchar('code', { length: 2 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
});

export const projects = pgTable(
  'projects',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    tenantId: varchar('tenant_id', { length: 64 })
      .notNull()
      .references(() => tenants.id),
    ownerId: varchar('owner_id', { length: 64 })
      .notNull()
      .references(() => users.id),
    name: varchar('name', { length: 255 }).notNull(),
    isPublic: boolean('is_public').notNull().default(false),
    deletedAt: timestamp('deleted_at'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
    createdById: varchar('created_by_id', { length: 64 }).references(
      () => users.id
    ),
    updatedById: varchar('updated_by_id', { length: 64 }).references(
      () => users.id
    ),
  },
  table => [
    index('projects_tenant_idx').on(table.tenantId),
    index('projects_owner_idx').on(table.ownerId),
  ]
);

export const tasks = pgTable(
  'tasks',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    tenantId: varchar('tenant_id', { length: 64 })
      .notNull()
      .references(() => tenants.id),
    projectId: varchar('project_id', { length: 64 })
      .notNull()
      .references(() => projects.id),
    title: varchar('title', { length: 255 }).notNull(),
    priority: integer('priority').notNull().default(0),
    deletedAt: timestamp('deleted_at'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  table => [
    index('tasks_tenant_idx').on(table.tenantId),
    index('tasks_project_idx').on(table.projectId),
  ]
);

export const projectMembers = pgTable(
  'project_members',
  {
    tenantId: varchar('tenant_id', { length: 64 })
      .notNull()
      .references(() => tenants.id),
    projectId: varchar('project_id', { length: 64 })
      .notNull()
      .references(() => projects.id),
    userId: varchar('user_id', { length: 64 })
      .notNull()
      .references(() => users.id),
    role: varchar('role', { length: 32 }).notNull(),
  },
  table => [
    primaryKey({
      columns: [table.projectId, table.userId],
    }),
  ]
);

export const apiKeys = pgTable('api_keys', {
  id: varchar('id', { length: 64 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 64 })
    .notNull()
    .references(() => tenants.id),
  name: varchar('name', { length: 255 }).notNull(),
  secretHash: text('secret_hash').notNull(),
  deletedAt: timestamp('deleted_at'),
});

export const auditLogs = pgTable('audit_logs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  actorId: varchar('actor_id', { length: 64 }).references(() => users.id),
  action: varchar('action', { length: 255 }).notNull(),
  payload: text('payload').notNull(),
  createdAt: timestamp('created_at').notNull(),
});

export const tableRelations = defineRelations(
  {
    tenants,
    users,
    countries,
    projects,
    tasks,
    projectMembers,
    apiKeys,
    auditLogs,
  },
  r => ({
    tenants: {
      users: r.many.users({
        from: r.tenants.id,
        to: r.users.tenantId,
      }),
      projects: r.many.projects({
        from: r.tenants.id,
        to: r.projects.tenantId,
      }),
      apiKeys: r.many.apiKeys({
        from: r.tenants.id,
        to: r.apiKeys.tenantId,
      }),
    },
    users: {
      tenant: r.one.tenants({
        from: r.users.tenantId,
        to: r.tenants.id,
      }),
      ownedProjects: r.many.projects({
        from: r.users.id,
        to: r.projects.ownerId,
      }),
      memberships: r.many.projectMembers({
        from: r.users.id,
        to: r.projectMembers.userId,
      }),
    },
    projects: {
      tenant: r.one.tenants({
        from: r.projects.tenantId,
        to: r.tenants.id,
      }),
      owner: r.one.users({
        from: r.projects.ownerId,
        to: r.users.id,
      }),
      tasks: r.many.tasks({
        from: r.projects.id,
        to: r.tasks.projectId,
      }),
      members: r.many.projectMembers({
        from: r.projects.id,
        to: r.projectMembers.projectId,
      }),
    },
    tasks: {
      project: r.one.projects({
        from: r.tasks.projectId,
        to: r.projects.id,
      }),
    },
    projectMembers: {
      project: r.one.projects({
        from: r.projectMembers.projectId,
        to: r.projects.id,
      }),
      user: r.one.users({
        from: r.projectMembers.userId,
        to: r.users.id,
      }),
    },
  })
);
