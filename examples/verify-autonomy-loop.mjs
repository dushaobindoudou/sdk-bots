/**
 * 自主能力端到端验证：多 bot 蜂群无需人工干预的自驱闭环。
 *
 * 验证目标（对应 7x24 多 bot 协作能力）：
 *   A1 自主创建 bot —— coordinator 用 CreateAgent 工具创建「工兵」
 *   A2 自主优化 bot —— coordinator 用 UpdateAgent 工具修改「工兵」的 description
 *   A3 自主排程     —— coordinator 用 update_state 工具给自己创建 cron 例行任务
 *   A4 例行任务唤醒 —— runAgentAutomationNow 强制触发后，bot 无人类消息即醒来干活
 *   A5 天然自驱循环 —— 本地 cron 调度器自动触发例行任务（真正的 7x24 心跳）
 *   A6 跨 bot 协作   —— SendToAgent 把任务派给「工兵」，工兵 transcript 收到消息
 *
 * 全程使用真实推理（dsh freeroute auto），与 verify-freeroute-auto.mjs 同一链路。
 *
 * 运行：
 *   NODE_OPTIONS="--use-system-ca" npx tsx examples/verify-autonomy-loop.mjs
 *
 * 可选环境变量：
 *   AUTONOMY_TIMEOUT_MS   每阶段超时（默认 300000）
 *   SAND_OPENROUTER_MODEL 钉定模型（默认 auto；模型不稳时可钉 deepseek-v4-flash）
 */

import { mkdtempSync, readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHost } from "../src/sdk/entry.ts";
import { resolveOpenRouterEndpoint } from "../src/host/extensions/inference/provider-session.ts";

const TIMEOUT_MS = Number(process.env.AUTONOMY_TIMEOUT_MS ?? 300_000);
const HELPER_NAME = "工兵";
const HELPER_DESC_MARK = "SWARM-HELPER-v1";
const HELPER_OPT_MARK = "[OPTIMIZED-r1]";
const ROUTINE_NAME = "AUTO-HEARTBEAT";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textOf(entry) {
  if (entry?.kind === "send-message") {
    const c = entry?.message?.content ?? entry?.content;
    return typeof c === "string" ? c : null;
  }
  if (entry?.kind === "message") {
    const c = entry?.message?.content ?? entry?.content;
    return typeof c === "string" ? c : null;
  }
  return null;
}

function dumpTail(tail, limit = 14) {
  const entries = tail?.entries ?? [];
  console.log(`  transcript 条目数: ${entries.length}`);
  for (const entry of entries.slice(-limit)) {
    const text = textOf(entry) ?? JSON.stringify(entry?.message ?? entry?.toolCall ?? entry).slice(0, 160);
    const name = entry?.toolCall?.name ?? entry?.toolName ?? "";
    console.log(`    - ${entry.kind}${name ? `/${name}` : ""}${entry.role ? `(${entry.role})` : ""} ${String(text).replace(/\s+/g, " ").slice(0, 170)}`);
  }
}

function findHeartbeats(root, acc = []) {
  let items;
  try { items = readdirSync(root); } catch { return acc; }
  for (const name of items) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(root, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) findHeartbeats(p, acc);
    else if (name === "heartbeat.log") {
      try { acc.push({ path: p, lines: readFileSync(p, "utf8").split("\n").filter((l) => l.includes("BEAT")) }); } catch { /* ignore */ }
    }
  }
  return acc;
}

function beatCount(dataDir) {
  return findHeartbeats(dataDir).reduce((n, f) => n + f.lines.length, 0);
}

async function main() {
  delete process.env.SAND_AGENT_MOCK_RESPONSE;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SAND_OPENROUTER_BASE_URL;
  if (!process.env.SAND_OPENROUTER_MODEL) delete process.env.SAND_OPENROUTER_MODEL;

  const resolved = resolveOpenRouterEndpoint();
  console.log("多 bot 自主能力端到端验证（freeroute 真实推理）");
  console.log(`  baseURL: ${resolved.baseURL}  modelId: ${resolved.modelId}`);

  const dataDir = process.env.EXAMPLE_DATA_DIR?.trim()
    || join(mkdtempSync(join(tmpdir(), "sdk-bots-autonomy-")), "data");
  console.log(`  数据目录: ${dataDir}\n`);

  const host = await startHost({ dataDir });
  const sdk = host.client;
  const gw = host.baseUrl.replace(/\/$/, "");
  console.log(`  网关: ${gw}\n`);

  const shutdown = () => {
    process.kill(process.pid, "SIGTERM");
    setTimeout(() => process.exit(process.exitCode ?? 0), 8_000);
  };
  process.once("SIGINT", () => shutdown());

  const results = {}; // A1..A6
  let coordinatorId, helperId;
  try {
    await sdk.setHostSettings({ inferenceProvider: "openrouter", localToolPermission: "always" });

    const created = await sdk.createAgent({
      name: "蜂群指挥部",
      description: "多 bot 蜂群的长官：负责创建与优化队友 bot、给队友派活、给自己排例行任务。严格执行工具序列，从不向用户提问。",
    });
    coordinatorId = created?.agent?.id ?? created?.id;
    console.log(`① coordinator: 蜂群指挥部 ${coordinatorId}`);

    // —— 主任务：一次性下发四步工具序列 ——
    const prompt = [
      "你是多 bot 蜂群的长官。现在执行编队任务，严格用工具依次完成以下 5 步，不要向用户提问：",
      `第1步：调用 CreateAgent 工具创建助手 bot：name=${HELPER_NAME}，description 里必须包含字样 ${HELPER_DESC_MARK}。`,
      `第2步：调用 UpdateAgent 工具修改第1步创建的 bot：把它的 description 末尾追加字样 ${HELPER_OPT_MARK}（原描述保留）。`,
      `第3步：调用 update_state 工具（target 取 routine，action 取 create）给自己创建一个例行任务：name=${ROUTINE_NAME}，schedule=@every 1m，prompt 为：用 Shell 工具执行 echo "BEAT $(date +%H:%M:%S)" >> heartbeat.log ，做完后不发任何消息直接结束。`,
      `第4步：调用 SendToAgent 工具向第1步创建的 bot（用它的 id）发消息：要求它用 Shell 工具执行 echo HELPER-ALIVE > helper-ready.txt 完成编队报到。`,
      "第5步：调用 SendMessage 向用户汇报：新 bot 的 id、例行任务的 id、以及每一步工具返回的真实摘要。",
    ].join("\n");
    await sdk.sendPrompt({ agentId: coordinatorId, prompt });
    console.log("② 主任务已下发（创建bot→优化bot→自排程→派活→汇报），等待执行…");

    // —— 轮询：等 coordinator 完成全部步骤（helper 出现 + routine 出现）——
    const startedAt = Date.now();
    let helper = null, routine = null, reportSeen = false;
    while (Date.now() - startedAt < TIMEOUT_MS) {
      await sleep(5_000);
      const tail = await sdk.getAgentTranscriptTail({ id: coordinatorId });
      const entries = tail?.entries ?? [];
      if (!reportSeen && entries.some((e) => textOf(e)?.includes("新 bot"))) reportSeen = true;

      const agents = normalizeAgents(await gateway(gw, "listAgents"));
      helper = agents.find((a) => a?.name === HELPER_NAME);

      const autos = await gateway(gw, "getAgentAutomations", { id: coordinatorId });
      const list = Array.isArray(autos) ? autos : autos?.automations ?? autos?.result ?? [];
      routine = list.find((a) => a?.name === ROUTINE_NAME);

      if (helper && routine && reportSeen) break;
    }

    if (helper) {
      results.A1 = { pass: String(helper?.description ?? "").includes(HELPER_DESC_MARK), detail: `helper id=${helper.id}` };
      helperId = helper.id;
      results.A2 = { pass: String(helper?.description ?? "").includes(HELPER_OPT_MARK), detail: String(helper?.description ?? "").slice(0, 120) };
    }
    if (routine) {
      results.A3 = { pass: true, detail: `routine id=${routine.id} trigger=${JSON.stringify(routine.trigger ?? routine.schedule ?? {}).slice(0, 80)}` };
    }
    console.log(`\n③ coordinator transcript：`);
    dumpTail(await sdk.getAgentTranscriptTail({ id: coordinatorId }));

    // —— A4：强制触发例行任务（无人值守唤醒的确定性证据）——
    if (routine) {
      const beatsBefore = beatCount(dataDir);
      console.log(`\n④ 强制触发例行任务（runAgentAutomationNow），此前 BEAT 行数: ${beatsBefore}`);
      await gateway(gw, "runAgentAutomationNow", { id: coordinatorId, automationId: routine.id });
      const fireDeadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < fireDeadline) {
        await sleep(5_000);
        if (beatCount(dataDir) > beatsBefore) break;
      }
      const beatsAfter = beatCount(dataDir);
      results.A4 = { pass: beatsAfter > beatsBefore, detail: `BEAT 行数 ${beatsBefore} → ${beatsAfter}` };
      if (!results.A4.pass) dumpTail(await sdk.getAgentTranscriptTail({ id: coordinatorId }), 20);
    }

    // —— A5：等天然 cron 触发（本地调度器 30s tick + @every 1m）——
    if (routine) {
      const forced = beatCount(dataDir);
      console.log(`\n⑤ 等待天然 cron 触发（最长 4 分钟）…`);
      const cronDeadline = Date.now() + 240_000;
      while (Date.now() < cronDeadline) {
        await sleep(10_000);
        if (beatCount(dataDir) > forced) break;
      }
      const total = beatCount(dataDir);
      results.A5 = { pass: total > forced, detail: `BEAT 总行数 ${total}（天然触发新增 ${total - forced}）` };
    }

    // —— A6：跨 bot 协作（工兵收到派活）——
    if (helperId) {
      const helperTail = await sdk.getAgentTranscriptTail({ id: helperId });
      const entries = helperTail?.entries ?? [];
      const gotTask = entries.some((e) => {
        const t = textOf(e);
        return t != null && (t.includes("编队报到") || t.includes("helper-ready"));
      });
      results.A6 = { pass: gotTask, detail: `工兵 transcript 条目 ${entries.length}${gotTask ? "，含派活消息" : ""}` };
      if (gotTask) {
        console.log(`\n⑥ 工兵 transcript：`);
        dumpTail(helperTail, 10);
      }
    }

    // —— 汇总 ——
    console.log("\n════ 验证结果 ════");
    const labels = {
      A1: "A1 自主创建 bot（CreateAgent）",
      A2: "A2 自主优化 bot（UpdateAgent）",
      A3: "A3 自主排程（update_state 例行任务）",
      A4: "A4 例行任务无人唤醒（runAgentAutomationNow → BEAT）",
      A5: "A5 天然自驱循环（本地 cron → BEAT）",
      A6: "A6 跨 bot 协作（SendToAgent 派活送达）",
    };
    let allPass = true;
    for (const k of Object.keys(labels)) {
      const r = results[k];
      const pass = r?.pass === true;
      if (!pass) allPass = false;
      console.log(`  ${pass ? "✅" : "❌"} ${labels[k]}${r ? ` — ${r.detail}` : " — 未执行（前置步骤缺失）"}`);
    }
    console.log(allPass ? "\n✅ 自主能力全链路验证通过：创建 bot / 优化 bot / 自排程 / 无人唤醒 / 自驱循环 / 跨 bot 协作" : "\n🔶 部分能力未通过，见上方明细");
    process.exitCode = allPass ? 0 : 1;
  } catch (error) {
    console.error("❌ 验证失败:", error);
    for (const id of [coordinatorId, helperId].filter(Boolean)) {
      try { console.error(`--- transcript ${id} ---`); dumpTail(await sdk.getAgentTranscriptTail({ id }), 20); } catch { /* ignore */ }
    }
    process.exitCode = 1;
  } finally {
    await sleep(300);
    shutdown();
  }
}

function normalizeAgents(raw) {
  if (Array.isArray(raw)) return raw;
  return raw?.agents ?? [];
}

async function gateway(base, method, body) {
  const res = await fetch(`${base}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.error)) {
    throw new Error(`gateway ${method} failed: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json && typeof json === "object" && "result" in json ? json.result : json;
}

main().catch((error) => {
  console.error("验证失败:", error);
  process.exit(1);
});
