import { defineHostExtension } from "../../../shared/host-extensions.js";
import { createNoopSandTelemetry } from "../../ports/telemetry.js";
import { createNoopApi } from "../noop-api.js";
import { HostExtensions } from "../extension-ids.generated.js";

/**
 * Cursor-free telemetry slot.
 *
 * The recovered implementation shipped structured logs, analytics events,
 * box logs, and crash markers to Cursor's backend. None of that has a local
 * destination in this headless SDK. The host hard-requires
 * createHostLifecycleProgress() to return a usable object, so that one is
 * real (a no-op lifecycle); analytics/logs keep their chained-call shapes via
 * the tolerant no-op proxy. branch must be a real no-op *telemetry* surface
 * (startTurn returns a turn with finalize, etc.) because the transcript turn
 * runtime calls it directly and would otherwise crash on every turn teardown;
 * flushTracing must be a function because transcript binds setTraceFlusher to it.
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
    brain: createNoopSandTelemetry(),
    flushTracing: (): void => {},
    reportMessageSent: (): void => {},
    noteSandModelExperimentActive: (): void => {},
  }),
});
