import { join } from "node:path";
import { createRealPollingPolicy, realClock } from "../../../shared/scheduling.js";
import { defineHostExtension } from "../../../shared/host-extensions.js";
import { getConfiguredBackendUrl } from "../../../shared/node/cursor-token.js";
import { AutomationsService } from "../../../proto/generated/aiserver/v1/automations_connect.js";
import { createSandCursorBackendClient } from "../../../shared/node/cursor-backend/cursor-inference.js";
import { inspectAgentAutomationDefinitions } from "../../automations/automation-store.js";
import { getSandAgentsRootDir } from "../../storage/agent-paths.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { LocalCronScheduler } from "./local-cron-scheduler.js";
import { createBackendRelaySources } from "./backend-relay-source.js";
import { ListenerConnectWatcher } from "./listener-connect-watcher.js";
import { createListenerIntegrationReads } from "./listener-integrations.js";
import { SandAutomationCloudSync, type CloudSyncClient, type ScheduledCloudAutomation } from "./sand-automation-cloud-sync.js";
import { SandAutomationFireConsumer } from "./sand-automation-fire-consumer.js";
import { SandTriggerHub } from "./sand-trigger-hub.js";
import { LISTENER_INTEGRATION_PLATFORMS, triggerListeners } from "../../../shared/automations.js";
import { getSandRootDir } from "../../../shared/sand-paths.js";

export const HUB_RECONCILE_INTERVAL_MS = 15_000, RELAY_POLL_INTERVAL_MS = 4_000, CONNECT_WATCH_POLL_INTERVAL_MS = 5_000, LOCAL_CRON_TICK_MS = 30_000;
export const SAND_BOX_BOOT_STARTED_AT_MS_ENV = "SAND_BOX_BOOT_STARTED_AT_MS";
export function getBoxUptimeMs(): number | undefined { const raw = process.env[SAND_BOX_BOOT_STARTED_AT_MS_ENV]?.trim(); if (!raw) return undefined; const started = Number(raw); return Number.isFinite(started) && started > 0 ? Math.max(0, Date.now() - started) : undefined; }
export function reconcileWhenAuthenticated(args: { auth: { peekAccessToken(): string | null; subscribeToRenewal(listener: () => void): () => void }; reconcile(): void }): () => void { let done = false; const once = () => { if (done || args.auth.peekAccessToken() == null) return; done = true; args.reconcile(); }; const off = args.auth.subscribeToRenewal(once); once(); return off; }

interface AutomationTranscript {
  listAgents(): Promise<readonly { id: string }[]>;
  listAllAutomationDefinitions(): Promise<readonly { agentId: string; automation: ScheduledCloudAutomation & { runs?: readonly { id: string; status: string; detail?: string; coalescedRunIds?: readonly string[] }[] } }[]>;
  runAutomationForEvent(agentId: string, automation: ScheduledCloudAutomation, event: Record<string, unknown>): Promise<unknown>;
  runServerScheduledAutomation(args: { agentId: string; automation: ScheduledCloudAutomation; runUuid: string; scheduledForMs?: number }): Promise<string | undefined>;
  runServerAutomationForEvent(args: { agentId: string; automation: ScheduledCloudAutomation; event: Record<string, unknown>; runUuid: string }): Promise<string | undefined>;
  getAgentChannels(agentId: string): Promise<readonly { platform: string; [key: string]: unknown }[]>;
  resumeAfterListenerConnect(agentId: string, platform: string): Promise<void>;
}
interface AutomationExtensionHost {
  log(message: string): void;
  events: { on<Payload>(topic: string, listener: (payload: Payload) => void): () => void };
}

export const automationsExtension = defineHostExtension({
  id: HostExtensions.Automations,
  dependencies: [HostExtensions.Auth, HostExtensions.Settings, HostExtensions.Telemetry, HostExtensions.Transcript, HostExtensions.Trays, HostExtensions.TurnExecution, HostExtensions.NotifyBus],
  start: (context) => {
    const host = context.host as AutomationExtensionHost;
    const deps = context.deps as {
      auth: { getAccessToken(args: { backendUrl: string }): Promise<string>; getMachineId(): Promise<string>; peekAccessToken(): string | null; subscribeToRenewal(listener: () => void): () => void };
      settings: { getUserTimeZone(): string | undefined };
      telemetry: { logs: { reportHostExtensionDiagnostic(value: Record<string, unknown>): void; reportAutomationShadowPrune(value: Record<string, unknown>): void }; brain: { reportAutomationFireDropped(value: Record<string, unknown>): void; reportAgentError?(value: Record<string, unknown>): void } };
      transcript: AutomationTranscript;
      trays: { pushError(value: { agentId: string; title: string; detail: string }): { id: string }; dismiss(value: { id: string }): void };
      "turn-execution": { isRunReady(): boolean };
      "notify-bus": { isConnected(): boolean; isSafetyPollEnabled(): boolean; onNotify(topic: string, listener: () => void): () => void };
    };
    // Headless (no Cursor credentials): the cloud scheduler relay is
    // unreachable, so cron routines run on a local timer instead. Slack and
    // GitHub listeners have no local connector and report disconnected.
    if (deps.auth.peekAccessToken() == null) {
      const scheduler = new LocalCronScheduler({
        clock: realClock,
        tickIntervalMs: LOCAL_CRON_TICK_MS,
        statePath: join(getSandRootDir(), "local-cron-state.json"),
        listAutomations: () => deps.transcript.listAllAutomationDefinitions() as unknown as Promise<import("./local-cron-scheduler.js").LocalCronSchedulerAutomation[]>,
        fire: (args) => deps.transcript.runServerScheduledAutomation(args as Parameters<typeof deps.transcript.runServerScheduledAutomation>[0]),
        isReady: () => deps["turn-execution"].isRunReady(),
        getTimeZone: () => deps.settings.getUserTimeZone(),
        log: (message) => host.log(message),
      });
      const offConfigChanged = host.events.on("transcript.automation-config-changed", () => scheduler.requestReconcile());
      scheduler.start();
      host.log(`[automations] local mode (no Cursor credentials): cron routines fire locally every ${LOCAL_CRON_TICK_MS / 1000}s; slack/github listeners unavailable`);
      context.onStop(() => { offConfigChanged(); scheduler.stop(); });
      const countListeners = async (platform: string) => (await deps.transcript.listAllAutomationDefinitions())
        .filter(({ automation }) => automation.isEnabled && triggerListeners(automation.trigger).some((listener) => listener.type === platform)).length;
      return {
        sourceStatuses: () => new Map<string, never>(),
        suspendWakes: async () => scheduler.stop(),
        resumeWakes: () => scheduler.start(),
        deleteAgentSchedules: (agentId: string) => scheduler.forgetAgent(agentId),
        reconcileNow: () => scheduler.requestReconcile(),
        getListenerIntegrations: async () => ({ integrations: await Promise.all((LISTENER_INTEGRATION_PLATFORMS as readonly string[]).map(async (platform) => ({ platform, isConnected: false, state: "idle", neededByCount: await countListeners(platform) }))) }),
        getListenerConnectUrl: async (_platform: "slack" | "github"): Promise<string | null> => null,
        isListenerPlatformConnected: async (_platform: "slack" | "github"): Promise<boolean> => false,
        getAgentChannels: async (agentId: string) => ({ manifests: [], connections: (await deps.transcript.getAgentChannels(agentId)).filter(() => false) }),
      };
    }
    const routineSyncFailureTrayIds = new Map<string, string>();
    let notifySchedulingAuthorityChanged = () => {};
    const cloudSyncOptions: ConstructorParameters<typeof SandAutomationCloudSync>[0] & {
      inspectLocalDefinitions(agentId: string): ReturnType<typeof inspectAgentAutomationDefinitions>;
      reportShadowPrune(report: Record<string, unknown>): void;
    } = {
      client: createSandCursorBackendClient(AutomationsService, {
        getAccessToken: deps.auth.getAccessToken,
        getMachineId: async () => await deps.auth.getMachineId()
      }) as unknown as CloudSyncClient,
      reportDiagnostic: (diagnostic) => deps.telemetry.logs.reportHostExtensionDiagnostic(diagnostic),
      hasCredential: () => deps.auth.peekAccessToken() != null,
      listAgentIds: async () => (await deps.transcript.listAgents()).map(({ id }) => id),
      listAutomations: () => deps.transcript.listAllAutomationDefinitions(),
      getTimeZone: () => deps.settings.getUserTimeZone(),
      inspectLocalDefinitions: (agentId: string) => inspectAgentAutomationDefinitions(join(getSandAgentsRootDir(), agentId)),
      reportShadowPrune: (report: Record<string, unknown>) => deps.telemetry.logs.reportAutomationShadowPrune({ ...report, boxUptimeMs: getBoxUptimeMs() }),
      onFailure: ({ agentId }) => { if (agentId == null || routineSyncFailureTrayIds.has(agentId)) return; const tray = deps.trays.pushError({ agentId, title: "Routine Sync Failed", detail: "Grok Bot couldn't sync this agent's routines. Event routines keep running locally when safe, but scheduled routines may be delayed while Grok Bot retries." }); routineSyncFailureTrayIds.set(agentId, tray.id); },
      onRecovery: (agentId) => { const id = routineSyncFailureTrayIds.get(agentId); if (id == null) return; deps.trays.dismiss({ id }); routineSyncFailureTrayIds.delete(agentId); },
      onSchedulingAuthorityChanged: () => notifySchedulingAuthorityChanged()
    };
    const cloudSync = new SandAutomationCloudSync(cloudSyncOptions);
    const relay = createBackendRelaySources({ getAccessToken: deps.auth.getAccessToken, getBackendUrl: () => getConfiguredBackendUrl(), polling: createRealPollingPolicy({ name: "automations.relay-poll", intervalMs: RELAY_POLL_INTERVAL_MS }), isNotifyConnected: () => deps["notify-bus"].isConnected(), isNotifySafetyPollEnabled: () => deps["notify-bus"].isSafetyPollEnabled() });
    const fireConsumer = new SandAutomationFireConsumer({ getAccessToken: deps.auth.getAccessToken, getBackendUrl: () => getConfiguredBackendUrl(), getTimeZone: () => deps.settings.getUserTimeZone(), getBoxUptimeMs, isReady: () => deps["turn-execution"].isRunReady(), listAutomations: () => deps.transcript.listAllAutomationDefinitions(), fire: (args) => deps.transcript.runServerScheduledAutomation(args), fireForEvent: (args) => deps.transcript.runServerAutomationForEvent(args), telemetry: deps.telemetry.brain, isNotifyConnected: () => deps["notify-bus"].isConnected(), isNotifySafetyPollEnabled: () => deps["notify-bus"].isSafetyPollEnabled() });
    context.onStop(deps["notify-bus"].onNotify("automation-fires", () => fireConsumer.requestDrain()));
    context.onStop(deps["notify-bus"].onNotify("listener-events", () => relay.requestDrain()));
    const hub = new SandTriggerHub({ polling: createRealPollingPolicy({ name: "automations.hub-reconcile", intervalMs: HUB_RECONCILE_INTERVAL_MS }), sources: [relay.slack, relay.github], listAutomations: () => deps.transcript.listAllAutomationDefinitions(), fire: (agentId, automation, event) => deps.transcript.runAutomationForEvent(agentId, automation as ScheduledCloudAutomation, event), isReady: () => deps["turn-execution"].isRunReady(), shouldScheduleLocally: (agentId, automation) => cloudSync.shouldScheduleLocally({ agentId, automation }), onReconcile: () => { void cloudSync.reconcileNow(); void fireConsumer.tick(); } });
    notifySchedulingAuthorityChanged = () => { void hub.reconcileNow(); };
    const listenerReads = createListenerIntegrationReads({ auth: deps.auth, transcript: deps.transcript, sourceStatuses: () => hub.getSourceStatuses(), log: host.log });
    const watcher = new ListenerConnectWatcher({ polling: createRealPollingPolicy({ name: "automations.connect-watch", intervalMs: CONNECT_WATCH_POLL_INTERVAL_MS }), isPlatformConnected: listenerReads.isPlatformConnected, onConnected: (agentId, platform) => void deps.transcript.resumeAfterListenerConnect(agentId, platform) });
    const offConfigChanged = host.events.on("transcript.automation-config-changed", () => { fireConsumer.resetPollDelay(); void hub.reconcileNow(); });
    const offConnectCard = host.events.on("transcript.listener-connect-card", ({ agentId, platform }: { agentId: string; platform: "slack" | "github" }) => watcher.watch(agentId, platform));
    hub.start();
    const stopAuth = reconcileWhenAuthenticated({ auth: deps.auth, reconcile: () => void hub.reconcileNow() });
    context.onStop(async () => { stopAuth(); offConfigChanged(); offConnectCard(); watcher.dispose(); fireConsumer.stop(); await hub.stop(); });
    return { sourceStatuses: () => hub.getSourceStatuses(), suspendWakes: async () => { watcher.suspend(); fireConsumer.stop(); await hub.stop(); }, resumeWakes: () => { watcher.resume(); hub.start(); fireConsumer.start(); }, deleteAgentSchedules: (agentId: string) => cloudSync.deleteAgent(agentId), reconcileNow: () => hub.reconcileNow(), getListenerIntegrations: () => listenerReads.getIntegrations(), getListenerConnectUrl: (platform: "slack" | "github") => listenerReads.getConnectUrl(platform), isListenerPlatformConnected: (platform: "slack" | "github") => listenerReads.isPlatformConnected(platform), getAgentChannels: (agentId: string) => listenerReads.getAgentChannels(agentId) };
  }
});
