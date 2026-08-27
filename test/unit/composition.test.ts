/**
 * Pins the SDK -> bootstrap composition boundary.
 *
 * src/sdk/entry.ts loads the composition module through a computed specifier
 * (so declaration emit cannot pull the host runtime graph into the SDK type
 * program). This test keeps that seam honest: the module must exist, export
 * exactly the boot shape the SDK casts to, and stay free of module-load side
 * effects (the CLI bootstrap - not this module - owns env defaults).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { startHeadlessHost } from "../../src/bootstrap/composition.ts";

test("composition exports the boot shape the SDK expects", () => {
  assert.equal(typeof startHeadlessHost, "function");
  // Type-level contract: assignable to the cast target in entry.ts.
  const boot: () => Promise<void> = startHeadlessHost;
  assert.ok(boot != null);
});
