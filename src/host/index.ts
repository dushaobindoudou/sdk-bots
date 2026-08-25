/**
 * Headless host bootstrap for sdk-bots.
 *
 * Replaces electron-main: assembles the production host ports from the
 * recovered clean-source providers and starts the gateway server directly.
 * No Electron, no window, no tray - just a loopback HTTP gateway.
 *
 * Usage:  node dist/host/index.js
 * Env:    SAND_DATA_ROOT (data dir; defaults to ~/.sdk-bots - never ~/.cursor),
 *         SAND_GATEWAY_TOKEN (auth), SAND_HOST_PORT (port), SAND_GATEWAY_BIND_HOST,
 *         SAND_BOX_EXEC_DAEMON_ENTRY (bundled loopback exec-daemon path)
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createProductionHostMainDependencies, startProductionHost } from "../../source/host/main.js";
import { bindRecoveredProductionExtensions } from "../../source/host/host-production-extensions.js";
import { productionBoxGeneratedPorts } from "../../source/host/box/generated-production.js";
import { convertProductionCloudAgentConversationToTrace, productionSecretsContext, createProductionStateBackstop } from "../../source/host/production-binding-providers.js";
import { createProductionRunnerContext } from "../../source/host/runner-context-production-provider.js";
import { createDefaultProductionTranscriptMirrorProvider } from "../../source/host/transcript-mirror/production-provider.js";
import { executeBoxCopyInFromEnv } from "../../source/host/extensions/box-store-sync/box-copy-in.js";
import { productionLocalExecCodec } from "../../source/host/extensions/local-exec/production.js";

// SDK defaults: isolate the data root from any real Cursor/Grok Bot install
// (host-paths would otherwise fall back to ~/.cursor/<variant>).
process.env.SAND_DATA_ROOT ??= join(homedir(), ".sdk-bots");

// Point the host at the bundled loopback box exec-daemon when present; without
// it turns block on box readiness forever (fall back to degraded no-daemon
// mode only when the bundle is missing).
{
  const here = dirname(fileURLToPath(import.meta.url));
  const daemonCandidates = [
    join(here, "..", "box-exec-daemon", "main.cjs"), // src/host -> src/box-exec-daemon (dev)
    join(here, "..", "..", "box-exec-daemon", "main.cjs"), // dist/src/host -> dist/box-exec-daemon (packaged)
    join(here, "..", "..", "src", "box-exec-daemon", "main.cjs"), // dist/src/host -> src/box-exec-daemon
  ];
  const daemonEntry = daemonCandidates.find(p => existsSync(p));
  if (daemonEntry != null) {
    process.env.SAND_BOX_EXEC_DAEMON_ENTRY ??= daemonEntry;
  } else {
    process.env.SAND_USE_EXISTING_BOX_EXEC_DAEMON ??= "1";
  }
}

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

const boundPorts = bindRecoveredProductionExtensions(ports, extensionBindings);

startProductionHost(boundPorts).catch((error) => {
  process.stderr.write("[sdk-bots] fatal: " + String(error) + "\n");
  process.exitCode = 1;
});
