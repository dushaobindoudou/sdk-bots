import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Value } from "@bufbuild/protobuf";
import { McpArgs, McpError, McpResult, McpSuccess, McpTextContent, McpToolResultContentItem } from "../../../proto/generated/agent/v1/mcp_exec_pb.js";
import type { McpServerConfig } from "../../../shared/node/mcp/mcp-display-runtime.js";

/**
 * Minimal in-process MCP client (stdio + streamable HTTP).
 *
 * The Cursor product routed account MCP servers through its cloud and ran
 * local servers inside the sandbox box; the headless box daemon has no MCP
 * exec surface, so this runtime speaks the MCP wire protocol directly from
 * the host process: JSON-RPC over the child's stdio, or JSON-over-HTTP for
 * remote servers. Only what tool discovery and execution need is
 * implemented: initialize handshake, tools/list, tools/call.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 15_000;

interface JsonRpcPending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

interface McpSession {
  listTools(): Promise<Array<{ name: string; description: string | undefined; inputSchema: unknown | undefined }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content?: Array<{ type?: string; text?: string }>; isError?: boolean }>;
  dispose(): void;
}

function makeError(label: string, error: unknown): Error {
  return new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
}

/** stdio transport: newline-delimited JSON-RPC over the child process pipes. */
interface StdioServerConfig { command: string; args?: string[]; env?: Record<string, string>; cwd?: string; headers?: Record<string, string> }
function connectStdio(config: StdioServerConfig, log: (message: string) => void): McpSession {
  let nextId = 1;
  const pending = new Map<number, JsonRpcPending>();
  let buffer = "";
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...(config.env ?? {}) },
      ...(config.cwd == null ? {} : { cwd: config.cwd }),
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    throw makeError(`spawn "${config.command}" failed`, error);
  }
  const failAll = (reason: string) => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); } pending.clear(); };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message: { id?: number; result?: unknown; error?: { message?: string } } | null = null;
      try { message = JSON.parse(line); } catch { continue; }
      if (message == null || message.id == null) continue; // notifications
      const entry = pending.get(message.id);
      if (entry == null) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error != null) entry.reject(new Error(message.error.message ?? "MCP error"));
      else entry.resolve(message.result);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { const text = chunk.trim(); if (text.length > 0) log(`[mcp:stdio] ${text.slice(0, 200)}`); });
  child.on("exit", () => failAll("MCP server process exited"));
  child.on("error", (error) => failAll(`MCP server process error: ${error.message}`));

  const request = <T>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(makeError(`${method} write failed`, error)); }
    });
  const notify = (method: string) => { try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`); } catch { /* exiting */ } };

  return makeProtocolSession(request, notify);
}

/** Streamable HTTP transport: one JSON-RPC message per POST. */
function connectHttp(url: string, headers: Record<string, string>, log: (message: string) => void): McpSession {
  let nextId = 1;
  let sessionId: string | null = null;
  const post = async (payload: unknown): Promise<unknown> => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId == null ? {} : { "mcp-session-id": sessionId }),
        ...headers,
      },
      body: JSON.stringify(payload),
    });
    const sessionHeader = response.headers.get("mcp-session-id");
    if (sessionHeader != null) sessionId = sessionHeader;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const body = line.slice(5).trim();
        if (body.length === 0) continue;
        try { return JSON.parse(body); } catch { /* skip bad frame */ }
      }
      throw new Error("empty SSE response");
    }
    return await response.json();
  };
  const request = async <T>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> => {
    const id = nextId++;
    const race = post({ jsonrpc: "2.0", id, method, params });
    const timer = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    });
    const message = await Promise.race([race, timer]) as { result?: unknown; error?: { message?: string } };
    if (message.error != null) throw new Error(message.error.message ?? "MCP error");
    return message.result as T;
  };
  void log;
  return makeProtocolSession(request, (method) => { void post({ jsonrpc: "2.0", method }); });
}

/** Shared initialize → tools handshake on top of either transport. */
function makeProtocolSession(
  request: <T>(method: string, params: unknown, timeoutMs?: number) => Promise<T>,
  notify: (method: string) => void,
): McpSession {
  let ready: Promise<void> | null = null;
  const ensureReady = () => ready ??= (async () => {
    await request<{ protocolVersion?: string }>("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "sdk-bots-local-mcp", version: "1.0.0" },
    }, INIT_TIMEOUT_MS);
    notify("notifications/initialized");
  })();
  return {
    async listTools() {
      await ensureReady();
      const result = await request<{ tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }> }>("tools/list", {});
      return (result.tools ?? []).filter((tool) => typeof tool.name === "string" && tool.name.length > 0)
        .map((tool) => ({ name: tool.name as string, description: tool.description, inputSchema: tool.inputSchema }));
    },
    async callTool(name: string, args: Record<string, unknown>) {
      await ensureReady();
      return await request<{ content?: Array<{ type?: string; text?: string }>; isError?: boolean }>("tools/call", { name, arguments: args });
    },
    dispose: () => { ready = null; },
  };
}

interface ManagedServer {
  readonly name: string;
  config: McpServerConfig;
  session: McpSession | null;
  status: "connected" | "error";
  statusDetail?: string;
  tools: Array<{ name: string; description: string | undefined; inputSchema: unknown | undefined }>;
}

export interface LocalMcpRuntime {
  listTools(serverIdentifiers: readonly string[]): Promise<unknown[]>;
  executeTool(args: { serverIdentifier: string; toolName: string; args: unknown; toolCallId: string; agentId?: string }): Promise<McpResult>;
}

export function createInProcessMcpRuntime(options: {
  readonly getServers: () => Array<{ name: string; config: McpServerConfig }>;
  readonly log: (message: string) => void;
}): LocalMcpRuntime {
  const { getServers, log } = options;
  const managed = new Map<string, ManagedServer>();

  const connect = async (server: ManagedServer): Promise<void> => {
    if (server.session != null) return;
    const config = server.config as StdioServerConfig & { url?: string; headers?: Record<string, string> };
    const session = config.url != null
      ? connectHttp(config.url, config.headers ?? {}, log)
      : connectStdio(config as McpServerConfig & { command: string }, log);
    server.session = session;
    server.tools = await session.listTools();
    server.status = "connected";
    delete server.statusDetail;
  };

  const ensureServer = (name: string): ManagedServer | null => {
    const existing = managed.get(name);
    if (existing != null) return existing;
    const definition = getServers().find((entry) => entry.name === name);
    if (definition == null) return null;
    const server: ManagedServer = { name: definition.name, config: definition.config, session: null, status: "error", tools: [] };
    managed.set(name, server);
    return server;
  };

  const resetIfConfigChanged = (name: string): void => {
    const definition = getServers().find((entry) => entry.name === name);
    const server = managed.get(name);
    if (definition == null) { server?.session?.dispose(); managed.delete(name); return; }
    if (server == null || JSON.stringify(server.config) !== JSON.stringify(definition.config)) {
      server?.session?.dispose();
      if (server != null) { server.config = definition.config; server.session = null; server.status = "error"; server.tools = []; }
    }
  };

  return {
    async listTools(serverIdentifiers) {
      const wanted = serverIdentifiers.length === 0 ? getServers().map((entry) => entry.name) : [...serverIdentifiers];
      const rows: unknown[] = [];
      for (const name of wanted) {
        resetIfConfigChanged(name);
        const server = ensureServer(name);
        if (server == null) {
          rows.push({ serverIdentifier: name, status: "notFound", tools: [], accountLabel: "default", rowServerIdentifier: name });
          continue;
        }
        try { await connect(server); }
        catch (error) {
          server.status = "error";
          server.statusDetail = error instanceof Error ? error.message : String(error);
          server.session?.dispose();
          server.session = null;
        }
        rows.push({
          serverIdentifier: server.name,
          status: server.status,
          ...(server.statusDetail == null ? {} : { statusDetail: server.statusDetail }),
          tools: server.tools.map((tool) => ({
            name: tool.name,
            providerIdentifier: server.name,
            toolName: tool.name,
            clientKey: server.name,
            ...(tool.description == null ? {} : { description: tool.description }),
            ...(tool.inputSchema == null ? {} : { inputSchema: tool.inputSchema }),
          })),
          accountLabel: "default",
          rowServerIdentifier: server.name,
        });
      }
      return rows;
    },
    async executeTool(args) {
      resetIfConfigChanged(args.serverIdentifier);
      const server = ensureServer(args.serverIdentifier);
      if (server == null) {
        return new McpResult({ result: { case: "error", value: new McpError({ error: `MCP server "${args.serverIdentifier}" is not registered` }) } });
      }
      try {
        await connect(server);
        const json = (args.args ?? {}) as Record<string, unknown>;
        const result = await (server.session as McpSession).callTool(args.toolName, json);
        const content = (result.content ?? [])
          .filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => new McpToolResultContentItem({ content: { case: "text", value: new McpTextContent({ text: item.text as string }) } }));
        return new McpResult({ result: { case: "success", value: new McpSuccess({ content, isError: result.isError === true }) } });
      } catch (error) {
        return new McpResult({ result: { case: "error", value: new McpError({ error: `MCP execution failed for "${args.toolName}": ${error instanceof Error ? error.message : String(error)}` }) } });
      }
    },
  };
}

/** Adapted for the box-exec shim used by Value-based McpArgs construction. */
export function mcpArgsToPlainJson(args: { args?: { [key: string]: Value } }): Record<string, unknown> {
  const json: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args.args ?? {})) {
    try { json[key] = value.toJson(); } catch { json[key] = null; }
  }
  return json;
}

/**
 * BoxMcpExecPort adapter over the in-process runtime. The display layer and
 * the tool executor treat STDLIO servers as "box" servers (they run on the
 * local computer) and HTTP servers as "backend" servers; in local mode both
 * channels are the same in-process runtime, so stdio servers get real
 * connected/tool statuses and execution instead of "computer unreachable".
 */
export function createInProcessBoxMcpExec(runtime: LocalMcpRuntime, getServersFingerprint: () => string, log: (message: string) => void): {
  loadServers(configJson: string): Promise<void>;
  listTools(serverIdentifiers: readonly string[], options?: { kickOnly?: boolean }): Promise<unknown[]>;
  executeTool(args: McpArgs): Promise<McpResult>;
} {
  let loadedFingerprint = "";
  return {
    async loadServers(configJson) {
      // Config is owned by the local registry; reconcile against it when the
      // manager pushes a load (it sends its own JSON, which we ignore).
      void configJson;
      loadedFingerprint = getServersFingerprint();
    },
    async listTools(serverIdentifiers) {
      const rows = await runtime.listTools(serverIdentifiers);
      return rows.map((row) => {
        const server = row as { serverIdentifier: string; status: string; statusDetail?: string; tools?: unknown[] };
        return {
          serverIdentifier: server.serverIdentifier,
          status: server.status,
          ...(server.statusDetail == null ? {} : { statusDetail: server.statusDetail }),
          toolCount: server.tools?.length ?? 0,
          tools: server.tools ?? [],
        };
      });
    },
    async executeTool(args) {
      void loadedFingerprint;
      const agentId = (args as unknown as { agentId?: string }).agentId;
      return await runtime.executeTool({
        serverIdentifier: args.serverIdentifier || args.providerIdentifier,
        toolName: args.toolName || args.name,
        args: mcpArgsToPlainJson(args),
        toolCallId: args.toolCallId,
        ...(agentId == null || agentId.length === 0 ? {} : { agentId }),
      });
    },
  };
}
