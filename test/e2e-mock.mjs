/**
 * Credential-free end-to-end test: full group-chat loop with the mock
 * inference provider.
 *
 *   startHost (mock inference) -> createAgent x2 -> createGroup
 *   -> sendPrompt -> await the mock reply on the SSE transcript channel
 *
 * Run:  npm run test:e2e       (no provider credentials needed)
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHost } from "../src/sdk/entry.ts";

const MOCK_REPLY = "MOCK-E2E-REPLY: the mock model is speaking.";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const dataDir = join(mkdtempSync(join(tmpdir(), "sdk-bots-e2e-")), "data");
  console.log("[e2e] data dir:", dataDir);

  // Mock inference is read per turn (cursor-session.createSession), so any
  // plain string here becomes every agent's reply - no credentials involved.
  process.env.SAND_AGENT_MOCK_RESPONSE = MOCK_REPLY;

  const host = await startHost({ dataDir });
  console.log("[e2e] host up on port", host.port);
  const sdk = host.client;

  try {
    // Subscribe to transcript events BEFORE sending, so the reply cannot race us.
    const replySeen = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for mock reply on SSE transcript channel")), 90_000);
      const dispose = sdk.subscribe(ev => {
        const text = JSON.stringify(ev?.payload ?? {});
        if (ev?.channel === "transcript" && text.includes(MOCK_REPLY)) {
          clearTimeout(timer);
          dispose();
          resolve(text.slice(0, 300));
        }
      });
    });

    const a1 = await sdk.createAgent({ name: "e2e-researcher", description: "researches" });
    const a2 = await sdk.createAgent({ name: "e2e-writer", description: "writes" });
    const id1 = a1?.agent?.id ?? a1?.id, id2 = a2?.agent?.id ?? a2?.id;
    console.log("[e2e] agents:", id1, id2);
    if (!id1 || !id2) throw new Error("agent ids missing");

    const group = await sdk.createGroup({ name: "e2e-war-room", description: "e2e", memberIds: [id1, id2] });
    const groupId = group?.agent?.id ?? group?.id;
    console.log("[e2e] group:", groupId);
    if (!groupId) throw new Error("group id missing");

    const sent = await sdk.sendPrompt({ agentId: groupId, prompt: "Discuss the mock topic." });
    console.log("[e2e] sendPrompt ->", JSON.stringify(sent).slice(0, 200));

    const snippet = await replySeen;
    console.log("[e2e] mock reply observed on transcript channel:", snippet);
    console.log("[e2e] PASS - full credential-free group-chat loop");
    process.exitCode = 0;
  } catch (e) {
    console.error("[e2e] FAIL:", e);
    process.exitCode = 1;
  } finally {
    await sleep(300);
    process.kill(process.pid, "SIGTERM");
    setTimeout(() => process.exit(process.exitCode ?? 0), 8_000);
  }
}

main().catch((e) => { console.error("[e2e] uncaught:", e); process.exit(1); });
