import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { mockScriptFromEnv, parseSandMockScript } from "../../src/host/extensions/inference/cursor-session.ts";

describe("parseSandMockScript", () => {
  test("reads { sendMessage } as a SendMessage tool call", () => {
    const script = parseSandMockScript(JSON.stringify({ sendMessage: "hello" }));
    assert.deepEqual(script, {
      toolCalls: [{ toolName: "SendMessage", args: { type: "text", content: "hello" } }],
    });
  });

  test("returns null for a plain string (not JSON)", () => {
    assert.equal(parseSandMockScript("just a reply"), null);
  });
});

describe("mockScriptFromEnv", () => {
  test("plain strings become SendMessage tool calls", () => {
    assert.deepEqual(mockScriptFromEnv("IT02-MOCK-REPLY single agent turn works"), {
      toolCalls: [{
        toolName: "SendMessage",
        args: { type: "text", content: "IT02-MOCK-REPLY single agent turn works" },
      }],
    });
  });

  test("JSON sendMessage scripts are preserved", () => {
    assert.deepEqual(mockScriptFromEnv(JSON.stringify({ sendMessage: "hi" })), {
      toolCalls: [{ toolName: "SendMessage", args: { type: "text", content: "hi" } }],
    });
  });
});
