# drizzle-policy

Application-side policy enforcement for Drizzle ORM.

Wrap your Drizzle client once, define the rules your app cares about, then keep
writing normal Drizzle queries. Drizzle Policy adds policy predicates, injects
safe values, or rejects unsafe operations before the query reaches the database.

It is useful for:

- tenant, workspace, organization, or account isolation
- soft-delete filtering
- blocking direct raw execution by default
- custom read, insert, update, and delete rules that live with your application
  code

Drizzle Policy is not a replacement for database-native row-level security. It
protects code that uses the wrapped client.

## Install

```bash
npm install drizzle-policy
```

`drizzle-orm` is a peer dependency.

The root import targets Drizzle v1 RC:

```ts
import { createPolicyClient, definePolicies } from 'drizzle-policy';
```

Use `drizzle-policy/v0` if your app is still on Drizzle v0.

## Quick Start

This example scopes every supported query to the current tenant. It affects
tables that have a `tenantId` column.

```ts
import { createPolicyClient, definePolicies } from 'drizzle-policy';
import { scopeIsolationPolicy } from 'drizzle-policy/recipes/scope-isolation';
import { rawDb } from './db';

type PolicyContext = {
  // Values your policies can read while a request or job is running.
  tenantId: string;
};

export const policies = definePolicies<PolicyContext>()(() => [
  scopeIsolationPolicy({
    // Any table with this Drizzle property is treated as tenant-scoped.
    column: 'tenantId',

    // The value to inject into inserts and add to reads/updates/deletes.
    getScopeValue: ctx => ctx.tenantId,
  }),
]);

export const { db, policyContext } = createPolicyClient(rawDb, {
  // Use this exported db everywhere you want policies enforced.
  policies,
});
```

Put request or job code inside a policy context at the boundary of your app:

```ts
import { policyContext } from './db';
import { app } from './app';

export default {
  async fetch(request: Request) {
    const session = await requireSession(request);

    return policyContext.run(
      { tenantId: session.tenantId },

      // Routes and services called inside this function can import the
      // wrapped db normally. They do not need to pass tenantId around.
      () => app.fetch(request)
    );
  },
};
```

For tests, scripts, and background jobs, you can also pass context directly:

```ts
await db.withPolicyContext({ tenantId: 'tenant_123' }, async db => {
  // This query sees tenantId from the explicit context above.
  return db.query.projects.findMany();
});
```

Use the wrapped `db` everywhere you want policies enforced.

If your framework already owns request or job context storage, pass a reader
and use the returned client:

```ts
export const { db } = createPolicyClient(rawDb, {
  policies,

  // Called whenever a policy needs the current request/job context.
  getContext: customContextReader,
});
```

When `getContext` is provided, Drizzle Policy does not create `policyContext`
for you. Your app already owns that part.

For a local PostgreSQL client example that configures Drizzle Policy without
opening a database connection on startup:

```bash
bun run example:client
```

With the policy above:

- reads, updates, and deletes on scoped tables are limited to the current tenant
- inserts into scoped tables get the current `tenantId`
- inserts or updates for another tenant are rejected
- tables without `tenantId` are left alone by this recipe
- raw `execute` is hidden from the normal wrapped client unless you explicitly
  enter an unsafe execute scope

## Schema Shape

Policies can only enforce what your schema exposes. A tenant policy needs a
scope column on the tables that belong to a tenant. The built-in soft-delete
recipe needs a nullable deleted marker column, usually `deletedAt`.

```ts
import { pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

export const projects = pgTable('projects', {
  id: varchar('id', { length: 64 }).primaryKey(),

  // scopeIsolationPolicy({ column: 'tenantId' }) uses this property.
  tenantId: varchar('tenant_id', { length: 64 }).notNull(),

  // softDeletePolicy({ column: 'deletedAt' }) checks for null here.
  deletedAt: timestamp('deleted_at'),
});

export const countries = pgTable('countries', {
  code: varchar('code', { length: 2 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),

  // No tenantId here, so the tenant recipe ignores this table by default.
});
```

The column names in recipe options are Drizzle property names, not SQL column
names. For example, use `tenantId` for `tenant_id`, and `deletedAt` for
`deleted_at`.

If a table must always be tenant-aware, give it the scope column. If a table is
global, leave the column off and either let the recipe ignore it or configure
`onTableWithoutScopeColumn` to throw for tables that should never be unscoped.

The built-in soft-delete recipe treats "not deleted" as `deletedAt is null`. If
your app uses a boolean such as `isDeleted`, write a custom policy instead.

## Recipes

Recipes are prebuilt policy factories for common app-level safeguards. They are
just `definePolicy(...)` wrappers under the hood, so you can mix them with
custom policies in the same policy set. Import only the recipes you need.

```ts
import { scopeIsolationPolicy } from 'drizzle-policy/recipes/scope-isolation';
import { softDeletePolicy } from 'drizzle-policy/recipes/soft-delete';
```

### Scope Isolation

Use `scopeIsolationPolicy` when rows belong to an application scope such as a
tenant, workspace, organization, account, or project.

```ts
type PolicyContext = {
  workspaceId: string;
};

scopeIsolationPolicy<PolicyContext>({
  // Tables with a workspaceId property are scoped.
  column: 'workspaceId',

  // Reads the workspace value from policyContext.run(...).
  getScopeValue: ctx => ctx.workspaceId,
});
```

For tables with `workspaceId`, the recipe constrains reads, updates, and deletes
to the current workspace. Inserts get the current workspace value automatically.
Tables without `workspaceId` are ignored by default.

If some tables should be treated differently, pass table-specific decisions:

```ts
import type * as schema from './schema';

scopeIsolationPolicy<PolicyContext, typeof schema>({
  column: 'workspaceId',
  getScopeValue: ctx => ctx.workspaceId,
  onTableWithoutScopeColumn: {
    // Global lookup table: this policy should not touch it.
    countries: 'ignore',

    // This table should never be queried without another policy.
    auditLogs: 'throw',
  },
});
```

The optional `typeof schema` generic gives TypeScript autocomplete for table
names in table-keyed options. You do not pass your schema object at runtime.

Recipes accept custom names when you want domain-specific errors, trace events,
or unsafe policy permissions. For `unsafe({ policies: [...] })` autocomplete,
put your context and schema generics on `definePolicies`, then let the recipe
call infer its own `name` literal:

```ts
export const policies = definePolicies<PolicyContext, typeof schema>()(() => [
  scopeIsolationPolicy({
    name: 'tenant-isolation',
    column: 'tenantId',
    getScopeValue: ctx => ctx.tenantId,
    onTableWithoutScopeColumn: {
      // Allow this table to stay global.
      auditLogs: 'ignore',
    },
  }),
]);
```

Avoid putting explicit generics on the recipe call when you need autocomplete
for a custom name:

```ts
scopeIsolationPolicy<PolicyContext, typeof schema>({
  name: 'tenant-isolation',
  column: 'tenantId',
  getScopeValue: ctx => ctx.tenantId,
});
```

That form typechecks, but TypeScript widens the custom `name` to `string`, so
`tenant-isolation` is still allowed as a custom policy permission but cannot be
suggested in `unsafe({ policies: [...] })`.

### Soft Delete

Use `softDeletePolicy` when deleted rows stay in the table.

```ts
import { softDeletePolicy } from 'drizzle-policy/recipes/soft-delete';

softDeletePolicy({
  // A nullable marker column. Active rows have deletedAt = null.
  column: 'deletedAt',
});
```

For tables with `deletedAt`, reads only return rows where `deletedAt` is `null`.
Deletes are rejected by default. Tables without `deletedAt` are ignored by this
recipe unless you configure `onTableWithoutDeletedColumn`.

To turn deletes into updates:

```ts
softDeletePolicy({
  column: 'deletedAt',

  // delete() becomes update({ deletedAt: new Date() }).
  deleteBehavior: 'softDelete',
  deletedValue: () => new Date(),
});
```

You can combine recipes in one policy set:

```ts
export const policies = definePolicies<PolicyContext>()(() => [
  scopeIsolationPolicy({
    // Tenant-aware tables need a tenantId property.
    column: 'tenantId',
    getScopeValue: ctx => ctx.tenantId,
  }),
  softDeletePolicy({
    // Soft-deletable tables need a nullable deletedAt property.
    column: 'deletedAt',
    deleteBehavior: 'softDelete',
  }),
]);
```

## Custom Policies

Use `policy.define(...)` when a recipe is not enough.

```ts
import { definePolicies } from 'drizzle-policy';
import { and, eq, isNull } from 'drizzle-orm';
import type * as schema from './schema';

type PolicyContext = {
  userId: string;
};

export const policies = definePolicies<PolicyContext>()(policy => [
  policy.define({
    name: 'visible-projects',
    onMissingContext: 'throw',

    // Keep this policy focused on one table.
    appliesTo: ({ tableKey }) => tableKey === 'projects',

    // The returned condition is added to project reads.
    read: ({ table, ctx }) => {
      const projects = table as typeof schema.projects;

      return and(eq(projects.ownerId, ctx.userId), isNull(projects.deletedAt));
    },
  }),
]);
```

Policy hooks use normal Drizzle expressions. Import `eq`, `and`, `or`, `isNull`,
`sql`, and other helpers from `drizzle-orm`; Drizzle Policy does not introduce a
separate predicate language.

Policies can define hooks for four operations:

- `read`: return a Drizzle condition
- `insert`: return inserted values, or transformed inserted values
- `update`: return a condition, transformed `set` values, or both
- `delete`: return a condition, reject the delete, or convert it into an update

`appliesTo` narrows which table operations a policy should consider. If you
omit it, the policy applies anywhere it has a hook.

`onMissingContext: 'throw'` makes the policy fail closed when no context is
available and lets TypeScript treat `ctx` as defined inside that policy's hooks.

### Delete As Update

A custom delete hook can replace a delete with an update:

```ts
const policies = definePolicies<PolicyContext>()(policy => [
  policy.define({
    name: 'archive-project-deletes',
    onMissingContext: 'throw',
    appliesTo: ({ tableKey }) => tableKey === 'projects',

    // delete(projects) becomes update(projects).set(...).
    delete: ({ ctx }) => ({
      action: 'update',
      set: {
        deletedAt: new Date(),
        deletedById: ctx.userId,
      },
    }),
  }),
]);
```

## Configuration

The safest production setup usually fails closed for unclassified table
operations and direct raw execution:

```ts
export const { db, policyContext } = createPolicyClient(rawDb, {
  policies,

  // Operations no policy handles should not slip through silently.
  onNoPolicyMatched: 'throw',

  // Raw SQL execution needs an explicit unsafe scope.
  rawExecution: 'throw',
});
```

Defaults:

| Option              | Default | Meaning                                                                                    |
| ------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `onNoPolicyMatched` | `allow` | Operations that no policy handles continue unchanged.                                      |
| `rawExecution`      | `throw` | Direct raw execution methods such as `execute` are rejected outside unsafe execute scopes. |

Recipe defaults:

| Option                                           | Default  | Meaning                                                               |
| ------------------------------------------------ | -------- | --------------------------------------------------------------------- |
| `scopeIsolationPolicy.onTableWithoutScopeColumn` | `ignore` | Tables without the configured scope column are ignored by the recipe. |
| `scopeIsolationPolicy.onMissingScopeValue`       | `throw`  | Scoped operations without a scope value are rejected.                 |
| `scopeIsolationPolicy.onScopeValueMismatch`      | `throw`  | Insert/update values for another scope are rejected.                  |
| `softDeletePolicy.deleteBehavior`                | `throw`  | Deletes are rejected unless you opt into soft-delete updates.         |

### Raw Execution

Raw execution APIs bypass table-aware planning, so Drizzle Policy rejects them
by default. The wrapped TypeScript client also omits `execute` unless you
explicitly allow raw execution for the client or enter an unsafe scope that
grants it:

```ts
const result = await db.unsafe({ execute: true }).execute(sql`select 1`);
```

If you set `rawExecution: 'allow'`, `execute` is available on the normal client
surface:

```ts
const { db } = createPolicyClient(rawDb, {
  policies,
  rawExecution: 'allow',
});

await db.execute(sql`select 1`);
```

For legacy JavaScript, casts, or conditional access to `execute`, the
`rawExecution` callback remains a runtime fallback:

```ts
type PolicyContext = {
  role: 'admin' | 'member';
};

const { db } = createPolicyClient(rawDb, {
  policies,
  rawExecution({ ctx }) {
    // ctx comes from policyContext.run(...) or db.withPolicyContext(...).
    return ctx?.role === 'admin' ? 'allow' : 'throw';
  },
});
```

You can still use Drizzle's `sql` template inside normal query builders and
policy hooks.

### Temporary Exceptions

Use `unsafe` for a narrow, intentional exception, such as an admin flow that
needs to include soft-deleted rows.

```ts
const projects = await db
  // Skip only the soft-delete policy for this returned client.
  .unsafe({ policies: ['soft-delete'] })
  .query.projects.findMany();
```

Custom recipe names inferred by `definePolicies` are suggested here too:

```ts
const allTenantProjects = await db
  // Skip only the custom-named tenant policy.
  .unsafe({ policies: ['tenant-isolation'] })
  .query.projects.findMany();
```

Only the named policies are skipped for that returned client. Other policies
still run. You can combine permissions when one client needs both kinds of
escape hatch:

```ts
await db
  .unsafe({ policies: ['soft-delete'], execute: true })
  .execute(sql`select refresh_admin_cache()`);
```

### Tracing

Pass `trace` while developing a policy setup to see which calls were checked
and which policy decisions were made.

```ts
const { db } = createPolicyClient(rawDb, {
  policies,
  trace(event) {
    // Use this while wiring policies. It is not part of enforcement.
    console.debug(event);
  },
});
```

Trace events are for debugging configuration, not for enforcing security.

## Supported Drizzle Calls

Both Drizzle versions currently cover:

- SQL-like select, insert, update, and delete builders
- joined tables in select builders
- relational `db.query.*.findMany(...)` and `findFirst(...)`
- nested relational `with` configs
- transactions, with the transaction client wrapped in the same policies
- raw `execute`, when granted through `unsafe({ execute: true })` or the
  `rawExecution` runtime fallback

## Drizzle v0

The policy definition API is shared. Only the client import changes:

```ts
import { definePolicies } from 'drizzle-policy';
import { createPolicyClient } from 'drizzle-policy/v0';
```

For a tiny local v0 playground:

```bash
bun run example:v0:minimal
```

## Protection Model

Drizzle Policy protects operations that go through the wrapped client. Queries
that bypass it are outside its control, including:

- direct access to the unwrapped Drizzle client
- raw execution that your app explicitly allows
- migrations and maintenance scripts that do not use the policy client
- database users or tools that connect outside your application

Use database-native permissions or row-level security as the final boundary when
you need protection outside application code.
