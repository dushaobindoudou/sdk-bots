/**
 * sdk-bots public entry.
 *
 * Two ways to use:
 *
 * 1. Programmatic (start the host in-process):
 *    import { startHost, SdkBotsClient } from "sdk-bots";
 *    const { port, token } = await startHost();
 *    const sdk = new SdkBotsClient({ baseUrl: `http://127.0.0.1:${port}`, token });
 *
 * 2. External (host already running as a process):
 *    import { SdkBotsClient } from "sdk-bots";
 *    const sdk = new SdkBotsClient({ baseUrl: "http://127.0.0.1:7331", token: "..." });
 */

export { SdkBotsClient } from "./index.js";
export type { SdkBotsClientOptions } from "./index.js";

export async function startHost(): Promise<{ port: number; token?: string }> {
  // SDK mode: skip spawning the box exec-daemon bundle (not shipped in source form).
  // Local shell-exec tooling is degraded; gateway / agents / transcripts are unaffected.
  process.env.SAND_USE_EXISTING_BOX_EXEC_DAEMON ??= "1";
  const { startProductionHost } = await import("../../source/host/main.js");
  const { bindRecoveredProductionExtensions } = await import("../../source/host/host-production-extensions.js");
  const { productionBoxGeneratedPorts } = await import("../../source/host/box/generated-production.js");
  const { convertProductionCloudAgentConversationToTrace, productionSecretsContext, createProductionStateBackstop } = await import("../../source/host/production-binding-providers.js");
  const { createProductionRunnerContext } = await import("../../source/host/runner-context-production-provider.js");
  const { createDefaultProductionTranscriptMirrorProvider } = await import("../../source/host/transcript-mirror/production-provider.js");
  const { executeBoxCopyInFromEnv } = await import("../../source/host/extensions/box-store-sync/box-copy-in.js");

  const ports = {
    executeBoxCopyInFromEnv,
    extensionHost: { boxGenerated: productionBoxGeneratedPorts, convertCloudAgentConversationToTrace: convertProductionCloudAgentConversationToTrace },
    runnerContext: createProductionRunnerContext(),
    createTranscriptMirror: createDefaultProductionTranscriptMirrorProvider(),
    log: console,
  };
  const extensionBindings = {
    stateBackstop: createProductionStateBackstop(),
    localExecCodec: undefined,
    secretsContext: productionSecretsContext,
  };
  await startProductionHost(bindRecoveredProductionExtensions(ports, extensionBindings));

  const fs = await import("node:fs/promises");
  const { getGatewayDiscoveryPath } = await import("../../source/host/host-paths.js");
  let discovery: any;
  try {
    discovery = JSON.parse(await fs.readFile(getGatewayDiscoveryPath(), "utf8"));
  } catch { discovery = { port: 7331 }; }
  return { port: discovery.port, token: discovery.token };
}
