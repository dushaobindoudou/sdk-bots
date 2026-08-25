/**
 * SDK client for sdk-bots.
 *
 * Talks to the headless host gateway over HTTP (JSON-RPC via POST /api/<method>)
 * and consumes the SSE event stream (GET /events). Mirrors the gateway protocol
 * surface — createAgent, createGroup, setGroupMembers, sendPrompt, etc.
 *
 * Example:
 *   const sdk = new SdkBotsClient({ baseUrl: "http://127.0.0.1:7331", token: "..." });
 *   const agent = await sdk.createAgent({ name: "researcher", description: "does research" });
 *   const group = await sdk.createGroup({ name: "war room", memberIds: [a1, a2] });
 *   await sdk.sendPrompt({ agentId: group.id, prompt: "discuss X" });
 *   for await (const ev of sdk.events()) console.log(ev.channel, ev.payload);
 */

export interface SdkBotsClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
}

export class SdkBotsClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: SdkBotsClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  async health(): Promise<any> {
    const res = await this.fetchFn(`${this.baseUrl}/health`);
    return res.json();
  }

  async call<T = any>(method: string, args?: Record<string, any>): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}/api/${method}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(args ?? {}),
    });
    if (!res.ok) {
      throw new Error(`${method} failed: ${res.status} ${await res.text()}`);
    }
    const json: any = await res.json();
    if (json && typeof json === "object" && "error" in json && json.error) {
      throw new Error(`${method} error: ${JSON.stringify(json.error)}`);
    }
    return json.result ?? json;
  }

  createAgent(args: { name: string; description?: string; title?: string; clientNonce?: string }) {
    return this.call("createAgent", args);
  }
  listAgents() { return this.call("listAgents"); }
  countAgents() { return this.call("countAgents"); }
  searchAgents(args: { query: string }) { return this.call("searchAgents", args); }
  updateAgent(args: { id: string; profile: Record<string, unknown> }) { return this.call("updateAgent", args); }
  deleteAgent(args: { id: string }) { return this.call("deleteAgent", args); }
  kickstartAgent(args: { id: string }) { return this.call("kickstartAgent", args); }

  createGroup(args: { name: string; description?: string; memberIds: string[] }) {
    // gateway arg surface: memberAgentIds (see host-gateway-api.ts createGroup)
    return this.call("createGroup", { name: args.name, description: args.description, memberAgentIds: args.memberIds });
  }
  setGroupMembers(args: { groupId: string; memberIds: string[] }) {
    return this.call("setGroupMembers", { id: args.groupId, memberAgentIds: args.memberIds });
  }

  openAgent(args: { id: string }) { return this.call("openAgent", args); }
  sendPrompt(args: { agentId: string; prompt: string; richText?: string; clientNonce?: string }) {
    return this.call("sendPrompt", args);
  }
  getConversationOutline(args: { id: string }) { return this.call("getConversationOutline", args); }
  getAgentTranscriptTail(args: any) { return this.call("getAgentTranscriptTail", args); }
  reactToMessage(args: any) { return this.call("reactToMessage", args); }

  getHostSettings() { return this.call("getHostSettings"); }
  setHostSettings(args: any) { return this.call("setHostSettings", args); }

  /** Subscribe to the SSE event stream. Returns an async iterator of {channel, payload}. */
  async *events(signal?: AbortSignal): AsyncGenerator<{ channel: string; payload: any }> {
    const res = await this.fetchFn(`${this.baseUrl}/events`, {
      headers: this.headers({ accept: "text/event-stream" }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`events failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataBuffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) dataBuffer += line.slice(6);
        else if (line === "" && dataBuffer) {
          try { yield JSON.parse(dataBuffer); } catch { /* ignore partial */ }
          dataBuffer = "";
        }
      }
    }
  }

  /** Event-emitter style subscription. Returns a disposer. */
  subscribe(handler: (event: { channel: string; payload: any }) => void): () => void {
    const ctrl = new AbortController();
    (async () => {
      try { for await (const ev of this.events(ctrl.signal)) handler(ev); }
      catch { /* stream closed */ }
    })();
    return () => ctrl.abort();
  }
}
