/**
 * 最小可跑示例：创建两个 bot，拉一个群，用 OpenRouter 免费模型真实对话。
 *
 * 默认凭证（按优先级）：
 *   1. 环境变量 OPENROUTER_API_KEY
 *   2. ~/.dsh/.credentials.yaml 里的 FREEROUTE_OPENROUTER_API_KEY
 *
 * 运行：
 *   NODE_OPTIONS="--use-system-ca" pnpm example:group-chat
 *   NODE_OPTIONS="--use-system-ca" pnpm example:group-chat -- 帮我想一个周末徒步计划
 *
 * 可选环境变量：
 *   SAND_OPENROUTER_MODEL   默认 nvidia/nemotron-3.5-lightning:free
 *   EXAMPLE_DATA_DIR        指定数据目录；不设则每次用临时目录
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { startHost } from "../src/sdk/entry.ts";

const DEFAULT_MODEL = "nvidia/nemotron-3.5-lightning:free";
const DEFAULT_TOPIC = "我们周末想去杭州附近玩一天，给两个具体去处，并写成给朋友看的两句话。";
const TURN_MS = 90_000;
const EXTRA_WAIT_MS = 8_000;

function loadOpenRouterKey() {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "OPENROUTER_API_KEY" };

  const credPath = join(homedir(), ".dsh", ".credentials.yaml");
  let raw;
  try {
    raw = readFileSync(credPath, "utf8");
  } catch {
    throw new Error(
      `没有找到 OpenRouter 凭证。请设置 OPENROUTER_API_KEY，或在 ${credPath} 配置 FREEROUTE_OPENROUTER_API_KEY。`,
    );
  }
  const match = raw.match(/^  FREEROUTE_OPENROUTER_API_KEY:\s*(\S+)\s*$/m);
  if (match == null) {
    throw new Error(`${credPath} 里没有 FREEROUTE_OPENROUTER_API_KEY`);
  }
  return { key: match[1], source: credPath };
}

function agentId(result) {
  const id = result?.agent?.id ?? result?.id;
  if (!id) throw new Error(`缺少 agent id: ${JSON.stringify(result).slice(0, 200)}`);
  return id;
}

function speak(topic) {
  return `${topic}\n\n只调用 SendMessage 回复用户（type=text）。一两句即可，不要调用其它工具。`;
}

function sendMessageText(entry) {
  if (entry?.kind !== "send-message") return null;
  const content = entry?.message?.content ?? entry?.content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

function listSendMessages(tail) {
  const entries = tail?.entries ?? [];
  const out = [];
  for (const entry of entries) {
    const text = sendMessageText(entry);
    if (text == null) continue;
    out.push({
      id: entry.id,
      name: entry?.author?.name ?? entry?.author?.id ?? "bot",
      text,
    });
  }
  return out;
}

function printLine(name, text) {
  const body = text.replace(/\s+/g, " ").trim();
  console.log(`\n  ${name}\n  ${body}\n`);
}

function dumpTail(label, tail) {
  const entries = tail?.entries ?? [];
  if (entries.length === 0) {
    console.log(`  [${label}] (空)`);
    return;
  }
  for (const entry of entries) {
    const text = sendMessageText(entry)
      ?? entry?.content
      ?? JSON.stringify(entry?.message ?? entry).slice(0, 160);
    console.log(
      `  [${label}] ${entry.kind}${entry.role ? "/" + entry.role : ""} ${String(text).replace(/\s+/g, " ").slice(0, 160)}`,
    );
  }
}

function waitForReplies(sdk, targetId, { min = 1, timeoutMs = TURN_MS, extraWaitMs = EXTRA_WAIT_MS } = {}) {
  const seenIds = new Set();
  let resolve;
  let reject;
  const done = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const snapshot = async () => {
    const tail = await sdk.getAgentTranscriptTail({ id: targetId });
    return listSendMessages(tail);
  };

  const timer = setTimeout(() => {
    reject(new Error(`等待回复超时（${timeoutMs / 1000}s）`));
  }, timeoutMs);

  let extraTimer;
  let latest = [];
  const maybeFinish = () => {
    if (latest.length < min) return;
    if (extraTimer != null) return;
    extraTimer = setTimeout(() => {
      clearTimeout(timer);
      void snapshot().then(resolve, reject);
    }, extraWaitMs);
  };

  const ingest = (replies) => {
    latest = replies;
    for (const reply of replies) {
      if (seenIds.has(reply.id)) continue;
      seenIds.add(reply.id);
      printLine(reply.name, reply.text);
    }
    maybeFinish();
  };

  const started = (async () => {
    const dispose = await sdk.subscribeWhenReady((ev) => {
      if (ev?.channel !== "transcript") return;
      const entry = ev?.payload?.entry ?? ev?.payload;
      if (sendMessageText(entry) == null) return;
      void snapshot().then(ingest).catch(() => {});
    });
    void snapshot().then(ingest).catch(() => {});
    const poll = setInterval(() => {
      void snapshot().then(ingest).catch(() => {});
    }, 800);
    try {
      return await done;
    } finally {
      clearTimeout(timer);
      if (extraTimer != null) clearTimeout(extraTimer);
      clearInterval(poll);
      dispose();
    }
  })();

  return started;
}

async function main() {
  delete process.env.SAND_AGENT_MOCK_RESPONSE;

  const topic = process.argv.slice(2).join(" ").trim() || DEFAULT_TOPIC;
  const { key, source } = loadOpenRouterKey();
  process.env.OPENROUTER_API_KEY = key;
  process.env.SAND_OPENROUTER_MODEL =
    process.env.SAND_OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;

  const dataDir = process.env.EXAMPLE_DATA_DIR?.trim()
    || join(mkdtempSync(join(tmpdir(), "sdk-bots-example-")), "data");

  console.log("sdk-bots 群聊示例");
  console.log(`  模型: ${process.env.SAND_OPENROUTER_MODEL}`);
  console.log(`  凭证: ${source} (${key.slice(0, 12)}…)`);
  console.log(`  数据: ${dataDir}`);
  console.log(`  话题: ${topic}`);

  const host = await startHost({ dataDir });
  const sdk = host.client;
  console.log(`  网关: ${host.baseUrl}\n`);

  const shutdown = () => {
    process.kill(process.pid, "SIGTERM");
    setTimeout(() => process.exit(process.exitCode ?? 0), 8_000);
  };
  process.once("SIGINT", () => {
    console.log("\n收到 Ctrl+C，正在退出…");
    shutdown();
  });

  let researcherId;
  let writerId;
  let groupId;

  try {
    const researcher = await sdk.createAgent({
      name: "研究员",
      description: "负责收集事实、给选项、列利弊。说话短，先给结论。",
    });
    const writer = await sdk.createAgent({
      name: "写手",
      description: "负责把研究员的材料写成给普通人看的短文，口语、不啰嗦。",
    });
    researcherId = agentId(researcher);
    writerId = agentId(writer);

    const group = await sdk.createGroup({
      name: "周末小队",
      description: "两个人一起商量一个小计划",
      memberIds: [researcherId, writerId],
    });
    groupId = agentId(group);

    await sdk.setHostSettings({ inferenceProvider: "openrouter" });
    console.log(`已创建 bot：研究员 ${researcherId}`);
    console.log(`已创建 bot：写手   ${writerId}`);
    console.log(`已创建群：周末小队 ${groupId}`);

    console.log("① 先问写手（单 bot）…");
    const soloWait = waitForReplies(sdk, writerId, { min: 1, extraWaitMs: 1_500 });
    await sdk.sendPrompt({
      agentId: writerId,
      prompt: speak("用一句话介绍你自己。"),
    });
    const solo = await soloWait;
    console.log(`—— 单 bot 结束，${solo.length} 条回复 ——`);

    console.log("② 再开群聊…");
    const groupWait = waitForReplies(sdk, groupId, { min: 1 });
    const sent = await sdk.sendPrompt({ agentId: groupId, prompt: speak(topic) });
    if (sent?.accepted === false) {
      throw new Error(`sendPrompt 未被接受: ${JSON.stringify(sent).slice(0, 200)}`);
    }
    const replies = await groupWait;
    console.log(`—— 群聊结束，${replies.length} 条回复 ——`);
    console.log("示例跑完。下次可把话题接在命令后面。");
    process.exitCode = 0;
  } catch (error) {
    console.error("示例失败:", error);
    try {
      for (const [label, id] of [["群", groupId], ["研究员", researcherId], ["写手", writerId]]) {
        if (id) dumpTail(label, await sdk.getAgentTranscriptTail({ id }));
      }
    } catch {
      /* ignore dump errors */
    }
    process.exitCode = 1;
  } finally {
    await new Promise((r) => setTimeout(r, 300));
    shutdown();
  }
}

main().catch((error) => {
  console.error("示例失败:", error);
  process.exit(1);
});
