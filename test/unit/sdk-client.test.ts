/**
 * Unit tests for SdkBotsClient — the HTTP/SSE client layer.
 *
 * Everything is exercised against an injected fake `fetch`, so no real host is
 * required. Covers: construction, header wiring, JSON-RPC transport (success /
 * HTTP error / business error), the full gateway method surface, the
 * createGroup/setGroupMembers parameter mapping (memberIds -> memberAgentIds,
 * groupId -> id), SSE stream parsing (multi-event, cross-chunk framing,
 * malformed lines, abort) and subscribe() disposal.
 *
 * Run:  npm run test:unit
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SdkBotsClient } from "../../src/sdk/index.ts";

const BASE = "http://127.0.0.1:7331";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface FakeFetchHarness {
  fetch: typeof fetch;
  calls: RecordedRequest[];
  /** Route a request: `${method} ${url}` -> handler. `*` matches anything. */
  route(pattern: string, handler: (req: RecordedRequest) => Response): void;
}

/** Build a fetch harness that records every call. */
function mockFetch(): FakeFetchHarness {
  const calls: RecordedRequest[] = [];
  const routes = new Map<string, (req: RecordedRequest) => Response>();

  const fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
    let body: unknown;
    if (init?.body != null) {
      try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); }
    }
    const rec: RecordedRequest = { method, url, headers, body };
    calls.push(rec);

    const handler = routes.get(`${method} ${url}`) ?? routes.get(`${method} *`) ?? routes.get("*");
    if (!handler) return new Response(`no route for ${method} ${url}`, { status: 404 });
    return handler(rec);
  };

  const route = (pattern: string, handler: (req: RecordedRequest) => Response) => {
    routes.set(pattern, handler);
  };

  return { fetch, calls, route };
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Collect all events from an async generator (with an optional cap). */
async function collect<T>(gen: AsyncGenerator<T>, cap = 100): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) {
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("SdkBotsClient construction", () => {
  test("strips a trailing slash from baseUrl", () => {
    const h = mockFetch();
    h.route("*", () => json({}));
    const sdk = new SdkBotsClient({ baseUrl: `${BASE}/`, fetch: h.fetch });
    void sdk.health();
    assert.equal(h.calls[0].url, `${BASE}/health`);
  });

  test("defaults to globalThis.fetch when no fetch is injected", () => {
    const sdk = new SdkBotsClient({ baseUrl: BASE });
    assert.equal((sdk as unknown as { fetchFn: typeof fetch }).fetchFn, globalThis.fetch);
  });

  test("uses the injected fetch when provided", () => {
    const h = mockFetch();
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });
    assert.equal((sdk as unknown as { fetchFn: typeof fetch }).fetchFn, h.fetch);
  });
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

describe("SdkBotsClient headers", () => {
  test("sends content-type json and no authorization when token is absent", () => {
    const h = mockFetch();
    h.route("*", () => json({ result: {} }));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });
    void sdk.call("listAgents");
    assert.equal(h.calls[0].headers["content-type"], "application/json");
    assert.equal(h.calls[0].headers.authorization, undefined);
  });

  test("sends a Bearer authorization header when token is set", () => {
    const h = mockFetch();
    h.route("*", () => json({ result: {} }));
    const sdk = new SdkBotsClient({ baseUrl: BASE, token: "sekret", fetch: h.fetch });
    void sdk.call("listAgents");
    assert.equal(h.calls[0].headers.authorization, "Bearer sekret");
  });
});

// ---------------------------------------------------------------------------
// health()
// ---------------------------------------------------------------------------

describe("health()", () => {
  test("GETs /health and parses the body", async () => {
    const h = mockFetch();
    h.route("GET *", () => json({ ok: true, version: "0.1.0" }));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });
    const res = await sdk.health();
    assert.equal(h.calls[0].method, "GET");
    assert.equal(h.calls[0].url, `${BASE}/health`);
    assert.deepEqual(res, { ok: true, version: "0.1.0" });
  });
});

// ---------------------------------------------------------------------------
// call() — JSON-RPC transport
// ---------------------------------------------------------------------------

describe("call() — RPC transport", () => {
  test("POSTs to /api/<method> with a JSON body and returns result", async () => {
    const h = mockFetch();
    h.route("POST *", () => json({ result: { id: "a1" } }));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });

    const res = await sdk.call("createAgent", { name: "alice" });

    assert.equal(h.calls[0].method, "POST");
    assert.equal(h.calls[0].url, `${BASE}/api/createAgent`);
    assert.deepEqual(h.calls[0].body, { name: "alice" });
    assert.deepEqual(res, { id: "a1" });
  });

  test("returns the whole JSON envelope when result is absent", async () => {
    const h = mockFetch();
    h.route("*", () => json({ ok: true }));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });
    const res = await sdk.call("countAgents");
    assert.deepEqual(res, { ok: true });
  });

  test("sends an empty object body when args are omitted", async () => {
    const h = mockFetch();
    h.route("*", () => json({ result: [] }));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });
    await sdk.call("listAgents");
    assert.deepEqual(h.calls[0].body, {});
  });

  test("throws with status text on HTTP errors", async () => {
    const h = mockFetch();
    h.route("*", () => new Response("boom", { status: 500 }));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });
    await assert.rejects(() => sdk.call("listAgents"), /listAgents failed: 500 boom/);
  });

  test("throws with the server error payload on business errors", async () => {
    const h = mockFetch();
    h.route("*", () => json({ error: { code: "INVALID", message: "bad member" } }));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });
    await assert.rejects(() => sdk.call("createGroup", {}), /INVALID/);
  });

  test("propagates transport failures (network down)", async () => {
    const h = mockFetch();
    h.route("*", () => { throw new Error("ECONNREFUSED"); });
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });
    await assert.rejects(() => sdk.call("listAgents"), /ECONNREFUSED/);
  });
});

// ---------------------------------------------------------------------------
// Agent / conversation method surface
// ---------------------------------------------------------------------------

describe("agent & conversation methods", () => {
  test("every method dispatches to the correct gateway method name", async () => {
    const h = mockFetch();
    h.route("*", () => json({ result: {} }));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });

    const cases: Array<[() => unknown, string, unknown]> = [
      [() => sdk.createAgent({ name: "a" }), "createAgent", { name: "a" }],
      [() => sdk.listAgents(), "listAgents", {}],
      [() => sdk.countAgents(), "countAgents", {}],
      [() => sdk.searchAgents({ query: "q" }), "searchAgents", { query: "q" }],
      [() => sdk.updateAgent({ id: "x", profile: { name: "b" } }), "updateAgent", { id: "x", profile: { name: "b" } }],
      [() => sdk.deleteAgent({ id: "x" }), "deleteAgent", { id: "x" }],
      [() => sdk.kickstartAgent({ id: "x" }), "kickstartAgent", { id: "x" }],
      [() => sdk.openAgent({ id: "x" }), "openAgent", { id: "x" }],
      [() => sdk.sendPrompt({ agentId: "x", prompt: "hi" }), "sendPrompt", { agentId: "x", prompt: "hi" }],
      [() => sdk.getConversationOutline({ id: "x" }), "getConversationOutline", { id: "x" }],
      [() => sdk.getHostSettings(), "getHostSettings", {}],
    ];

    for (const [invoke, method, expectedBody] of cases) {
      await invoke();
      const call = h.calls.at(-1)!;
      assert.equal(call.url, `${BASE}/api/${method}`, `url for ${method}`);
      assert.deepEqual(call.body, expectedBody, `body for ${method}`);
    }
  });
});

// ---------------------------------------------------------------------------
// createGroup / setGroupMembers — gateway parameter mapping
// ---------------------------------------------------------------------------

describe("group methods — gateway parameter mapping", () => {
  test("createGroup maps memberIds -> memberAgentIds", async () => {
    const h = mockFetch();
    h.route("*", () => json({ result: { id: "g1" } }));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });

    await sdk.createGroup({ name: "war room", description: "ops", memberIds: ["a1", "a2"] });

    assert.equal(h.calls[0].url, `${BASE}/api/createGroup`);
    assert.deepEqual(h.calls[0].body, {
      name: "war room",
      description: "ops",
      memberAgentIds: ["a1", "a2"],
    });
  });

  test("createGroup passes description through when omitted", async () => {
    const h = mockFetch();
    h.route("*", () => json({ result: {} }));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });

    await sdk.createGroup({ name: "g", memberIds: [] });
    // undefined properties are dropped by JSON.stringify, so only the
    // present keys are expected on the wire.
    assert.deepEqual(h.calls[0].body, { name: "g", memberAgentIds: [] });
  });

  test("setGroupMembers maps groupId -> id and memberIds -> memberAgentIds", async () => {
    const h = mockFetch();
    h.route("*", () => json({ result: {} }));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });

    await sdk.setGroupMembers({ groupId: "g1", memberIds: ["a3"] });

    assert.equal(h.calls[0].url, `${BASE}/api/setGroupMembers`);
    assert.deepEqual(h.calls[0].body, { id: "g1", memberAgentIds: ["a3"] });
  });
});

// ---------------------------------------------------------------------------
// events() — SSE parsing
// ---------------------------------------------------------------------------

describe("events() — SSE stream", () => {
  test("parses a single well-formed event", async () => {
    const h = mockFetch();
    h.route("GET *", () => sseResponse([`data: ${JSON.stringify({ channel: "transcript", payload: { id: 1 } })}\n\n`]));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });

    const events = await collect(sdk.events());
    assert.deepEqual(events, [{ channel: "transcript", payload: { id: 1 } }]);
    assert.equal(h.calls[0].headers.accept, "text/event-stream");
  });

  test("parses multiple events in one chunk", async () => {
    const body =
      `data: ${JSON.stringify({ channel: "a", payload: 1 })}\n\n` +
      `data: ${JSON.stringify({ channel: "b", payload: 2 })}\n\n`;
    const h = mockFetch();
    h.route("*", () => sseResponse([body]));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });

    const events = await collect(sdk.events());
    assert.deepEqual(events, [
      { channel: "a", payload: 1 },
      { channel: "b", payload: 2 },
    ]);
  });

  test("handles events split across chunk boundaries (streaming framing)", async () => {
    const a = JSON.stringify({ channel: "t", payload: "hello" });
    const b = JSON.stringify({ channel: "u", payload: "world" });
    const h = mockFetch();
    // Deliberately cut the first event in half and interleave the second one.
    h.route("*", () => sseResponse([
      `data: ${a.slice(0, 10)}`,
      `${a.slice(10)}\n\ndata: `,
      `${b}\n\n`,
    ]));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });

    const events = await collect(sdk.events());
    assert.deepEqual(events, [
      { channel: "t", payload: "hello" },
      { channel: "u", payload: "world" },
    ]);
  });

  test("tolerates comment/keep-alive lines and blank frames", async () => {
    const h = mockFetch();
    h.route("*", () => sseResponse([`: keep-alive\n\n`, `data: \n\n`, `data: ${JSON.stringify({ channel: "x" })}\n\n`]));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });

    const events = await collect(sdk.events());
    assert.deepEqual(events, [{ channel: "x" }]);
  });

  test("skips malformed JSON payloads without crashing the stream", async () => {
    const h = mockFetch();
    h.route("*", () => sseResponse([`data: {not json}\n\n`, `data: ${JSON.stringify({ channel: "ok" })}\n\n`]));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });

    const events = await collect(sdk.events());
    assert.deepEqual(events, [{ channel: "ok" }]);
  });

  test("throws when the events endpoint is not ok", async () => {
    const h = mockFetch();
    h.route("*", () => new Response("denied", { status: 403 }));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });
    await assert.rejects(async () => { for await (const _ of sdk.events()) { /* drain */ } }, /events failed: 403/);
  });

  test("passes an abort signal through to the underlying fetch", async () => {
    const h = mockFetch();
    let seenSignal: AbortSignal | undefined;
    const origFetch = h.fetch;
    const wrapped = ((input: any, init?: any) => {
      seenSignal = init?.signal;
      return origFetch(input, init);
    }) as typeof fetch;

    h.route("*", () => sseResponse([`data: ${JSON.stringify({ channel: "x" })}\n\n`]));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: wrapped });
    const ctrl = new AbortController();
    const gen = sdk.events(ctrl.signal);
    await gen.next();
    assert.equal(seenSignal, ctrl.signal);
    await gen.return(undefined); // close the generator cleanly
  });
});

// ---------------------------------------------------------------------------
// subscribe()
// ---------------------------------------------------------------------------

describe("subscribe()", () => {
  test("delivers events to the handler and returns a working disposer", async () => {
    const h = mockFetch();
    h.route("*", () => sseResponse([`data: ${JSON.stringify({ channel: "t", payload: "hi" })}\n\n`]));
    const sdk = new SdkBotsClient({ baseUrl: BASE, fetch: h.fetch });

    const seen: unknown[] = [];
    const dispose = sdk.subscribe(ev => seen.push(ev));
    await new Promise(r => setTimeout(r, 50));

    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { channel: "t", payload: "hi" });

    // Disposer aborts the stream; a second subscribe must start a new request.
    dispose();
    await new Promise(r => setTimeout(r, 10));
    assert.ok(h.calls.length >= 1);
  });
});
