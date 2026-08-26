import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildGroupTurnPrompt,
  parseGroupMentions,
  resolveResponders,
} from "../../source/host/groups/group-chat.ts";

const researcher = { id: "r", name: "研究员", description: "" };
const writer = { id: "w", name: "写手", description: "" };
const alex = { id: "a", name: "Alex", description: "" };
const alexander = { id: "al", name: "Alexander", description: "" };

describe("parseGroupMentions", () => {
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
