/**
 * Headless host bootstrap for sdk-bots.
 *
 * Replaces electron-main: assembles the production host ports from the
 * recovered clean-source providers and starts the gateway server directly.
 * No Electron, no window, no tray — just a loopback HTTP gateway.
 *
 * Usage:  node dist/host/index.js
 * Env:    SAND_GATEWAY_TOKEN (auth), SAND_HOST_PORT (port), SAND_GATEWAY_BIND_HOST
 */

import { createProductionHostMainDependencies, startProductionHost } from "../../source/host/main.js";
import { bindRecoveredProductionExtensions } from "../../source/host/host-production-extensions.js";
import { productionBoxGeneratedPorts } from "../../source/host/box/generated-production.js";
import { convertProductionCloudAgentConversationToTrace, productionSecretsContext, createProductionStateBackstop } from "../../source/host/production-binding-providers.js";
import { createProductionRunnerContext } from "../../source/host/runner-context-production-provider.js";
import { createDefaultProductionTranscriptMirrorProvider } from "../../source/host/transcript-mirror/production-provider.js";
import { executeBoxCopyInFromEnv } from "../../source/host/extensions/box-store-sync/box-copy-in.js";

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
  localExecCodec: undefined,
  secretsContext: productionSecretsContext,
};

const boundPorts = bindRecoveredProductionExtensions(ports, extensionBindings);

startProductionHost(boundPorts).catch((error) => {
  process.stderr.write("[sdk-bots] fatal: " + String(error) + "\n");
  process.exitCode = 1;
});
