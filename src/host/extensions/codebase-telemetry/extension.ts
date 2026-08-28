import { defineHostExtension } from "../../../shared/host-extensions.js";
import { createNoopApi } from "../noop-api.js";
import { HostExtensions } from "../extension-ids.generated.js";

// Capability probing stays exported — packaged layouts and tests import it.
export { resolveCsnapsBinPath, resolveCsnapsCapability } from "./csnaps-capability.js";

/**
 * Cursor-free codebase-telemetry slot.
 *
 * The recovered implementation spawned a csnaps daemon, shipped codebase
 * telemetry to Cursor, and looked up the account's privacy mode from the
 * Cursor dashboard. In this headless SDK none of those backends exist (the
 * old implementation already degraded to "csnaps missing" warnings); the
 * extension now reports an empty capability set and never spawns anything.
 */
export const codebaseTelemetryExtension = defineHostExtension({
  id: HostExtensions.CodebaseTelemetry,
  dependencies: [HostExtensions.Auth, HostExtensions.Experiments],
  start: () => createNoopApi(),
});
