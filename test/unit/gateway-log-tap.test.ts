/**
 * Unit tests for the gateway console log tap (src/host/gateway-log-tap.ts).
 *
 * The tap wraps console.* process-wide (refcounted), so these tests must
 * restore state exactly: create → assert → dispose, and use the original
 * console bindings for assertions (the wrapped ones are what we test).
 */
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createGatewayLogTap } from "../../src/host/gateway-log-tap.ts";

// Keep pristine bindings for reading captured output inside tests.
const real = { log: console.log.bind(console), error: console.error.bind(console) };

afterEach(() => {
  // Dispose any tap a test leaked so later suites log through the originals.
  for (let i = 0; i < 5; i += 1) {
    const tap = createGatewayLogTap({ capacity: 2 });
    tap.dispose();
  }
});

describe("createGatewayLogTap", () => {
  test("captures log/info/warn/error levels with monotonic seq and ts", () => {
    const tap = createGatewayLogTap({ capacity: 10 });
    try {
      console.log("hello", "world");
      console.error(new Error("boom"));
      const entries = tap.recent(10);
      assert.equal(entries.length, 2);
      assert.deepEqual(entries.map((e) => e.level), ["log", "error"]);
      const first = entries[0], second = entries[1];
      assert.ok(first != null && second != null);
      assert.equal(first.text, "hello world");
      assert.match(second.text, /boom/);
      assert.ok(second.text.includes("Error"), "errors render with name+stack");
      assert.ok(second.seq > first.seq, "seq is monotonic");
      assert.ok(Math.abs(second.ts - Date.now()) < 5_000);
    } finally { tap.dispose(); }
  });

  test("still passes through to the real console (no swallowed output)", () => {
    const tap = createGatewayLogTap({ capacity: 10 });
    try {
      let saw = "";
      const original = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => { saw += String(chunk); return true; }) as typeof process.stdout.write;
      try { console.log("passthrough-check"); } finally { process.stdout.write = original; }
      assert.ok(saw.includes("passthrough-check"));
      assert.ok(tap.recent(10).some((e) => e.text.includes("passthrough-check")));
    } finally { tap.dispose(); }
  });

  test("ring buffer respects capacity and recent() limit", () => {
    const tap = createGatewayLogTap({ capacity: 3 });
    try {
      for (let i = 1; i <= 5; i += 1) console.log("m" + i);
      const all = tap.recent(10);
      assert.deepEqual(all.map((e) => e.text), ["m3", "m4", "m5"], "oldest entries evicted");
      assert.deepEqual(tap.recent(2).map((e) => e.text), ["m4", "m5"], "limit returns the tail");
    } finally { tap.dispose(); }
  });

  test("subscribers fan out live and unsubscribe cleanly; a throwing sink never breaks logging", () => {
    const tap = createGatewayLogTap({ capacity: 10 });
    try {
      const got: string[] = [];
      const dispose = tap.subscribe((entry) => got.push(entry.text));
      const tap2 = createGatewayLogTap(); // shares the same underlying wrap (refcount)
      try {
        console.log("first");
        dispose();
        console.log("second");
        assert.deepEqual(got, ["first"], "unsubscribed sink hears nothing");
      } finally { tap2.dispose(); }
      // throwing listener must not break capture or passthrough
      const disposeBad = tap.subscribe(() => { throw new Error("sink broken"); });
      console.log("survives");
      disposeBad();
      assert.ok(tap.recent(10).some((e) => e.text === "survives"));
    } finally { tap.dispose(); }
  });

  test("dispose restores the original console bindings (refcounted)", () => {
    const before = console.log;
    const a = createGatewayLogTap();
    const b = createGatewayLogTap();
    a.dispose();
    assert.equal(console.log !== before, true, "still wrapped while one ref remains");
    b.dispose();
    assert.equal(console.log === before, true, "fully unwound after the last ref");
  });

  test("truncates pathological payloads instead of unbounded memory", () => {
    const tap = createGatewayLogTap({ capacity: 10 });
    try {
      console.log("x".repeat(50_000));
      const entry = tap.recent(1)[0];
      assert.ok(entry != null);
      assert.ok(entry.text.length < 2_100, `truncated (got ${entry.text.length})`);
      assert.ok(entry.text.endsWith("…[truncated]"));
    } finally { tap.dispose(); }
  });
});

describe("gateway log tap ring noise filter", () => {
  test("Statsig warnings stay out of the ring but real warns enter it", async () => {
    const tap = createGatewayLogTap({ capacity: 10 });
    try {
      console.warn('  WARN  [Statsig] The user does not have the required id_type "userID" for Gate "glass_tabs"');
      console.warn("real warning from the host");
      const entries = tap.recent(10);
      assert.equal(entries.filter((e) => e.text.includes("Statsig")).length, 0);
      assert.ok(entries.some((e) => e.text === "real warning from the host"));
    } finally { tap.dispose(); }
  });
});
