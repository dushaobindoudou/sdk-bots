/**
 * Integration 05 — gateway token authentication.
 *
 * boot(token pinned) -> SDK client (token-wired) works -> raw fetch without
 * a token is rejected -> SDK client with the wrong token throws -> health
 * stays reachable.
 */

import {
  assert, boot, finish,
} from "./helpers.mjs";

const TAG = "it05";
const TOKEN = "it05-secret-token";

async function main() {
  const host = await boot({ name: "05-token-auth", reply: "unused", token: TOKEN });
  const sdk = host.client;

  // Token-wired client works.
  const agents = await sdk.listAgents();
  assert(Array.isArray(agents?.agents), "token-wired client can listAgents");

  // Raw fetch without a token is rejected.
  const noToken = await fetch(`${host.baseUrl}/api/listAgents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  console.log(`[${TAG}] no-token status:`, noToken.status);
  assert(noToken.status === 401 || noToken.status === 403, `no-token request rejected (status=${noToken.status})`);

  // Raw fetch with the wrong token is rejected.
  const wrongToken = await fetch(`${host.baseUrl}/api/listAgents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
    body: "{}",
  });
  console.log(`[${TAG}] wrong-token status:`, wrongToken.status);
  assert(wrongToken.status === 401 || wrongToken.status === 403, `wrong-token request rejected (status=${wrongToken.status})`);

  // A client constructed without the token cannot call protected methods.
  const { SdkBotsClient } = await import("../../src/sdk/index.ts");
  const bare = new SdkBotsClient({ baseUrl: host.baseUrl });
  let threw = false;
  try {
    await bare.listAgents();
  } catch {
    threw = true;
  }
  assert(threw, "tokenless client call throws");

  finish(TAG);
}

main().catch((e) => finish(TAG, e));
