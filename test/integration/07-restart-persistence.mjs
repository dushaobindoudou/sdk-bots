/**
 * Integration 07 — state persistence across a host restart (two phases).
 *
 * Phase 1 (no IT_PHASE): boot on the shared IT_DATA_DIR, create an agent,
 * run a mock turn, shut down cleanly (SIGTERM clears gateway.json/host.lock).
 * Phase 2 (IT_PHASE=2): boot a fresh host on the SAME dataDir, verify the
 * agent survives and the transcript still contains the persisted reply.
 *
 * The runner (run.mjs) executes this file twice with a shared IT_DATA_DIR.
 */

import {
  assert, agentId, boot, finish, countTranscriptMatches, waitTranscript,
} from "./helpers.mjs";

const TAG = process.env.IT_PHASE === "2" ? "it07/phase2" : "it07/phase1";
const MARKER = "IT07-MOCK-REPLY persisted across restart";
const AGENT_NAME = "it07-restart-bot";

async function phase1() {
  const host = await boot({ name: "07-restart", reply: MARKER }); // dataDir from IT_DATA_DIR
  console.log(`[${TAG}] data dir:`, host.dataDir);
  const sdk = host.client;

  const a1 = await sdk.createAgent({ name: AGENT_NAME, description: "survives restarts" });
  const id1 = agentId(a1);

  const replyPromise = waitTranscript(sdk, MARKER, 90_000, id1);
  const sent = await sdk.sendPrompt({ agentId: id1, prompt: "reply before restart" });
  assert(sent != null, "phase1 sendPrompt returned");
  await replyPromise;
  console.log(`[${TAG}] reply observed, agent ${id1} created — shutting down cleanly`);
  finish(TAG);
}

async function phase2() {
  const host = await boot({ name: "07-restart", reply: "IT07-MOCK-REPLY should not fire again" });
  const sdk = host.client;

  const agents = await sdk.listAgents();
  const found = (agents?.agents ?? []).find((a) => a.name === AGENT_NAME);
  assert(found != null, `agent "${AGENT_NAME}" survived the restart`);
  console.log(`[${TAG}] agent restored:`, found.id);

  const tail = await sdk.getAgentTranscriptTail({ id: found.id });
  const { count } = countTranscriptMatches(tail, MARKER);
  console.log(`[${TAG}] persisted transcript matches:`, count);
  assert(count >= 1, `persisted transcript still contains the pre-restart reply (count=${count})`);

  // The restarted host also accepts new work on the restored agent.
  const reply2 = waitTranscript(sdk, "IT07-MOCK-REPLY should not fire again", 90_000, found.id);
  await sdk.sendPrompt({ agentId: found.id, prompt: "post-restart turn" });
  await reply2;
  console.log(`[${TAG}] post-restart turn executed`);

  finish(TAG);
}

const main = process.env.IT_PHASE === "2" ? phase2 : phase1;
main().catch((e) => finish(TAG, e));
