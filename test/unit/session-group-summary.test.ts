import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { groupFieldsFromDir } from "../../source/host/extensions/session/session-summaries.ts";

describe("groupFieldsFromDir", () => {
  test("returns isGroup when group.json is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "sand-group-"));
    try {
      writeFileSync(join(dir, "group.json"), JSON.stringify({ version: 1, memberIds: ["a", "b"] }));
      assert.deepEqual(groupFieldsFromDir(dir), { isGroup: true, memberIds: ["a", "b"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns a bot when group.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "sand-bot-"));
    try {
      assert.deepEqual(groupFieldsFromDir(dir), { isGroup: false, memberIds: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
