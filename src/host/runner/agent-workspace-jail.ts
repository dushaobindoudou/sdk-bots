import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { getSandRootDir } from "../../shared/sand-paths.js";
import { getSandSettingsPath, readSandSettingsFile } from "../agents/settings-file.js";
import { boxComputerWorkspaceRoot } from "../box/box-exec-endpoint.js";

/**
 * Per-agent workspace jail.
 *
 * The box exec daemon only constrains the *cwd* of a spawn; a shell command can
 * still write anywhere the host user can. When an agent's settings.json
 * declares `workspaceRoot`, every shell that agent runs is wrapped in a
 * generated macOS Seatbelt profile that denies file writes outside the agent's
 * own workspace directory (plus a small set of system-necessary paths). Reads
 * stay unrestricted so shared blackboards remain readable.
 *
 * Config surface (per agent, `~/.sdk-bots/agents/<id>/settings.json`):
 *   workspaceRoot: "/workspace/<slug>"        — bot-facing virtual root
 *   workspaceAllowPaths: ["/abs/path", ...]   — extra writable host paths
 *
 * The jail resolves lazily per turn, so editing settings.json takes effect on
 * the agent's next turn without restarting the host.
 */

export const SAND_WORKSPACE_VIRTUAL_PREFIX = "/workspace/";
const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
const SANDBOX_EXEC_ENV_DISABLE = "0";

export interface WorkspaceJailConfig {
  readonly agentId: string;
  /** Bot-facing cwd forced onto every jailed shell, e.g. "/workspace/<slug>". */
  readonly virtualRoot: string;
  /** Host directory backing virtualRoot, e.g. "<box-workspace>/<slug>". */
  readonly hostRoot: string;
  /** Generated Seatbelt profile applied around every jailed command. */
  readonly profilePath: string;
  /** Extra host paths the jailed agent may write. */
  readonly allowPaths: readonly string[];
}

export interface WorkspaceJailDeps {
  readonly agentsDir?: string;
  readonly boxWorkspaceRoot?: string;
  readonly jailsDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides the sandbox-exec binary probed for existence; null disables. */
  readonly sandboxExecPath?: string | null;
}

export class WorkspaceJailConfigError extends Error {
  override readonly name = "WorkspaceJailConfigError";
}

const SLUG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,78}$/u;
const AGENT_ID_FILENAME_PATTERN = /^[\w-]{1,128}$/;

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function assertSlugSafe(slug: string, source: string): string {
  if (slug.includes("..") || slug.includes("/") || !SLUG_PATTERN.test(slug)) {
    throw new WorkspaceJailConfigError(
      `Invalid workspaceRoot "${source}": expected "/workspace/<slug>" with a flat slug (letters, digits, dot, dash, underscore)`,
    );
  }
  return slug;
}

function assertAllowPath(candidate: string): string {
  const resolved = resolve(candidate);
  if (!isAbsolute(candidate) || resolved === "/") {
    throw new WorkspaceJailConfigError(
      `Invalid workspaceAllowPaths entry "${candidate}": must be an absolute host path other than "/"`,
    );
  }
  return resolved;
}

/**
 * Resolves the workspace jail for one agent, or undefined when the agent is
 * not jailed (no workspaceRoot in settings.json), the platform has no
 * sandbox-exec, or the kill switch `SAND_AGENT_WORKSPACE_JAIL=0` is set.
 * Throws on a present-but-malformed configuration: a jail that silently fails
 * open would be a security hole.
 */
export function resolveAgentWorkspaceJail(
  agentId: string,
  deps: WorkspaceJailDeps = {},
): WorkspaceJailConfig | undefined {
  const env = deps.env ?? process.env;
  if (env.SAND_AGENT_WORKSPACE_JAIL === SANDBOX_EXEC_ENV_DISABLE) return undefined;
  const sandboxExecPath = deps.sandboxExecPath === undefined ? SANDBOX_EXEC_PATH : deps.sandboxExecPath;
  if ((deps.platform ?? process.platform) !== "darwin" || sandboxExecPath == null || !existsSync(sandboxExecPath)) return undefined;
  if (!AGENT_ID_FILENAME_PATTERN.test(agentId)) return undefined;

  const agentsDir = deps.agentsDir ?? join(getSandRootDir(), "agents");
  const settings = readSandSettingsFile(getSandSettingsPath(join(agentsDir, agentId)));
  if (settings.workspaceRoot === undefined) return undefined;
  const requested = settings.workspaceRoot;

  const boxWorkspaceRoot = resolve(deps.boxWorkspaceRoot ?? boxComputerWorkspaceRoot(env));
  let slug: string;
  if (requested.startsWith(SAND_WORKSPACE_VIRTUAL_PREFIX)) {
    slug = assertSlugSafe(requested.slice(SAND_WORKSPACE_VIRTUAL_PREFIX.length), requested);
  } else if (isAbsolute(requested)) {
    const resolved = resolve(requested);
    const rel = relative(boxWorkspaceRoot, resolved);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new WorkspaceJailConfigError(
        `Invalid workspaceRoot "${requested}": must be "/workspace/<slug>" or an absolute path inside ${boxWorkspaceRoot}`,
      );
    }
    slug = assertSlugSafe(rel, requested);
  } else {
    throw new WorkspaceJailConfigError(
      `Invalid workspaceRoot "${requested}": expected "/workspace/<slug>" or an absolute host path inside ${boxWorkspaceRoot}`,
    );
  }

  return {
    agentId,
    virtualRoot: `${SAND_WORKSPACE_VIRTUAL_PREFIX}${slug}`,
    hostRoot: join(boxWorkspaceRoot, slug),
    profilePath: join(
      deps.jailsDir ?? join(getSandRootDir(), "workspace-jails"),
      `${agentId}.sb`,
    ),
    allowPaths: (settings.workspaceAllowPaths ?? []).map(assertAllowPath),
  };
}

/**
 * Renders the Seatbelt profile. Writes are confined to the agent workspace,
 * configured extra paths, and the OS temp directory; everything else is denied
 * at the kernel level. Both the literal and /private realpath forms of every
 * allowed subpath are emitted because /tmp and /var are symlinks on macOS and
 * Seatbelt matches against resolved paths.
 */
export function buildWorkspaceSeatbeltProfile(config: WorkspaceJailConfig, extraTempDir = tmpdir()): string {
  const writeRoots = [config.hostRoot, ...config.allowPaths, extraTempDir];
  const subpaths: string[] = [];
  for (const root of writeRoots) {
    const resolved = resolve(root);
    subpaths.push(`  (subpath "${resolved}")`);
    if (!resolved.startsWith("/private/")) subpaths.push(`  (subpath "/private${resolved}")`);
  }
  return [
    "(version 1)",
    `; dsh agent workspace jail: ${config.agentId} -> ${config.virtualRoot}`,
    "(deny default)",
    "(allow process*)",
    "(allow file-read*)",
    "(allow network*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix*)",
    "(allow ipc-posix-shm)",
    "(allow system-socket)",
    "(allow file-write*",
    ...subpaths,
    "  (regex #\"^/dev/(null|stdout|stderr|stdin|fd|ttys[0-9]+|dtracehelper|console)$\")",
    ")",
    "",
  ].join("\n");
}

/** Writes the profile when missing or changed; returns the profile path. */
export function ensureWorkspaceSeatbeltProfile(config: WorkspaceJailConfig, profile = buildWorkspaceSeatbeltProfile(config)): string {
  mkdirSync(resolve(config.profilePath, ".."), { recursive: true });
  let existing: string | null = null;
  try {
    existing = readFileSync(config.profilePath, "utf8");
  } catch {
    existing = null;
  }
  if (existing !== profile) {
    const temporary = `${config.profilePath}.${process.pid}.tmp`;
    writeFileSync(temporary, profile, "utf8");
    renameSync(temporary, config.profilePath);
  }
  return config.profilePath;
}

/** Minimal shape shared by ShellArgs and BackgroundShellSpawnArgs. */
export interface JailableShellArgs {
  command: string;
  workingDirectory: string;
  clone(): JailableShellArgs;
}

/**
 * Rewrites one shell invocation into its jailed form: the original command is
 * single-quoted into `sandbox-exec -f <profile> /bin/sh -c <original>` and the
 * working directory is forced to the agent's own workspace. The daemon spawns
 * the wrapper via `/bin/sh -lc`, so confinement covers the whole process tree.
 */
export function applyWorkspaceJailToShellArgs<T extends JailableShellArgs>(args: T, config: WorkspaceJailConfig): T {
  const profilePath = ensureWorkspaceSeatbeltProfile(config);
  const wrapped = `${SANDBOX_EXEC_PATH} -f ${shellSingleQuote(profilePath)} /bin/sh -c ${shellSingleQuote(args.command)}`;
  // Generated protobuf messages override clone() with the concrete `this` type;
  // through the generic constraint TS only sees JailableShellArgs, so assert.
  const jailed = args.clone() as unknown as T;
  jailed.command = wrapped;
  jailed.workingDirectory = config.virtualRoot;
  return jailed;
}
