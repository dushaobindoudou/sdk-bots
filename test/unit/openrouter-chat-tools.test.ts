import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_LOCAL_PLACEHOLDER_KEY,
  compactLocalMessages,
  openRouterChatTools,
  resolveOpenRouterEndpoint,
} from "../../source/host/extensions/inference/provider-session.ts";

describe("openRouterChatTools", () => {
  test("keeps sandbox tools including Shell and Read", () => {
    const filtered = openRouterChatTools([
      { name: "SendMessage", inputSchema: { type: "object" } },
      { name: "Shell", inputSchema: { type: "object" } },
      { name: "Computer", inputSchema: { type: "object" } },
      { name: "SendToAgent", inputSchema: { type: "object" } },
      { name: "Read", inputSchema: { type: "object" } },
    ]);
    assert.deepEqual(
      filtered?.map((definition) => definition.name),
      ["SendMessage", "Shell", "SendToAgent", "Read"],
    );
  });

  test("leaves definitions unchanged when no sandbox tools match", () => {
    const definitions = [{ name: "Computer", inputSchema: { type: "object" } }];
    assert.equal(openRouterChatTools(definitions), definitions);
  });

  test("passes through empty or missing lists", () => {
    assert.equal(openRouterChatTools(undefined), undefined);
    assert.deepEqual(openRouterChatTools([]), []);
  });
});

describe("resolveOpenRouterEndpoint", () => {
  test("defaults to local freeroute auto without a key", () => {
    assert.deepEqual(
      resolveOpenRouterEndpoint({} as NodeJS.ProcessEnv, { OPENROUTER_API_KEY: "sk-or-should-not-use" }),
      {
        baseURL: OPENROUTER_DEFAULT_BASE_URL,
        apiKey: OPENROUTER_LOCAL_PLACEHOLDER_KEY,
        modelId: "auto",
      },
    );
  });

  test("official OpenRouter requires a key", () => {
    assert.throws(
      () => resolveOpenRouterEndpoint({ SAND_OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1" } as NodeJS.ProcessEnv, {}),
      /OPENROUTER_API_KEY/,
    );
    assert.deepEqual(
      resolveOpenRouterEndpoint(
        { SAND_OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1", OPENROUTER_API_KEY: "sk-or-test" } as NodeJS.ProcessEnv,
        {},
      ),
      { baseURL: "https://openrouter.ai/api/v1", apiKey: "sk-or-test", modelId: "deepseek/deepseek-chat" },
    );
  });
});

describe("compactLocalMessages", () => {
  test("keeps only the group-turn prompt, dropping private 1-1 history", () => {
    const compacted = compactLocalMessages([
      { role: "user", content: "private dm" },
      { role: "assistant", content: "ok" },
      { role: "user", content: `[Group chat: "周末小队" - with 写手]\nIt's your turn, 研究员.` },
    ]);
    assert.equal(compacted.length, 1);
    assert.match(compacted[0]!.content, /Group chat/);
  });
});
