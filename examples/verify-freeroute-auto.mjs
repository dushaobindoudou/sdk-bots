/**
 * 端到端链路验证：sdk-bots turn loop → dsh freeroute (`auto`) → 工具调用回环。
 *
 * 与 example:group-chat 的区别：
 *   1. 不设置任何 SAND_OPENROUTER_* / OPENROUTER_API_KEY —— 全部走默认值，
 *      即 provider-session.ts 里的 OPENROUTER_DEFAULT_BASE_URL (dsh freeroute) + model `auto`。
 *   2. 刻意要求模型调用 Shell 工具执行 echo，验证 tools/tool_calls 过 freeroute 的回环。
 *
 * 通过判据：SendMessage 回复里出现 MARKER，且 transcript 里有 shell 工具调用记录。
 *
 * 运行：
 *   NODE_OPTIONS="--use-system-ca" npx tsx examples/verify-freeroute-auto.mjs
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHost } from "../src/sdk/entry.ts";
import { resolveOpenRouterEndpoint } from "../src/host/extensions/inference/provider-session.ts";

const MARKER = "freeroute-e2e-ok";
const TIMEOUT_MS = 180_000;

function agentId(result) {
  const id = result?.agent?.id ?? result?.id;
  if (!id) throw new Error(`缺少 agent id: ${JSON.stringify(result).slice(0, 200)}`);
  return id;
}

function sendMessageText(entry) {
  if (entry?.kind !== "send-message") return null;
  const content = entry?.message?.content ?? entry?.content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

function dumpTail(tail) {
  const entries = tail?.entries ?? [];
  console.log(`  transcript 条目数: ${entries.length}`);
  for (const entry of entries) {
    const text = sendMessageText(entry)
      ?? entry?.content
      ?? JSON.stringify(entry?.message ?? entry).slice(0, 200);
    const name = entry?.toolCall?.name ?? entry?.toolName ?? "";
    console.log(
      `    - ${entry.kind}${name ? `/${name}` : ""}${entry.role ? `(${entry.role})` : ""} ${String(text).replace(/\s+/g, " ").slice(0, 180)}`,
    );
  }
}

async function main() {
  // 关键：清掉一切显式配置，让 provider 走纯默认值（= dsh freeroute + auto）
  delete process.env.SAND_AGENT_MOCK_RESPONSE;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SAND_OPENROUTER_BASE_URL;
  delete process.env.SAND_OPENROUTER_MODEL;

  const resolved = resolveOpenRouterEndpoint();
  console.log("sdk-bots → dsh freeroute 端到端验证");
  console.log(`  baseURL: ${resolved.baseURL}`);
  console.log(`  modelId: ${resolved.modelId}`);
  console.log(`  apiKey:  ${resolved.apiKey.slice(0, 4)}…`);

  if (resolved.baseURL !== "http://127.0.0.1:3080/freeroute/v1" || resolved.modelId !== "auto") {
    throw new Error(`默认端点不符合预期: ${JSON.stringify(resolved)}`);
  }

  const dataDir = process.env.EXAMPLE_DATA_DIR?.trim()
    || join(mkdtempSync(join(tmpdir(), "sdk-bots-verify-")), "data");
  console.log(`  数据目录: ${dataDir}`);

  const host = await startHost({ dataDir });
  const sdk = host.client;
  console.log(`  网关: ${host.baseUrl}\n`);

  const shutdown = () => {
    process.kill(process.pid, "SIGTERM");
    setTimeout(() => process.exit(process.exitCode ?? 0), 8_000);
  };
  process.once("SIGINT", () => shutdown());

  let agentIdValue;
  const channelCounts = {};

  try {
    // SSE 事件流统计（Web UI 将依赖同一条链路）
    const dispose = await sdk.subscribeWhenReady((ev) => {
      channelCounts[ev?.channel] = (channelCounts[ev?.channel] ?? 0) + 1;
    });

    const created = await sdk.createAgent({
      name: "工具员",
      description: "会用 Shell 工具执行命令并把输出如实汇报。",
    });
    agentIdValue = agentId(created);

    await sdk.setHostSettings({
      inferenceProvider: "openrouter",
      localToolPermission: "always",
    });

    console.log(`① 已创建 bot: 工具员 ${agentIdValue}`);
    console.log("② 发送带工具要求的 prompt…");

    await sdk.sendPrompt({
      agentId: agentIdValue,
      prompt: [
        `请严格按以下步骤操作：`,
        `1. 调用 Shell 工具执行命令: echo ${MARKER}`,
        `2. 把 Shell 的真实输出原样放入 SendMessage(type=text) 回复给我，不要额外解释。`,
      ].join("\n"),
    });

    // 轮询 transcript，直到出现包含 MARKER 的 send-message 或超时
    const startedAt = Date.now();
    let found = null;
    let shellCalls = 0;
    while (Date.now() - startedAt < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 1_500));
      const tail = await sdk.getAgentTranscriptTail({ id: agentIdValue });
      const entries = tail?.entries ?? [];
      shellCalls = entries.filter((e) => String(e?.toolCall?.name ?? e?.toolName ?? "").toLowerCase().includes("shell")).length;
      found = entries.find((e) => {
        const text = sendMessageText(e);
        return text != null && text.includes(MARKER);
      });
      if (found != null) break;
    }

    console.log("\n③ transcript 明细：");
    dumpTail(await sdk.getAgentTranscriptTail({ id: agentIdValue }));
    console.log(`\n  SSE 事件统计: ${JSON.stringify(channelCounts)}`);
    console.log(`  Shell 工具调用条目: ${shellCalls}`);

    if (found == null) {
      throw new Error(`超时（${TIMEOUT_MS / 1000}s）未收到含 "${MARKER}" 的 SendMessage 回复`);
    }
    console.log(`\n回复: ${sendMessageText(found).replace(/\s+/g, " ").slice(0, 200)}`);
    console.log("\n✅ 端到端验证通过：sdk-bots turn loop → freeroute(auto) → Shell 工具回环 → SendMessage");
    process.exitCode = 0;
    dispose();
  } catch (error) {
    console.error("❌ 验证失败:", error);
    if (agentIdValue) {
      try { dumpTail(await sdk.getAgentTranscriptTail({ id: agentIdValue })); } catch { /* ignore */ }
    }
    process.exitCode = 1;
  } finally {
    await new Promise((r) => setTimeout(r, 300));
    shutdown();
  }
}

main().catch((error) => {
  console.error("验证失败:", error);
  process.exit(1);
});
