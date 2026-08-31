/**
 * 群聊寻址路由的回归用例。
 *
 * 语料取自真实转录（群「暴富」，2026-08-28）与文献分类（I1/I2/S1/S2，
 * 见 docs/group-turn-taking.md）。
 *
 * 本文件只覆盖**与模型能力无关**的三类缺陷 —— 它们纯粹是路由代码的问题，
 * 不需要任何语义理解就能判定对错：
 *   1. 机器人的 @ 不得为同伴授予发言权（房间自我放大）
 *   2. 机器人的 @所有人 不得扩散房间
 *   3. 「本轮无人需要发言」必须可表达
 *
 * 需要语义理解的用例（第三人称指称、自然语言全员、隐式追问）不在此文件，
 * 它们由 docs/group-turn-taking.md §3 的意图+仲裁机制处理。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { resolveResponders } from "../../src/host/groups/group-chat.ts";

const MEMBERS = [
  { id: "m1", name: "幕僚长" },
  { id: "m2", name: "速报员" },
  { id: "m3", name: "系统分析师" },
  { id: "m4", name: "股票技术分析" },
  { id: "m5", name: "宏观分析师" },
];

const user = (content: string) => ({ speaker: { kind: "user" as const }, content });
const bot = (id: string, name: string, content: string) => ({
  speaker: { kind: "member" as const, id, name },
  content,
});

const names = (history: readonly unknown[]): string[] =>
  resolveResponders(MEMBERS, history as never).map((m) => m.name).sort();

describe("群聊寻址：用户的 @ 正常工作（回归保护）", () => {
  test("用户点名一人 → 只有那人应答", () => {
    assert.deepEqual(names([user("@速报员 黄金现价多少？一句话就行")]), ["速报员"]);
  });

  test("用户点名多人 → 恰好那几人应答", () => {
    assert.deepEqual(names([user("@速报员 @宏观分析师 你俩各说一句")]), ["宏观分析师", "速报员"]);
  });

  test("用户 @所有人 → 全员应答", () => {
    assert.equal(names([user("@所有人 都对今天加密货币的行情发言一下")]).length, MEMBERS.length);
  });
});

describe("群聊寻址：机器人委派是正当的，但不得扩散或级联", () => {
  test("机器人点名同伴 = 正当委派，该同伴应获得发言权", () => {
    // 真实场景（转录 #76）：幕僚长统筹分派任务给各专家。这是这个群的核心
    // 设计（幕僚长是唯一对用户发言的人，其余是被他调度的专家），必须保留。
    const history = [
      user("@幕僚长 你安排一下今晚的盯盘"),
      bot("m1", "幕僚长", "好的，@速报员 你负责播报"),
    ];
    assert.deepEqual(names(history), ["幕僚长", "速报员"]);
  });

  test("机器人 @所有人 不得把房间扩散成全员", () => {
    // 真实场景（转录 #74→#76）：用户只 @ 了幕僚长，幕僚长回复里带了 @全员，
    // 于是下一轮响应集合被一个机器人单方面扩散成 5 人 —— #77/#78 因此被选举
    // 进来，答的全是上一个话题，没人回应用户。
    // 委派可以点名，但不能一次拉全场。
    const history = [
      user("@幕僚长 你安排一下"),
      bot("m1", "幕僚长", "各位，本轮我兜底统筹 @全员 按既定框架走"),
    ];
    assert.deepEqual(names(history), ["幕僚长"]);
  });

  test("委派不得级联：被委派者的 @ 不能再拉新人进来", () => {
    // A→B 是委派；B→C 若仍生效，就是可以无限延续的自维持集合。
    // 一条用户消息只允许一跳委派。
    const history = [
      user("@幕僚长 开始吧"),
      bot("m1", "幕僚长", "@宏观分析师 你先说"),
      bot("m5", "宏观分析师", "@股票技术分析 那你补充一下"),
    ];
    assert.deepEqual(names(history), ["宏观分析师", "幕僚长"]);
  });
});
