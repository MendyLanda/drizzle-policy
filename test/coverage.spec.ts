import { describe, expect, test } from 'bun:test';

import {
  createPolicyClient,
  createPolicyContext,
  definePolicy,
  definePolicies,
} from '../src';
import { hasColumn, isRecord, resolveDecision } from '../src/core/decision';
import {
  createPolicyDisableScope,
  normalizeUnsafePermissions,
} from '../src/core/policy-disable';
import {
  DrizzlePolicyError,
  MissingPolicyContextError,
} from '../src/core/types';
import {
  injectScopeValue,
  makeScopePredicate,
} from '../src/recipes/scope-isolation-helpers';
import { scopeIsolationPolicy } from '../src/recipes/scope-isolation-policy';
import { softDeletePolicy } from '../src/recipes/soft-delete-policy';
import { createPolicyClient as createV0PolicyClient } from '../src/v0/client';
import * as v0Engine from '../src/v0/policy-engine';
import * as v0Runtime from '../src/v0/policy-runtime';
import * as v0Relational from '../src/v0/relational';
import * as v0SqlBuilders from '../src/v0/sql-builders';
import { createTableRegistry as createV0TableRegistry } from '../src/v0/table-registry';
import { createPolicyClient as createV1PolicyClient } from '../src/v1/client';
import * as v1Engine from '../src/v1/policy-engine';
import * as v1Runtime from '../src/v1/policy-runtime';
import * as v1Relational from '../src/v1/relational';
import * as v1SqlBuilders from '../src/v1/sql-builders';
import { createTableRegistry as createV1TableRegistry } from '../src/v1/table-registry';
import * as v0Schema from './fixtures/v0-schema';
import * as v1Schema from './fixtures/v1-schema';

type AppPolicyContext = {
  tenantId: string;
  userId: string;
};

const appContext: AppPolicyContext = {
  tenantId: 'tenant_1',
  userId: 'user_1',
};

const projectTable = {
  tableKey: 'projects',
  tableName: 'projects',
  table: v1Schema.projects,
} as const;

const policyArgs = (
  operation: 'read' | 'insert' | 'update' | 'delete',
  extra: Record<string, unknown> = {}
) =>
  ({
    tableKey: 'projects',
    tableName: 'projects',
    table: v1Schema.projects,
    operation,
    ctx: appContext,
    ...extra,
  }) as any;

const createRuntime = (
  policies: readonly unknown[],
  options: {
    readonly ctx?: unknown;
    readonly disabled?: readonly string[];
    readonly onNoPolicyMatched?: unknown;
    readonly rawExecution?: unknown;
    readonly rawAllowed?: boolean;
    readonly trace?: (event: unknown) => void;
  } = {}
) =>
  ({
    options: {
      policies,
      onNoPolicyMatched: options.onNoPolicyMatched,
      rawExecution: options.rawExecution,
    },
    trace: options.trace,
    getContext: () => options.ctx,
    getDisabledPolicyNames: () => new Set(options.disabled ?? []),
    isRawExecutionAllowed: () => options.rawAllowed ?? false,
  }) as any;

describe('coverage-focused core helpers', () => {
  test('resolves decision options from fallbacks, callbacks, strings, and maps', () => {
    expect(resolveDecision(undefined, { tableKey: 'projects' }, 'allow')).toBe(
      'allow'
    );
    expect(
      resolveDecision(
        ({ tableKey }) => (tableKey === 'projects' ? 'throw' : 'allow'),
        { tableKey: 'projects' },
        'allow'
      )
    ).toBe('throw');
    expect(resolveDecision('ignore', { tableKey: 'projects' }, 'allow')).toBe(
      'ignore'
    );
    expect(
      resolveDecision(
        {
          projects: 'throw',
        },
        { tableKey: 'projects' },
        'allow'
      )
    ).toBe('throw');
    expect(
      resolveDecision(
        {
          projects: undefined,
        },
        { tableKey: 'projects' },
        'allow'
      )
    ).toBe('allow');
    expect(
      resolveDecision(
        {
          projects: 'throw',
        },
        {},
        'allow'
      )
    ).toBe('allow');
  });

  test('narrows table columns and record-like values', () => {
    expect(hasColumn(v1Schema.projects, 'tenantId')).toBe(true);
    expect(hasColumn(v1Schema.countries, 'tenantId')).toBe(false);
    expect(hasColumn(null, 'tenantId')).toBe(false);
    expect(isRecord({ tenantId: 'tenant_1' })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  test('throws stable context and policy errors', () => {
    const context = createPolicyContext<AppPolicyContext>();

    expect(() => context.getOrThrow()).toThrow(
      'No Drizzle Policy context is active.'
    );
    expect(new MissingPolicyContextError().name).toBe(
      'MissingPolicyContextError'
    );
    expect(new DrizzlePolicyError('blocked').name).toBe('DrizzlePolicyError');
  });

  test('normalizes and validates unsafe permissions', () => {
    expect(normalizeUnsafePermissions(['one', 'one', 'two'])).toEqual({
      policyNames: ['one', 'two'],
      execute: false,
    });
    expect(normalizeUnsafePermissions({ execute: true })).toEqual({
      policyNames: [],
      execute: true,
    });
    expect(normalizeUnsafePermissions({})).toEqual({
      policyNames: [],
      execute: false,
    });
    expect(() => normalizeUnsafePermissions(1 as never)).toThrow(
      'Unsafe permissions must be an object.'
    );
    expect(() =>
      normalizeUnsafePermissions({ policies: 'scope-isolation' } as never)
    ).toThrow('Unsafe policy names must be an array.');
    expect(() =>
      normalizeUnsafePermissions({ execute: 'yes' } as never)
    ).toThrow('Unsafe execute permission must be a boolean.');
    expect(() => normalizeUnsafePermissions(['ok', 1] as never)).toThrow(
      'Disabled policy names must be strings.'
    );
  });

  test('layers disabled policies and raw execution through unsafe scopes', () => {
    const client = { name: 'db' };
    const inheritedPolicies = new Set(['outer']);
    const scope = createPolicyDisableScope(
      () => inheritedPolicies,
      () => true
    );

    expect([...scope.getDisabledPolicyNames()]).toEqual(['outer']);
    expect(scope.isRawExecutionAllowed()).toBe(true);

    const inheritedResult = scope.unsafe([], client, db => {
      expect(db).toBe(client);
      expect([...scope.getDisabledPolicyNames()]).toEqual(['outer']);
      expect(scope.isRawExecutionAllowed()).toBe(true);

      return 'inherited';
    });

    expect(inheritedResult).toBe('inherited');

    scope.unsafe({ policies: ['inner'], execute: false }, client, () => {
      expect([...scope.getDisabledPolicyNames()]).toEqual(['outer', 'inner']);
      expect(scope.isRawExecutionAllowed()).toBe(true);
    });

    const isolatedScope = createPolicyDisableScope<typeof client>();
    isolatedScope.unsafe({ execute: true }, client, () => {
      expect([...isolatedScope.getDisabledPolicyNames()]).toEqual([]);
      expect(isolatedScope.isRawExecutionAllowed()).toBe(true);
    });
    isolatedScope.withPoliciesDisabled(['legacy'], client, () => {
      expect([...isolatedScope.getDisabledPolicyNames()]).toEqual(['legacy']);
    });
  });
});

describe('coverage-focused recipe behavior', () => {
  test('scope helpers return non-record payloads and reject missing columns', () => {
    expect(injectScopeValue('raw sql', 'tenant_1', 'tenantId')).toBe('raw sql');
    expect(() =>
      makeScopePredicate(v1Schema.countries, 'tenant_1', {
        column: 'tenantId',
      })
    ).toThrow('Policy references missing column "tenantId".');
  });

  test('scope isolation resolves missing scope, missing columns, arrays, and mismatches', () => {
    const missingScopePolicy = scopeIsolationPolicy<
      AppPolicyContext,
      typeof v1Schema
    >({
      column: 'tenantId',
      getScopeValue: () => undefined,
      onMissingScopeValue: 'ignore',
    });

    expect(
      (missingScopePolicy.options.onMissingContext as (args: any) => unknown)(
        policyArgs('read', { ctx: undefined })
      )
    ).toBe('ignore');
    expect(missingScopePolicy.options.read?.(policyArgs('read'))).toBe(
      'ignore'
    );
    expect(missingScopePolicy.options.update?.(policyArgs('update'))).toBe(
      'ignore'
    );
    expect(missingScopePolicy.options.delete?.(policyArgs('delete'))).toBe(
      'ignore'
    );

    const rejectingMissingScopePolicy = scopeIsolationPolicy<
      AppPolicyContext,
      typeof v1Schema
    >({
      column: 'tenantId',
      getScopeValue: () => null,
    });

    expect(rejectingMissingScopePolicy.options.read?.(policyArgs('read'))).toBe(
      'throw'
    );
    expect(
      rejectingMissingScopePolicy.options.insert?.(
        policyArgs('insert', {
          values: {
            id: 'project_1',
          },
        })
      )
    ).toBe('throw');

    const strictColumnPolicy = scopeIsolationPolicy<
      AppPolicyContext,
      typeof v1Schema
    >({
      column: 'tenantId',
      getScopeValue: ctx => ctx.tenantId,
      onTableWithoutScopeColumn: 'throw',
    });

    expect(
      strictColumnPolicy.options.appliesTo?.(
        policyArgs('read', {
          tableKey: 'countries',
          tableName: 'countries',
          table: v1Schema.countries,
        })
      )
    ).toBe('throw');

    const defaultMissingColumnPolicy = scopeIsolationPolicy<
      AppPolicyContext,
      typeof v1Schema
    >({
      column: 'tenantId',
      getScopeValue: ctx => ctx.tenantId,
    });

    expect(
      defaultMissingColumnPolicy.options.appliesTo?.(
        policyArgs('read', {
          tableKey: 'countries',
          tableName: 'countries',
          table: v1Schema.countries,
        })
      )
    ).toBe(false);

    const permissiveMismatchPolicy = scopeIsolationPolicy<
      AppPolicyContext,
      typeof v1Schema
    >({
      column: 'tenantId',
      getScopeValue: ctx => ctx.tenantId,
      onScopeValueMismatch: 'allow',
    });

    expect(
      permissiveMismatchPolicy.options.insert?.(
        policyArgs('insert', {
          values: [
            {
              id: 'project_1',
              tenantId: 'tenant_2',
            },
            {
              id: 'project_2',
            },
          ],
        })
      )
    ).toEqual([
      {
        id: 'project_1',
        tenantId: 'tenant_2',
      },
      {
        id: 'project_2',
        tenantId: 'tenant_1',
      },
    ]);

    expect(
      permissiveMismatchPolicy.options.update?.(
        policyArgs('update', {
          set: {
            tenantId: 'tenant_2',
          },
        })
      )
    ).toMatchObject({
      set: {
        tenantId: 'tenant_2',
      },
    });

    const strictMismatchPolicy = scopeIsolationPolicy<
      AppPolicyContext,
      typeof v1Schema
    >({
      column: 'tenantId',
      getScopeValue: ctx => ctx.tenantId,
    });

    expect(
      strictMismatchPolicy.options.insert?.(
        policyArgs('insert', {
          values: [
            {
              id: 'project_1',
              tenantId: 'tenant_2',
            },
          ],
        })
      )
    ).toBe('throw');
  });

  test('soft delete resolves missing columns and soft-delete update actions', () => {
    const strictPolicy = softDeletePolicy<typeof v1Schema>({
      onTableWithoutDeletedColumn: 'throw',
    });

    expect(
      strictPolicy.options.appliesTo?.(
        policyArgs('read', {
          tableKey: 'countries',
          tableName: 'countries',
          table: v1Schema.countries,
        })
      )
    ).toBe('throw');
    expect(() =>
      strictPolicy.options.read?.(
        policyArgs('read', {
          tableKey: 'countries',
          tableName: 'countries',
          table: v1Schema.countries,
        })
      )
    ).toThrow('Policy references missing column "deletedAt".');

    const defaultPolicy = softDeletePolicy<typeof v1Schema>();
    expect(
      defaultPolicy.options.appliesTo?.(
        policyArgs('read', {
          tableKey: 'countries',
          tableName: 'countries',
          table: v1Schema.countries,
        })
      )
    ).toBe(false);

    const deletedAt = new Date('2026-02-03T04:05:06.000Z');
    const softDelete = softDeletePolicy<typeof v1Schema>({
      deleteBehavior: 'softDelete',
      deletedValue: () => deletedAt,
    });

    expect(softDelete.options.delete?.(policyArgs('delete'))).toEqual({
      action: 'update',
      set: {
        deletedAt,
      },
    });
  });
});

const policyStacks = [
  {
    name: 'v0',
    engine: v0Engine,
    runtime: v0Runtime,
  },
  {
    name: 'v1',
    engine: v1Engine,
    runtime: v1Runtime,
  },
] as const;

for (const { name, engine, runtime } of policyStacks) {
  const engineApi = engine as any;
  const runtimeApi = runtime as any;

  describe(`${name} policy runtime and evaluator coverage`, () => {
    test('filters policies and resolves applies/context/raw decisions', () => {
      const readPolicy = definePolicy({
        name: 'read-policy',
        read: () => 'ignore' as const,
      });
      const throwingAppliesPolicy = definePolicy({
        name: 'throwing-applies',
        appliesTo: () => 'throw' as const,
        read: () => 'ignore' as const,
      });
      const ignoringAppliesPolicy = definePolicy({
        name: 'ignoring-applies',
        appliesTo: () => 'ignore' as const,
        read: () => 'ignore' as const,
      });
      const falseAppliesPolicy = definePolicy({
        name: 'false-applies',
        appliesTo: () => false,
        read: () => 'ignore' as const,
      });
      const defaultAppliesPolicy = definePolicy({
        name: 'default-applies',
        read: () => 'ignore' as const,
      });

      expect(
        runtimeApi.getPolicies([readPolicy, null, { name: 'fake' }])
      ).toEqual([readPolicy]);
      expect(() =>
        runtimeApi.policyApplies(
          createRuntime([throwingAppliesPolicy]),
          throwingAppliesPolicy,
          projectTable,
          'read'
        )
      ).toThrow('Policy "throwing-applies" rejected read.');
      expect(
        runtimeApi.policyApplies(
          createRuntime([throwingAppliesPolicy]),
          throwingAppliesPolicy,
          projectTable,
          'read',
          { disabled: true }
        )
      ).toBe(true);
      expect(
        runtimeApi.policyApplies(
          createRuntime([ignoringAppliesPolicy]),
          ignoringAppliesPolicy,
          projectTable,
          'read'
        )
      ).toBe(false);
      expect(
        runtimeApi.policyApplies(
          createRuntime([falseAppliesPolicy]),
          falseAppliesPolicy,
          projectTable,
          'read'
        )
      ).toBe(false);
      expect(
        runtimeApi.policyApplies(
          createRuntime([defaultAppliesPolicy]),
          defaultAppliesPolicy,
          projectTable,
          'read'
        )
      ).toBe(true);

      expect(
        runtimeApi.getHookContext(
          createRuntime([readPolicy]),
          readPolicy,
          projectTable,
          'read'
        )
      ).toEqual({
        decision: 'use',
        value: undefined,
      });

      const missingContextIgnorePolicy = definePolicy({
        name: 'missing-ignore',
        onMissingContext: 'ignore',
        read: () => 'ignore' as const,
      });
      expect(
        runtimeApi.getHookContext(
          createRuntime([missingContextIgnorePolicy]),
          missingContextIgnorePolicy,
          projectTable,
          'read'
        )
      ).toEqual({
        decision: 'ignore',
      });

      const missingContextThrowPolicy = definePolicy({
        name: 'missing-throw',
        onMissingContext: () => 'throw' as const,
        read: () => 'ignore' as const,
      });
      expect(() =>
        runtimeApi.getHookContext(
          createRuntime([missingContextThrowPolicy]),
          missingContextThrowPolicy,
          projectTable,
          'read'
        )
      ).toThrow('Policy "missing-throw" requires context.');

      expect(() =>
        runtimeApi.enforceNoPolicyMatched(
          createRuntime([], { onNoPolicyMatched: 'throw' }),
          projectTable,
          'read'
        )
      ).toThrow('No policy matched read on "projects".');

      const events: unknown[] = [];
      engineApi.enforceRawExecution(
        createRuntime([], {
          ctx: appContext,
          trace: event => events.push(event),
          rawExecution: ({ method, args, ctx }: any) =>
            method === 'execute' && args[0] === 'select 1' && ctx === appContext
              ? 'allow'
              : 'throw',
        }),
        'execute',
        ['select 1']
      );
      engineApi.enforceRawExecution(
        createRuntime([], {
          rawAllowed: true,
          trace: event => events.push(event),
          rawExecution: () => 'throw',
        }),
        'execute',
        ['select 2']
      );

      expect(events).toEqual([
        {
          kind: 'raw-execution',
          method: 'execute',
          decision: 'allow',
        },
        {
          kind: 'raw-execution',
          method: 'execute',
          decision: 'allow',
        },
      ]);
      expect(() =>
        engineApi.enforceRawExecution(
          createRuntime([], { rawExecution: 'throw' }),
          'execute',
          []
        )
      ).toThrow('Raw execution through Drizzle Policy is not allowed.');
    });

    test('evaluates ignored, transformed, disabled, and rejected policy hooks', () => {
      const readPlan = engineApi.evaluateReadPolicies(
        createRuntime([
          definePolicy({
            name: 'read-ignore',
            read: () => 'ignore' as const,
          }),
          definePolicy({
            name: 'read-undefined',
            read: () => undefined,
          }),
          definePolicy({
            name: 'read-predicate',
            read: () => 'read-predicate' as any,
          }),
        ]),
        projectTable
      );
      expect(readPlan).toEqual({
        predicates: ['read-predicate'],
        matched: true,
      });
      expect(() =>
        engineApi.evaluateReadPolicies(
          createRuntime([
            definePolicy({
              name: 'read-throw',
              read: () => 'throw' as const,
            }),
          ]),
          projectTable
        )
      ).toThrow('Policy "read-throw" rejected read.');

      const insertPlan = engineApi.evaluateInsertPolicies(
        createRuntime([
          definePolicy({
            name: 'insert-ignore',
            insert: () => 'ignore' as const,
          }),
          definePolicy({
            name: 'insert-undefined',
            insert: () => undefined,
          }),
          definePolicy({
            name: 'insert-transform',
            insert: ({ values }: any) => ({
              ...(values as Record<string, unknown>),
              touched: true,
            }),
          }),
        ]),
        projectTable,
        {
          id: 'project_1',
        }
      );
      expect(insertPlan).toEqual({
        values: {
          id: 'project_1',
          touched: true,
        },
        matched: true,
      });
      expect(() =>
        engineApi.evaluateInsertPolicies(
          createRuntime([
            definePolicy({
              name: 'insert-throw',
              insert: () => 'throw' as const,
            }),
          ]),
          projectTable,
          {}
        )
      ).toThrow('Policy "insert-throw" rejected insert.');

      const updatePlan = engineApi.evaluateUpdatePolicies(
        createRuntime([
          definePolicy({
            name: 'update-ignore',
            update: () => 'ignore' as const,
          }),
          definePolicy({
            name: 'update-undefined',
            update: () => undefined,
          }),
          definePolicy({
            name: 'update-set',
            update: ({ set }: any) => ({
              set: {
                ...(set as Record<string, unknown>),
                touched: true,
              },
            }),
          }),
          definePolicy({
            name: 'update-where',
            update: () => ({
              where: 'where-predicate' as any,
            }),
          }),
          definePolicy({
            name: 'update-predicate',
            update: () => 'bare-predicate' as any,
          }),
        ]),
        projectTable,
        {
          name: 'Launch',
        }
      );
      expect(updatePlan).toEqual({
        set: {
          name: 'Launch',
          touched: true,
        },
        predicates: ['where-predicate', 'bare-predicate'],
        matched: true,
      });
      expect(() =>
        engineApi.evaluateUpdatePolicies(
          createRuntime([
            definePolicy({
              name: 'update-throw',
              update: () => 'throw' as const,
            }),
          ]),
          projectTable,
          {}
        )
      ).toThrow('Policy "update-throw" rejected update.');

      const deletePlan = engineApi.evaluateDeletePolicies(
        createRuntime([
          definePolicy({
            name: 'delete-ignore',
            delete: () => 'ignore' as const,
          }),
          definePolicy({
            name: 'delete-undefined',
            delete: () => undefined,
          }),
          definePolicy({
            name: 'delete-update-one',
            delete: () => ({
              action: 'update' as const,
              set: {
                deletedAt: 'now',
              },
            }),
          }),
          definePolicy({
            name: 'delete-update-two',
            delete: () => ({
              action: 'update' as const,
              set: {
                archivedBy: 'user_1',
              },
            }),
          }),
          definePolicy({
            name: 'delete-predicate',
            delete: () => 'delete-predicate' as any,
          }),
        ]),
        projectTable
      );
      expect(deletePlan).toEqual({
        predicates: ['delete-predicate'],
        updateSet: {
          deletedAt: 'now',
          archivedBy: 'user_1',
        },
        matched: true,
      });
      expect(() =>
        engineApi.evaluateDeletePolicies(
          createRuntime([
            definePolicy({
              name: 'delete-throw',
              delete: () => 'throw' as const,
            }),
          ]),
          projectTable
        )
      ).toThrow('Policy "delete-throw" rejected delete.');

      const missingContextPolicy = definePolicy({
        name: 'missing-context',
        onMissingContext: 'ignore',
        read: () => 'should-not-run' as any,
        insert: () => 'should-not-run' as any,
        update: () => 'should-not-run' as any,
        delete: () => 'should-not-run' as any,
      });
      expect(
        engineApi.evaluateReadPolicies(
          createRuntime([missingContextPolicy]),
          projectTable
        )
      ).toEqual({
        predicates: [],
        matched: false,
      });
      expect(
        engineApi.evaluateInsertPolicies(
          createRuntime([missingContextPolicy]),
          projectTable,
          {
            id: 'project_1',
          }
        )
      ).toEqual({
        values: {
          id: 'project_1',
        },
        matched: false,
      });
      expect(
        engineApi.evaluateUpdatePolicies(
          createRuntime([missingContextPolicy]),
          projectTable,
          {
            name: 'Launch',
          }
        )
      ).toEqual({
        set: {
          name: 'Launch',
        },
        predicates: [],
        matched: false,
      });
      expect(
        engineApi.evaluateDeletePolicies(
          createRuntime([missingContextPolicy]),
          projectTable
        )
      ).toEqual({
        predicates: [],
        matched: false,
      });

      const disabledPolicies = [
        definePolicy({
          name: 'disabled-read',
          read: () => 'throw' as const,
        }),
        definePolicy({
          name: 'disabled-insert',
          insert: () => 'throw' as const,
        }),
        definePolicy({
          name: 'disabled-update',
          update: () => 'throw' as const,
        }),
        definePolicy({
          name: 'disabled-delete',
          delete: () => 'throw' as const,
        }),
      ];
      const disabledRuntime = createRuntime(disabledPolicies, {
        disabled: disabledPolicies.map(policy => policy.name),
        onNoPolicyMatched: 'throw',
      });

      expect(
        engineApi.evaluateReadPolicies(disabledRuntime, projectTable)
      ).toEqual({
        predicates: [],
        matched: false,
      });
      expect(
        engineApi.evaluateInsertPolicies(disabledRuntime, projectTable, {
          id: 'project_1',
        })
      ).toEqual({
        values: {
          id: 'project_1',
        },
        matched: false,
      });
      expect(
        engineApi.evaluateUpdatePolicies(disabledRuntime, projectTable, {
          name: 'Launch',
        })
      ).toEqual({
        set: {
          name: 'Launch',
        },
        predicates: [],
        matched: false,
      });
      expect(
        engineApi.evaluateDeletePolicies(disabledRuntime, projectTable)
      ).toEqual({
        predicates: [],
        matched: false,
      });
    });
  });
}

describe('coverage-focused table registries', () => {
  test('v0 registry resolves query-root tables and fallback names', () => {
    const registry = createV0TableRegistry({
      ignored: null,
      ignoredArray: [v0Schema.projects],
      missingTable: {},
      badTable: {
        table: {},
      },
      badConfigTable: {
        tableConfig: [],
      },
      projects: {
        table: v0Schema.projects,
      },
      tasks: {
        tableConfig: {
          table: v0Schema.tasks,
        },
      },
    });

    expect(registry.resolve(v0Schema.projects)).toMatchObject({
      tableKey: 'projects',
      tableName: 'projects',
    });
    expect(registry.resolve(v0Schema.tasks, 'tasks')).toMatchObject({
      tableKey: 'tasks',
      tableName: 'tasks',
    });
    expect(
      registry.resolve(v0Schema.projects, 'public.projects')
    ).toMatchObject({
      tableKey: 'projects',
      tableName: 'projects',
    });
    expect(registry.resolve({}, 'manual')).toMatchObject({
      tableKey: 'manual',
      tableName: 'manual',
    });
    expect(registry.resolve(123)).toMatchObject({
      tableKey: 'unknown',
      tableName: 'unknown',
      table: 123,
    });
    expect(registry.resolve(undefined)).toMatchObject({
      tableKey: 'unknown',
      tableName: 'unknown',
      table: undefined,
    });
  });

  test('v1 registry resolves query-root tables and fallback names', () => {
    const registry = createV1TableRegistry({
      ignored: null,
      ignoredArray: [v1Schema.projects],
      missingTable: {},
      badTable: {
        table: {},
      },
      badConfigTable: {
        tableConfig: [],
      },
      projects: {
        table: v1Schema.projects,
      },
      tasks: {
        tableConfig: {
          table: v1Schema.tasks,
        },
      },
    });

    expect(registry.resolve(v1Schema.projects)).toMatchObject({
      tableKey: 'projects',
      tableName: 'projects',
    });
    expect(registry.resolve(v1Schema.tasks, 'tasks')).toMatchObject({
      tableKey: 'tasks',
      tableName: 'tasks',
    });
    expect(
      registry.resolve(v1Schema.projects, 'public.projects')
    ).toMatchObject({
      tableKey: 'projects',
      tableName: 'projects',
    });
    expect(registry.resolve({}, 'manual')).toMatchObject({
      tableKey: 'manual',
      tableName: 'manual',
    });
    expect(registry.resolve(123)).toMatchObject({
      tableKey: 'unknown',
      tableName: 'unknown',
      table: 123,
    });
    expect(registry.resolve(undefined)).toMatchObject({
      tableKey: 'unknown',
      tableName: 'unknown',
      table: undefined,
    });
  });
});

const sqlBuilderStacks = [
  {
    name: 'v0',
    builders: v0SqlBuilders,
  },
  {
    name: 'v1',
    builders: v1SqlBuilders,
  },
] as const;

for (const { name, builders } of sqlBuilderStacks) {
  describe(`${name} SQL builder wrapper coverage`, () => {
    const tables = {
      resolve: (table: unknown, tableKeyHint?: string) => ({
        tableKey: tableKeyHint ?? 'projects',
        tableName: tableKeyHint ?? 'projects',
        table,
      }),
    } as any;

    test('returns untouched properties and rejects unexpected builder shapes', () => {
      expect(
        (
          builders.wrapSelectBuilder(
            {
              label: 'select-builder',
            },
            createRuntime([]),
            tables
          ) as any
        ).label
      ).toBe('select-builder');
      expect(
        (
          builders.wrapInsertBuilder(
            {
              label: 'insert-builder',
            },
            createRuntime([]),
            projectTable as any
          ) as any
        ).label
      ).toBe('insert-builder');
      expect(
        (
          builders.wrapUpdateBuilder(
            {
              label: 'update-builder',
            },
            createRuntime([]),
            projectTable as any
          ) as any
        ).label
      ).toBe('update-builder');

      expect(() =>
        (
          builders.wrapSelectBuilder(
            {
              from: () => null,
            },
            createRuntime([]),
            tables
          ) as any
        ).from(v1Schema.projects)
      ).toThrow('Expected Drizzle select.from() to return an object.');

      expect(() =>
        (
          builders.wrapUpdateBuilder(
            {
              set: () => null,
            },
            createRuntime([]),
            projectTable as any
          ) as any
        ).set({})
      ).toThrow('Expected Drizzle update.set() to return an object.');
    });

    test('applies where predicates once and preserves fluent query methods', () => {
      let predicateCalls = 0;
      const query = {
        config: {} as Record<string, unknown>,
        toSQL: 'sql',
      };
      const wrapped = builders.wrapWhereQuery(query, () => {
        predicateCalls += 1;
        return ['tenant-filter'];
      }) as any;

      expect(wrapped.toSQL).toBe('sql');
      expect(wrapped.toSQL).toBe('sql');
      expect(predicateCalls).toBe(1);
      expect(query.config.where).toBe('tenant-filter');

      const fluentQuery = {
        config: {},
        chain() {
          return fluentQuery;
        },
        done() {
          return 'done';
        },
      };
      const fluent = builders.wrapWhereQuery(fluentQuery, []) as any;

      expect(fluent.chain()).toBe(fluent);
      expect(fluent.done()).toBe('done');

      expect(() => (builders.wrapWhereQuery({}, []) as any).toSQL).toThrow(
        'Unable to inspect Drizzle query builder config.'
      );
    });

    test('handles intercepted join calls and missing join methods', () => {
      const interceptedTarget = {
        config: {},
        join() {
          return interceptedTarget;
        },
      };
      const intercepted = builders.wrapWhereQuery(interceptedTarget, [], {
        interceptCall: () => ({
          handled: true,
          result: interceptedTarget,
        }),
      }) as any;
      const interceptedResult = builders.wrapWhereQuery(interceptedTarget, [], {
        interceptCall: () => ({
          handled: true,
          result: 'handled',
        }),
      }) as any;

      expect(intercepted.join()).toBe(intercepted);
      expect(interceptedResult.join()).toBe('handled');

      const joinQuery = {
        config: {},
        innerJoin() {
          return joinQuery;
        },
      } as {
        config: Record<string, unknown>;
        innerJoin?: () => unknown;
      };
      const wrappedSelect = builders.wrapSelectBuilder(
        {
          from: () => joinQuery,
        },
        createRuntime([]),
        tables
      ) as any;
      const readQuery = wrappedSelect.from(v1Schema.projects);
      const innerJoin = readQuery.innerJoin;
      delete joinQuery.innerJoin;

      expect(() => innerJoin(v1Schema.tasks, undefined)).toThrow(
        'Expected Drizzle builder method innerJoin().'
      );
    });
  });
}

describe('coverage-focused relational wrappers', () => {
  test('v0 relational wrapper preserves non-query members and unresolved nested relations', () => {
    let capturedConfig: any;
    let capturedNoRelationsConfig: any;
    const projectBuilder = {
      table: v0Schema.projects,
      tableConfig: {
        relations: {
          missingTable: {},
          missingBuilder: {
            referencedTable: v0Schema.tasks,
          },
        },
      },
      count: () => 'count',
      findMany(config: unknown) {
        capturedConfig = config;
        return {
          config,
        };
      },
    };
    const queryRoot = {
      primitive: 'value',
      projects: projectBuilder,
    };
    const wrapped = v0Relational.wrapRelationalQueryRoot(
      queryRoot,
      createRuntime([]),
      createV0TableRegistry({
        projects: {
          table: v0Schema.projects,
        },
      })
    ) as any;

    expect(wrapped.primitive).toBe('value');
    expect(wrapped.projects.count()).toBe('count');

    wrapped.projects.findMany({
      with: {
        missingTable: true,
        missingBuilder: {
          limit: 1,
        },
      },
    });

    expect(capturedConfig.with).toEqual({
      missingTable: true,
      missingBuilder: {
        limit: 1,
      },
    });

    const noRelationsBuilder = {
      table: v0Schema.projects,
      findMany(config: unknown) {
        capturedNoRelationsConfig = config;
        return {
          config,
        };
      },
    };
    const noRelationsWrapped = v0Relational.wrapRelationalQueryRoot(
      {
        projects: noRelationsBuilder,
      },
      createRuntime([]),
      createV0TableRegistry({
        projects: {
          table: v0Schema.projects,
        },
      })
    ) as any;

    noRelationsWrapped.projects.findMany({
      with: {
        tasks: true,
      },
    });

    expect(capturedNoRelationsConfig.with).toEqual({
      tasks: true,
    });
  });

  test('v1 relational wrapper preserves non-query members and unresolved nested relations', () => {
    let capturedConfig: any;
    let capturedNoRelationsConfig: any;
    const projectBuilder = {
      table: v1Schema.projects,
      tableConfig: {
        relations: {
          missingTable: {},
          missingBuilder: {
            targetTable: v1Schema.tasks,
            targetTableName: 'tasks',
          },
        },
      },
      count: () => 'count',
      findMany(config: unknown) {
        capturedConfig = config;
        return {
          config,
        };
      },
    };
    const queryRoot = {
      primitive: 'value',
      projects: projectBuilder,
    };
    const wrapped = v1Relational.wrapRelationalQueryRoot(
      queryRoot,
      createRuntime([]),
      createV1TableRegistry({
        projects: {
          table: v1Schema.projects,
        },
      })
    ) as any;

    expect(wrapped.primitive).toBe('value');
    expect(wrapped.projects.count()).toBe('count');

    wrapped.projects.findMany({
      with: {
        missingTable: true,
        missingBuilder: {
          limit: 1,
        },
      },
    });

    expect(capturedConfig.with).toEqual({
      missingTable: true,
      missingBuilder: {
        limit: 1,
      },
    });

    const noRelationsBuilder = {
      table: v1Schema.projects,
      findMany(config: unknown) {
        capturedNoRelationsConfig = config;
        return {
          config,
        };
      },
    };
    const noRelationsWrapped = v1Relational.wrapRelationalQueryRoot(
      {
        projects: noRelationsBuilder,
      },
      createRuntime([]),
      createV1TableRegistry({
        projects: {
          table: v1Schema.projects,
        },
      })
    ) as any;

    noRelationsWrapped.projects.findMany({
      with: {
        tasks: true,
      },
    });

    expect(capturedNoRelationsConfig.with).toEqual({
      tasks: true,
    });
  });
});

const clientStacks = [
  {
    name: 'v0',
    createPolicyClient: createV0PolicyClient,
    table: v0Schema.projects,
  },
  {
    name: 'v1',
    createPolicyClient: createV1PolicyClient,
    table: v1Schema.projects,
  },
] as const;

for (const { name, createPolicyClient: createClient, table } of clientStacks) {
  describe(`${name} client proxy edge coverage`, () => {
    test('generated contexts, helper scopes, passthrough methods, and transaction fallback work', () => {
      const generated = (createClient as any)(
        {
          select: () => 'select',
        },
        {
          policies: [],
        }
      );

      expect(generated.policyContext.get()).toBeUndefined();
      generated.policyContext.run(appContext, () => {
        expect(generated.db.getPolicyContext()).toEqual(appContext);
      });

      const rawDb = {
        marker: 'raw-db',
        query: null,
        custom() {
          return this.marker;
        },
        transaction(callback: unknown, ...args: readonly unknown[]) {
          return {
            callback,
            args,
          };
        },
      };
      const { db } = (createClient as any)(rawDb, {
        getContext: () => appContext,
        policies: [],
      });

      expect(db.query).toBeNull();
      expect(db.custom()).toBe('raw-db');
      expect(
        db.withPolicyContext(
          {
            ...appContext,
            tenantId: 'tenant_2',
          },
          (scopedDb: any) => scopedDb.getPolicyContext()
        )
      ).toEqual({
        ...appContext,
        tenantId: 'tenant_2',
      });
      expect(
        db.withPoliciesDisabled(['legacy'], (scopedDb: any) =>
          scopedDb.getPolicyContext()
        )
      ).toEqual(appContext);
      expect(db.unsafe({}).custom()).toBe('raw-db');
      expect(db.transaction('not-a-callback', 'arg')).toEqual({
        callback: 'not-a-callback',
        args: ['arg'],
      });
    });

    test('delete wrapper reports unexpected raw builder shapes', () => {
      const predicatePolicy = definePolicy({
        name: 'delete-predicate',
        delete: () => 'delete-predicate' as any,
      });
      const nullDeleteClient = (createClient as any)(
        {
          delete: () => null,
        },
        {
          getContext: () => appContext,
          policies: [predicatePolicy],
        }
      ).db;

      expect(() => nullDeleteClient.delete(table)).toThrow(
        'Expected Drizzle builder method to return an object.'
      );

      const softDeletePolicy = definePolicy({
        name: 'soft-delete-action',
        delete: () => ({
          action: 'update' as const,
          set: {
            deletedAt: 'now',
          },
        }),
      });
      const missingUpdateClient = (createClient as any)(
        {
          delete: () => ({
            config: {},
          }),
        },
        {
          getContext: () => appContext,
          policies: [softDeletePolicy],
        }
      ).db;

      expect(() => missingUpdateClient.delete(table)).toThrow(
        'Drizzle client does not expose update().'
      );

      const missingSetClient = (createClient as any)(
        {
          update: () => ({}),
          delete: () => ({
            config: {},
          }),
        },
        {
          getContext: () => appContext,
          policies: [softDeletePolicy],
        }
      ).db;

      expect(() => missingSetClient.delete(table)).toThrow(
        'Drizzle builder does not expose set().'
      );
    });
  });
}

describe('coverage-focused public client helpers', () => {
  test('generated contexts are returned when no external reader is provided', () => {
    const policies = definePolicies<AppPolicyContext>()(() => []);
    const result = createPolicyClient(
      {
        select: () => 'select',
      },
      {
        policies,
      }
    );

    expect(result.policyContext.get()).toBeUndefined();
    result.policyContext.run(appContext, () => {
      expect(result.db.getPolicyContext()).toEqual(appContext);
    });
  });
});
