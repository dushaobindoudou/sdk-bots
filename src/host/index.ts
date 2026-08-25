/**
 * Headless host bootstrap for sdk-bots.
 *
 * Replaces electron-main: assembles the production host ports from the
 * recovered clean-source providers and starts the gateway server directly.
 * No Electron, no window, no tray — just a loopback HTTP gateway.
 *
 * Usage:  node dist/host/index.js
 * Env:    SAND_DATA_ROOT (data dir; defaults to ~/.sdk-bots — never ~/.cursor),
 *         SAND_GATEWAY_TOKEN (auth), SAND_HOST_PORT (port), SAND_GATEWAY_BIND_HOST
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { createProductionHostMainDependencies, startProductionHost } from "../../source/host/main.js";
import { bindRecoveredProductionExtensions } from "../../source/host/host-production-extensions.js";
import { productionBoxGeneratedPorts } from "../../source/host/box/generated-production.js";
import { convertProductionCloudAgentConversationToTrace, productionSecretsContext, createProductionStateBackstop } from "../../source/host/production-binding-providers.js";
import { createProductionRunnerContext } from "../../source/host/runner-context-production-provider.js";
import { createDefaultProductionTranscriptMirrorProvider } from "../../source/host/transcript-mirror/production-provider.js";
import { executeBoxCopyInFromEnv } from "../../source/host/extensions/box-store-sync/box-copy-in.js";

// SDK defaults: isolate the data root from any real Cursor/Grok Bot install
// (host-paths would otherwise fall back to ~/.cursor/<variant>), and skip the
// box-exec-daemon sidecar that is not shipped with this SDK.
process.env.SAND_DATA_ROOT ??= join(homedir(), ".sdk-bots");
process.env.SAND_USE_EXISTING_BOX_EXEC_DAEMON ??= "1";

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
