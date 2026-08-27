import { join } from "node:path";

import { getSandRootDir } from "../../shared/sand-paths.js";
import { DEFAULT_AUTH_TOKEN, EXEC_DAEMON_PORT } from "./loopback-sand-box.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackBoxHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export interface BoxExecEndpoint {
  /** Address the host uses to reach the daemon (may be a remote IP). */
  readonly host: string;
  /** Address the daemon process binds. `0.0.0.0` accepts remote clients. */
  readonly bindHost: string;
  readonly port: number;
  readonly authToken: string;
}

function readPort(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Connect/bind/auth for the box exec-daemon.
 *
 * - `SAND_BOX_EXEC_DAEMON_HOST` — host process connects here (default 127.0.0.1).
 *   A non-loopback value means a remote box; the host will not spawn a local daemon.
 * - `SAND_BOX_EXEC_DAEMON_BIND_HOST` — daemon listen address (default 127.0.0.1,
 *   or 0.0.0.0 when the connect host is already non-loopback on a daemon-only machine).
 * - `SAND_BOX_EXEC_DAEMON_PORT` — both sides (default 1337).
 * - `SAND_BOX_EXEC_DAEMON_AUTH_TOKEN` — bearer token (default `local`).
 */
export function resolveBoxExecEndpoint(env: NodeJS.ProcessEnv = process.env): BoxExecEndpoint {
  const host = env.SAND_BOX_EXEC_DAEMON_HOST?.trim() || "127.0.0.1";
  const bindHost = env.SAND_BOX_EXEC_DAEMON_BIND_HOST?.trim()
    || (isLoopbackBoxHost(host) ? host : "0.0.0.0");
  const port = readPort(env.SAND_BOX_EXEC_DAEMON_PORT, EXEC_DAEMON_PORT);
  const authToken = env.SAND_BOX_EXEC_DAEMON_AUTH_TOKEN?.trim() || DEFAULT_AUTH_TOKEN;
  return { host, bindHost, port, authToken };
}

/** After binding 0.0.0.0, readiness pings must use a unicast address. */
export function boxExecPingHost(endpoint: Pick<BoxExecEndpoint, "host" | "bindHost">): string {
  if (endpoint.bindHost === "0.0.0.0" || endpoint.bindHost === "::") {
    return isLoopbackBoxHost(endpoint.host) ? "127.0.0.1" : endpoint.host;
  }
  return endpoint.host;
}

export function shouldSpawnLocalBoxExecDaemon(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SAND_USE_EXISTING_BOX_EXEC_DAEMON === "1") return false;
  return isLoopbackBoxHost(resolveBoxExecEndpoint(env).host);
}

/** Reconstructed daemon has no fork-desktop router; only a loopback pre-existing image does. */
export function isStandaloneBoxExecDaemon(env: NodeJS.ProcessEnv = process.env): boolean {
  return shouldSpawnLocalBoxExecDaemon(env) || !isLoopbackBoxHost(resolveBoxExecEndpoint(env).host);
}

export function boxComputerWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SAND_BOX_WORKSPACE_ROOT?.trim() || join(getSandRootDir(), "box-workspace");
}
