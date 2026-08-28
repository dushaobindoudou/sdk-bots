/**
 * Tolerant no-op API surface for Cursor-platform capabilities that have no
 * local backend in this headless SDK (telemetry shipping, action-audit
 * forwarding). The host registry requires every extension slot to be
 * present, so these extensions keep their slots but return this surface
 * instead of dialing Cursor's servers.
 *
 * Property access returns the same callable no-op (so chained calls like
 * telemetry.analytics.trackEvent(...) work), invoking it returns undefined
 * (so boolean consumers read falsy), with three exceptions:
 * - "subscribe" returns a no-op unsubscribe (callers hand it to onStop)
 * - Function.prototype-inherited members (bind/call/apply/toString) pass
 *   through to the real target — guards like optionalMethod() call
 *   candidate.bind(api), which the proxy must not swallow
 * - symbols / "then" / "toJSON" stay undefined (proxies must not look
 *   thenable to await, or stringify-able to serializers)
 */
const noopFunction = function noop(): undefined { return undefined; };

export function createNoopApi(): unknown {
  return new Proxy(noopFunction, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") return undefined;
      if (prop === "subscribe") return (): (() => void) => () => {};
      if (typeof prop === "string" && prop in Function.prototype) return Reflect.get(target, prop, receiver);
      return createNoopApi();
    },
    apply() { return undefined; },
  });
}
