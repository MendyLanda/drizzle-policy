import { describe, expect, test } from 'bun:test';

import {
  createPolicyClient as createV1PolicyClient,
  DrizzlePolicyError,
} from '../src';
import { createPolicyClient as createV0PolicyClient } from '../src/v0';

type ClientFactory = (
  db: object,
  options: {
    readonly policies: readonly [];
    readonly rawExecution?: 'allow';
  }
) => { readonly db: any };

const clients: readonly {
  readonly name: string;
  readonly createPolicyClient: ClientFactory;
}[] = [
  {
    name: 'v0',
    createPolicyClient: createV0PolicyClient as ClientFactory,
  },
  {
    name: 'v1',
    createPolicyClient: createV1PolicyClient as ClientFactory,
  },
];

const rawExecutionMethods = [
  'execute',
  'run',
  'all',
  'get',
  'values',
  'batch',
] as const;

for (const { name, createPolicyClient } of clients) {
  describe(`${name} client hardening`, () => {
    test('refuses unsupported query and raw-handle surfaces', () => {
      const rawDb = Object.fromEntries(
        [
          'with',
          '$with',
          'refreshMaterializedView',
          '$count',
          '$client',
          '$cache',
          '_',
          'session',
          'dialect',
          'authToken',
          'tagged',
        ].map(surface => [surface, { raw: surface }])
      );
      const { db } = createPolicyClient(rawDb, { policies: [] });

      for (const surface of Object.keys(rawDb)) {
        const value = db[surface];
        expect(typeof value).toBe('function');
        expect(value).toThrow(DrizzlePolicyError);

        const descriptor = Reflect.getOwnPropertyDescriptor(db, surface);
        expect(typeof descriptor?.value).toBe('function');
        expect(descriptor?.value).toThrow(DrizzlePolicyError);
      }
    });

    test('guards every direct raw execution method', async () => {
      const calls: string[] = [];
      const rawDb = Object.fromEntries(
        rawExecutionMethods.map(method => [
          method,
          () => {
            calls.push(method);
            return method === 'run' ? method : Promise.resolve(method);
          },
        ])
      );
      const { db } = createPolicyClient(rawDb, { policies: [] });

      for (const method of rawExecutionMethods) {
        expect(() => db[method]()).toThrow(
          'Raw execution through Drizzle Policy is not allowed.'
        );

        const descriptor = Reflect.getOwnPropertyDescriptor(db, method);
        expect(() => descriptor?.value()).toThrow(
          'Raw execution through Drizzle Policy is not allowed.'
        );
      }
      expect(calls).toEqual([]);

      const unsafeDb = db.unsafe({ execute: true });
      for (const method of rawExecutionMethods) {
        expect(await unsafeDb[method]()).toBe(method);
      }
      expect(calls).toEqual([...rawExecutionMethods]);
    });

    test('guards raw clients exposed by replica accessors', async () => {
      const rawPrimary = {
        execute: () => Promise.resolve('primary'),
      };
      const rawReplica = {
        execute: () => Promise.resolve('replica'),
      };
      const rawDb = {
        $primary: rawPrimary,
        $replicas: [rawReplica],
      };
      const { db } = createPolicyClient(rawDb, { policies: [] });

      expect(db.$primary).not.toBe(rawPrimary);
      expect(db.$replicas[0]).not.toBe(rawReplica);
      expect(Reflect.set(db.$replicas, 0, rawReplica)).toBe(false);
      expect(db.$replicas[0]).not.toBe(rawReplica);
      expect(() => db.$primary.execute()).toThrow(
        'Raw execution through Drizzle Policy is not allowed.'
      );
      expect(() => db.$replicas[0].execute()).toThrow(
        'Raw execution through Drizzle Policy is not allowed.'
      );

      const unsafeDb = db.unsafe({ execute: true });
      await expect(unsafeDb.$primary.execute()).resolves.toBe('primary');
      await expect(unsafeDb.$replicas[0].execute()).resolves.toBe('replica');
    });

    test('prevents replacement of protected client surfaces', () => {
      const rawDb = {
        select: () => ({ raw: true }),
        execute: () => Promise.resolve('raw'),
      };
      const { db } = createPolicyClient(rawDb, { policies: [] });

      expect(() => Reflect.set(db, 'select', rawDb.select)).toThrow(
        DrizzlePolicyError
      );
      expect(() =>
        Reflect.defineProperty(db, 'execute', { value: rawDb.execute })
      ).toThrow(DrizzlePolicyError);
      expect(() => Reflect.deleteProperty(db, 'select')).toThrow(
        DrizzlePolicyError
      );

      expect(Reflect.set(db, 'extension', 'value')).toBe(true);
      expect(
        Reflect.defineProperty(db, 'anotherExtension', {
          configurable: true,
          value: 'another value',
        })
      ).toBe(true);
      expect(Reflect.deleteProperty(db, 'anotherExtension')).toBe(true);
    });
  });
}
