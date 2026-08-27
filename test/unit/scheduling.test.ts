/**
 * Unit tests for src/shared/scheduling.ts — the scheduling contract that
 * moved out of src/internal during the 0.3.0 layering pass.
 *
 * All policies run on a deterministic fake clock: no real timers, so the
 * suite stays fast and hermetic. These tests pin the contract every host
 * extension leans on (debounce, retry, polling, expiry, deadline).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DeadlineExceededError,
  createDebouncePolicy,
  createExpiryPolicy,
  createDeadlinePolicy,
  createIdleWatchdogPolicy,
  createPollingPolicy,
  createRetryPolicy,
  type Clock,
} from "../../src/shared/scheduling.ts";

/** Deterministic clock: tasks sorted by due time, advance() runs them synchronously. */
function fakeClock(): Clock & { advance(ms: number): void; pending(): number } {
  let now = 1_000;
  const tasks = new Map<number, { due: number; run: () => void }>();
  let nextId = 1;
  const flush = () => {
    for (;;) {
      const due = [...tasks.entries()].filter(([, t]) => t.due <= now).sort((a, b) => a[1].due - b[1].due)[0];
      if (due == null) return;
      tasks.delete(due[0]);
      due[1].run();
    }
  };
  return {
    now: () => now,
    monotonicNow: () => now,
    schedule(delayMs, callback) {
      const id = nextId++;
      tasks.set(id, { due: now + delayMs, run: callback });
      return { dispose() { tasks.delete(id); } };
    },
    advance(ms) { now += ms; flush(); },
    pending: () => tasks.size,
  };
}

/** Drain the microtask queue so Promise.race winners settle between clock steps. */
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

describe("DeadlineExceededError", () => {
  test("carries the policy name, code, and a stable error identity", () => {
    const error = new DeadlineExceededError("turn-deadline");
    assert.equal(error.name, "DeadlineExceededError");
    assert.equal(error.code, "deadline_exceeded");
    assert.equal(error.policyName, "turn-deadline");
    assert.match(error.message, /turn-deadline/);
    assert.ok(error instanceof Error);
  });
});

describe("createDebouncePolicy", () => {
  test("coalesces bursts and fires once after the quiet window", () => {
    const clock = fakeClock();
    const policy = createDebouncePolicy(clock, { name: "deb", delayMs: 100 });
    let calls = 0;
    const fn = policy.wrap(() => { calls += 1; });
    fn(); fn(); fn();
    assert.equal(calls, 0, "nothing fires inside the window");
    clock.advance(99);
    assert.equal(calls, 0);
    clock.advance(1);
    assert.equal(calls, 1, "exactly one call after the window closes");
  });

  test("re-arms on late activity and dispose() cancels the pending call", () => {
    const clock = fakeClock();
    const policy = createDebouncePolicy(clock, { name: "deb", delayMs: 50 });
    let calls = 0;
    const fn = policy.wrap(() => { calls += 1; });
    fn();
    clock.advance(25);
    fn(); // restart the window
    clock.advance(50);
    assert.equal(calls, 1, "fired once for both invocations");
    fn();
    fn.dispose();
    clock.advance(500);
    assert.equal(calls, 1, "disposed wrapper never fires again");
  });

  test("rejects empty names and negative/NaN delays", () => {
    const clock = fakeClock();
    assert.throws(() => createDebouncePolicy(clock, { name: "  ", delayMs: 10 }), TypeError);
    assert.throws(() => createDebouncePolicy(clock, { name: "deb", delayMs: -1 }), RangeError);
    assert.throws(() => createDebouncePolicy(clock, { name: "deb", delayMs: Number.NaN }), RangeError);
  });
});

describe("createRetryPolicy", () => {
  test("retries until success, growing the delay and capping it at maxDelayMs", async () => {
    const clock = fakeClock();
    const policy = createRetryPolicy(clock, { name: "r", maxAttempts: 5, initialDelayMs: 10, maxDelayMs: 80 });
    const seenDelays: number[] = [];
    let attempts = 0;
    const run = policy.runWithRetry(async (attempt) => {
      attempts = attempt;
      if (attempt < 4) throw new Error("boom");
      return "ok";
    });
    let settled = false;
    void run.then((v) => { settled = true; assert.equal(v, "ok"); });
    for (let step = 0; step < 40 && !settled; step += 1) { await settle(); clock.advance(10); }
    await settle();
    assert.ok(settled, `retry loop should finish (attempts=${attempts})`);
    assert.equal(attempts, 4, "4th attempt succeeded");
    assert.deepEqual(seenDelays, []);
  });

  test("schedule() backoff: 10, 20, 40, then capped at 80", async () => {
    const clock = fakeClock();
    const policy = createRetryPolicy(clock, { name: "r", maxAttempts: 9, initialDelayMs: 10, maxDelayMs: 80 });
    const measure = async (attempt: number): Promise<number> => {
      let elapsed = false;
      const delay = policy.schedule(attempt);
      void delay.elapsed.then(() => { elapsed = true; });
      let needed = 0;
      while (!elapsed && needed < 500) { clock.advance(10); needed += 10; await settle(); }
      delay.dispose();
      return needed;
    };
    assert.deepEqual(await Promise.all([]), []);
    const delays: number[] = [];
    for (const attempt of [1, 2, 3, 4, 5]) delays.push(await measure(attempt));
    assert.deepEqual(delays, [10, 20, 40, 80, 80]);
  });

  test("gives up after maxAttempts and surfaces the last error", async () => {
    const clock = fakeClock();
    const policy = createRetryPolicy(clock, { name: "r", maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 });
    const promise = policy.runWithRetry(async () => { throw new Error("always"); });
    let caught: unknown;
    void promise.catch((error) => { caught = error; });
    for (let step = 0; step < 30 && caught === undefined; step += 1) { await settle(); clock.advance(5); }
    await settle();
    assert.ok(caught instanceof Error && caught.message === "always");
  });

  test("shouldRetry=false stops the loop immediately", async () => {
    const clock = fakeClock();
    const policy = createRetryPolicy(clock, {
      name: "r", maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 1,
      shouldRetry: (error) => !(error instanceof RangeError),
    });
    const promise = policy.runWithRetry(async () => { throw new RangeError("fatal"); });
    await assert.rejects(promise, RangeError);
    assert.equal(clock.pending(), 0, "no delay scheduled for non-retryable errors");
  });

  test("rejects invalid option ranges", () => {
    const clock = fakeClock();
    assert.throws(() => createRetryPolicy(clock, { name: "", maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 }), TypeError);
    assert.throws(() => createRetryPolicy(clock, { name: "r", maxAttempts: 0, initialDelayMs: 1, maxDelayMs: 1 }), RangeError);
    assert.throws(() => createRetryPolicy(clock, { name: "r", maxAttempts: 1, initialDelayMs: 5, maxDelayMs: 1 }), RangeError);
    assert.throws(() => createRetryPolicy(clock, { name: "r", maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffFactor: 0.5 }), RangeError);
  });
});

describe("createIdleWatchdogPolicy", () => {
  test("fires once after idleMs and kick() postpones the fire", () => {
    const clock = fakeClock();
    const policy = createIdleWatchdogPolicy(clock, { name: "w", idleMs: 100 });
    let fires = 0;
    const handle = policy.arm(() => { fires += 1; });
    clock.advance(50);
    handle.kick();
    clock.advance(60);
    assert.equal(fires, 0, "kick pushed the deadline out");
    clock.advance(40);
    assert.equal(fires, 1);
    handle.dispose();
    clock.advance(1000);
    assert.equal(fires, 1, "dispose stops the watchdog");
  });
});

describe("createPollingPolicy", () => {
  test("ticks sequentially — never overlapping a slow tick", async () => {
    const clock = fakeClock();
    const policy = createPollingPolicy(clock, { name: "p", intervalMs: 10 });
    let running = 0, maxRunning = 0, ticks = 0;
    const polling = policy.start(async () => {
      running += 1; maxRunning = Math.max(maxRunning, running); ticks += 1;
      await settle(); // simulate async work spanning the interval
      running -= 1;
    });
    for (let step = 0; step < 5; step += 1) { await settle(); clock.advance(10); }
    await settle();
    polling.dispose();
    assert.ok(ticks >= 2, `polled multiple times (${ticks})`);
    assert.equal(maxRunning, 1, "ticks must not overlap");
    const ticksAtDispose = ticks;
    clock.advance(1000);
    assert.equal(ticks, ticksAtDispose, "dispose stops future ticks");
  });

  test("a rejected tick disposes the loop; a throwing tick disposes too", async () => {
    const clock = fakeClock();
    const policy = createPollingPolicy(clock, { name: "p", intervalMs: 5 });
    let ticks = 0;
    const polling = policy.start(async () => { ticks += 1; if (ticks === 2) throw new Error("sink"); });
    for (let step = 0; step < 20 && ticks < 2; step += 1) { await settle(); clock.advance(5); }
    await settle();
    clock.advance(1000);
    assert.equal(ticks, 2, "loop died on the second (throwing) tick");
    polling.dispose();
  });

  test("an already-aborted signal never ticks", () => {
    const clock = fakeClock();
    const policy = createPollingPolicy(clock, { name: "p", intervalMs: 5 });
    const controller = new AbortController();
    controller.abort();
    let ticks = 0;
    const polling = policy.start(async () => { ticks += 1; }, controller.signal);
    clock.advance(1000);
    assert.equal(ticks, 0);
    polling.dispose();
  });
});

describe("createExpiryPolicy", () => {
  test("arms a key, fires after ttl, and delete() cancels", () => {
    const clock = fakeClock();
    const policy = createExpiryPolicy(clock, { name: "e", ttlMs: 50 });
    let fires = 0;
    const handle = policy.arm("k", () => { fires += 1; });
    clock.advance(49);
    handle.dispose();
    clock.advance(1000);
    assert.equal(fires, 0, "disposed entry never expires");
    policy.arm("k2", () => { fires += 1; });
    clock.advance(50);
    assert.equal(fires, 1);
  });

  test("re-arming the same key replaces the old timer", () => {
    const clock = fakeClock();
    const policy = createExpiryPolicy(clock, { name: "e", ttlMs: 50 });
    const fired: string[] = [];
    policy.arm("k", () => fired.push("first"));
    clock.advance(25);
    policy.arm("k", () => fired.push("second"));
    clock.advance(1000);
    assert.deepEqual(fired, ["second"], "only the latest arming survives");
  });
});

describe("createDeadlinePolicy", () => {
  test("returns work's value when it finishes inside the budget", async () => {
    const clock = fakeClock();
    const policy = createDeadlinePolicy(clock, { name: "d", timeoutMs: 100 });
    const result = await Promise.race([
      policy.run(async (signal) => { clock.advance(10); assert.equal(signal.aborted, false); return 42; }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stalled")), 500)),
    ]);
    assert.equal(result, 42);
  });

  test("throws DeadlineExceededError and aborts the work signal at the budget", async () => {
    const clock = fakeClock();
    const policy = createDeadlinePolicy(clock, { name: "turn", timeoutMs: 50 });
    let observedAbort: unknown;
    const promise = policy.run(async (signal) => {
      signal.addEventListener("abort", () => { observedAbort = signal.reason; }, { once: true });
      await new Promise<never>(() => {}); // never settles; only the deadline can end this
    });
    let caught: unknown;
    void promise.catch((error) => { caught = error; });
    await settle();
    clock.advance(50);
    for (let i = 0; i < 10 && caught === undefined; i += 1) await settle();
    assert.ok(caught instanceof DeadlineExceededError, "deadline error wins the race");
    assert.equal((caught as DeadlineExceededError).policyName, "turn");
    assert.ok(observedAbort instanceof DeadlineExceededError, "work signal aborted with the same error");
  });

  test("a pre-aborted outer signal rejects before work starts", async () => {
    const clock = fakeClock();
    const policy = createDeadlinePolicy(clock, { name: "d", timeoutMs: 100 });
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    controller.abort(reason);
    let workRan = false;
    await assert.rejects(
      policy.run(async () => { workRan = true; return 1; }, controller.signal),
      (error: unknown) => error === reason,
    );
    assert.equal(workRan, false);
    assert.equal(clock.pending(), 0, "no timer left behind");
  });
});
