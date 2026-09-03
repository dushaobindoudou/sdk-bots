import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GROUP_DEFAULT_MAX_MEMBERS,
  GROUP_HARD_MAX_MEMBERS,
  normalizeGroupMaxMembers,
  normalizeMemberIds,
  normalizeRemoteMembers,
  readSandGroupConfig,
  writeSandGroupConfig,
} from "../../src/host/groups/group-store.js";

function makeGroupDir(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "group-cap-"));
  writeFileSync(join(dir, "group.json"), JSON.stringify(config), "utf8");
  return dir;
}

describe("群成员上限可配置（group.json maxMembers）", () => {
  test("默认上限为 8，硬顶 16", () => {
    assert.equal(GROUP_DEFAULT_MAX_MEMBERS, 8);
    assert.equal(GROUP_HARD_MAX_MEMBERS, 16);
  });

  test("normalizeMemberIds 遵循传入上限，缺省用默认 8", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
    assert.equal(normalizeMemberIds(ids).length, 8);
    assert.equal(normalizeMemberIds(ids, 3).length, 3);
    assert.equal(normalizeMemberIds(ids, 16).length, 11);
    assert.deepEqual(normalizeMemberIds(ids, 2), ["a", "b"]);
  });

  test("normalizeGroupMaxMembers 钳制到 1..16，非法值回默认", () => {
    assert.equal(normalizeGroupMaxMembers(12), 12);
    assert.equal(normalizeGroupMaxMembers(1), 1);
    assert.equal(normalizeGroupMaxMembers(16), 16);
    assert.equal(normalizeGroupMaxMembers(99), 16);
    assert.equal(normalizeGroupMaxMembers(0), 1);
    assert.equal(normalizeGroupMaxMembers(-3), 1);
    assert.equal(normalizeGroupMaxMembers("8"), 8);
    assert.equal(normalizeGroupMaxMembers(undefined), 8);
    assert.equal(normalizeGroupMaxMembers(null), 8);
    assert.equal(normalizeGroupMaxMembers("abc"), 8);
    assert.equal(normalizeGroupMaxMembers(6.9), 6);
  });

  test("read 读取 maxMembers 并按它截断成员；缺省补默认 8", () => {
    const wide = readSandGroupConfig(
      makeGroupDir({ version: 1, maxMembers: 10, memberIds: ["a","b","c","d","e","f","g","h","i"] }),
    );
    assert.equal(wide?.maxMembers, 10);
    assert.equal(wide?.memberIds.length, 9);

    const legacy = readSandGroupConfig(
      makeGroupDir({ version: 1, memberIds: ["a","b","c","d","e","f","g","h","i","j","k"] }),
    );
    assert.equal(legacy?.maxMembers, 8);
    assert.equal(legacy?.memberIds.length, 8);
  });

  test("read 把超过硬顶的 maxMembers 钳回 16", () => {
    const capped = readSandGroupConfig(
      makeGroupDir({ version: 1, maxMembers: 50, memberIds: ["a"] }),
    );
    assert.equal(capped?.maxMembers, 16);
  });

  test("write 持久化 maxMembers 并按它截断；remoteMembers 同样受限", () => {
    const dir = mkdtempSync(join(tmpdir(), "group-cap-write-"));
    writeSandGroupConfig(dir, {
      version: 1,
      maxMembers: 3,
      memberIds: ["a", "b", "c", "d", "e"],
      remoteMembers: Array.from({ length: 5 }, (_, i) => ({
        ownerAuthId: `o${i}`,
        agentId: `r${i}`,
        name: `R${i}`,
      })),
    });
    const onDisk = JSON.parse(readFileSync(join(dir, "group.json"), "utf8"));
    assert.equal(onDisk.maxMembers, 3);
    assert.equal(onDisk.memberIds.length, 3);
    assert.equal((onDisk.remoteMembers ?? []).length, 3);
    const reread = readSandGroupConfig(dir);
    assert.equal(reread?.maxMembers, 3);
    assert.equal(reread?.memberIds.length, 3);
  });

  test("normalizeRemoteMembers 遵循传入上限", () => {
    const remotes = Array.from({ length: 10 }, (_, i) => ({
      ownerAuthId: `o${i}`,
      agentId: `r${i}`,
    }));
    assert.equal(normalizeRemoteMembers(remotes).length, 8);
    assert.equal(normalizeRemoteMembers(remotes, 4).length, 4);
  });
});
