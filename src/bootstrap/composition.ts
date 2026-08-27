/**
 * Shared headless composition root for sdk-bots.
 *
 * Both entrypoints — the CLI bootstrap (`src/bootstrap/index.ts`) and the
 * SDK's `startHost()` (`src/sdk/entry.ts`) — assemble the recovered host from
 * the same production providers. This module is the single place that wiring
 * lives so the two entries cannot drift apart.
 *
 * Providers are imported dynamically on purpose: loading them pulls in the
 * whole host runtime (tree-sitter, jimp, sqlite, …). Embedders who only use
 * `SdkBotsClient` against an external gateway must not pay that cost — or
 * suffer its module-load side effects — until a host actually starts.
 */

/** Assembles and boots the production host graph. Resolves when startup completes. */
export async function startHeadlessHost(): Promise<void> {
  const { startProductionHost } = await import("../host/main.js");
  const { bindRecoveredProductionExtensions } = await import("../host/host-production-extensions.js");
  const { productionBoxGeneratedPorts } = await import("../host/box/generated-production.js");
  const {
    convertProductionCloudAgentConversationToTrace,
    productionSecretsContext,
    createProductionStateBackstop,
  } = await import("../host/production-binding-providers.js");
  const { createProductionRunnerContext } = await import("../host/runner-context-production-provider.js");
  const { createDefaultProductionTranscriptMirrorProvider } = await import("../host/transcript-mirror/production-provider.js");
  const { executeBoxCopyInFromEnv } = await import("../host/extensions/box-store-sync/box-copy-in.js");
  const { productionLocalExecCodec } = await import("../host/extensions/local-exec/production.js");

  const ports = {
    executeBoxCopyInFromEnv,
    extensionHost: {
      boxGenerated: productionBoxGeneratedPorts,
      convertCloudAgentConversationToTrace: convertProductionCloudAgentConversationToTrace,
    },
    runnerContext: createProductionRunnerContext(),
    createTranscriptMirror: createDefaultProductionTranscriptMirrorProvider(),
    log: console,
  };

  const extensionBindings = {
    stateBackstop: createProductionStateBackstop(),
    // Concrete artifact-backed codec; without it every turn's resource
    // accessor creation throws and the turn retry loop spins forever.
    localExecCodec: productionLocalExecCodec,
    secretsContext: productionSecretsContext,
  };

  return startProductionHost(bindRecoveredProductionExtensions(ports, extensionBindings));
}
