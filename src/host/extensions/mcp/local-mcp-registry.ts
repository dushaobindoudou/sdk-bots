import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AccountMcpServer } from "../../../shared/node/cursor-backend/account-mcp.js";
import { SandMcpConfigError } from "../../../shared/node/mcp/mcp-config-error.js";
import type { McpServerConfig } from "../../../shared/node/mcp/mcp-display-runtime.js";
import { validateServerName } from "../../../shared/node/mcp/mcp-validation.js";

/**
 * Local, file-backed MCP server registry.
 *
 * The recovered host stored user-added MCP servers in the Cursor account
 * (DashboardService getMcpConfig/setMcpConfig) and discovered them through
 * the same backend. Without Cursor credentials neither path exists. This
 * registry is the local replacement: one JSON file owns the server map and
 * stable ids, and it implements both halves the manager needs —
 * AccountMcpWriter (add/remove) and the account servers provider
 * (discovery for tool routing).
 *
 * File format (~/.sdk-bots/mcp-servers.json):
 *   { "version": 1, "servers": { "filesystem": { "id": "900000001",
 *       "config": { "command": "npx", "args": ["-y", "..."] } } } }
 *
 * Ids are allocated from a fixed 9-digit local range so they never collide
 * with backend-assigned ids and remain stable across edits.
 */

const LOCAL_ID_BASE = 900_000_000;

interface RegistryEntry { readonly id: string; readonly config: McpServerConfig }
interface RegistryFile { version: 1; servers: Record<string, RegistryEntry> }

export interface LocalMcpRegistry {
  readonly writer: {
    getConfigForEdit(): Promise<{ config: { mcpServers: Record<string, McpServerConfig> }; serverIdsByName: Record<string, bigint> }>;
    setConfig(config: { mcpServers: Record<string, McpServerConfig> }, serverIdsByName: Readonly<Record<string, bigint>>): Promise<void>;
    installPlugin(args: { pluginId: bigint; variables?: Readonly<Record<string, string>> }): Promise<never>;
    uninstallPlugin(args: { pluginId: bigint }): Promise<never>;
    updatePluginInstall(args: { pluginId: bigint; variables: Readonly<Record<string, string>> }): Promise<never>;
  };
  readonly serversProvider: () => Promise<{ servers: AccountMcpServer[]; cacheScope: string }>;
  readonly listServers: () => Array<{ name: string; id: string; config: McpServerConfig }>;
}

export function parseLocalMcpServerConfig(value: unknown): McpServerConfig {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new SandMcpConfigError("MCP server config must be a JSON object.");
  }
  const config = value as Record<string, unknown>;
  const hasCommand = typeof config.command === "string" && config.command.trim().length > 0;
  const hasUrl = typeof config.url === "string" && config.url.trim().length > 0;
  if (!hasCommand && !hasUrl) {
    throw new SandMcpConfigError('MCP server config needs either "command" (stdio) or "url" (http/sse).');
  }
  if (hasCommand && Array.isArray(config.args)) {
    for (const arg of config.args) if (typeof arg !== "string") throw new SandMcpConfigError('"args" entries must be strings.');
  }
  return config as unknown as McpServerConfig;
}

export function createLocalMcpRegistry(options: { registryPath: string; log?: (message: string) => void }): LocalMcpRegistry {
  const { registryPath, log } = options;
  let nextId = LOCAL_ID_BASE;

  const read = (): RegistryFile => {
    try {
      const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as Partial<RegistryFile>;
      if (parsed != null && parsed.version === 1 && parsed.servers != null && typeof parsed.servers === "object") {
        const servers: Record<string, RegistryEntry> = {};
        for (const [name, entry] of Object.entries(parsed.servers)) {
          const record = entry as Partial<RegistryEntry>;
          if (record == null || typeof record.id !== "string" || record.config == null) continue;
          servers[name] = { id: record.id, config: record.config as McpServerConfig };
          const numeric = Number(record.id);
          if (Number.isInteger(numeric) && numeric >= LOCAL_ID_BASE && numeric < nextId + 1_000_000) {
            nextId = Math.max(nextId, numeric + 1);
          }
        }
        return { version: 1, servers };
      }
    } catch {
      // Missing or malformed file — start empty.
    }
    return { version: 1, servers: {} };
  };

  const write = (file: RegistryFile): void => {
    try {
      writeFileSync(registryPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    } catch (error) {
      log?.(`[mcp] local registry write failed: ${String(error)}`);
      throw error;
    }
  };

  return {
    writer: {
      async getConfigForEdit() {
        const { servers } = read();
        const mcpServers: Record<string, McpServerConfig> = {};
        const serverIdsByName: Record<string, bigint> = {};
        for (const [name, entry] of Object.entries(servers)) {
          mcpServers[name] = entry.config;
          serverIdsByName[name] = BigInt(entry.id);
        }
        return { config: { mcpServers }, serverIdsByName };
      },
      async setConfig(config, serverIdsByName) {
        const previous = read();
        const servers: Record<string, RegistryEntry> = {};
        for (const [rawName, value] of Object.entries(config.mcpServers)) {
          const name = validateServerName(rawName);
          const existingId = previous.servers[name]?.id ?? (serverIdsByName[name] != null ? String(serverIdsByName[name]) : undefined);
          const id = existingId ?? String(nextId++);
          servers[name] = { id, config: value };
        }
        write({ version: 1, servers });
      },
      async installPlugin() { throw new SandMcpConfigError("plugin installs need the plugin marketplace; not available in local mode"); },
      async uninstallPlugin() { throw new SandMcpConfigError("plugin uninstalls need the plugin marketplace; not available in local mode"); },
      async updatePluginInstall() { throw new SandMcpConfigError("plugin updates need the plugin marketplace; not available in local mode"); },
    },
    serversProvider: async () => {
      const { servers } = read();
      const list: AccountMcpServer[] = Object.entries(servers).map(([name, entry]) => ({
        id: entry.id,
        name,
        serverIdentifier: name,
        config: entry.config,
        isTeamServer: false,
        disabledByTeamAdminPolicy: false,
      }));
      return { servers: list, cacheScope: "local" };
    },
    listServers: () => Object.entries(read().servers).map(([name, entry]) => ({ name, id: entry.id, config: entry.config })),
  };
}
