/**
 * Unit tests for the inference router transcript store
 * (source/node-agent-coordinator/inference-router.ts).
 *
 * Migrated from the original repo's tests/inference-router-transcript.test.mjs;
 * the esbuild temp-bundle loader is replaced by direct tsx imports.
 *
 * Covers: structured MCP mention rich text survives store parse + projection,
 * and malformed rich text carriers are dropped instead of crashing the store.
 *
 * Run:  npm run test:unit
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  parseInferenceRouterTranscriptStore,
  projectInferenceRouterTranscriptEntry,
} from "../../source/node-agent-coordinator/inference-router.ts";

describe("inference router transcript", () => {
  test("routed transcript preserves structured MCP mention rich text across reload", () => {
    const richText = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [
        { type: "mention", attrs: { id: "mcp:3213107", label: "Gmail" } },
        { type: "text", text: " what's new?" },
      ] }],
    });
    const store = parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{
          provider: "codex",
          role: "user",
          content: "@Gmail what's new?",
          richText,
          id: "t1u",
          clientNonce: "nonce-1",
          timestampMs: 123,
        }],
      },
    });
    const projected = projectInferenceRouterTranscriptEntry(
      (store.agents as { agent: unknown[] }).agent[0] as never,
    ) as { richText?: string };
    assert.equal(projected.richText, richText);
    assert.deepEqual(
      JSON.parse(projected.richText!).content[0].content[0],
      { type: "mention", attrs: { id: "mcp:3213107", label: "Gmail" } },
    );
  });

  test("routed transcript rejects malformed rich text carriers", () => {
    const store = parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{ provider: "codex", role: "user", content: "@Gmail", richText: {}, id: "t1u", timestampMs: 123 }],
      },
    });
    assert.deepEqual((store.agents as { agent: unknown[] }).agent, []);
  });
});
