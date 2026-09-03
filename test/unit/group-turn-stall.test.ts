/**
 * 群聊"空转停摆"回归用例（2026-09-02 群「玄骨-续」实证）。
 *
 * 实证链条一（addressed 强唤）：用户 @导演 → 导演交稿并再用预算发"请制片人/编剧把
 * 需求发上来"（无 @ 语法，不触发委派）→ 后续轮次仍只选中导演 → addressed=true +
 * 空房间 + "不许 pass" 三者叠加，逼出"没看到具体诉求"式幻觉，房间停摆。
 *
 * 实证链条二（批次边界吞交接）：导演后来学会了 @ 语法，但 @ 编剧发生在第 3 轮
 * （轮次上限），批次结束、被点名的编剧从未被唤醒——"@编剧 直接交我，我接活"悬空。
 *
 * 本文件锁定四个路由级修复（与模型能力无关）：
 *   1. 已回过话的成员不再被判 addressed（允许 pass，不再强唤）
 *   2. 未被点名的空转回合明确指示 "(pass)"，禁止待命腔
 *   3. 系统提示必须教会 @ 委派语法（有委派机制但没人会用 = 没有委派机制）
 *   4. 批次结束后的接力续场：仍有"被 @ 且未回应"的成员时继续唤醒，直到
 *      链条收尾；总条数上限与 pass 即收场的约束不变
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { GroupChatOrchestrator } from "../../src/host/extensions/transcript/group-chat-orchestrator.ts";
import {
  buildGroupMemberSystemPrompt,
  buildGroupTurnPrompt,
} from "../../src/host/groups/group-chat.ts";

const MEMBERS = [
  { id: "m1", name: "导演", description: "剧组总指挥" },
  { id: "m2", name: "制片人", description: "预算与排期" },
  { id: "m3", name: "编剧", description: "剧本" },
];

const GROUP = { id: "g1", name: "玄骨-续", description: "" };
const ROSTER = MEMBERS.map((m) => m.id);
const user = (content: string) => ({ speaker: { kind: "user" as const }, content });

type HarnessMessage = { speaker: { kind: "user" } | { kind: "member"; id: string; name: string }; content: string };

/** scriptByMember：每个成员一个"回合队列"，队列每项是该回合发出的消息数组。 */
function makeHarness(initialHistory: ReturnType<typeof user>[], scriptByMember: Record<string, string[][]>, roster: typeof MEMBERS = MEMBERS) {
  const history: HarnessMessage[] = [...initialHistory];
  const captured: Array<{ member: { id: string; name: string }; systemPrompt: string; prompt: string }> = [];
  const queues = new Map(Object.entries(scriptByMember).map(([name, queue]) => [name, [...queue]]));
  const deps = {
    resolveMembers: async (ids: readonly string[]) => roster.filter((m) => ids.includes(m.id)),
    readHistory: () => history,
    isCurrent: () => true,
    runMemberTurn: async (args: { member: { id: string; name: string }; systemPrompt: string; prompt: string }) => {
      captured.push(args);
      return queues.get(args.member.name)?.shift() ?? ["(pass)"];
    },
    postMemberMessage: (member: { id: string; name: string }, content: string) => {
      history.push({ speaker: { kind: "member", id: member.id, name: member.name }, content });
    },
    finalizeMemberTurn: () => {},
  };
  return { orchestrator: new GroupChatOrchestrator(deps), history, captured };
}

describe("群聊停摆修复：已回话成员不得被 addressed 状态强唤", () => {
  test("被 @ 成员首次被唤仍是 addressed（回归保护：不许 pass 的规则本身保留）", async () => {
    const { orchestrator, captured } = makeHarness([user("@导演 出分镜")], {});
    await orchestrator.run({ group: GROUP, memberIds: ROSTER });
    const director = captured.find((c) => c.member.name === "导演");
    assert.ok(director);
    assert.match(director.prompt, /do not pass/);
  });

  test("导演交稿后的再唤醒必须降级为可 pass 的非 addressed 提示", async () => {
    const { orchestrator, captured } = makeHarness(
      [user("@导演 出分镜")],
      { 导演: [["分镜好了"]] },
    );
    await orchestrator.run({ group: GROUP, memberIds: ROSTER });
    const directorTurns = captured.filter((c) => c.member.name === "导演");
    assert.ok(directorTurns.length >= 2, "导演至少被唤两次（round-robin 语义不变）");
    assert.match(directorTurns[0]!.prompt, /do not pass/);
    const last = directorTurns.at(-1)!.prompt;
    assert.doesNotMatch(last, /do not pass/);
    assert.match(last, /\(pass\)/);
    assert.match(last, /No new messages in the room since your last turn\./);
  });
});

describe("群聊接力续场：批次边界不得吞掉 @ 交接", () => {
  test("轮次上限处的 @ 交接必须续场唤醒被点名者（玄骨-续 实证场景）", async () => {
    const { orchestrator, captured } = makeHarness(
      [user("@导演 开工")],
      { 导演: [["@编剧 把本集需求发上来"], ["@编剧 稿子定了直接交我，我接活"]], 编剧: [["需求给你了"]] },
    );
    await orchestrator.run({ group: GROUP, memberIds: ROSTER });
    const writerTurns = captured.filter((c) => c.member.name === "编剧");
    assert.ok(writerTurns.length >= 2, `编剧必须被续场唤醒，实际 ${writerTurns.length} 次`);
    const lastWriterPrompt = writerTurns.at(-1)!.prompt;
    assert.match(lastWriterPrompt, /稿子定了直接交我/);
  });

  test("待回应成员 pass 后立即收场，不空转", async () => {
    const { orchestrator, captured } = makeHarness(
      [user("@导演 开工")],
      { 导演: [["@编剧 给我需求"], ["@编剧 稿子定了直接交我"]], 编剧: [["需求给你了"]] },
    );
    await orchestrator.run({ group: GROUP, memberIds: ROSTER });
    // 3 轮标准轮询 + 续场唤醒编剧（pass）+ 收尾回合各一次（pass）→ 收场
    assert.equal(captured.filter((c) => c.member.name === "导演").length, 4);
    assert.equal(captured.filter((c) => c.member.name === "编剧").length, 4);
  });

  test("续场链条在无待回应 @ 时自然终止", async () => {
    const { orchestrator, captured } = makeHarness(
      [user("@导演 开工")],
      { 导演: [["@编剧 给我需求"], ["@编剧 稿子定了直接交我"]], 编剧: [["需求给你了"], ["稿子来了，请查收"]] },
    );
    await orchestrator.run({ group: GROUP, memberIds: ROSTER });
    const writerTurns = captured.filter((c) => c.member.name === "编剧");
    assert.equal(writerTurns.length, 3);
    assert.ok(captured.length <= 7);
  });

  test("昵称缩写 @摄影 也能委派并续场唤醒摄影指导", async () => {
    const crew = [
      { id: "m1", name: "导演", description: "总指挥" },
      { id: "m2", name: "编剧", description: "剧本" },
      { id: "m5", name: "摄影指导", description: "机位" },
    ];
    const { orchestrator, captured } = makeHarness(
      [user("@导演 出锚点图")],
      { 导演: [["@摄影 机位锚点我甩给你"]], 摄影指导: [["收到，开始打点"]] },
      crew,
    );
    await orchestrator.run({ group: GROUP, memberIds: crew.map((m) => m.id) });
    const dpTurns = captured.filter((c) => c.member.name === "摄影指导");
    assert.ok(dpTurns.length >= 1, `缩写 @摄影 必须唤醒摄影指导，实际 ${dpTurns.length} 次`);
    assert.match(dpTurns[0]!.prompt, /机位锚点我甩给你/);
  });

  test("收尾回合：口头承诺未兑现的成员被要求执行或转派（玄骨-续 实证：导演只 @ 不回活）", async () => {
    const crew = [
      { id: "m1", name: "导演", description: "总指挥" },
      { id: "m2", name: "摄影指导", description: "机位" },
    ];
    const { orchestrator, captured } = makeHarness(
      [user("@导演 出锚点图")],
      { 导演: [["@摄影指导 图我认领，马上重出"], ["@摄影指导 完成"]], 摄影指导: [["收到"]] },
      crew,
    );
    await orchestrator.run({ group: GROUP, memberIds: crew.map((m) => m.id) });
    const directorTurns = captured.filter((c) => c.member.name === "导演");
    const lastDirector = directorTurns.at(-1)!;
    // 最后一次唤醒应是收尾回合（含 closing 检查），且导演被要求在 pass 之前先执行或转派
    assert.match(lastDirector.prompt, /closing check/);
    assert.match(lastDirector.prompt, /\(pass\)/);
    assert.doesNotMatch(lastDirector.prompt, /do not pass/);
  });
});

describe("群聊停摆修复：提示词层面教会 @ 委派与反待命", () => {
  test("系统提示必须包含 @ 委派语法说明", () => {
    const prompt = buildGroupMemberSystemPrompt(MEMBERS[0]!, GROUP, MEMBERS.slice(1));
    assert.match(prompt, /@-mention their name/);
    assert.match(prompt, /delegates the next room turn/);
    assert.match(prompt, /wakes nobody/);
  });

  test("非 addressed 回合必须包含反待命指令", () => {
    const prompt = buildGroupTurnPrompt({
      member: MEMBERS[0]!,
      group: GROUP,
      peers: MEMBERS.slice(1),
      newMessages: [],
      addressed: false,
    });
    assert.match(prompt, /never send standby or status notes/);
    assert.match(prompt, /No new messages in the room since your last turn\./);
  });

  test("addressed 回合保持原有强回复语义（回归保护）", () => {
    const prompt = buildGroupTurnPrompt({
      member: MEMBERS[0]!,
      group: GROUP,
      peers: MEMBERS.slice(1),
      newMessages: [user("开工")],
      addressed: true,
    });
    assert.match(prompt, /do not pass/);
  });
});
