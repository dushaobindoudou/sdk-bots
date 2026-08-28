import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LocalCronScheduler, type LocalCronSchedulerAutomation } from "../../src/host/extensions/automations/local-cron-scheduler.js";

function setup(overrides: Partial<ConstructorParameters<typeof LocalCronScheduler>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "local-cron-test-"));
  const fired: Array<{ agentId: string; automationId: string; scheduledForMs: number }> = [];
  let now = 1_700_000_000_000;
  let ready = true;
  let automations: LocalCronSchedulerAutomation[] = [];
  const scheduler = new LocalCronScheduler({
    clock: { now: () => now, monotonicNow: () => now, schedule: () => () => {} } as never,
    tickIntervalMs: 10,
    statePath: join(dir, "state.json"),
    listAutomations: async () => automations,
    fire: async (args) => { fired.push({ agentId: args.agentId, automationId: args.automation.id, scheduledForMs: args.scheduledForMs }); },
    isReady: () => ready,
    getTimeZone: () => undefined,
    log: () => {},
    ...overrides,
  });
  return {
    scheduler, fired, dir,
    setNow: (ms: number) => { now = ms; },
    setReady: (value: boolean) => { ready = value; },
    setAutomations: (list: LocalCronSchedulerAutomation[]) => { automations = list; },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const EVERY_MINUTE = { id: "a1", name: "tick", prompt: "go", isEnabled: true, trigger: { type: "cron", schedule: "* * * * *" } } as const;

describe("LocalCronScheduler", () => {
  it("initializes without firing and fires once the schedule comes due", async () => {
    const t = setup();
    try {
      t.setAutomations([{ agentId: "agent-1", automation: EVERY_MINUTE }]);
      t.scheduler.start();
      await new Promise((r) => setTimeout(r, 40));
      // First tick only initializes the next-due cursor — no catch-up fire.
      assert.equal(t.fired.length, 0);
      const minute = 60_000;
      t.setNow(1_700_000_000_000 + 2 * minute + 1_000); // two minutes later
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(t.fired.length, 1);
      assert.equal(t.fired[0]?.automationId, "a1");
      // Advancing one more minute fires exactly once more.
      t.setNow(1_700_000_000_000 + 3 * minute + 1_000);
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(t.fired.length, 2);
      t.scheduler.stop();
    } finally { t.cleanup(); }
  });

  it("does not refire missed runs after a restart (state file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-cron-restart-"));
    const fired: string[] = [];
    let now = 1_700_000_000_000;
    const automations: LocalCronSchedulerAutomation[] = [{ agentId: "agent-1", automation: EVERY_MINUTE }];
    const make = () => new LocalCronScheduler({
      clock: { now: () => now, monotonicNow: () => now, schedule: () => () => {} } as never,
      tickIntervalMs: 10,
      statePath: join(dir, "state.json"),
      listAutomations: async () => automations,
      fire: async () => { fired.push("x"); },
      isReady: () => true,
      log: () => {},
    });
    const first = make();
    first.start();
    await new Promise((r) => setTimeout(r, 30));
    first.stop();
    assert.equal(fired.length, 0);
    // Restart ten minutes later: no replay of the ten missed runs.
    now += 10 * 60_000;
    const second = make();
    second.start();
    await new Promise((r) => setTimeout(r, 30));
    second.stop();
    assert.equal(fired.length, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips disabled automations and forgets deleted agents", async () => {
    const t = setup();
    try {
      t.setAutomations([{ agentId: "agent-1", automation: { ...EVERY_MINUTE, isEnabled: false } }]);
      t.scheduler.start();
      t.setNow(1_700_000_000_000 + 5 * 60_000);
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(t.fired.length, 0);
      t.scheduler.forgetAgent("agent-1");
      t.scheduler.stop();
    } finally { t.cleanup(); }
  });

  it("holds fire while the host is not ready", async () => {
    const t = setup();
    try {
      t.setReady(false);
      t.setAutomations([{ agentId: "agent-1", automation: EVERY_MINUTE }]);
      t.scheduler.start();
      t.setNow(1_700_000_000_000 + 5 * 60_000);
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(t.fired.length, 0);
      t.scheduler.stop();
    } finally { t.cleanup(); }
  });
});
