/**
 * Unit tests for routed-provider MCP argument handling
 * (source/shared/node/mcp/mcp-validation.ts and
 *  source/shared/node/cursor-backend/backend-mcp-exec.ts).
 *
 * Migrated from the original repo's tests/backend-mcp-exec-json.test.mjs; the
 * esbuild temp-bundle loader is replaced by direct tsx imports.
 *
 * Covers: routed JSON arguments are accepted alongside native generated
 * values, and plain objects are converted into a protobuf Struct before
 * Connect serialization (the field that failed in the real serializer).
 *
 * Run:  npm run test:unit
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { toJsonArgs } from "../../source/shared/node/mcp/mcp-validation.ts";
import { createDashboardSandBackendMcpExec } from "../../source/shared/node/cursor-backend/backend-mcp-exec.ts";

describe("backend MCP exec JSON handling", () => {
  test("MCP discovery accepts both routed JSON and native generated values", () => {
    assert.deepEqual(toJsonArgs({
      query: "in:inbox",
      pageSize: 1,
      native: { toJson: () => ({ retained: true }) },
    }), {
      query: "in:inbox",
      pageSize: 1,
      native: { retained: true },
    });
  });

  test("routed MCP JSON arguments become a protobuf Struct before backend serialization", async () => {
    let captured: { args?: { toBinary?: unknown; toJson?: () => unknown } } | undefined;
    const backend = createDashboardSandBackendMcpExec({
      getAccessToken: async () => "unused",
      getMachineId: async () => "unused",
      createClient: () => ({
        executeSandMcpTool: async (request: typeof captured) => {
          captured = request;
          // This is the operation that failed in the real Connect serializer
          // when routed providers supplied a plain object instead of a Struct.
          assert.deepEqual(
            (request!.args as { toJson: () => unknown }).toJson(),
            { query: "in:inbox", pageSize: 1 },
          );
          return { result: { result: { case: "success", value: { content: [] } } } };
        },
      }),
    } as never) as {
      executeTool(args: {
        serverIdentifier: string;
        toolName: string;
        args: Record<string, unknown>;
        toolCallId: string;
        agentId: string;
      }): Promise<{ result: { case: string } }>;
    };
    const result = await backend.executeTool({
      serverIdentifier: "user-Gmail",
      toolName: "search_threads",
      args: { query: "in:inbox", pageSize: 1 },
      toolCallId: "call-1",
      agentId: "agent-1",
    });
    assert.equal(result.result.case, "success");
    assert.equal(typeof captured?.args?.toBinary, "function");
  });
});
