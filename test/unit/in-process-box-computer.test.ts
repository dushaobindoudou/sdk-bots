/**
 * In-process box computer: the local-exec bridge must see a live provider
 * without an Electron renderer or SSE daemon.
 *
 * Run:  npm run test:unit
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createIdleWatchdogPolicy, realClock } from "../../src/shared/scheduling.ts";
import { SandLocalExecBridge } from "../../src/host/extensions/local-exec/local-exec-bridge.ts";
import { attachInProcessBoxComputer } from "../../src/host/local-exec/in-process-attach.ts";

describe("attachInProcessBoxComputer()", () => {
  test("registers the box as the live user computer", async () => {
    const bridge = new SandLocalExecBridge({
      clock: realClock,
      responseWatchdog: createIdleWatchdogPolicy(realClock, { name: "test-local-exec", idleMs: 5_000 }),
      blockedReason: () => undefined,
    });
    const computer = attachInProcessBoxComputer(bridge, {
      SAND_BOX_COMPUTER_ID: "box",
      SAND_BOX_COMPUTER_LABEL: "box",
      SAND_BOX_EXEC_DAEMON_HOST: "127.0.0.1",
    });
    try {
      const deadline = Date.now() + 1_000;
      let listed = bridge.listComputers();
      while (Date.now() < deadline && !listed.some((entry) => entry.id === "box" && entry.connected)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        listed = bridge.listComputers();
      }
      assert.equal(bridge.hasProvider(), true);
      assert.equal(listed.some((entry) => entry.id === "box" && entry.connected), true);
    } finally {
      computer.close();
    }
  });
});
