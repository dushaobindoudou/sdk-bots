/**
 * Headless host bootstrap for sdk-bots (CLI entry).
 *
 * Replaces electron-main: starts the gateway server directly from the shared
 * headless composition. No Electron, no window, no tray - just a loopback
 * HTTP gateway.
 *
 * Usage:  node dist/bootstrap/index.js   (or: npm run dev)
 *         node dist/bootstrap/index.js --local-exec-daemon
 * Env:    SAND_DATA_ROOT (data dir; defaults to ~/.sdk-bots - never ~/.cursor),
 *         SAND_GATEWAY_TOKEN (auth), SAND_HOST_PORT (port), SAND_GATEWAY_BIND_HOST,
 *         SAND_BOX_EXEC_DAEMON_ENTRY (bundled loopback exec-daemon path),
 *         SAND_BOX_EXEC_DAEMON_HOST (connect host; non-loopback = remote box),
 *         SAND_LOCAL_EXEC_GATEWAY_URL (standalone --local-exec-daemon attach URL)
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startHeadlessHost } from "./composition.js";
import { runLocalExecDaemon } from "../host/local-exec/local-exec-daemon.js";

// SDK defaults: isolate the data root from any real Cursor/Grok Bot install
// (host-paths would otherwise fall back to ~/.cursor/<variant>).
process.env.SAND_DATA_ROOT ??= join(homedir(), ".sdk-bots");

// Local OpenAI-compatible freeroute: default model that is currently proven
// working on the local proxy (the `auto` route returns empty content as of
// 2026-09-03). Override with SAND_OPENROUTER_BASE_URL / SAND_OPENROUTER_MODEL /
// OPENROUTER_API_KEY.
process.env.SAND_OPENROUTER_BASE_URL ??= "http://127.0.0.1:3080/freeroute/v1";
process.env.SAND_OPENROUTER_MODEL ??= "deepseek-v4-flash";

// Point the host at the bundled loopback box exec-daemon (dist/box-exec-daemon,
// built by `npm run build:daemon`); without it turns block on box readiness
// forever (fall back to degraded no-daemon mode only when the bundle is missing).
{
  const here = dirname(fileURLToPath(import.meta.url));
  const daemonCandidates = [
    join(here, "..", "box-exec-daemon", "main.cjs"), // dist/bootstrap -> dist/box-exec-daemon (packaged)
    join(here, "..", "..", "dist", "box-exec-daemon", "main.cjs"), // src/bootstrap -> dist (dev via tsx)
  ];
  const daemonEntry = daemonCandidates.find(p => existsSync(p));
  if (daemonEntry != null) {
    process.env.SAND_BOX_EXEC_DAEMON_ENTRY ??= daemonEntry;
  } else {
    process.env.SAND_USE_EXISTING_BOX_EXEC_DAEMON ??= "1";
  }
}

if (process.argv.includes("--local-exec-daemon")) {
  runLocalExecDaemon({ publishDiscovery: false }).then((handle) => {
    const shutdown = () => { void handle.close().finally(() => process.exit(0)); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch((error) => {
    process.stderr.write("[sdk-bots] local-exec-daemon fatal: " + String(error) + "\n");
    process.exitCode = 1;
  });
} else {
  startHeadlessHost().catch((error) => {
    process.stderr.write("[sdk-bots] fatal: " + String(error) + "\n");
    process.exitCode = 1;
  });
}
