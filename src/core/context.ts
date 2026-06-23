import { AsyncLocalStorage } from 'node:async_hooks';

import { type PolicyContext, MissingPolicyContextError } from './types.js';

/**
 * Creates an async-local policy context store.
 *
 * Use this to make request or job context available to policy hooks without
 * passing it through every Drizzle call.
 *
 * `createPolicyClient` calls this for you unless you provide `getContext`.
 * Use this helper directly when the same context should be shared with code
 * outside Drizzle Policy.
 *
 * @example
 * ```ts
 * const policyContext = createPolicyContext<{ tenantId: string }>();
 *
 * await policyContext.run({ tenantId: 'tenant_123' }, async () => {
 *   return db.query.projects.findMany();
 * });
 * ```
 */
export const createPolicyContext = <TContext>(): PolicyContext<TContext> => {
  const storage = new AsyncLocalStorage<TContext>();

  return {
    run<TResult>(ctx: TContext, fn: () => TResult): TResult {
      return storage.run(ctx, fn);
    },

    get(): TContext | undefined {
      return storage.getStore();
    },

    getOrThrow(): TContext {
      const ctx = storage.getStore();
      if (ctx === undefined) {
        throw new MissingPolicyContextError();
      }

      return ctx;
    },
  };
};
