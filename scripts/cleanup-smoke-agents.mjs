/**
 * Cleanup: delete all leftover smoke-test agents via the SDK (dogfood).
 * Run: NODE_OPTIONS="--use-system-ca" node_modules/.bin/tsx scripts/cleanup-smoke-agents.mjs
 */
import { startHost, SdkBotsClient } from "../src/sdk/entry.ts";

async function main() {
  process.env.SAND_USE_EXISTING_BOX_EXEC_DAEMON ??= "1";
  console.log("[cleanup] starting headless host...");
  const info = await startHost();
  const sdk = new SdkBotsClient({ baseUrl: `http://127.0.0.1:${info.port}`, token: info.token });
  const list = await sdk.listAgents();
  const agents = Array.isArray(list) ? list : list?.agents ?? [];
  const targets = agents.filter((a) => a?.name?.startsWith("smoke-test") || a?.name === "smoke-war-room");
  console.log(`[cleanup] ${targets.length} leftover smoke agents to remove`);
  for (const a of targets) {
    await sdk.deleteAgent({ id: a.id });
    console.log("[cleanup] deleted", a.id, `(${a.name})`);
  }
  console.log("[cleanup] done");
  process.exit(0);
}

main().catch((e) => { console.error("[cleanup] failed:", e); process.exit(1); });
