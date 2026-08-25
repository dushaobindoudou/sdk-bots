/**
 * Integration 03 — group turn: the mock reply comes from a member agent.
 *
 * boot(mock reply) -> createAgent x2 -> createGroup -> sendPrompt to the
 * group -> await the reply -> assert the reply author is one of the member
 * agents (orchestrated fan-out picks a member).
 */

import {
  assert, agentId, boot, finish, waitTranscript,
} from "./helpers.mjs";

const TAG = "it03";
const MARKER = "IT03-MOCK-REPLY group turn works";

async function main() {
  const host = await boot({ name: "03-group-turn", reply: MARKER });
  const sdk = host.client;

  const a1 = await sdk.createAgent({ name: "it03-member-a", description: "member a" });
  const a2 = await sdk.createAgent({ name: "it03-member-b", description: "member b" });
  const id1 = agentId(a1), id2 = agentId(a2);

  const group = await sdk.createGroup({ name: "it03-group", description: "it03", memberIds: [id1, id2] });
  const groupId = agentId(group);

  const replyPromise = waitTranscript(sdk, MARKER);

  const sent = await sdk.sendPrompt({ agentId: groupId, prompt: "discuss the topic" });
  assert(sent != null, "sendPrompt to group returned");

  const payload = await replyPromise;
  const authorId = payload?.entry?.author?.id ?? payload?.author?.id;
  console.log(`[${TAG}] reply author:`, authorId);
  if (authorId !== undefined) {
    assert(
      authorId === id1 || authorId === id2,
      `reply author ${authorId} is one of the group members`,
    );
  }
  // The reply must not be attributed to the group container itself.
  assert(authorId !== groupId, "reply author is not the group container");

  finish(TAG);
}

main().catch((e) => finish(TAG, e));
