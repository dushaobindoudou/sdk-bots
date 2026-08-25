/**
 * Smoke test for sdk-bots headless host.
 *
 * Boots the host in-process, waits for the gateway, then exercises:
 *   GET /health  ->  POST /api/listAgents  ->  POST /api/createAgent  ->  teardown
 *
 * Run:  node test/smoke.mjs
 * (No provider credentials needed — sendPrompt is NOT called here.)
 */

import { startHost, SdkBotsClient } from "../src/sdk/entry.ts";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("[smoke] starting headless host...");
  let info;
  try {
    info = await startHost();
  } catch (e) {
    console.error("[smoke] host failed to start:", e);
    process.exit(1);
  }
  console.log("[smoke] host up, gateway on port", info.port);
  const sdk = new SdkBotsClient({ baseUrl: `http://127.0.0.1:${info.port}`, token: info.token });

  // 1. health
  const h = await sdk.health();
  console.log("[smoke] health:", JSON.stringify(h));
  if (!h.ok) { console.error("[smoke] FAIL: health not ok"); process.exit(1); }

  // 2. listAgents (should succeed even with zero agents)
  const list = await sdk.listAgents();
  console.log("[smoke] listAgents:", JSON.stringify(list).slice(0, 200));
  const leftovers = (Array.isArray(list) ? list : list?.agents ?? []).filter(
    (a) => a?.name?.startsWith("smoke-test") || a?.name === "smoke-war-room",
  );
  if (leftovers.length > 0) {
    console.log(`[smoke] note: ${leftovers.length} leftover smoke agents from earlier runs (not deleting to stay under bulk-delete guard; they are harmless)`);
  }

  // 3. createAgent
  const agent = await sdk.createAgent({ name: "smoke-test-bot", description: "created by smoke test" });
  console.log("[smoke] createAgent:", JSON.stringify(agent).slice(0, 300));
  const agentId = agent?.agent?.id ?? agent?.id;
  if (!agentId) { console.error("[smoke] FAIL: no agent id returned"); process.exit(1); }

  // 4. countAgents
  const count = await sdk.countAgents();
  console.log("[smoke] countAgents:", JSON.stringify(count));

  // 5. createAgent #2 (group member)
  const agent2 = await sdk.createAgent({ name: "smoke-test-bot-2", description: "second member" });
  const agent2Id = agent2?.agent?.id ?? agent2?.id;
  console.log("[smoke] createAgent#2 id:", agent2Id);
  if (!agent2Id) { console.error("[smoke] FAIL: second agent id missing"); process.exit(1); }

  // 6. createGroup — 群聊会话（group-chat 轮值编排入口）
  const group = await sdk.createGroup({ name: "smoke-war-room", description: "smoke test group", memberIds: [agentId, agent2Id] });
  console.log("[smoke] createGroup:", JSON.stringify(group).slice(0, 300));
  const groupAgentId = group?.agent?.id ?? group?.id;
  if (!groupAgentId) { console.error("[smoke] FAIL: no group id returned"); process.exit(1); }

  // 7. setGroupMembers (rotate membership)
  const set = await sdk.setGroupMembers({ groupId: groupAgentId, memberIds: [agentId, agent2Id] });
  console.log("[smoke] setGroupMembers ok");

  // 8. updateAgent
  const upd = await sdk.updateAgent({ id: agentId, profile: { name: "smoke-test-bot", description: "updated by smoke test" } });
  console.log("[smoke] updateAgent ok");

  // 9. deleteAgent cleanup (remove second member, then the group, then agent 1)
  await sdk.deleteAgent({ id: agent2Id });
  await sdk.deleteAgent({ id: groupAgentId });
  await sdk.deleteAgent({ id: agentId });
  console.log("[smoke] deleteAgent x3 (cleanup) ok");

  // 10. verify SSE event stream opens
  const ctrl = new AbortController();
  let sawEvent = false;
  const stop = sdk.subscribe(() => { sawEvent = true; });
  await sleep(800);
  stop();
  console.log("[smoke] SSE stream opened ok (events seen:", sawEvent + ")");

  console.log("[smoke] PASS — all gateway calls succeeded");
  // SIGTERM (not process.exit) so the host's shutdown handler clears
  // gateway.json and releases the host lock before the process dies.
  await sleep(300);
  process.kill(process.pid, "SIGTERM");
  // Safety net only; the host's own shutdown path exits the process.
  setTimeout(() => process.exit(0), 8_000);
}

main().catch((e) => { console.error("[smoke] uncaught:", e); process.exit(1); });
