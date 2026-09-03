import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildGroupTurnPrompt,
  parseGroupMentions,
  resolveResponders,
  stripGroupPassToken,
} from "../../src/host/groups/group-chat.ts";

const researcher = { id: "r", name: "研究员", description: "" };
const writer = { id: "w", name: "写手", description: "" };
const alex = { id: "a", name: "Alex", description: "" };
const alexander = { id: "al", name: "Alexander", description: "" };

describe("parseGroupMentions", () => {
  test("nickname prefixes resolve when unambiguous (玄骨-续实证：@摄影/@灯光)", () => {
    const crew = [
      { id: "m1", name: "导演", description: "" },
      { id: "m2", name: "制片人", description: "" },
      { id: "m3", name: "编剧", description: "" },
      { id: "m4", name: "演员", description: "" },
      { id: "m5", name: "摄影指导", description: "" },
      { id: "m6", name: "灯光师", description: "" },
    ];
    assert.deepEqual(parseGroupMentions("@摄影 直接逐点打点", crew), { isEveryone: false, memberIds: ["m5"] });
    assert.deepEqual(parseGroupMentions("@灯光 锁光位", crew), { isEveryone: false, memberIds: ["m6"] });
    assert.deepEqual(parseGroupMentions("@导演 @摄影 看锚点图", crew), { isEveryone: false, memberIds: ["m1", "m5"] });
    assert.deepEqual(parseGroupMentions("工具到位后 @摄影 @灯光 打点验收。", crew), { isEveryone: false, memberIds: ["m5", "m6"] });
    assert.deepEqual(parseGroupMentions("@摄影指导 全名照常", crew), { isEveryone: false, memberIds: ["m5"] });
  });

  test("ambiguous prefixes stay unresolved rather than guessing", () => {
    const photographers = [
      { id: "p1", name: "摄影指导", description: "" },
      { id: "p2", name: "摄影助理", description: "" },
    ];
    assert.deepEqual(parseGroupMentions("@摄影 谁来", photographers), { isEveryone: false, memberIds: [] });
    assert.deepEqual(parseGroupMentions("@摄影指导 全名无歧义", photographers), { isEveryone: false, memberIds: ["p1"] });
  });

  test("single-char prefixes and latin names keep conservative matching", () => {
    const crew = [
      { id: "m6", name: "灯光师", description: "" },
      { id: "a1", name: "Alexander", description: "" },
    ];
    assert.deepEqual(parseGroupMentions("@灯 开灯", crew), { isEveryone: false, memberIds: [] });
    assert.deepEqual(parseGroupMentions("@alex 来一下", crew), { isEveryone: false, memberIds: [] });
    assert.deepEqual(parseGroupMentions("@Alexander 来一下", crew), { isEveryone: false, memberIds: ["a1"] });
  });

  test("picks a Chinese member and ignores the rest", () => {
    assert.deepEqual(
      parseGroupMentions("@研究员 今晚去哪", [researcher, writer]),
      { isEveryone: false, memberIds: ["r"] },
    );
  });

  test("accepts fullwidth at-sign and a space after it", () => {
    assert.deepEqual(
      parseGroupMentions("＠ 写手 你来写", [researcher, writer]),
      { isEveryone: false, memberIds: ["w"] },
    );
  });

  test("treats 所有人 / 全员 as everyone", () => {
    assert.equal(parseGroupMentions("@所有人 集合", [researcher, writer]).isEveryone, true);
    assert.equal(parseGroupMentions("@全员 看这个", [researcher, writer]).isEveryone, true);
  });

  test("does not treat @allison as @all", () => {
    const mentions = parseGroupMentions("ask @allison", [alex, { id: "x", name: "Allison", description: "" }]);
    assert.equal(mentions.isEveryone, false);
    assert.deepEqual(mentions.memberIds, ["x"]);
  });

  test("longest latin handle wins: @alexander is not alex", () => {
    assert.deepEqual(
      parseGroupMentions("hey @alexander", [alex, alexander]),
      { isEveryone: false, memberIds: ["al"] },
    );
  });
});

describe("resolveResponders", () => {
  test("without @, every member speaks", () => {
    const history = [{ speaker: { kind: "user" as const }, content: "大家好" }];
    assert.deepEqual(
      resolveResponders([researcher, writer], history).map((member) => member.id),
      ["r", "w"],
    );
  });

  test("with @, only the named member speaks", () => {
    const history = [{ speaker: { kind: "user" as const }, content: "@写手 把结论写成两句" }];
    assert.deepEqual(
      resolveResponders([researcher, writer], history).map((member) => member.id),
      ["w"],
    );
  });
});

describe("buildGroupTurnPrompt", () => {
  test("tells an @mentioned member not to pass", () => {
    const prompt = buildGroupTurnPrompt({
      member: writer,
      group: { name: "周末小队", description: "" },
      peers: [researcher],
      newMessages: [{ speaker: { kind: "user" }, content: "@写手 你好" }],
      addressed: true,
    });
    assert.match(prompt, /@mentioned you/);
    assert.match(prompt, /do not pass/);
  });
});

describe("stripGroupPassToken", () => {
  test("strips a parenthesized leading token and keeps the commentary", () => {
    assert.equal(
      stripGroupPassToken("(pass)The answer has already been delivered to the room."),
      "The answer has already been delivered to the room.",
    );
    assert.equal(stripGroupPassToken("(PASS) 已回复过，无需再说"), "已回复过，无需再说");
    assert.equal(stripGroupPassToken("( pass ) — nothing new"), "nothing new");
  });
  test("reduces a bare pass to empty", () => {
    assert.equal(stripGroupPassToken("(pass)"), "");
    assert.equal(stripGroupPassToken("  (pass).  "), "");
  });
  test("never strips a bare leading Pass in a real English answer", () => {
    assert.equal(
      stripGroupPassToken("Pass me the chart and I will mark the levels."),
      "Pass me the chart and I will mark the levels.",
    );
  });
});
