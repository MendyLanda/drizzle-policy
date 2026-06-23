import { createPolicyContext } from './context.js';
import { DrizzlePolicyError } from './types.js';

/**
 * Empty disabled-policy set returned when no policies are disabled.
 */
const EMPTY_DISABLED_POLICY_NAMES = new Set<string>();

/**
 * Permissions accepted by an unsafe policy scope at runtime.
 *
 * Arrays are shorthand for disabling policy names. Object form can also allow
 * raw execution.
 *
 * @example
 * ```ts
 * ['soft-delete']
 * { policies: ['scope-isolation'], execute: true }
 * ```
 */
export type UnsafeRuntimePermissions =
  | readonly string[]
  | {
      readonly policies?: readonly string[];
      readonly execute?: boolean;
    };

/**
 * Runtime permissions after validation and normalization.
 *
 * Duplicate policy names are removed and omitted options become their safe
 * defaults.
 */
export interface NormalizedUnsafePermissions {
  /**
   * Policy names to disable for an unsafe client or callback.
   *
   * @defaultValue `[]`
   */
  readonly policyNames: readonly string[];
  /**
   * Whether direct raw execution is allowed for an unsafe client or callback.
   *
   * @defaultValue `false`
   */
  readonly execute: boolean;
}

/**
 * Scoped helper for temporarily allowing unsafe policy-client operations.
 *
 * v0/v1 client wrappers use this to carry disabled policies and raw-execution
 * permissions through async callbacks, transactions, and nested unsafe clients.
 */
export interface PolicyDisableScope<TClient> {
  /**
   * Returns policy names disabled in the current async call chain.
   *
   * Includes permissions inherited from an outer policy client or transaction.
   */
  getDisabledPolicyNames(): ReadonlySet<string>;
  /**
   * Returns whether raw execution is allowed in the current async call chain.
   *
   * Includes permissions inherited from an outer unsafe scope.
   */
  isRawExecutionAllowed(): boolean;
  /**
   * Runs `fn` with the provided unsafe permissions.
   *
   * The callback receives the same client value, but policy evaluation reads
   * the temporary permissions from async-local storage.
   */
  unsafe<TResult>(
    permissions: UnsafeRuntimePermissions,
    client: TClient,
    fn: (db: TClient) => TResult
  ): TResult;
  /**
   * Runs `fn` with the provided policy names disabled.
   *
   * @deprecated Prefer `unsafe({ policies: [...] })` in public APIs.
   */
  withPoliciesDisabled<TResult>(
    policyNames: readonly string[],
    client: TClient,
    fn: (db: TClient) => TResult
  ): TResult;
}

/**
 * Creates a helper that grants unsafe permissions for one callback at a time.
 *
 * Inherited readers let transaction clients see the same permissions as their
 * parent client unless a nested unsafe scope extends them.
 */
export const createPolicyDisableScope = <TClient>(
  getInheritedDisabledPolicyNames?: () => ReadonlySet<string>,
  getInheritedRawExecutionAllowed?: () => boolean
): PolicyDisableScope<TClient> => {
  const disabledPolicyNames = createPolicyContext<ReadonlySet<string>>();
  const rawExecutionAllowed = createPolicyContext<boolean>();

  const getDisabledPolicyNames = () => {
    return (
      disabledPolicyNames.get() ??
      getInheritedDisabledPolicyNames?.() ??
      EMPTY_DISABLED_POLICY_NAMES
    );
  };

  const isRawExecutionAllowed = () => {
    return (
      rawExecutionAllowed.get() ?? getInheritedRawExecutionAllowed?.() ?? false
    );
  };

  const unsafe = <TResult>(
    permissions: UnsafeRuntimePermissions,
    client: TClient,
    fn: (db: TClient) => TResult
  ): TResult => {
    const normalized = normalizeUnsafePermissions(permissions);

    if (!normalized.execute && normalized.policyNames.length === 0) {
      return fn(client);
    }

    const nextDisabledPolicyNames =
      normalized.policyNames.length === 0
        ? getDisabledPolicyNames()
        : new Set([...getDisabledPolicyNames(), ...normalized.policyNames]);
    const nextRawExecutionAllowed =
      isRawExecutionAllowed() || normalized.execute;

    return disabledPolicyNames.run(nextDisabledPolicyNames, () =>
      rawExecutionAllowed.run(nextRawExecutionAllowed, () => fn(client))
    );
  };

  return {
    getDisabledPolicyNames,
    isRawExecutionAllowed,
    unsafe,
    withPoliciesDisabled<TResult>(
      policyNames: readonly string[],
      client: TClient,
      fn: (db: TClient) => TResult
    ): TResult {
      return unsafe(policyNames, client, fn);
    },
  };
};

/**
 * Normalizes permissions passed to `unsafe`.
 *
 * Returns safe defaults for omitted fields and throws `DrizzlePolicyError` for
 * invalid permission shapes.
 */
export const normalizeUnsafePermissions = (
  permissions: UnsafeRuntimePermissions
): NormalizedUnsafePermissions => {
  if (isPolicyNameArray(permissions)) {
    return {
      policyNames: normalizePolicyNames(permissions),
      execute: false,
    };
  }

  if (typeof permissions !== 'object' || permissions === null) {
    throw new DrizzlePolicyError('Unsafe permissions must be an object.');
  }

  if (
    permissions.policies !== undefined &&
    !Array.isArray(permissions.policies)
  ) {
    throw new DrizzlePolicyError('Unsafe policy names must be an array.');
  }

  if (
    permissions.execute !== undefined &&
    typeof permissions.execute !== 'boolean'
  ) {
    throw new DrizzlePolicyError(
      'Unsafe execute permission must be a boolean.'
    );
  }

  return {
    policyNames:
      permissions.policies === undefined
        ? []
        : normalizePolicyNames(permissions.policies),
    execute: permissions.execute === true,
  };
};

/**
 * Returns whether unsafe permissions used the policy-name shorthand.
 */
const isPolicyNameArray = (
  permissions: UnsafeRuntimePermissions
): permissions is readonly string[] => {
  return Array.isArray(permissions);
};

/**
 * Normalizes policy names passed to an unsafe policy scope.
 */
const normalizePolicyNames = (policyNames: readonly string[]): string[] => {
  const names = new Set<string>();

  for (const policyName of policyNames) {
    if (typeof policyName !== 'string') {
      throw new DrizzlePolicyError('Disabled policy names must be strings.');
    }

    names.add(policyName);
  }

  return [...names];
};
