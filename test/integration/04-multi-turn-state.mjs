/**
 * Integration 04 — sequential multi-turn state on one agent.
 *
 * Three sequential prompts, each awaited before the next (mock reply each
 * turn). Verifies turns serialize through the exclusive run queue and the
 * persisted transcript accumulates assistant replies.
 */

import {
  assert, agentId, boot, finish, countTranscriptMatches, waitTranscript,
} from "./helpers.mjs";

const TAG = "it04";
const MARKER = "IT04-MOCK-REPLY multi turn state";

async function main() {
  const host = await boot({ name: "04-multi-turn", reply: MARKER });
  const sdk = host.client;

  const a1 = await sdk.createAgent({ name: "it04-chatterbox", description: "chatty" });
  const id1 = agentId(a1);

  for (let i = 1; i <= 3; i += 1) {
    const replyPromise = waitTranscript(sdk, MARKER, 90_000);
    const sent = await sdk.sendPrompt({ agentId: id1, prompt: `turn ${i}: reply now` });
    assert(sent != null, `sendPrompt turn ${i} returned`);
    await replyPromise;
    console.log(`[${TAG}] turn ${i} reply observed`);
  }

  const tail = await sdk.getAgentTranscriptTail({ id: id1 });
  const { count, total } = countTranscriptMatches(tail, MARKER);
  console.log(`[${TAG}] transcript tail: ${count} matching entries of ${total} total`);
  assert(count >= 3, `transcript accumulated >= 3 mock replies (count=${count})`);

  finish(TAG);
}

main().catch((e) => finish(TAG, e));
