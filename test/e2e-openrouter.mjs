/**
 * Live OpenRouter e2e: real free-model inference through the headless host.
 *
 * Reads FREEROUTE_OPENROUTER_API_KEY from ~/.dsh/.credentials.yaml (never
 * prints the secret). Chains:
 *   startHost -> CRUD agents/group -> set inferenceProvider=openrouter
 *   -> group sendPrompt -> single-agent follow-up -> transcript asserts
 *
 * Run:  NODE_OPTIONS="--use-system-ca" pnpm test:e2e:openrouter
 * Env:  SAND_OPENROUTER_MODEL (default nvidia/nemotron-3.5-lightning:free)
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { startHost } from "../src/sdk/entry.ts";
import {
  agentId,
  countTranscriptMatches,
  waitTranscript,
} from "./integration/helpers.mjs";

const TAG = "e2e-or";
const DEFAULT_MODEL = "nvidia/nemotron-3.5-lightning:free";
const MARKER_GROUP = "LIVE-OR-CHAIN-1";
const MARKER_SOLO = "LIVE-OR-CHAIN-2";
const TURN_MS = 180_000;

function loadDshOpenRouterKey() {
  const raw = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
  const match = raw.match(/^  FREEROUTE_OPENROUTER_API_KEY:\s*(\S+)\s*$/m);
  if (match == null) {
    throw new Error("dsh ~/.dsh/.credentials.yaml has no FREEROUTE_OPENROUTER_API_KEY");
  }
  return match[1];
}

function summarizeTail(tail) {
  const entries = tail?.entries ?? [];
  return entries.map((entry) => {
    const content = entry?.message?.content ?? entry?.content ?? "";
    const text = typeof content === "string" ? content : JSON.stringify(content);
    return `${entry?.kind ?? "?"}:${String(text).slice(0, 120)}`;
  });
}

async function main() {
  delete process.env.SAND_AGENT_MOCK_RESPONSE;
  const key = loadDshOpenRouterKey();
  process.env.OPENROUTER_API_KEY = key;
  process.env.SAND_OPENROUTER_MODEL =
    process.env.SAND_OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
  console.log(`[${TAG}] model: ${process.env.SAND_OPENROUTER_MODEL}`);
  console.log(`[${TAG}] key: ${key.slice(0, 12)}… (from dsh credentials)`);

  const dataDir = join(mkdtempSync(join(tmpdir(), "sdk-bots-e2e-or-")), "data");
  console.log(`[${TAG}] data dir: ${dataDir}`);

  const host = await startHost({ dataDir });
  console.log(`[${TAG}] host up on port ${host.port}`);
  const sdk = host.client;

  try {
    const health = await sdk.health();
    if (!health || typeof health !== "object") throw new Error("health failed");

    const researcher = await sdk.createAgent({
      name: "or-researcher",
      description: "researches in the live openrouter chain",
    });
    const writer = await sdk.createAgent({
      name: "or-writer",
      description: "writes in the live openrouter chain",
    });
    const id1 = agentId(researcher);
    const id2 = agentId(writer);
    console.log(`[${TAG}] agents: ${id1} ${id2}`);

    const listed = await sdk.listAgents();
    const listedIds = (listed.agents ?? []).map((a) => a.id);
    if (!listedIds.includes(id1) || !listedIds.includes(id2)) {
      throw new Error(`listAgents missing created ids: ${listedIds.join(",")}`);
    }

    const group = await sdk.createGroup({
      name: "or-war-room",
      description: "live openrouter chain",
      memberIds: [id1, id2],
    });
    const groupId = agentId(group);
    console.log(`[${TAG}] group: ${groupId}`);

    // Switch provider after roster CRUD so onboarding kickstart does not
    // burn free-quota calls against OpenRouter.
    const settings = await sdk.setHostSettings({ inferenceProvider: "openrouter" });
    if (settings?.inferenceProvider !== "openrouter") {
      throw new Error(`inferenceProvider not applied: ${JSON.stringify(settings).slice(0, 200)}`);
    }
    console.log(`[${TAG}] inferenceProvider=openrouter`);

    const groupWait = waitTranscript(sdk, MARKER_GROUP, TURN_MS, groupId);
    const groupSent = await sdk.sendPrompt({
      agentId: groupId,
      prompt:
        `This is a live connectivity check. Call SendMessage with type=text. ` +
        `The content MUST contain the exact token ${MARKER_GROUP}. One short sentence.`,
    });
    console.log(`[${TAG}] group sendPrompt -> ${JSON.stringify(groupSent).slice(0, 180)}`);
    await groupWait;
    const groupTail = await sdk.getAgentTranscriptTail({ id: groupId });
    const groupHits = countTranscriptMatches(groupTail, MARKER_GROUP);
    if (groupHits.count < 1) {
      throw new Error(`group transcript missing ${MARKER_GROUP}: ${summarizeTail(groupTail).join(" | ")}`);
    }
    console.log(`[${TAG}] group reply observed (${groupHits.count} hit / ${groupHits.total} entries)`);

    const soloWait = waitTranscript(sdk, MARKER_SOLO, TURN_MS, id1);
    const soloSent = await sdk.sendPrompt({
      agentId: id1,
      prompt:
        `Follow-up on the same live check. Call SendMessage with type=text. ` +
        `The content MUST contain the exact token ${MARKER_SOLO}. One short sentence.`,
    });
    console.log(`[${TAG}] solo sendPrompt -> ${JSON.stringify(soloSent).slice(0, 180)}`);
    await soloWait;
    const soloTail = await sdk.getAgentTranscriptTail({ id: id1 });
    const soloHits = countTranscriptMatches(soloTail, MARKER_SOLO);
    if (soloHits.count < 1) {
      throw new Error(`solo transcript missing ${MARKER_SOLO}: ${summarizeTail(soloTail).join(" | ")}`);
    }
    console.log(`[${TAG}] solo reply observed (${soloHits.count} hit / ${soloHits.total} entries)`);

    console.log(`[${TAG}] PASS - live OpenRouter group + single-agent chain`);
    process.exitCode = 0;
  } catch (error) {
    console.error(`[${TAG}] FAIL:`, error);
    process.exitCode = 1;
  } finally {
    await new Promise((r) => setTimeout(r, 300));
    process.kill(process.pid, "SIGTERM");
    setTimeout(() => process.exit(process.exitCode ?? 0), 8_000);
  }
}

main().catch((error) => {
  console.error(`[${TAG}] uncaught:`, error);
  process.exit(1);
});
