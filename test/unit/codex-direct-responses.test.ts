/**
 * Unit tests for the direct Codex Responses transport
 * (source/host/extensions/inference/codex-direct-responses.ts).
 *
 * Migrated from the original repo's tests/codex-direct-responses.test.mjs;
 * the esbuild transform loader is replaced by a direct tsx import.
 *
 * Covers: plain text streaming without an SDK reader, tool execution with the
 * exact call id threaded into the follow-up request, and fail-closed behavior
 * on a truncated SSE stream.
 *
 * Run:  npm run test:unit
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { streamCodexDirectResponses } from "../../source/host/extensions/inference/codex-direct-responses.ts";

function sse(events: unknown[], split = 17): Response {
  const bytes = new TextEncoder().encode(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += split) {
        controller.enqueue(bytes.slice(offset, offset + split));
      }
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("direct Codex Responses transport", () => {
  test("streams text without an SDK reader", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetch = async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return sse([
        { type: "response.output_text.delta", delta: "DIRECT_" },
        { type: "response.output_text.delta", delta: "OK" },
        { type: "response.completed", response: { id: "resp-1", output: [{ type: "message", role: "assistant", content: [] }], usage: { input_tokens: 11, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } } } },
      ], 5);
    };
    const events: unknown[] = [];
    for await (const event of streamCodexDirectResponses({
      fetch,
      endpoint: "https://example.invalid/responses",
      model: "gpt-test",
      instructions: "Grok",
      input: [{ role: "user", content: "hi" }],
    } as never)) {
      events.push(event);
    }
    assert.deepEqual(events, [
      { type: "text-delta", delta: "DIRECT_" },
      { type: "text-delta", delta: "OK" },
      { type: "done", text: "DIRECT_OK", responseId: "resp-1", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 } },
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.store, false);
    assert.equal(requests[0]!.stream, true);
  });

  test("executes tools and continues with the exact call id", async () => {
    const requests: Record<string, unknown>[] = [];
    let toolExecution: unknown = null;
    const fetch = async (_url: string, init: RequestInit) => {
      const request = JSON.parse(init.body as string);
      requests.push(request);
      if (requests.length === 1) {
        return sse([
          { type: "response.output_item.done", item: { type: "reasoning", id: "reason-1", encrypted_content: "opaque" } },
          { type: "response.output_item.done", item: { type: "function_call", id: "call-item", call_id: "call-123", name: "gmail_search", arguments: "{\"query\":\"newer_than:1d\"}" } },
          { type: "response.completed", response: { id: "resp-tool", output: [], usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } } } },
        ]);
      }
      return sse([
        { type: "response.output_text.delta", delta: "Subject" },
        { type: "response.completed", response: { id: "resp-final", output: [{ type: "message", role: "assistant", content: [] }], usage: { input_tokens: 8, output_tokens: 1, input_tokens_details: { cached_tokens: 2 } } } },
      ]);
    };
    const source = { providerIdentifier: "user-Gmail", toolName: "search_threads" };
    const events: unknown[] = [];
    for await (const event of streamCodexDirectResponses({
      fetch,
      endpoint: "https://example.invalid/responses",
      model: "gpt-test",
      instructions: "Use connected tools",
      input: [{ role: "user", content: "latest email" }],
      tools: [{ name: "gmail_search", description: "Search Gmail", parameters: { type: "object" }, source }],
      executeTool: async (tool: unknown, args: unknown, toolCallId: string) => {
        toolExecution = { tool, args, toolCallId };
        return { result: { case: "success", value: { subject: "Subject" } } };
      },
    } as never)) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(toolExecution, {
      tool: { name: "gmail_search", description: "Search Gmail", parameters: { type: "object" }, source },
      args: { query: "newer_than:1d" },
      toolCallId: "call-123",
    });
    const secondInput = requests[1]!.input as Record<string, unknown>[];
    assert.equal(secondInput.at(-2)!.type, "function_call");
    assert.deepEqual(secondInput.at(-1), {
      type: "function_call_output",
      call_id: "call-123",
      output: JSON.stringify({ result: { case: "success", value: { subject: "Subject" } } }),
    });
    assert.deepEqual((events.at(-1) as Record<string, unknown>).usage, {
      inputTokens: 28,
      outputTokens: 6,
      cacheReadTokens: 6,
      cacheWriteTokens: 0,
    });
  });

  test("fails closed on a truncated stream", async () => {
    await assert.rejects(async () => {
      for await (const _event of streamCodexDirectResponses({
        fetch: async () => new Response("data: {\"type\":\"response.output_text.delta\"", { status: 200 }),
        endpoint: "https://example.invalid/responses",
        model: "gpt-test",
        instructions: "Grok",
        input: [{ role: "user", content: "hi" }],
      } as never)) {
        // drain
      }
    }, /incomplete SSE event/);
  });
});
