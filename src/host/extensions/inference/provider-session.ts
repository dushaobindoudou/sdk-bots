import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { query as queryClaude, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool, type CoreMessage, type LanguageModelV1, type ToolSet } from "ai";

import { BasePromptBuilder, BasePromptExecutor } from "../../../lib/chat-inference/base.js";
import type { SandInferenceProvider } from "../../../shared/inference-router.js";
import { resolveClaudeCodeCliPath } from "../../../shared/node/inference-router-local.js";
import { getSandRootDir } from "../../../shared/sand-paths.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { getBoxSecretsStorePath } from "../secrets/secrets-service.js";
import { GROUP_CHAT_TAG_PREFIX, SAND_HIDDEN_PROMPT_MARKER } from "../../groups/group-chat.js";
import { streamCodexDirectResponses, type CodexDirectTool } from "./codex-direct-responses.js";
import type { LabelMessage, PromptExecutor } from "./sand-labeling.js";

type Loose = Record<string, any>;
interface ProviderMessage extends LabelMessage { role: string; content: string | readonly unknown[] }
type RoutedProvider = Exclude<SandInferenceProvider, "cursor">;
type UsageRecord = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
type RoutedToolExecutor = (tool: Loose, args: unknown, toolCallId: string) => Promise<unknown>;

const GROK_ROUTER_SYSTEM_PROMPT = [
  "You are Grok Bot, a warm, concise desktop assistant.",
  "You are running inside Grok Bot, not inside Codex CLI or Claude Code.",
  "The tools supplied with this request are Grok Bot's already-connected plugins and accounts. Use them whenever they are relevant instead of claiming that a plugin is unavailable or asking the user to reconnect it.",
  "Never ask for an API key for an already-connected plugin. Respond directly to the user in natural language after completing any necessary tool calls.",
].join("\n");

function recordRoutedUsage(provider: RoutedProvider, usage: UsageRecord): void {
  new SandSettingsStore(join(getSandRootDir(), "settings.json")).recordInferenceUsage(provider, usage);
}

function persistedSecrets(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(getBoxSecretsStorePath(), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};
    const secrets = (parsed as { secrets?: unknown }).secrets;
    if (typeof secrets !== "object" || secrets == null || Array.isArray(secrets)) return {};
    return Object.fromEntries(Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

export const OPENROUTER_CLOUD_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_BASE_URL = "http://127.0.0.1:3080/freeroute/v1";
export const OPENROUTER_LOCAL_PLACEHOLDER_KEY = "local";

export function resolveOpenRouterEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  secrets: Record<string, string> = persistedSecrets(),
): { baseURL: string; apiKey: string; modelId: string } {
  const baseURL = env.SAND_OPENROUTER_BASE_URL?.trim().replace(/\/+$/, "") || OPENROUTER_DEFAULT_BASE_URL;
  const isOfficial = baseURL === OPENROUTER_CLOUD_BASE_URL;
  const modelId = env.SAND_OPENROUTER_MODEL?.trim() || (isOfficial ? "deepseek/deepseek-chat" : "auto");
  const envKey = env.OPENROUTER_API_KEY?.trim();
  const apiKey = envKey
    || (isOfficial ? secrets.OPENROUTER_API_KEY?.trim() : undefined)
    || (isOfficial ? undefined : OPENROUTER_LOCAL_PLACEHOLDER_KEY);
  if (apiKey == null || apiKey.length === 0) {
    throw new Error("OpenRouter needs OPENROUTER_API_KEY. Add it in Settings → Router.");
  }
  return { baseURL, apiKey, modelId };
}

function providerPrompt(messages: readonly ProviderMessage[]): string {
  const rendered = messages.map(message => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return `${message.role.toUpperCase()}: ${content}`;
  }).join("\n\n");
  return `${GROK_ROUTER_SYSTEM_PROMPT}\n\nContinue this Grok Bot conversation.\n\n${rendered}`;
}

function deferred<T>() { return Promise.withResolvers<T>(); }

export type LocalResponseContentPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown };

function response(text: string, id: string, modelId: string) {
  return { id, modelId, timestamp: new Date(), headers: {}, messages: [{ role: "assistant", content: [{ type: "text" as const, text }] as LocalResponseContentPart[] }] };
}

type CodexCredentials = { accessToken: string; refreshToken: string; idToken: string; accountId: string; path: string; document: Loose };

function codexCredentials(): CodexCredentials {
  const path = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Codex login credentials must be a private direct regular file.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Loose;
  const accessToken = parsed?.tokens?.access_token;
  const refreshToken = parsed?.tokens?.refresh_token;
  const idToken = parsed?.tokens?.id_token;
  const accountId = parsed?.tokens?.account_id;
  if (parsed?.auth_mode !== "chatgpt" || typeof accessToken !== "string" || accessToken.length === 0 || typeof refreshToken !== "string" || refreshToken.length === 0 || typeof idToken !== "string" || idToken.length === 0 || typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("Codex is not signed in with ChatGPT. Run `codex login`, then reopen Grok Bot.");
  }
  return { accessToken, refreshToken, idToken, accountId, path, document: parsed };
}

function jwtAudience(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Loose;
    const audience = payload.aud;
    return typeof audience === "string" ? audience : Array.isArray(audience) ? audience.find((value): value is string => typeof value === "string") ?? null : null;
  } catch { return null; }
}

async function refreshCodexCredentials(current: CodexCredentials): Promise<CodexCredentials> {
  const clientId = jwtAudience(current.idToken);
  if (clientId == null) throw new Error("Codex login expired and its refresh identity is invalid. Run `codex login` again.");
  const refresh = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: clientId }),
  });
  if (!refresh.ok) throw new Error("Codex login expired and could not be refreshed. Run `codex login` again.");
  const payload = await refresh.json() as Loose;
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) throw new Error("Codex returned an invalid refreshed login. Run `codex login` again.");
  const document = {
    ...current.document,
    tokens: {
      ...current.document.tokens,
      access_token: payload.access_token,
      refresh_token: typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 ? payload.refresh_token : current.refreshToken,
      id_token: typeof payload.id_token === "string" && payload.id_token.length > 0 ? payload.id_token : current.idToken,
    },
    last_refresh: new Date().toISOString(),
  };
  const temporary = `${current.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, current.path);
  return codexCredentials();
}

function codexAuthenticatedFetch(initial: CodexCredentials): typeof fetch {
  let credentials = initial;
  return async (input, init) => {
    const perform = () => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${credentials.accessToken}`);
      headers.set("ChatGPT-Account-Id", credentials.accountId);
      return fetch(input, { ...init, headers });
    };
    let result = await perform();
    if (result.status !== 401) return result;
    credentials = await refreshCodexCredentials(credentials);
    result = await perform();
    return result;
  };
}

function configuredCodexModel(): string {
  const selected = process.env.SAND_CODEX_MODEL?.trim();
  if (selected) return selected;
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim() || "gpt-5.4";
  } catch { return "gpt-5.4"; }
}

function configuredCodexReasoningEffort(): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  const selected = process.env.SAND_CODEX_REASONING_EFFORT?.trim();
  if (selected === "minimal" || selected === "low" || selected === "medium" || selected === "high" || selected === "xhigh") return selected;
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    const value = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim();
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
  } catch { return undefined; }
}

function codexTools(definitions: readonly Loose[] | undefined): CodexDirectTool[] | undefined {
  if (definitions == null) return undefined;
  const tools = definitions.flatMap((source): CodexDirectTool[] => {
    const parameters = source.inputSchema ?? source.parameters;
    return typeof source.name === "string" && source.name.length > 0 && parameters != null ? [{
      name: source.name,
      ...(typeof source.description === "string" ? { description: source.description } : {}),
      parameters,
      source,
    }] : [];
  });
  return tools.length === 0 ? undefined : tools;
}

function codexExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void) {
  const credentials = codexCredentials();
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const model = configuredCodexModel();
  const tools = codexTools(definitions);
  const fullStream = (async function* () {
    let text = "";
    try {
      for await (const event of streamCodexDirectResponses({
        fetch: codexAuthenticatedFetch(credentials),
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        model,
        ...(configuredCodexReasoningEffort() == null ? {} : { reasoningEffort: configuredCodexReasoningEffort()! }),
        instructions: GROK_ROUTER_SYSTEM_PROMPT,
        input: messages.map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) })),
        ...(tools == null ? {} : { tools }),
        ...(executeTool == null ? {} : { executeTool: async (selected, args, toolCallId) => await executeTool(selected.source, args, toolCallId) }),
        maxSteps: tools == null ? 1 : 8,
      })) {
        if (event.type === "text-delta") { text += event.delta; yield { type: "text-delta" as const, textDelta: event.delta }; continue; }
        const basic = { promptTokens: event.usage.inputTokens, completionTokens: event.usage.outputTokens, totalTokens: event.usage.inputTokens + event.usage.outputTokens };
        const extended = { ...event.usage, maxTokens: 0 };
        onUsage?.(event.usage);
        usage.resolve(basic);
        extendedUsage.resolve(extended);
        metadata.resolve({ openai: { responseId: event.responseId, direct: true } });
        resultResponse.resolve(response(text, invocationId, model));
      }
    } catch (error) { usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error; }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function claudeExecutor(messages: readonly ProviderMessage[], invocationId: string, onUsage?: (usage: UsageRecord) => void, mcpServerUrl?: string) {
  const executable = resolveClaudeCodeCliPath();
  if (executable == null) throw new Error("Claude Code is not installed. Install and sign in to Claude Code, then reopen Grok Bot.");
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const fullStream = (async function* () {
    try {
      let final: SDKResultMessage | undefined;
      const selectedModel = process.env.SAND_CLAUDE_MODEL?.trim();
      for await (const message of queryClaude({ prompt: providerPrompt(messages), options: { pathToClaudeCodeExecutable: executable, cwd: getSandRootDir(), tools: mcpServerUrl == null ? [] : ["mcp__grok_bot_plugins__*"], ...(mcpServerUrl == null ? {} : { mcpServers: { grok_bot_plugins: { type: "http" as const, url: mcpServerUrl } }, strictMcpConfig: true }), permissionMode: "default", maxTurns: mcpServerUrl == null ? 1 : 8, persistSession: false, ...(selectedModel == null || selectedModel.length === 0 ? {} : { model: selectedModel }) } })) if (message.type === "result") final = message;
      if (final == null) throw new Error("Claude Code ended without a result.");
      if (final.subtype !== "success") throw new Error(final.errors.join("\n") || `Claude Code failed (${final.subtype}).`);
      const text = final.result;
      if (text.length > 0) yield { type: "text-delta" as const, textDelta: text };
      const input = final.usage.input_tokens, output = final.usage.output_tokens, cacheRead = final.usage.cache_read_input_tokens ?? 0, cacheWrite = final.usage.cache_creation_input_tokens ?? 0;
      onUsage?.({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
      usage.resolve({ promptTokens: input, completionTokens: output, totalTokens: input + output });
      extendedUsage.resolve({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, maxTokens: 0 });
      metadata.resolve({ anthropic: { sessionId: final.session_id, totalCostUsd: final.total_cost_usd } });
      resultResponse.resolve(response(text, invocationId, "claude-code"));
    } catch (error) { usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error; }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function toToolSet(definitions: readonly Loose[] | undefined, executeTool?: RoutedToolExecutor): ToolSet | undefined {
  if (definitions == null || definitions.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const definition of definitions) {
    if (typeof definition.name !== "string" || definition.name.length === 0) continue;
    const parameters = definition.inputSchema ?? definition.parameters;
    if (parameters == null) continue;
    const routedTool: any = {
      ...(typeof definition.description === "string" ? { description: definition.description } : {}),
      parameters: jsonSchema(parameters),
    };
    if (executeTool != null) routedTool.execute = async (args: unknown, options: { toolCallId: string }) => await executeTool(definition, args, options.toolCallId);
    tools[definition.name] = tool(routedTool);
  }
  return Object.keys(tools).length === 0 ? undefined : tools;
}

const OPENROUTER_CHAT_PROMPT = [
  "You are a helpful assistant in a local multi-bot console.",
  "You have a local sandbox: Shell/Read/Write and related tools run in /workspace.",
  "Use tools when they help (run commands, read or write files, search). Then tell the user via SendMessage.",
  "The user only sees SendMessage tool calls (type \"text\", content string). Plain assistant text is invisible.",
  "Keep replies concise.",
].join("\n");

const OPENROUTER_SANDBOX_TOOLS = new Set([
  "SendMessage",
  "SendToAgent",
  "Shell",
  "Read",
  "Write",
  "Delete",
  "Glob",
  "Grep",
  "StrReplace",
  "AwaitShell",
  "WebSearch",
  "WebFetch",
  "LS",
  "ListDir",
  "ReadFile",
  "WriteFile",
  "DeleteFile",
  "ApplyPatch",
  "EditNotebook",
]);

export function openRouterChatTools(definitions?: readonly Loose[]): readonly Loose[] | undefined {
  if (definitions == null || definitions.length === 0) return definitions;
  const filtered = definitions.filter((definition) => typeof definition.name === "string" && OPENROUTER_SANDBOX_TOOLS.has(definition.name));
  return filtered.length > 0 ? filtered : definitions;
}

async function* rethrowProviderStreamErrors<T extends { type?: string; error?: unknown }>(stream: AsyncIterable<T>): AsyncGenerator<T> {
  for await (const event of stream) {
    if (event?.type === "error") {
      const error = event.error;
      throw error instanceof Error ? error : new Error(String(error ?? "provider stream error"));
    }
    yield event;
  }
}

function openRouterRequest(messages: readonly ProviderMessage[], definitions?: readonly Loose[], executeTool?: RoutedToolExecutor) {
  const endpoint = resolveOpenRouterEndpoint();
  const model: LanguageModelV1 = createOpenAI({ apiKey: endpoint.apiKey, baseURL: endpoint.baseURL, compatibility: "compatible", name: "openrouter", headers: { "HTTP-Referer": "https://github.com/grok-bot-reconstructed", "X-Title": "Grok Bot Reconstructed" } }).chat(endpoint.modelId as any);
  const tools = toToolSet(openRouterChatTools(definitions), executeTool);
  return {
    endpoint,
    model,
    tools,
    input: {
      model,
      system: OPENROUTER_CHAT_PROMPT,
      messages: messages as CoreMessage[],
      ...(tools === undefined ? {} : { tools, toolChoice: "auto" as const }),
      maxSteps: 8 as const,
      maxRetries: 1 as const,
    },
  };
}

const LOCAL_CHAT_TOOLS: readonly Loose[] = [{
  name: "SendMessage",
  description: "Send a text message to the user. This is the only way they can see your reply.",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["text"] },
      content: { type: "string" },
    },
    required: ["type", "content"],
  },
}];

type LocalChatMessage = {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

function stringifyContent(content: unknown, limit = 6_000): string {
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

function serializeLocalMessages(messages: readonly ProviderMessage[]): LocalChatMessage[] {
  const out: LocalChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const parts = Array.isArray(message.content) ? message.content as Loose[] : [];
      const result = parts.find((part) => part?.type === "tool-result");
      out.push({
        role: "tool",
        tool_call_id: String((message as Loose).id ?? result?.toolCallId ?? ""),
        content: stringifyContent(result?.result ?? message.content),
      });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const parts = message.content as Loose[];
      const toolCalls = parts.filter((part) => part?.type === "tool-call");
      if (toolCalls.length > 0) {
        const text = parts.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("");
        out.push({
          role: "assistant",
          content: text.length > 0 ? stringifyContent(text, 4_000) : null,
          tool_calls: toolCalls.map((call) => ({
            id: String(call.toolCallId ?? crypto.randomUUID()),
            type: "function" as const,
            function: {
              name: String(call.toolName ?? "unknown"),
              arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {}),
            },
          })),
        });
        continue;
      }
    }
    const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    out.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: stringifyContent(raw, 4_000),
    });
  }
  return out;
}

function isGroupTurnUserText(text: string): boolean {
  return text.includes(GROUP_CHAT_TAG_PREFIX) || text.includes(SAND_HIDDEN_PROMPT_MARKER);
}

export function compactLocalMessages(messages: readonly ProviderMessage[]): LocalChatMessage[] {
  const chat = serializeLocalMessages(messages);
  let lastUserIndex = -1;
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    if (chat[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  const lastUser = lastUserIndex >= 0 ? chat[lastUserIndex] : undefined;
  if (lastUser != null && typeof lastUser.content === "string" && isGroupTurnUserText(lastUser.content)) {
    return chat.slice(lastUserIndex);
  }
  if (lastUserIndex < 0) return chat.slice(-8);
  return chat.slice(Math.max(0, lastUserIndex - 6));
}

function localSystemPrompt(messages: readonly ProviderMessage[]): string {
  const lastUser = [...serializeLocalMessages(messages)].reverse().find((message) => message.role === "user");
  if (lastUser != null && typeof lastUser.content === "string" && isGroupTurnUserText(lastUser.content)) {
    return [
      OPENROUTER_CHAT_PROMPT,
      "This turn is a group-chat member turn. Stay in character as named in the user message.",
      "You may use sandbox tools if they help, then speak to the room with SendMessage. If you have nothing to add, send exactly \"(pass)\".",
    ].join("\n");
  }
  return OPENROUTER_CHAT_PROMPT;
}

function toOpenAITools(definitions?: readonly Loose[]): { type: "function"; function: { name: string; description: string; parameters: unknown } }[] | undefined {
  const filtered = openRouterChatTools(definitions) ?? (definitions == null || definitions.length === 0 ? LOCAL_CHAT_TOOLS : undefined);
  if (filtered == null || filtered.length === 0) return undefined;
  const tools = [];
  for (const definition of filtered) {
    if (typeof definition.name !== "string" || definition.name.length === 0) continue;
    const parameters = definition.inputSchema ?? definition.parameters ?? { type: "object", properties: {} };
    const encoded = JSON.stringify(parameters);
    tools.push({
      type: "function" as const,
      function: {
        name: definition.name,
        description: String(definition.description ?? "").slice(0, 800),
        parameters: encoded.length > 8_000 ? { type: "object", additionalProperties: true } : parameters,
      },
    });
    if (tools.length >= 16) break;
  }
  return tools.length > 0 ? tools : undefined;
}

async function localChatCompletion(endpoint: { baseURL: string; apiKey: string; modelId: string }, messages: readonly ProviderMessage[], definitions?: readonly Loose[]): Promise<{
  text: string;
  finishReason: string;
  toolCalls: { toolCallId: string; toolName: string; args: unknown }[];
  usage: { promptTokens: number; completionTokens: number };
}> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (endpoint.apiKey !== OPENROUTER_LOCAL_PLACEHOLDER_KEY) headers.authorization = `Bearer ${endpoint.apiKey}`;
  const tools = toOpenAITools(definitions);
  const res = await fetch(`${endpoint.baseURL}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: endpoint.modelId,
      messages: [{ role: "system", content: localSystemPrompt(messages) }, ...compactLocalMessages(messages)],
      ...(tools == null ? {} : { tools, tool_choice: "auto" }),
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`local chat ${res.status}: ${raw.slice(0, 400)}`);
  const data = JSON.parse(raw) as Loose;
  const choice = (data.choices as Loose[] | undefined)?.[0] ?? {};
  const message = (choice.message ?? {}) as Loose;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.flatMap((call: Loose) => {
    const fn = call?.function ?? {};
    if (typeof fn.name !== "string" || fn.name.length === 0) return [];
    let args: unknown = {};
    try { args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments ?? {}; } catch { args = { content: String(fn.arguments ?? "") }; }
    return [{ toolCallId: typeof call.id === "string" ? call.id : crypto.randomUUID(), toolName: fn.name, args }];
  }) : [];
  const usage = data.usage ?? {};
  const text = typeof message.content === "string" ? message.content : "";
  if (toolCalls.length === 0 && text.trim().length > 0) {
    toolCalls.push({
      toolCallId: crypto.randomUUID(),
      toolName: "SendMessage",
      args: { type: "text", content: text.trim() },
    });
  }
  return {
    text,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "stop",
    toolCalls,
    usage: {
      promptTokens: Number(usage.prompt_tokens) || 0,
      completionTokens: Number(usage.completion_tokens) || 0,
    },
  };
}

function openRouterFromLocalChat(
  pending: Promise<Awaited<ReturnType<typeof localChatCompletion>>>,
  invocationId: string,
  modelId: string,
  onUsage?: (usage: UsageRecord) => void,
) {
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const fullStream = (async function* () {
    try {
      const result = await pending;
      console.info(`[sdk-bots] local chat finish=${result.finishReason} tools=${result.toolCalls.map((call) => call.toolName).join(",") || "-"}`);
      const basic = { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, totalTokens: result.usage.promptTokens + result.usage.completionTokens };
      const extended = { inputTokens: result.usage.promptTokens, outputTokens: result.usage.completionTokens, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 };
      onUsage?.(extended);
      usage.resolve(basic);
      extendedUsage.resolve(extended);
      metadata.resolve({});
      const content: LocalResponseContentPart[] = [];
      if (result.text) {
        content.push({ type: "text", text: result.text });
        yield { type: "text-delta" as const, textDelta: result.text };
      }
      for (const call of result.toolCalls) {
        yield { type: "tool-call-streaming-start" as const, toolCallId: call.toolCallId, toolName: call.toolName };
        yield { type: "tool-call-delta" as const, toolCallId: call.toolCallId, toolName: call.toolName, argsTextDelta: JSON.stringify(call.args) };
        yield { type: "tool-call" as const, toolCallId: call.toolCallId, toolName: call.toolName, args: call.args };
        content.push({ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, args: call.args });
      }
      resultResponse.resolve({
        id: invocationId,
        modelId,
        timestamp: new Date(),
        headers: {},
        messages: [{ role: "assistant", content: content.length > 0 ? content : [{ type: "text", text: "" }] }],
      });
      yield { type: "finish" as const, finishReason: result.finishReason, usage: basic };
    } catch (error) {
      console.error(`[sdk-bots] local chat failed: ${error instanceof Error ? error.message : String(error)}`);
      usage.reject(error);
      extendedUsage.reject(error);
      metadata.reject(error);
      resultResponse.reject(error);
      throw error;
    }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function openRouterExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void) {
  const { endpoint, input } = openRouterRequest(messages, definitions, executeTool);
  if (endpoint.baseURL !== OPENROUTER_CLOUD_BASE_URL) {
    console.info(`[sdk-bots] inference ${endpoint.baseURL} model=${endpoint.modelId}`);
    return openRouterFromLocalChat(localChatCompletion(endpoint, messages, definitions), invocationId, endpoint.modelId, onUsage);
  }
  const result = streamText({ ...input, toolCallStreaming: true });
  const extendedUsage = result.usage.then(value => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 }));
  if (onUsage != null) void extendedUsage.then(onUsage);
  return { fullStream: rethrowProviderStreamErrors(result.fullStream), response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) };
}

class ProviderPromptExecutor extends BasePromptExecutor<ProviderMessage> {
  constructor(readonly provider: RoutedProvider, initialMessages?: readonly ProviderMessage[], readonly onUsage?: (usage: UsageRecord) => void) { super(new BasePromptBuilder(initialMessages)); }
  stream(_ctx: unknown, invocationId = crypto.randomUUID(), definitions?: readonly Loose[]) {
    if (this.provider === "codex") return codexExecutor(this.getMessages(), invocationId, definitions, undefined, this.onUsage);
    if (this.provider === "claude-code") return claudeExecutor(this.getMessages(), invocationId, this.onUsage);
    return openRouterExecutor(this.getMessages(), invocationId, definitions, undefined, this.onUsage);
  }
}

export function createProviderPromptSession(provider: RoutedProvider): { getModelId(): string; getExecutor(state?: unknown): PromptExecutor } {
  const modelId = provider === "codex" ? configuredCodexModel() : provider === "claude-code" ? "claude-code" : resolveOpenRouterEndpoint().modelId;
  return { getModelId: () => modelId, getExecutor: state => new ProviderPromptExecutor(provider, Array.isArray(state) ? state as ProviderMessage[] : undefined, usage => recordRoutedUsage(provider, usage)) };
}

export async function runRoutedProviderText(provider: RoutedProvider, messages: readonly ProviderMessage[], options?: {
  readonly mcpServerUrl?: string;
  readonly tools?: readonly Loose[];
  readonly executeTool?: RoutedToolExecutor;
  readonly onTextDelta?: (delta: string, accumulated: string) => void;
}): Promise<string> {
  const invocationId = crypto.randomUUID();
  const onUsage = (usage: UsageRecord) => recordRoutedUsage(provider, usage);
  const result = provider === "codex"
    ? codexExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage)
    : provider === "claude-code"
      ? claudeExecutor(messages, invocationId, onUsage, options?.mcpServerUrl)
      : openRouterExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage);
  let text = "";
  for await (const event of result.fullStream) {
    if (event.type === "text-delta" && typeof event.textDelta === "string") {
      text += event.textDelta;
      options?.onTextDelta?.(event.textDelta, text);
    }
  }
  await result.response;
  return text;
}
