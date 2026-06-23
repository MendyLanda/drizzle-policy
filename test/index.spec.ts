import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import {
  createPolicyClient,
  createPolicyContext,
  type DrizzleTableLike,
  definePolicy,
  definePolicies,
} from '../src';
import * as root from '../src';
import { scopeIsolationPolicy } from '../src/recipes/scope-isolation-policy';
import { softDeletePolicy } from '../src/recipes/soft-delete-policy';
import * as v0 from '../src/v0';
import {
  createV0TestEnvironment,
  createV1TestEnvironment,
} from './fixtures/drizzle-environments';
import * as v0Schema from './fixtures/v0-schema';
import * as v1Schema from './fixtures/v1-schema';

type AppPolicyContext = {
  tenantId: string;
  userId: string;
  role: 'admin' | 'member';
};

type Expect<T extends true> = T;

type TypeEquals<TActual, TExpected> =
  (<T>() => T extends TActual ? 1 : 2) extends <T>() => T extends TExpected
    ? 1
    : 2
    ? true
    : false;

const typeCheckOnly = (_fn: () => void) => undefined;

const appContext: AppPolicyContext = {
  tenantId: 'tenant_1',
  userId: 'user_1',
  role: 'member',
};

describe('drizzle-policy interface', () => {
  test('does not expose adapter marker constants from public entrypoints', () => {
    expect('drizzlePolicyTarget' in root).toBe(false);
    expect('drizzlePolicyTarget' in v0).toBe(false);
  });

  test('package exposes only focused recipe subpaths', () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8')
    ) as {
      engines: Record<string, string>;
      exports: Record<string, unknown>;
      keywords: string[];
    };

    const hasExport = (path: string) =>
      Object.prototype.hasOwnProperty.call(packageJson.exports, path);

    expect(hasExport('./recipes/scope-isolation')).toBe(true);
    expect(hasExport('./recipes/soft-delete')).toBe(true);
    expect(hasExport('./recipes/audit')).toBe(false);
    expect(hasExport('./recipes/scope')).toBe(false);
    expect(hasExport('./recipes/tenant-isolation')).toBe(false);
    expect(packageJson.engines).toEqual({
      node: '>=18',
    });
    expect(packageJson.keywords).not.toContain('audit');
  });

  test('package exposes a runnable example client script', () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8')
    ) as {
      scripts: Record<string, string>;
    };
    const examplePath = join(process.cwd(), 'examples', 'policy-client.ts');

    expect(packageJson.scripts['example:client']).toBe(
      'bun examples/policy-client.ts'
    );

    const exampleSource = readFileSync(examplePath, 'utf8');

    expect(exampleSource).toContain("from 'drizzle-orm/node-postgres'");
    expect(exampleSource).toContain('createPolicyClient(rawDb');
    expect(exampleSource).toContain("name: 'custom-name'");
    expect(exampleSource).toContain("rawExecution: 'allow'");
    expect(exampleSource).toContain('db.execute(sql`select 1`)');
    expect(exampleSource).not.toContain('DemoRawDb');
    expect(exampleSource).not.toContain('DemoQuery');
  });

  test('creates and restores app-boundary policy context', async () => {
    const policyContext = createPolicyContext<AppPolicyContext>();

    expect(policyContext.get()).toBeUndefined();

    await policyContext.run(appContext, async () => {
      expect(policyContext.get()).toEqual(appContext);
      expect(policyContext.getOrThrow()).toEqual(appContext);
    });

    expect(policyContext.get()).toBeUndefined();
  });

  test('assembles schema-typed policies without storing runtime schema', () => {
    const policies = definePolicies<AppPolicyContext, typeof v1Schema>()(
      policy => [
        scopeIsolationPolicy<AppPolicyContext, typeof v1Schema>({
          column: 'tenantId',
          getScopeValue: ctx => ctx.tenantId,
          onTableWithoutScopeColumn: {
            countries: 'ignore',
            auditLogs: 'ignore',
          },
        }),
        softDeletePolicy({
          column: 'deletedAt',
        }),
        policy.define({
          name: 'owner-read',
          onMissingContext: 'throw',
          appliesTo: ({ tableKey }) => tableKey === 'projects',
          read: ({ table, ctx }) =>
            eq((table as typeof v1Schema.projects).ownerId, ctx.userId),
        }),
      ]
    );

    expect(policies).toHaveLength(3);
    expect('schema' in policies).toBe(false);
    expect(policies.map(policy => policy.name)).toEqual([
      'scope-isolation',
      'soft-delete',
      'owner-read',
    ]);
  });

  test('schema generic narrows table-specific decision maps', () => {
    const policy = scopeIsolationPolicy<AppPolicyContext, typeof v1Schema>({
      column: 'tenantId',
      getScopeValue: ctx => ctx.tenantId,
      onTableWithoutScopeColumn: {
        countries: 'ignore',
        auditLogs: 'ignore',
      },
    });

    scopeIsolationPolicy<AppPolicyContext, typeof v1Schema>({
      column: 'tenantId',
      getScopeValue: ctx => ctx.tenantId,
      onTableWithoutScopeColumn: {
        // @ts-expect-error relations exports are not table names
        tableRelations: 'ignore',
      },
    });

    scopeIsolationPolicy<AppPolicyContext, typeof v1Schema>({
      column: 'tenantId',
      getScopeValue: ctx => ctx.tenantId,
      onTableWithoutScopeColumn: {
        // @ts-expect-error table name is not in the schema generic
        missingTable: 'ignore',
      },
    });

    expect(policy.name).toBe('scope-isolation');
  });

  test('recipes accept custom names when context and schema come from the policy set', () => {
    const policies = definePolicies<AppPolicyContext, typeof v1Schema>()(() => [
      scopeIsolationPolicy({
        name: 'tenant-isolation',
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
        onTableWithoutScopeColumn: {
          countries: 'ignore',
          auditLogs: 'ignore',
        },
      }),
      softDeletePolicy({
        name: 'archived-filter',
        column: 'deletedAt',
      }),
    ]);
    type PolicySetName = root.PolicyNames<typeof policies>;
    type CustomRecipeNamesArePreserved = Expect<
      TypeEquals<PolicySetName, 'tenant-isolation' | 'archived-filter'>
    >;
    const customRecipeNamesArePreserved: CustomRecipeNamesArePreserved = true;

    const explicitGenericPolicy = scopeIsolationPolicy<
      AppPolicyContext,
      typeof v1Schema
    >({
      name: 'explicit-tenant-isolation',
      column: 'tenantId',
      getScopeValue: ctx => ctx.tenantId,
    });
    type ExplicitGenericNameIsBroad = Expect<
      TypeEquals<typeof explicitGenericPolicy.name, string>
    >;
    const explicitGenericNameIsBroad: ExplicitGenericNameIsBroad = true;

    expect(policies.map(policy => policy.name)).toEqual([
      'tenant-isolation',
      'archived-filter',
    ]);
    expect(customRecipeNamesArePreserved).toBe(true);
    expect(explicitGenericNameIsBroad).toBe(true);
  });

  test('definePolicy keeps metadata out of the public policy shape', () => {
    definePolicy<AppPolicyContext, typeof v1Schema>({
      name: 'no-meta',
      // @ts-expect-error meta is not part of public policy definitions
      meta: {
        recipe: 'internal-only',
      },
      delete: () => 'throw',
    });

    const policy = definePolicy<AppPolicyContext, typeof v1Schema>({
      name: 'no-deletes',
      delete: () => 'throw',
    });

    expect('meta' in policy).toBe(false);
  });

  test('schema-typed policy hooks receive Drizzle table exports', () => {
    const policy = definePolicy<AppPolicyContext, typeof v1Schema>({
      name: 'typed-table',
      delete: ({ table, tableKey, operation }) => {
        type HookTableIsDrizzleTable = Expect<
          TypeEquals<typeof table, DrizzleTableLike>
        >;
        type HookTableKeyIsKnown = Expect<
          TypeEquals<
            typeof tableKey,
            | 'projects'
            | 'countries'
            | 'tenants'
            | 'users'
            | 'tasks'
            | 'projectMembers'
            | 'apiKeys'
            | 'auditLogs'
          >
        >;
        type HookOperationIsDelete = Expect<
          TypeEquals<typeof operation, 'delete'>
        >;
        type TableBrand = HookTableIsDrizzleTable extends true
          ? (typeof table)['_']['brand']
          : never;
        const operationIsDelete: HookOperationIsDelete = true;
        const tableKeyIsKnown: HookTableKeyIsKnown = true;
        const brand: TableBrand = 'Table';

        return {
          action: 'update',
          set: {
            brand,
            tableKeyIsKnown,
            operationIsDelete,
          },
        };
      },
    });

    const result = policy.options.delete?.({
      tableKey: 'projects',
      tableName: 'projects',
      table: v1Schema.projects,
      operation: 'delete',
      ctx: appContext,
    });

    expect(result).toEqual({
      action: 'update',
      set: {
        brand: 'Table',
        tableKeyIsKnown: true,
        operationIsDelete: true,
      },
    });
  });

  test('policy hooks no longer expose schemaKey', () => {
    definePolicy<AppPolicyContext, typeof v1Schema>({
      name: 'no-schema-key',
      read: ({
        // @ts-expect-error tableKey replaced schemaKey in policy callbacks
        schemaKey,
      }) => {
        return schemaKey === 'projects' ? 'ignore' : 'throw';
      },
    });
  });

  test('read policy hooks receive read operation literals', () => {
    const policy = definePolicy<AppPolicyContext, typeof v1Schema>({
      name: 'read-operation',
      read: ({ operation }) => {
        type HookOperationIsRead = Expect<TypeEquals<typeof operation, 'read'>>;
        const operationIsRead: HookOperationIsRead = true;

        return operationIsRead ? 'ignore' : 'throw';
      },
    });

    const result = policy.options.read?.({
      tableKey: 'projects',
      tableName: 'projects',
      table: v1Schema.projects,
      operation: 'read',
      ctx: appContext,
    });

    expect(result).toBe('ignore');
  });

  test('scope isolation recipe injects values and rejects mismatched scope', () => {
    const policy = scopeIsolationPolicy<AppPolicyContext, typeof v1Schema>({
      column: 'tenantId',
      getScopeValue: ctx => ctx.tenantId,
    });

    const readResult = policy.options.read?.({
      tableKey: 'projects',
      tableName: 'projects',
      table: v1Schema.projects,
      operation: 'read',
      ctx: appContext,
    });

    expect(readResult).toBeDefined();
    expect(readResult).not.toHaveProperty('kind');

    const insertResult = policy.options.insert?.({
      tableKey: 'projects',
      tableName: 'projects',
      table: v1Schema.projects,
      operation: 'insert',
      ctx: appContext,
      values: {
        id: 'project_1',
        name: 'Launch',
      },
    });

    expect(insertResult).toEqual({
      id: 'project_1',
      name: 'Launch',
      tenantId: 'tenant_1',
    });

    const mismatchResult = policy.options.insert?.({
      tableKey: 'projects',
      tableName: 'projects',
      table: v1Schema.projects,
      operation: 'insert',
      ctx: appContext,
      values: {
        id: 'project_2',
        name: 'Other',
        tenantId: 'tenant_2',
      },
    });

    expect(mismatchResult).toBe('throw');
  });

  test('scope isolation recipe supports non-tenant scope columns', () => {
    type ProjectPolicyContext = {
      projectId: string;
    };

    const policy = scopeIsolationPolicy<ProjectPolicyContext, typeof v1Schema>({
      column: 'projectId',
      getScopeValue: ctx => ctx.projectId,
    });

    const insertResult = policy.options.insert?.({
      tableKey: 'tasks',
      tableName: 'tasks',
      table: v1Schema.tasks,
      operation: 'insert',
      ctx: {
        projectId: 'project_1',
      },
      values: {
        id: 'task_1',
        tenantId: 'tenant_1',
        title: 'Ship it',
      },
    });

    expect(insertResult).toEqual({
      id: 'task_1',
      tenantId: 'tenant_1',
      projectId: 'project_1',
      title: 'Ship it',
    });
  });

  test('soft delete recipe exposes reusable operation hooks', () => {
    const softDelete = softDeletePolicy<typeof v1Schema>();

    const readResult = softDelete.options.read?.({
      tableKey: 'projects',
      tableName: 'projects',
      table: v1Schema.projects,
      operation: 'read',
      ctx: undefined,
    });

    expect(readResult).toBeDefined();
    expect(readResult).not.toHaveProperty('kind');
  });

  test('policy client exposes explicit context helpers on the v1 proxy', () => {
    const { db } = createV1TestEnvironment();
    const policyContext = createPolicyContext<AppPolicyContext>();
    const policies = definePolicies<AppPolicyContext, typeof v1Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v1Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);

    const { db: policyDb } = createPolicyClient(db, {
      getContext: policyContext.get,
      policies,
    });

    expect(policyDb.getPolicyContext()).toBeUndefined();

    policyContext.run(appContext, () => {
      expect(policyDb.getPolicyContext()).toEqual(appContext);
    });

    policyDb.withPolicyContext(
      {
        ...appContext,
        tenantId: 'tenant_2',
      },
      scopedDb => {
        expect(scopedDb.getPolicyContext()?.tenantId).toBe('tenant_2');
      }
    );
  });

  test('policy client returns a generated context inferred from direct policies', () => {
    const { db } = createV1TestEnvironment();
    const result = createPolicyClient(db, {
      policies: [
        definePolicy<AppPolicyContext, typeof v1Schema>({
          name: 'direct-context-policy',
          onMissingContext: 'throw',
          read: ({ ctx }) => {
            const tenantId: string = ctx.tenantId;

            return tenantId ? 'ignore' : 'throw';
          },
        }),
        softDeletePolicy<typeof v1Schema>(),
      ] as const,
    });

    type GeneratedContext = Parameters<typeof result.policyContext.run>[0];
    type GeneratedContextIsAppContext = Expect<
      TypeEquals<GeneratedContext, AppPolicyContext>
    >;
    const generatedContextIsAppContext: GeneratedContextIsAppContext = true;

    expect(generatedContextIsAppContext).toBe(true);
    expect(result.policyContext.get()).toBeUndefined();

    result.policyContext.run(appContext, () => {
      expect(result.db.getPolicyContext()).toEqual(appContext);
    });

    expect(result.db.getPolicyContext()).toBeUndefined();
  });

  test('policy client omits public generated context when an external reader is supplied', () => {
    const { db } = createV1TestEnvironment();
    const policies = definePolicies<AppPolicyContext, typeof v1Schema>()(
      policy => [
        policy.define({
          name: 'contextful-policy',
          onMissingContext: 'throw',
          read: ({ ctx }) => (ctx.tenantId ? 'ignore' : 'throw'),
        }),
      ]
    );

    const result = createPolicyClient(db, {
      getContext: () => appContext,
      policies,
    });

    type ResultHasNoPublicPolicyContext = Expect<
      TypeEquals<
        'policyContext' extends keyof typeof result ? true : false,
        false
      >
    >;
    const resultHasNoPublicPolicyContext: ResultHasNoPublicPolicyContext = true;

    expect(resultHasNoPublicPolicyContext).toBe(true);
    expect('policyContext' in result).toBe(false);
    expect(result.db.getPolicyContext()).toEqual(appContext);
  });

  test('unsafe policy permissions preserve known names and accept custom strings', () => {
    const { db } = createV1TestEnvironment();
    const ownerReadPolicy = definePolicy({
      name: 'owner-read',
      read: () => 'ignore' as const,
    });
    const explicitGenericTenantPolicy = scopeIsolationPolicy<
      AppPolicyContext,
      typeof v1Schema
    >({
      name: 'custom-name',
      allowGlobalRows: true,
      onMissingScopeValue: 'throw',
      onScopeValueMismatch: 'throw',
      column: 'tenantId',
      getScopeValue: ctx => ctx.tenantId,
      onTableWithoutScopeColumn: {
        auditLogs: 'ignore',
      },
    });
    const policies = definePolicies<AppPolicyContext, typeof v1Schema>()(
      policy => [
        scopeIsolationPolicy({
          name: 'tenant-isolation',
          column: 'tenantId',
          getScopeValue: ctx => ctx.tenantId,
        }),
        softDeletePolicy(),
        ownerReadPolicy,
        explicitGenericTenantPolicy,
        policy.define({
          name: 'member-write',
          update: () => 'ignore',
        }),
      ]
    );

    const { db: policyDb } = createPolicyClient(db, {
      getContext: () => appContext,
      policies,
    });

    type PolicySetName = root.PolicyNames<typeof policies>;
    type PolicySetNamesArePreserved = Expect<
      TypeEquals<
        PolicySetName,
        'tenant-isolation' | 'soft-delete' | 'owner-read' | 'member-write'
      >
    >;
    type UnsafePermissions = Extract<
      Parameters<typeof policyDb.unsafe>[0],
      { readonly policies?: readonly unknown[] }
    >;
    type DisabledPolicyName = NonNullable<
      UnsafePermissions['policies']
    >[number];
    type CustomPolicyNameIsAllowed = Expect<
      TypeEquals<
        'custom-policy' extends DisabledPolicyName ? true : false,
        true
      >
    >;
    type RecipeNamesArePreserved = Expect<
      TypeEquals<
        Extract<
          DisabledPolicyName,
          'tenant-isolation' | 'soft-delete' | 'owner-read' | 'member-write'
        >,
        'tenant-isolation' | 'soft-delete' | 'owner-read' | 'member-write'
      >
    >;
    const policySetNamesArePreserved: PolicySetNamesArePreserved = true;
    const customPolicyNameIsAllowed: CustomPolicyNameIsAllowed = true;
    const recipeNamesArePreserved: RecipeNamesArePreserved = true;

    policyDb.unsafe({
      policies: [
        'tenant-isolation',
        'soft-delete',
        'owner-read',
        'member-write',
        'custom-name',
        'custom-policy',
      ],
    });

    expect(customPolicyNameIsAllowed).toBe(true);
    expect(recipeNamesArePreserved).toBe(true);
    expect(policySetNamesArePreserved).toBe(true);
  });

  test('unsafe policy arrays autocomplete recipe and custom policy names', () => {
    const policyNameCompletions = getUnsafePolicyNameCompletions(`
      import { createPolicyClient, definePolicy, definePolicies } from './src';
      import type { PolicyNames } from './src';
      import { scopeIsolationPolicy } from './src/recipes/scope-isolation-policy';
      import { softDeletePolicy } from './src/recipes/soft-delete-policy';
      import * as schema from './test/fixtures/v1-schema';

      type AppPolicyContext = {
        tenantId: string;
        userId: string;
        role: 'admin' | 'member';
      };
      type Db = {
        execute(query: unknown): unknown;
      };
      type Expect<T extends true> = T;
      type TypeEquals<TActual, TExpected> =
        (<T>() => T extends TActual ? 1 : 2) extends <T>() => T extends TExpected
          ? 1
          : 2
          ? true
          : false;

      const rawDb = {
        execute: (_query: unknown) => undefined,
      } as Db;
      const ownerReadPolicy = definePolicy({
        name: 'owner-read',
        read: () => 'ignore' as const,
      });
      const explicitGenericTenantPolicy = scopeIsolationPolicy<AppPolicyContext, typeof schema>({
        name: 'custom-name',
        allowGlobalRows: true,
        onMissingScopeValue: 'throw',
        onScopeValueMismatch: 'throw',
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
        onTableWithoutScopeColumn: {
          auditLogs: 'ignore',
        },
      });
      const policies = definePolicies<AppPolicyContext, typeof schema>()(policy => [
        scopeIsolationPolicy({
          name: 'tenant-isolation',
          column: 'tenantId',
          getScopeValue: ctx => ctx.tenantId,
        }),
        softDeletePolicy(),
        ownerReadPolicy,
        explicitGenericTenantPolicy,
        policy.define({
          name: 'member-write',
          update: () => 'ignore',
        }),
      ]);
      type PolicySetNamesArePreserved = Expect<
        TypeEquals<
          PolicyNames<typeof policies>,
          'tenant-isolation' | 'soft-delete' | 'owner-read' | 'member-write'
        >
      >;
      const policySetNamesArePreserved: PolicySetNamesArePreserved = true;
      const { db } = createPolicyClient(rawDb, {
        getContext: () => ({
          tenantId: 'tenant_1',
          userId: 'user_1',
          role: 'admin',
        } as AppPolicyContext),
        policies,
        rawExecution: 'allow',
      });

      db.unsafe({ policies: ['/*cursor*/'] }).execute('select 1');
    `);

    expect(policyNameCompletions).toContain('tenant-isolation');
    expect(policyNameCompletions).toContain('soft-delete');
    expect(policyNameCompletions).toContain('owner-read');
    expect(policyNameCompletions).toContain('member-write');
  });

  test('policy client exposes execute only inside unsafe execute scopes', () => {
    type TypedSqlClient = {
      select(): 'select';
      execute(query: unknown): 'execute';
      transaction<TResult>(callback: (tx: TypedSqlClient) => TResult): TResult;
    };

    const rawDb: TypedSqlClient = {
      select: () => 'select',
      execute: () => 'execute',
      transaction: callback => callback(rawDb),
    };
    const policies = definePolicies<AppPolicyContext>()(() => []);
    const { db: policyDb } = createPolicyClient(rawDb, {
      getContext: () => appContext,
      policies,
    });

    typeCheckOnly(() => {
      // @ts-expect-error protected policy clients hide raw execute by default
      policyDb.execute('select 1');
    });

    const policyUnsafeDb = policyDb.unsafe({ policies: ['custom-policy'] });
    const selectMethod: () => 'select' = policyUnsafeDb.select;

    typeCheckOnly(() => {
      // @ts-expect-error disabling policies does not expose raw execute
      policyUnsafeDb.execute('select 1');
    });

    typeCheckOnly(() => {
      policyDb.transaction(tx => {
        // @ts-expect-error protected transaction clients hide raw execute too
        tx.execute('select 1');
      });
    });

    const executeUnsafeDb = policyDb.unsafe({ execute: true });
    const executeMethod: (query: unknown) => 'execute' =
      executeUnsafeDb.execute;

    const result = executeMethod('select 1');
    const transactionResult = executeUnsafeDb.transaction(tx => {
      const executeMethod: (query: unknown) => 'execute' = tx.execute;

      return executeMethod('select 1');
    });

    const { db: rawExecutionAllowDb } = createPolicyClient(rawDb, {
      getContext: () => appContext,
      policies,
      rawExecution: 'allow',
    });
    const directExecuteMethod: (query: unknown) => 'execute' =
      rawExecutionAllowDb.execute;
    const directExecuteResult = directExecuteMethod('select 1');
    const directTransactionResult = rawExecutionAllowDb.transaction(tx => {
      const executeMethod: (query: unknown) => 'execute' = tx.execute;

      return executeMethod('select 1');
    });
    const policyOnlyUnsafeDb = rawExecutionAllowDb.unsafe({
      policies: ['custom-policy'],
    });
    const policyOnlyUnsafeExecuteMethod: (query: unknown) => 'execute' =
      policyOnlyUnsafeDb.execute;

    type ExecuteResult = Expect<TypeEquals<typeof result, 'execute'>>;
    type TransactionResult = Expect<
      TypeEquals<typeof transactionResult, 'execute'>
    >;
    type DirectExecuteResult = Expect<
      TypeEquals<typeof directExecuteResult, 'execute'>
    >;
    type DirectTransactionResult = Expect<
      TypeEquals<typeof directTransactionResult, 'execute'>
    >;
    const executeResult: ExecuteResult = true;
    const transactionResultType: TransactionResult = true;
    const directExecuteResultType: DirectExecuteResult = true;
    const directTransactionResultType: DirectTransactionResult = true;

    expect(result).toBe('execute');
    expect(typeof selectMethod).toBe('function');
    expect(transactionResult).toBe('execute');
    expect(directExecuteResult).toBe('execute');
    expect(directTransactionResult).toBe('execute');
    expect(typeof policyOnlyUnsafeExecuteMethod).toBe('function');
    expect(executeResult).toBe(true);
    expect(transactionResultType).toBe(true);
    expect(directExecuteResultType).toBe(true);
    expect(directTransactionResultType).toBe(true);
  });

  test('v0 subpath exposes the same interface for Drizzle v0 consumers', () => {
    const { db } = createV0TestEnvironment();
    const policies = definePolicies<AppPolicyContext, typeof v0Schema>()(() => [
      scopeIsolationPolicy<AppPolicyContext, typeof v0Schema>({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
      }),
    ]);

    const { db: policyDb } = v0.createPolicyClient(db, {
      policies,
      getContext: () => appContext,
    });

    type TypedV0SqlClient = {
      execute(query: unknown): unknown;
      transaction<TResult>(
        callback: (tx: TypedV0SqlClient) => TResult
      ): Promise<Awaited<TResult>>;
    };

    const { db: rawExecutionPolicyDb } = v0.createPolicyClient(
      db as TypedV0SqlClient,
      {
        policies,
        getContext: () => appContext,
        rawExecution: 'allow',
      }
    );

    typeCheckOnly(() => {
      const executeMethod: (query: unknown) => unknown =
        rawExecutionPolicyDb.execute;
      const transactionResult = rawExecutionPolicyDb.transaction(tx => {
        const txExecuteMethod: (query: unknown) => unknown = tx.execute;

        return txExecuteMethod;
      });
      const unsafeExecuteMethod: (query: unknown) => unknown =
        rawExecutionPolicyDb.unsafe({ policies: ['scope-isolation'] }).execute;

      return [executeMethod, transactionResult, unsafeExecuteMethod] as const;
    });

    expect(policyDb.getPolicyContext()).toEqual(appContext);
  });

  test('recipes can be used without schema generic when users do not need schema-key typing', () => {
    const policy = scopeIsolationPolicy<AppPolicyContext>({
      column: 'tenantId',
      getScopeValue: ctx => ctx.tenantId,
      onTableWithoutScopeColumn: {
        countries: 'ignore',
      },
    });

    expect(policy.name).toBe('scope-isolation');
  });

  test('schema generic can be omitted from policy sets', () => {
    const policies = definePolicies<AppPolicyContext>()(policy => [
      scopeIsolationPolicy({
        column: 'tenantId',
        getScopeValue: ctx => ctx.tenantId,
        onTableWithoutScopeColumn: {
          countries: 'ignore',
        },
      }),
      policy.define({
        name: 'no-deletes',
        delete: () => 'throw',
      }),
    ]);

    expect(policies.map(policy => policy.name)).toEqual([
      'scope-isolation',
      'no-deletes',
    ]);
  });
});

const getUnsafePolicyNameCompletions = (sourceWithCursor: string): string[] => {
  const root = process.cwd();
  const fileName = join(root, '__virtual_unsafe_policy_completion.ts');
  const cursor = '/*cursor*/';
  const position = sourceWithCursor.indexOf(cursor);
  const source = sourceWithCursor.replace(cursor, '');
  const configPath = ts.findConfigFile(
    root,
    ts.sys.fileExists,
    'tsconfig.json'
  );

  if (!configPath) {
    throw new Error('Expected tsconfig.json to exist.');
  }

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, '\n')
    );
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    root,
    undefined,
    configPath
  );
  const files = new Map([
    [
      fileName,
      {
        text: source,
        version: '0',
      },
    ],
  ]);
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => parsedConfig.options,
    getCurrentDirectory: () => root,
    getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    getScriptFileNames: () => [...parsedConfig.fileNames, fileName],
    getScriptSnapshot(nextFileName) {
      const text =
        files.get(nextFileName)?.text ?? ts.sys.readFile(nextFileName);

      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getScriptVersion: nextFileName => {
      return files.get(nextFileName)?.version ?? '0';
    },
    readDirectory: ts.sys.readDirectory,
    readFile: nextFileName => {
      return files.get(nextFileName)?.text ?? ts.sys.readFile(nextFileName);
    },
    fileExists: nextFileName => {
      return files.has(nextFileName) || ts.sys.fileExists(nextFileName);
    },
  };
  const service = ts.createLanguageService(host);

  expect(
    service
      .getSemanticDiagnostics(fileName)
      .map(diagnostic =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      )
  ).toEqual([]);

  const completions = service.getCompletionsAtPosition(fileName, position, {
    includeCompletionsWithInsertText: true,
  });

  if (!completions) {
    return [];
  }

  return completions.entries.map(entry => entry.name);
};
