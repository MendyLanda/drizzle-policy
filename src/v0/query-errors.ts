import type { MaybeSchema } from '../core/types.js';
import type { PolicyRuntime } from './policy-runtime.js';

/**
 * Translates a driver error raised by a policy-wrapped query; the returned
 * value is thrown in place of the original.
 */
export type OnQueryError = (error: unknown) => unknown;

/**
 * Wraps a Drizzle query so its rejection passes through `onQueryError`.
 * Transparent when no handler is configured.
 */
export const wrapQueryErrors = <TContext, TSchema extends MaybeSchema>(
  query: object,
  runtime: PolicyRuntime<TContext, TSchema>
): object => {
  const onQueryError = runtime.options.onQueryError;
  return onQueryError ? createErrorProxy(query, onQueryError) : query;
};

/**
 * Proxies one query object, mapping rejections through `onQueryError`.
 */
const createErrorProxy = (
  query: object,
  onQueryError: OnQueryError
): object => {
  const proxy: object = new Proxy(query, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }

      if (prop === 'then') {
        return (onFulfilled: unknown, onRejected: unknown) => {
          return Reflect.apply(value, target, [
            onFulfilled,
            (error: unknown) => {
              const mapped = onQueryError(error);
              if (typeof onRejected !== 'function') {
                throw mapped;
              }

              return onRejected(mapped);
            },
          ]);
        };
      }

      if (prop === 'catch') {
        return (onRejected: unknown) => {
          return (proxy as PromiseLike<unknown>).then(
            undefined,
            (error: unknown) => {
              if (typeof onRejected === 'function') {
                return onRejected(error);
              }

              throw error;
            }
          );
        };
      }

      if (prop === 'finally') {
        return (onFinally: (() => void) | undefined) => {
          return Promise.resolve(proxy as PromiseLike<unknown>).finally(
            onFinally
          );
        };
      }

      if (prop === 'execute') {
        return async (...args: readonly unknown[]) => {
          try {
            return await Reflect.apply(value, target, args);
          } catch (error) {
            throw onQueryError(error);
          }
        };
      }

      return (...args: readonly unknown[]) => {
        const result = Reflect.apply(value, target, args);
        if (result === target) {
          return proxy;
        }

        if (
          (prop === 'prepare' || prop === '_prepare') &&
          typeof result === 'object' &&
          result !== null
        ) {
          return createErrorProxy(result, onQueryError);
        }

        return isThenable(result)
          ? createErrorProxy(result, onQueryError)
          : result;
      };
    },
  });

  return proxy;
};

/**
 * Returns whether a chained builder result is still an awaitable query.
 */
const isThenable = (value: unknown): value is object => {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
};
