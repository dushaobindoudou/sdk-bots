/**
 * Regression: the headless telemetry extension must expose a real no-op
 * *telemetry* surface (not a generic proxy). The transcript turn runtime calls
 * brain.startTurn(...).finalize(...) and binds traceFlusher to flushTracing on
 * every turn; when those are missing/undefined each turn teardown throws
 * ("reading 'finalize'" / "traceFlusher is not a function") and is marked
 * failed even though the message was delivered.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { telemetryExtension } from "../../src/host/extensions/telemetry/extension.ts";

const ctx = {
  deps: {},
  host: {},
  onStop: () => {},
} as never;

function api() {
  return telemetryExtension.start(ctx) as Record<string, any>;
}

describe("headless telemetry extension no-op surface", () => {
  test("brain.startTurn returns a turn with finalize (turn teardown never crashes)", () => {
    const brain = api().brain;
    const turn = brain.startTurn({ conversationId: "x", turnType: "new" });
    assert.equal(typeof turn.finalize, "function");
    assert.doesNotThrow(() => turn.finalize("success"));
    assert.equal(typeof brain.reportTurnUsage, "function");
    assert.equal(typeof brain.reportTurnEmptyDelivery, "function");
  });

  test("flushTracing is a callable function (transcript binds traceFlusher to it)", () => {
    const flushTracing = api().flushTracing;
    assert.equal(typeof flushTracing, "function");
    assert.doesNotThrow(() => flushTracing());
  });
});
