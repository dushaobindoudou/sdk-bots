import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SAND_SETTINGS_FILENAME = "settings.json";
export const DEFAULT_NOTIFY_ON_AGENT_UPDATES = true;
export const DEFAULT_HIDDEN_FROM_SIDEBAR = false;

export interface SandAgentSettings {
  notifyOnAgentUpdates: boolean;
  hiddenFromSidebar: boolean;
  /**
   * Optional per-agent workspace jail root (agent-workspace-jail). Accepts the
   * bot-facing virtual form "/workspace/<slug>" or an absolute host path inside
   * the box workspace root. When set, every shell the agent spawns is confined
   * to this directory via a generated Seatbelt profile (macOS).
   */
  workspaceRoot?: string;
  /** Extra host paths the jailed agent may write (e.g. a shared blackboard). */
  workspaceAllowPaths?: string[];
}

export function getSandSettingsPath(agentDir: string): string { return join(agentDir, SAND_SETTINGS_FILENAME); }

function readRawSettings(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export function readSandSettingsFile(path: string): SandAgentSettings {
  const raw = readRawSettings(path);
  const workspaceAllowPaths = Array.isArray(raw.workspaceAllowPaths)
    ? raw.workspaceAllowPaths.filter((value): value is string => typeof value === "string" && value.trim() !== "")
    : undefined;
  return {
    notifyOnAgentUpdates: typeof raw.notifyOnAgentUpdates === "boolean" ? raw.notifyOnAgentUpdates : DEFAULT_NOTIFY_ON_AGENT_UPDATES,
    hiddenFromSidebar: typeof raw.hiddenFromSidebar === "boolean" ? raw.hiddenFromSidebar : DEFAULT_HIDDEN_FROM_SIDEBAR,
    ...(typeof raw.workspaceRoot === "string" && raw.workspaceRoot.trim() !== "" ? { workspaceRoot: raw.workspaceRoot.trim() } : {}),
    ...(workspaceAllowPaths !== undefined && workspaceAllowPaths.length > 0 ? { workspaceAllowPaths } : {})
  };
}

export function writeSandSettingsFile(path: string, update: Partial<SandAgentSettings>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...readRawSettings(path), ...update }, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
