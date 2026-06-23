import type { PolicyOperation } from '../core/types.js';

/**
 * Trace event emitted by a Drizzle v0 policy client.
 *
 * Use trace events while configuring policies to see which calls were checked
 * and what Drizzle Policy decided.
 *
 * @example
 * ```ts
 * createPolicyClient(db, {
 *   policies,
 *   trace: event => console.debug('[drizzle-policy]', event),
 * });
 * ```
 */
export type V0PolicyTraceEvent =
  | {
      /**
       * Emitted when code calls a top-level client method.
       *
       * This confirms that the call went through the policy-wrapped client.
       */
      readonly kind: 'client-call';
      /**
       * Client method name, such as `select`, `insert`, or `transaction`.
       */
      readonly method: string;
    }
  | {
      /**
       * Emitted after policies are applied to one table operation.
       *
       * One Drizzle call may produce multiple policy-plan events when it
       * touches joined or nested relational tables.
       */
      readonly kind: 'policy-plan';
      /**
       * Operation that was checked.
       *
       * `read` covers select builders and relational `findMany/findFirst`.
       */
      readonly operation: PolicyOperation;
      /**
       * Key of the table in the schema/query root.
       *
       * This is the schema export name when Drizzle Policy can resolve it.
       */
      readonly tableKey: string;
      /**
       * SQL-facing table name reported by Drizzle.
       */
      readonly tableName: string;
      /**
       * Whether at least one policy hook matched and contributed a result.
       *
       * `false` can still be acceptable when `onNoPolicyMatched` allows the
       * operation or when an enabled policy intentionally returned `ignore`.
       */
      readonly matched: boolean;
      /**
       * Number of predicates contributed by matching policies.
       */
      readonly predicateCount: number;
    }
  | {
      /**
       * Emitted when a raw execution method is checked.
       *
       * Raw execution is rejected by default unless the client option or an
       * unsafe scope allows it.
       */
      readonly kind: 'raw-execution';
      /**
       * Raw method name, such as `execute`.
       */
      readonly method: string;
      /**
       * Decision returned by the raw execution option.
       *
       * This is the final decision after considering active unsafe scopes.
       */
      readonly decision: 'allow' | 'throw';
    };

/**
 * Callback that receives v0 policy trace events.
 *
 * Keep this callback side-effect-light; it runs synchronously during query
 * construction or execution.
 */
export type V0PolicyTraceSink = (event: V0PolicyTraceEvent) => void;

/**
 * Emits a trace event when a trace sink is configured.
 *
 * Internal helper used by the v0 runtime.
 */
export const emitTrace = (
  trace: V0PolicyTraceSink | undefined,
  event: V0PolicyTraceEvent
): void => {
  trace?.(event);
};
