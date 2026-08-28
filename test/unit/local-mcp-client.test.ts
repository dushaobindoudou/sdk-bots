import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createInProcessMcpRuntime } from "../../src/host/extensions/mcp/local-mcp-client.js";

/**
 * Fixture behaviors (first CLI arg):
 * - "flaky": exits non-zero immediately on FIRST launch (marker file absent),
 *   serves one tool on every later launch — models a transient startup failure.
 * - "crash-after-ready": serves tools/list once, then exits — models a server
 *   that dies mid-session (stale session must not stick).
 */
const FIXTURE = String.raw`
import { existsSync, writeFileSync } from "node:fs";
import readline from "node:readline";
const mode = process.argv[2];
const marker = process.argv[3];
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
if (mode === "flaky" && !existsSync(marker)) { writeFileSync(marker, "1"); process.exit(3); }
let served = false;
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id == null) return;
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } } });
  else if (msg.method === "tools/list") {
    if (mode === "crash-after-ready" && served) process.exit(0);
    served = true;
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "p", inputSchema: { type: "object" } }] } });
  } else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong" }] } });
  else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
});
`;

function setup(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-client-test-"));
  const script = join(dir, "fixture.mjs");
  writeFileSync(script, FIXTURE, "utf8");
  const marker = join(dir, "launched.marker");
  const servers = [{ name: "t", config: { command: "node", args: [script, mode, marker] } }];
  const runtime = createInProcessMcpRuntime({
    getServers: () => servers,
    log: () => {},
  });
  return { runtime, cleanup: () => { runtime.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("local MCP client resilience (Grok v1.0.12 class fix)", () => {
  it("retries a transiently failing stdio server within the same discovery cycle", async () => {
    const t = setup("flaky");
    try {
      const rows = (await t.runtime.listTools(["t"])) as Array<{ serverIdentifier: string; status: string; tools: unknown[] }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, "connected");
      assert.equal(rows[0]?.tools?.length, 1);
    } finally { t.cleanup(); }
  });

  it("reconnects a session whose server process died instead of staying unavailable", async () => {
    const t = setup("crash-after-ready");
    try {
      const first = (await t.runtime.listTools(["t"])) as Array<{ status: string }>;
      assert.equal(first[0]?.status, "connected");
      // The fixture exits after its first tools/list. Allow the exit to land,
      // then discover again: the dead session must be replaced, not reused.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const second = (await t.runtime.listTools(["t"])) as Array<{ status: string; tools: unknown[] }>;
      assert.equal(second[0]?.status, "connected");
      assert.equal(second[0]?.tools?.length, 1);
    } finally { t.cleanup(); }
  });
});
