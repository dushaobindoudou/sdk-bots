/**
 * Integration 01 — lifecycle CRUD over the gateway.
 *
 * boot -> health -> createAgent x2 -> listAgents -> createGroup ->
 * setGroupMembers -> updateAgent -> getAgentTranscriptTail -> deleteAgent x3
 * -> listAgents empty -> clean shutdown.
 */

import {
  assert, assertEqual, agentId, boot, finish,
} from "./helpers.mjs";

const TAG = "it01";

async function main() {
  const host = await boot({ name: "01-lifecycle" });
  const sdk = host.client;

  const health = await sdk.health();
  assert(health && typeof health === "object", "health returned an object");

  let agents = await sdk.listAgents();
  const before = (agents?.agents ?? []).length;

  const a1 = await sdk.createAgent({ name: "it01-researcher", description: "researches" });
  const a2 = await sdk.createAgent({ name: "it01-writer", description: "writes" });
  const id1 = agentId(a1), id2 = agentId(a2);

  agents = await sdk.listAgents();
  assertEqual((agents?.agents ?? []).length, before + 2, "listAgents grows by 2");

  const group = await sdk.createGroup({ name: "it01-war-room", description: "it01", memberIds: [id1, id2] });
  const groupId = agentId(group);

  const afterMembers = await sdk.setGroupMembers({ groupId, memberIds: [id1, id2] });
  assert(afterMembers != null, "setGroupMembers returned");

  const updated = await sdk.updateAgent({ id: id1, profile: { name: "it01-researcher-2", description: "renamed" } });
  assert(updated != null, "updateAgent returned");

  const tail = await sdk.getAgentTranscriptTail({ id: id1 });
  assert(tail != null, "getAgentTranscriptTail returned");
  assertEqual((tail?.entries ?? []).length, 0, "fresh agent transcript is empty");

  await sdk.deleteAgent({ id: id2 });
  await sdk.deleteAgent({ id: groupId });
  await sdk.deleteAgent({ id: id1 });

  agents = await sdk.listAgents();
  const names = (agents?.agents ?? []).map((a) => a.name);
  assert(!names.includes("it01-researcher-2") && !names.includes("it01-writer"), "deleted agents are gone from listAgents");

  finish(TAG);
}

main().catch((e) => finish(TAG, e));
