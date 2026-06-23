import type {
  CompatiblePolicy,
  DefinePolicyOptions,
  MaybeSchema,
  Policy,
  PolicyBuilder,
  PolicyNames,
  PolicySet,
} from './types.js';

/**
 * Policy value used for contextual typing without widening literal names.
 */
type NameAgnosticCompatiblePolicy<
  TContext,
  TSchema extends MaybeSchema,
> = CompatiblePolicy<TContext, TSchema, any, any>;

/**
 * Builder returned when you call `definePolicies<TContext, TSchema>()` without
 * a callback.
 *
 * Use it to set context and schema generics once, then define policies with
 * those types already applied.
 *
 * @example
 * ```ts
 * const defineAppPolicies = definePolicies<AppPolicyContext, typeof schema>();
 *
 * export const policies = defineAppPolicies(policy => [
 *   policy.define({ name: 'no-deletes', delete: () => 'throw' }),
 * ]);
 * ```
 */
export interface DefinePoliciesForContext<
  TContext,
  TSchema extends MaybeSchema,
> {
  /**
   * Builds a readonly policy set.
   *
   * The returned policy set preserves literal names for
   * `unsafe({ policies: [...] })` autocomplete.
   */
  <
    const TPolicies extends readonly NameAgnosticCompatiblePolicy<
      TContext,
      TSchema
    >[],
  >(
    build: (policy: PolicyBuilder<TContext, TSchema>) => TPolicies
  ): PolicySet<TContext, TSchema, PolicyNames<TPolicies>>;
}

/**
 * Defines one policy.
 *
 * Use this for a reusable standalone policy. For app-local policies,
 * `definePolicies` is usually more convenient because it applies the context
 * and schema generics once for the whole policy set.
 *
 * @example
 * ```ts
 * const noDeletes = definePolicy({
 *   name: 'no-deletes',
 *   delete: () => 'throw',
 * });
 * ```
 */
export function definePolicy<
  TContext = unknown,
  TSchema extends MaybeSchema = undefined,
  TName extends string = string,
>(
  options: DefinePolicyOptions<TContext, TSchema, TName>
): Policy<TContext, TSchema, TName> {
  return Object.freeze({
    __drizzlePolicy: true,
    name: options.name,
    options,
  });
}

/**
 * Creates the `policy.define(...)` helper used by `definePolicies`.
 *
 * Library authors can use this when building a custom policy-set factory. Most
 * applications should call `definePolicies` instead.
 */
export const createPolicyBuilder = <
  TContext,
  TSchema extends MaybeSchema,
>(): PolicyBuilder<TContext, TSchema> => {
  return {
    define<TName extends string>(
      options: DefinePolicyOptions<TContext, TSchema, TName>
    ) {
      return definePolicy<TContext, TSchema, TName>(options);
    },
  };
};

/**
 * Creates a policy-set builder with context and schema generics applied.
 *
 * @example
 * ```ts
 * const defineAppPolicies = definePolicies<AppPolicyContext>();
 * const policies = defineAppPolicies(policy => [
 *   policy.define({ name: 'no-deletes', delete: () => 'throw' }),
 * ]);
 * ```
 */
export function definePolicies<
  TContext = unknown,
  TSchema extends MaybeSchema = undefined,
>(): DefinePoliciesForContext<TContext, TSchema>;
/**
 * Creates a readonly policy set.
 *
 * Use the optional schema generic when you want `tableKey` decision maps to
 * autocomplete table exports from your Drizzle schema.
 *
 * @example
 * ```ts
 * import type * as schema from './schema';
 *
 * const policies = definePolicies<AppPolicyContext, typeof schema>(policy => [
 *   policy.define({
 *     name: 'visible-projects',
 *     appliesTo: ({ tableKey }) => tableKey === 'projects',
 *     read: ({ table, ctx }) =>
 *       eq((table as typeof schema.projects).ownerId, ctx?.userId),
 *   }),
 * ]);
 * ```
 */
export function definePolicies<
  TContext = unknown,
  TSchema extends MaybeSchema = undefined,
  const TPolicies extends readonly NameAgnosticCompatiblePolicy<
    TContext,
    TSchema
  >[] = readonly NameAgnosticCompatiblePolicy<TContext, TSchema>[],
>(
  build: (policy: PolicyBuilder<TContext, TSchema>) => TPolicies
): PolicySet<TContext, TSchema, PolicyNames<TPolicies>>;
/**
 * Creates policy sets with either direct or curried call style.
 *
 * Direct style is concise for one module. Curried style is useful when several
 * files share the same context/schema generics.
 */
export function definePolicies<
  TContext = unknown,
  TSchema extends MaybeSchema = undefined,
>(
  build?: (
    policy: PolicyBuilder<TContext, TSchema>
  ) => readonly NameAgnosticCompatiblePolicy<TContext, TSchema>[]
):
  | PolicySet<TContext, TSchema, string>
  | DefinePoliciesForContext<TContext, TSchema> {
  if (build === undefined) {
    return ((nextBuild: unknown) => {
      return definePolicies(nextBuild as never) as unknown;
    }) as DefinePoliciesForContext<TContext, TSchema>;
  }

  const policies = [
    ...build(createPolicyBuilder<TContext, TSchema>()),
  ] as PolicySet<TContext, TSchema, string>;

  return Object.freeze(policies) as PolicySet<TContext, TSchema, string>;
}
