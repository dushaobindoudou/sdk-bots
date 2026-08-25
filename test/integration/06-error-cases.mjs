/**
 * Integration 06 — gateway error surfaces.
 *
 * sendPrompt to a nonexistent agent fails loudly; createGroup without
 * members is rejected; both errors carry a useful message.
 */

import { assert, boot, finish } from "./helpers.mjs";

const TAG = "it06";

async function main() {
  const host = await boot({ name: "06-errors", reply: "unused" });
  const sdk = host.client;

  let sendError = null;
  try {
    await sdk.sendPrompt({ agentId: "00000000-nonexistent-agent", prompt: "hello" });
  } catch (e) {
    sendError = e;
  }
  assert(sendError !== null, "sendPrompt to a nonexistent agent throws");
  console.log(`[${TAG}] sendPrompt error:`, String(sendError).slice(0, 160));

  let groupError = null;
  try {
    await sdk.createGroup({ name: "it06-empty", description: "no members" });
  } catch (e) {
    groupError = e;
  }
  assert(groupError !== null, "createGroup without members throws");
  assert(
    String(groupError).includes("member"),
    `createGroup error mentions members: ${String(groupError).slice(0, 160)}`,
  );

  // A bad method name surfaces as a gateway error too.
  let methodError = null;
  try {
    await sdk.call("definitelyNotAMethod");
  } catch (e) {
    methodError = e;
  }
  assert(methodError !== null, "unknown method throws");
  console.log(`[${TAG}] unknown-method error:`, String(methodError).slice(0, 160));

  finish(TAG);
}

main().catch((e) => finish(TAG, e));
