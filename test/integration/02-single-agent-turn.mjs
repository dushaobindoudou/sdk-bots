/**
 * Integration 02 — single-agent turn with the mock inference provider.
 *
 * boot(mock reply) -> createAgent -> sendPrompt to the agent (not a group)
 * -> await the reply on the SSE transcript channel -> transcript tail
 * contains the mock reply.
 */

import {
  assert, agentId, boot, finish, countTranscriptMatches, waitTranscript,
} from "./helpers.mjs";

const TAG = "it02";
const MARKER = "IT02-MOCK-REPLY single agent turn works";

async function main() {
  const host = await boot({ name: "02-single-turn", reply: MARKER });
  const sdk = host.client;

  const a1 = await sdk.createAgent({ name: "it02-solo", description: "solo bot" });
  const id1 = agentId(a1);

  const replyPromise = waitTranscript(sdk, MARKER, 90_000, id1);

  const sent = await sdk.sendPrompt({ agentId: id1, prompt: "reply now" });
  assert(sent?.accepted === true || sent != null, `sendPrompt accepted: ${JSON.stringify(sent).slice(0, 120)}`);

  const payload = await replyPromise;
  const tail = await sdk.getAgentTranscriptTail({ id: id1 });
  const { count } = countTranscriptMatches(tail, MARKER);
  assert(count >= 1, `transcript tail contains the mock reply (count=${count}, payload=${JSON.stringify(payload).slice(0, 160)})`);

  finish(TAG);
}

main().catch((e) => finish(TAG, e));
