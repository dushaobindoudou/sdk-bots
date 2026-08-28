import { defineHostExtension } from "../../../shared/host-extensions.js";
import { createNoopApi } from "../noop-api.js";
import { HostExtensions } from "../extension-ids.generated.js";

/**
 * Cursor-free telemetry slot.
 *
 * The recovered implementation shipped structured logs, analytics events,
 * box logs, and crash markers to Cursor's backend. None of that has a local
 * destination in this headless SDK. The host hard-requires
 * createHostLifecycleProgress() to return a usable object, so that one is
 * real (a no-op lifecycle); analytics/logs/brain keep their chained-call
 * shapes via the tolerant no-op proxy, and the scalar consumers use
 * null-safe method() helpers anyway.
 */
export const telemetryExtension = defineHostExtension({
  id: HostExtensions.Telemetry,
  dependencies: [],
  start: () => ({
    createHostLifecycleProgress:
      (_startedAt: number): { complete(_report?: Record<string, unknown>): void; fail(): void } => ({
        complete: () => {},
        fail: () => {},
      }),
    analytics: createNoopApi(),
    logs: createNoopApi(),
    brain: createNoopApi(),
    reportMessageSent: (): void => {},
    noteSandModelExperimentActive: (): void => {},
  }),
});
