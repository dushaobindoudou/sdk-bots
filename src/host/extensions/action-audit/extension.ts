import { defineHostExtension } from "../../../shared/host-extensions.js";
import { createNoopApi } from "../noop-api.js";
import { HostExtensions } from "../extension-ids.generated.js";

/**
 * Cursor-free action-audit slot.
 *
 * The recovered implementation batched action audit records and forwarded
 * them to Cursor's backend (behind a Statsig gate). Local headless use has
 * no such destination; the auditor surface becomes a no-op.
 */
export const actionAuditExtension = defineHostExtension({
  id: HostExtensions.ActionAudit,
  dependencies: [HostExtensions.Auth, HostExtensions.Experiments, HostExtensions.Telemetry],
  start: () => createNoopApi(),
});
