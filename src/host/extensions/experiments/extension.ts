import { defineHostExtension } from "../../../shared/host-extensions.js";
import { MutableGateProperty } from "../../../shared/node/experiments/gate-property.js";
import { resolveMultitaskEnabled } from "../../sand-multitask.js";
import { resolveSpotlightEnabled } from "../../../shared/sand-spotlight.js";
import { HostExtensions } from "../extension-ids.generated.js";

/** Permanent false gate — consumers call get()/subscribe() on the result. */
const disabledGate = (): { get(): boolean; subscribe(listener: (value: boolean) => void): () => void } =>
  new MutableGateProperty(false);

/**
 * Cursor-free experiments slot.
 *
 * The recovered implementation ran a Statsig client (fetching feature gates
 * and model experiments from Cursor's backend) — in a headless deployment
 * without Cursor credentials it can never hydrate, spews hundreds of
 * "id_type userID" warnings, and every gate reads false anyway. This stub
 * keeps the exact API surface with deterministic local answers: all feature
 * gates off, no model experiments, and the two env-switchable capabilities
 * (SAND_MULTITASK / SAND_SPOTLIGHT) still honor their environment variables.
 */
export const experimentsExtension = defineHostExtension({
  id: HostExtensions.Experiments,
  dependencies: [HostExtensions.Auth, HostExtensions.Settings],
  start: () => ({
    checkFeatureGate: (_name: string): boolean => false,
    getFeatureGateProperty: (_name: string) => disabledGate(),
    checkGate: async (_name: string): Promise<boolean> => false,
    getDynamicConfig: (_name: string): Record<string, never> => ({}),
    subscribe: (_listener: () => void): (() => void) => () => {},
    pinGateOnAuthenticatedBootstrap: (_name: string, _pin: (value: boolean) => void): void => {},
    hasHydratedStatsigUserId: (): boolean => true,
    waitForHydratedStatsigUserId: async (_timeoutMs?: number): Promise<void> => {},
    hasAuthenticatedStatsigBootstrap: (): boolean => true,
    getSandModelExperimentState: (): null => null,
    logSandModelExperimentExposure: (): void => {},
    getConfiguredDefaultModel: (): undefined => undefined,
    getConfiguredAutomationsModel: (): undefined => undefined,
    getComputerUseModelOverride: (): undefined => undefined,
    getBrowserUseModelOverride: (): undefined => undefined,
    isAgentNetworkEnabled: (): boolean => false,
    isMcpMultiAccountEnabled: (): boolean => false,
    isSparsePluginClonesEnabled: (): boolean => false,
    isMultitaskEnabled: (): boolean => resolveMultitaskEnabled(process.env.SAND_MULTITASK, () => false),
    isSendMessageDeliveryOwedEnabled: (): boolean => false,
    isDynamicToolsEnabled: (): boolean => false,
    isBrowserUseSubagentEnabled: (): boolean => false,
    isSpotlightEnabled: (): boolean => resolveSpotlightEnabled(process.env.SAND_SPOTLIGHT, () => false),
    isUnicodeTypingEnabled: (): boolean => false,
    isUaTokenKillSwitchEnabled: (): boolean => false,
  }),
});
