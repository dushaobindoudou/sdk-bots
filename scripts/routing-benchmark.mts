/**
 * 判据实验：群聊寻址是「模型能力问题」还是「代码逻辑问题」？
 *
 * 当前代码 (resolveResponders) 是纯正则，从不询问模型。
 * 本实验对同一批真实消息，比较：
 *   code      —— 现状（正则）
 *   router-v1 —— 朴素提问「谁该回应？」
 *   router-v2 —— 带 addressed/mentioned 语义区分的提问
 * 全部对齐到人工标注的作者真实意图。
 */
import { resolveResponders } from "../src/host/groups/group-chat.js";

const BASE = process.env.SAND_OPENROUTER_BASE_URL ?? "http://127.0.0.1:3080/freeroute/v1";
const MODEL = process.env.SAND_OPENROUTER_MODEL ?? "auto";

const MEMBERS = [
  { id: "m1", name: "幕僚长",       desc: "唯一能跟用户沟通的员工，代表用户意志（当天刚加入）" },
  { id: "m2", name: "速报员",       desc: "获取最新信息，及时同步" },
  { id: "m3", name: "系统分析师",   desc: "分析系统故障" },
  { id: "m4", name: "股票技术分析", desc: "分析当前技术行情" },
  { id: "m5", name: "宏观分析师",   desc: "金融宏观分析" },
];
const ALL = MEMBERS.map((m) => m.name);
const N = (names: string[]) => [...names].sort().join(",");

interface Case { id: string; ctx?: string[]; msg: string; gt: string[]; note: string }

// gt = 作者真实意图（人工标注）。ctx = 该消息之前的房间上下文。
const CASES: Case[] = [
  // ---------- 真实转录（27 条，去重后 24 条） ----------
  { id: "r04", msg: "最近 宇树科技好像挺火的，你们怎么看？", gt: ALL, note: "「你们」= 全员" },
  { id: "r05", msg: "@股票技术分析 你来说说看", gt: ["股票技术分析"], note: "I1 直接寻址" },
  { id: "r10", msg: "@股票技术分析 你获取一下 NVDA 最新的股票", gt: ["股票技术分析"], note: "I1" },
  { id: "r11", msg: "@系统分析师 系统好像失效了", gt: ["系统分析师"], note: "I1" },
  { id: "r12", msg: "@股票技术分析 用两句话说说你怎么看待止损", gt: ["股票技术分析"], note: "I1" },
  { id: "r13", msg: "@速报员 简短报一下今天你值班就行", gt: ["速报员"], note: "I1" },
  { id: "r18", msg: "为啥超时了？ @系统分析师", gt: ["系统分析师"], note: "I1，@ 在句尾" },
  { id: "r22", msg: "头脑风暴一下，如何在 AI 时代能脱颖而出，都要发言", gt: ALL, note: "自然语言全员：「都要发言」" },
  { id: "r24", msg: "@速报员 现在重新获取 NVDA 最新股价，简短报出来", gt: ["速报员"], note: "I1" },
  { id: "r29", msg: "@宏观分析师 搜一下今天美股大盘情况，一段话总结", gt: ["宏观分析师"], note: "I1" },
  { id: "r38", msg: "@速报员 搜一下英伟达最新市值，一句话", gt: ["速报员"], note: "I1" },
  { id: "r41", msg: "@速报员 报个到就行", gt: ["速报员"], note: "I1" },
  { id: "r44", msg: "@速报员 调用 echo 工具回显这句话：本地MCP打通了，然后把 echo 返回的原文发到群里", gt: ["速报员"], note: "I1" },
  { id: "r46", msg: "@速报员 用中文一句话说明今天星期几，先用 SendMessage 发出去，然后结束", gt: ["速报员"], note: "I1" },
  { id: "r49", msg: "@速报员 今天的日期？一句话", gt: ["速报员"], note: "I1" },
  { id: "r50", msg: "@速报员 查一下苹果最新市值占标普500的比重，给出完整分析", gt: ["速报员"], note: "I1" },
  { id: "r51", msg: "@速报员 黄金现价多少？一句话就行", gt: ["速报员"], note: "I1" },
  { id: "r55", msg: "@速报员 找找关于加密货币的最新消息", gt: ["速报员"], note: "I1" },
  {
    id: "r56", msg: "没有任何消息？", gt: ["速报员"], note: "★ 隐式追问：承接上一条对速报员的提问",
    ctx: ["用户: @速报员 找找关于加密货币的最新消息", "速报员: （未能给出有效结果）"],
  },
  { id: "r57", msg: "@速报员 今天有没有加密最新动态", gt: ["速报员"], note: "I1" },
  { id: "r60", msg: "@所有人 都对今天加密货币的行情发言一下，如果需要提供帮助的话直接说", gt: ALL, note: "显式 @所有人" },
  { id: "r71", msg: "@速报员 的风格非常好，最好直接把图展示出来就更好了， 但是我不知道你生成这个图的意图是什么？", gt: ["速报员"], note: "@X 开头但确实在问 X" },
  {
    id: "r74", msg: "大家有什么需要都说一下，需要支持直接找 @幕僚长 ，他有我所有权限，如果大家都收到了就回复一下，欢迎一下我们的新伙伴",
    gt: ALL, note: "★ 自然语言全员 + 对幕僚长的第三人称指称（S2）",
    ctx: ["（幕僚长为当天新加入的成员）"],
  },

  // ---------- 合成边界用例（探测 I1/I2/S1/S2 分类） ----------
  {
    id: "s01", msg: "@宏观分析师 的分析很好，其他人怎么看？", gt: ALL.filter((n) => n !== "宏观分析师"),
    note: "★ S2 反转：@X 是被表扬对象，「其他人」才是被问的",
  },
  {
    id: "s02", msg: "刚才 @速报员 说的数据我记下来了，谢谢大家", gt: [],
    note: "★ 纯致谢，无提问 —— 无人需要发言",
  },
  { id: "s03", msg: "@速报员 @宏观分析师 你俩各说一句", gt: ["速报员", "宏观分析师"], note: "多人显式寻址" },
  {
    id: "s04", msg: "这个数字对吗？", gt: ["速报员"], note: "I2 隐式追问",
    ctx: ["速报员: BTC 现价约 $79,800，日内 +1.2%"],
  },
];

function currentCode(c: Case): string[] {
  const history = [
    ...(c.ctx ?? []).map((line) => ({ speaker: { kind: "member", id: "x", name: "ctx" }, content: line })),
    { speaker: { kind: "user" as const }, content: c.msg },
  ];
  return resolveResponders(MEMBERS, history as never).map((m) => m.name);
}

const ROSTER = MEMBERS.map((m) => `- ${m.name}：${m.desc}`).join("\n");

const PROMPT_V1 = (c: Case) => `群成员名单：
${ROSTER}
${c.ctx?.length ? `\n之前的房间消息：\n${c.ctx.join("\n")}` : ""}

用户刚发了这条消息：
"""${c.msg}"""

谁应该回应这条消息？只输出 JSON：{"responders":["名字",...]}。无人需要回应则输出空数组。`;

const PROMPT_V2 = (c: Case) => `你是群聊的发言调度器。判断用户这条消息**在对谁说话**。

群成员名单：
${ROSTER}
${c.ctx?.length ? `\n之前的房间消息：\n${c.ctx.join("\n")}` : ""}

用户刚发了这条消息：
"""${c.msg}"""

判断要点：
- 「被谈论」不等于「被对话」。有人被 @ 或被提到名字，可能只是被介绍、被表扬、被转述——这种情况他**不因此获得发言权**，真正被问的是别人。
- 寻址可以完全不带 @。中文里「大家」「你们」「都说说」「各位」同样是在对全体说话。
- 承接上文的追问（没有主语）通常是在问上一个发言的人。
- 纯粹的告知、致谢、确认，可能不需要任何人回应。

只输出 JSON：{"responders":["名字",...]}。无人需要回应则输出空数组。`;

async function ask(prompt: string): Promise<string[] | null> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) { if (attempt === 3) return null; await new Promise((r) => setTimeout(r, 800 * attempt)); continue; }
      const text = (await res.json())?.choices?.[0]?.message?.content ?? "";
      const m = String(text).match(/\{[\s\S]*?"responders"[\s\S]*?\}/);
      if (!m) { if (attempt === 3) return null; continue; }
      const parsed = JSON.parse(m[0]).responders;
      if (!Array.isArray(parsed)) return null;
      return parsed.map(String).filter((n) => ALL.includes(n));
    } catch { if (attempt === 3) return null; await new Promise((r) => setTimeout(r, 800 * attempt)); }
  }
  return null;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]!); }
  }));
  return out;
}

const REPEATS = Number(process.env.REPEATS ?? 3);

async function main() {
  console.log(`模型: ${MODEL} @ ${BASE}   用例: ${CASES.length}   每例重复: ${REPEATS}\n`);

  const jobs = CASES.flatMap((c) =>
    [1, 2].flatMap((v) => Array.from({ length: REPEATS }, (_, r) => ({ c, v, r }))));
  const results = await pool(jobs, 5, async (j) => ({
    ...j, got: await ask(j.v === 1 ? PROMPT_V1(j.c) : PROMPT_V2(j.c)),
  }));

  const score = { code: 0, v1: 0, v2: 0 };
  const rows: string[] = [];
  for (const c of CASES) {
    const code = currentCode(c);
    const codeOk = N(code) === N(c.gt);
    if (codeOk) score.code += 1;

    const vote = (v: number) => {
      const runs = results.filter((r) => r.c.id === c.id && r.v === v);
      const ok = runs.filter((r) => r.got != null && N(r.got) === N(c.gt)).length;
      return { ok, total: runs.length, sample: runs.find((r) => r.got != null)?.got ?? null };
    };
    const a = vote(1), b = vote(2);
    score.v1 += a.ok / Math.max(1, a.total);
    score.v2 += b.ok / Math.max(1, b.total);

    const star = c.note.startsWith("★") ? "★" : " ";
    rows.push(
      `${star}${c.id}  code:${codeOk ? "✓" : "✗"}  v1:${a.ok}/${a.total}  v2:${b.ok}/${b.total}` +
      `\n     期望 ${N(c.gt) || "(无人)"}` +
      `\n     code ${N(code) || "(无人)"}${codeOk ? "" : "   ← 错"}` +
      `\n     v2   ${b.sample ? N(b.sample) : "(解析失败)"}` +
      `\n     ${c.note}`);
  }

  console.log(rows.join("\n\n"));
  const n = CASES.length;
  console.log(`\n${"=".repeat(64)}`);
  console.log(`总体准确率（${n} 例）`);
  console.log(`  现状代码 (正则)      ${(score.code / n * 100).toFixed(1)}%   ${score.code}/${n}`);
  console.log(`  模型 v1 (朴素提问)   ${(score.v1 / n * 100).toFixed(1)}%`);
  console.log(`  模型 v2 (语义区分)   ${(score.v2 / n * 100).toFixed(1)}%`);

  const hard = CASES.filter((c) => c.note.startsWith("★"));
  const hardCode = hard.filter((c) => N(currentCode(c)) === N(c.gt)).length;
  const hardV2 = hard.reduce((s, c) => {
    const runs = results.filter((r) => r.c.id === c.id && r.v === 2);
    return s + runs.filter((r) => r.got != null && N(r.got) === N(c.gt)).length / Math.max(1, runs.length);
  }, 0);
  console.log(`\n困难用例（★ ${hard.length} 例：S2 / 隐式寻址 / 自然语言全员）`);
  console.log(`  现状代码   ${(hardCode / hard.length * 100).toFixed(1)}%`);
  console.log(`  模型 v2    ${(hardV2 / hard.length * 100).toFixed(1)}%`);

  const easy = CASES.filter((c) => !c.note.startsWith("★"));
  const easyV2 = easy.reduce((s, c) => {
    const runs = results.filter((r) => r.c.id === c.id && r.v === 2);
    return s + runs.filter((r) => r.got != null && N(r.got) === N(c.gt)).length / Math.max(1, runs.length);
  }, 0);
  console.log(`\n简单用例（${easy.length} 例，回归保护 —— 模型不得在这里退步）`);
  console.log(`  现状代码   ${(easy.filter((c) => N(currentCode(c)) === N(c.gt)).length / easy.length * 100).toFixed(1)}%`);
  console.log(`  模型 v2    ${(easyV2 / easy.length * 100).toFixed(1)}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });
