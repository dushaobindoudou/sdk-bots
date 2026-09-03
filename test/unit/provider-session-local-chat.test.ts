/**
 * Regressions in the local (OpenAI-compatible) chat path.
 *
 * Each case here corresponds to a defect observed against a live freeroute
 * backend: a muted bot, a rejected request window, and a paid-for round-trip
 * that could only ever answer "nothing left to do".
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  compactLocalMessages,
  __localChatTestHooks,
} from "../../src/host/extensions/inference/provider-session.ts";

const { isTerminalSendMessageFollowUp, isRetryableLocalChatError, describeError } = __localChatTestHooks;

const user = (content: string) => ({ role: "user", content });
const toolCall = (id: string, toolName: string) => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName, args: {} }],
});
const toolCalls = (ids: readonly string[], toolName = "Shell") => ({
  role: "assistant",
  content: ids.map((id) => ({ type: "tool-call", toolCallId: id, toolName, args: {} })),
});
const toolResult = (id: string) => ({
  role: "tool",
  id,
  content: [{ type: "tool-result", toolCallId: id, result: "ok" }],
});

function orphanedToolMessages(window: readonly { role: string; tool_call_id?: string; tool_calls?: readonly { id: string }[] }[]): string[] {
  const answered = new Set<string>();
  const orphans: string[] = [];
  for (const message of window) {
    if (message.tool_calls != null) for (const call of message.tool_calls) answered.add(call.id);
    if (message.role === "tool" && !answered.has(String(message.tool_call_id))) orphans.push(String(message.tool_call_id));
  }
  return orphans;
}

describe("compactLocalMessages window validity", () => {
  test("a window that starts mid tool-call group carries no orphaned tool message", () => {
    // One assistant step batching two calls yields assistant + 2 tool messages,
    // so the naive 6-back slice lands on a `tool` message whose tool_calls was
    // sliced away. OpenAI-compatible backends reject that with a 400.
    const history = [
      user("q0"),
      toolCalls(["a1", "a2"]), toolResult("a1"), toolResult("a2"),
      toolCalls(["b1", "b2"]), toolResult("b1"), toolResult("b2"),
      toolCalls(["d1"]), toolResult("d1"),
      user("next question"),
    ] as never[];
    const window = compactLocalMessages(history);
    assert.notEqual(window[0]?.role, "tool", "window must not start on a tool message");
    assert.deepEqual(orphanedToolMessages(window), []);
  });

  test("every tool message keeps a matching preceding tool_calls across window shapes", () => {
    for (let pad = 0; pad < 8; pad += 1) {
      const history: unknown[] = [user("q0")];
      for (let i = 0; i < pad; i += 1) history.push(toolCalls([`p${i}`]), toolResult(`p${i}`));
      history.push(toolCalls(["m1", "m2"]), toolResult("m1"), toolResult("m2"));
      history.push(user("next"));
      const window = compactLocalMessages(history as never[]);
      assert.deepEqual(orphanedToolMessages(window), [], `pad=${pad} produced an orphaned tool message`);
    }
  });
});

describe("isTerminalSendMessageFollowUp", () => {
  test("true once a sole SendMessage call has its result: the next round-trip is pure waste", () => {
    const messages = [user("hi"), toolCall("s1", "SendMessage"), toolResult("s1")] as never[];
    assert.equal(isTerminalSendMessageFollowUp(messages), true);
  });

  test("false while the SendMessage result is still in flight", () => {
    assert.equal(isTerminalSendMessageFollowUp([user("hi"), toolCall("s1", "SendMessage")] as never[]), false);
  });

  test("false for a non-SendMessage tool: the model must see the result", () => {
    const messages = [user("hi"), toolCall("t1", "Shell"), toolResult("t1")] as never[];
    assert.equal(isTerminalSendMessageFollowUp(messages), false);
  });

  test("false when SendMessage was batched with real work", () => {
    const step = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "s1", toolName: "SendMessage", args: {} },
        { type: "tool-call", toolCallId: "t1", toolName: "Shell", args: {} },
      ],
    };
    assert.equal(isTerminalSendMessageFollowUp([user("hi"), step, toolResult("s1"), toolResult("t1")] as never[]), false);
  });

  test("false at the start of a fresh turn, even after an earlier turn sent", () => {
    const messages = [
      user("turn 1"), toolCall("s1", "SendMessage"), toolResult("s1"),
      user("turn 2"),
    ] as never[];
    assert.equal(isTerminalSendMessageFollowUp(messages), false);
  });
});

describe("local chat retry classification", () => {
  test("a 5xx from a restarting backend is retryable", () => {
    const error = Object.assign(new Error("local chat 502: bad gateway"), { retryable: true });
    assert.equal(isRetryableLocalChatError(error), true);
  });

  test("a request timeout is retryable", () => {
    assert.equal(isRetryableLocalChatError(Object.assign(new Error("timed out"), { name: "TimeoutError" })), true);
  });

  test("a 4xx is our own bad request and must fail fast", () => {
    assert.equal(isRetryableLocalChatError(new Error("local chat 400: invalid tool message")), false);
  });

  test("a refused connection is retryable", () => {
    assert.equal(isRetryableLocalChatError(new Error("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) })), true);
  });
});

describe("describeError", () => {
  test("unwraps the cause chain that 'fetch failed' hides", () => {
    const error = new Error("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3080"), { code: "ECONNREFUSED" }) });
    const described = describeError(error);
    assert.match(described, /fetch failed/);
    assert.match(described, /ECONNREFUSED 127\.0\.0\.1:3080/);
  });

  test("terminates on a self-referential cause", () => {
    const error = new Error("loop") as Error & { cause?: unknown };
    error.cause = error;
    assert.equal(describeError(error), "loop");
  });
});
