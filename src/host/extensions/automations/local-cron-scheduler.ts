import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeNextRunAt } from "../../../shared/automation-schedule.js";
import { triggerCronSchedules, type AutomationTrigger } from "../../../shared/automations.js";
import type { Clock } from "../../../shared/scheduling.js";

/**
 * Fires cron-triggered automations on a local timer.
 *
 * The recovered architecture delegated scheduling authority to Cursor's
 * cloud (SandAutomationCloudSync pushes definitions up; SandAutomationFireConsumer
 * drains fire notifications back down). Without Cursor credentials neither
 * half can talk to the cloud, so scheduled routines would never fire. This
 * scheduler is the local replacement: it evaluates every enabled cron
 * schedule against the wall clock and invokes the same local run path the
 * cloud consumer used (runServerScheduledAutomation), so automation
 * execution semantics stay identical.
 *
 * Double-fire protection: a tiny JSON state file maps `${agentId}:${id}` to
 * the next due timestamp. On first sight of an automation the state is
 * initialized WITHOUT firing (a restart must not replay missed runs), and
 * each fire advances the cursor before the run is enqueued.
 */

export interface LocalCronSchedulerAutomation {
  readonly agentId: string;
  readonly automation: {
    readonly id: string;
    readonly isEnabled: boolean;
    readonly trigger: AutomationTrigger;
  };
}

export interface LocalCronSchedulerDeps {
  readonly clock: Clock;
  readonly tickIntervalMs: number;
  readonly statePath: string;
  readonly listAutomations: () => Promise<readonly LocalCronSchedulerAutomation[]>;
  readonly fire: (args: {
    agentId: string;
    automation: LocalCronSchedulerAutomation["automation"];
    runUuid: string;
    scheduledForMs: number;
  }) => Promise<unknown>;
  readonly isReady: () => boolean;
  readonly getTimeZone?: () => string | undefined;
  readonly log: (message: string) => void;
}

interface StateFile {
  readonly version: 1;
  readonly next: Record<string, number>;
}

const LOG_PREFIX = "[automations] local scheduler:";

export class LocalCronScheduler {
  private readonly deps: LocalCronSchedulerDeps;
  private nextByAutomationId = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private loaded = false;

  constructor(deps: LocalCronSchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer != null) return;
    this.loadState();
    this.timer = setInterval(() => { void this.tick(); }, this.deps.tickIntervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-evaluate schedules after definitions change (config edit, agent create/delete). */
  requestReconcile(): void {
    void this.tick();
  }

  /** Drop all firing state for an agent (called when the agent is deleted). */
  forgetAgent(agentId: string): void {
    const prefix = `${agentId}:`;
    let mutated = false;
    for (const key of this.nextByAutomationId.keys()) {
      if (key.startsWith(prefix)) { this.nextByAutomationId.delete(key); mutated = true; }
    }
    if (mutated) this.saveState();
  }

  private loadState(): void {
    this.loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(this.deps.statePath, "utf8")) as Partial<StateFile>;
      if (parsed.version === 1 && parsed.next != null && typeof parsed.next === "object") {
        for (const [key, value] of Object.entries(parsed.next)) {
          if (typeof value === "number" && Number.isFinite(value)) this.nextByAutomationId.set(key, value);
        }
      }
    } catch {
      // No state yet (first boot) or unreadable — start from a clean map.
    }
  }

  private saveState(): void {
    const next: Record<string, number> = {};
    for (const [key, value] of this.nextByAutomationId) next[key] = value;
    try {
      writeFileSync(this.deps.statePath, JSON.stringify({ version: 1, next } satisfies StateFile), "utf8");
    } catch (error) {
      this.deps.log(`${LOG_PREFIX} failed to persist state: ${String(error)}`);
    }
  }

  private async tick(): Promise<void> {
    if (this.busy || this.timer == null) return;
    this.busy = true;
    try {
      if (!this.deps.isReady()) return;
      const now = this.deps.clock.now();
      const seen = new Set<string>();
      for (const { agentId, automation } of await this.deps.listAutomations()) {
        if (!automation.isEnabled) continue;
        for (const schedule of triggerCronSchedules(automation.trigger)) {
          const key = `${agentId}:${automation.id}`;
          seen.add(key);
          const dueAt = this.nextByAutomationId.get(key);
          if (dueAt === undefined) {
            const next = computeNextRunAt(schedule, now, this.deps.getTimeZone?.());
            if (next != null) this.nextByAutomationId.set(key, next);
            continue;
          }
          if (now < dueAt) continue;
          // Anchor the next run on `now` (not dueAt): a late fire (host was
          // busy, machine asleep) reschedules forward instead of replaying
          // every missed occurrence in a burst.
          const next = computeNextRunAt(schedule, now, this.deps.getTimeZone?.());
          this.nextByAutomationId.set(key, next ?? Number.MAX_SAFE_INTEGER);
          this.saveState();
          this.deps.log(`${LOG_PREFIX} firing "${automation.id}" for agent ${agentId} (schedule "${schedule}", due ${new Date(dueAt).toISOString()})`);
          try {
            await this.deps.fire({
              agentId,
              automation,
              runUuid: randomUUID(),
              scheduledForMs: dueAt,
            });
          } catch (error) {
            this.deps.log(`${LOG_PREFIX} run for "${automation.id}" failed: ${String(error)}`);
          }
        }
      }
      let mutated = false;
      for (const key of this.nextByAutomationId.keys()) {
        if (!seen.has(key)) { this.nextByAutomationId.delete(key); mutated = true; }
      }
      if (mutated) this.saveState();
    } catch (error) {
      this.deps.log(`${LOG_PREFIX} tick failed: ${String(error)}`);
    } finally {
      this.busy = false;
    }
  }
}
