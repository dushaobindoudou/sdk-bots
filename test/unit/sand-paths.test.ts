/**
 * Unit tests for src/shared/sand-paths.ts — the path-policy module that sank
 * from host/ into shared/ during the 0.3.0 layering pass (it is consumed by
 * both tiers, so shared owns it).
 *
 * Pins the three load-bearing behaviors: box path visibility remapping,
 * data-root precedence (override > user-data-dir > variant default), and
 * legacy-path re-anchoring — including the traversal guard.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SAND_BOX_DATA_ROOT,
  SAND_BOX_MODEL_VISIBLE_DATA_ROOT,
  toModelVisiblePath,
  readUserDataDirArg,
  resolveSandUserDataDir,
  resolveSandDataRootOverride,
  getSandProductionRootDir,
  getSandRootDir,
  getGatewayDiscoveryPath,
  reanchorSandPath,
} from "../../src/shared/sand-paths.ts";

const SAVED_ENV = new Map<string, string | undefined>();
const WATCHED = ["SAND_DATA_ROOT", "SAND_USER_DATA_DIR", "SAND_PACKAGED", "SAND_LAB"];

beforeEach(() => {
  for (const key of WATCHED) SAVED_ENV.set(key, process.env[key]);
});

afterEach(() => {
  for (const [key, value] of SAVED_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  SAVED_ENV.clear();
});

/** Sandbox the four env vars for one test body. */
function withEnv(values: Record<string, string | undefined>): void {
  for (const key of WATCHED) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
}

describe("toModelVisiblePath()", () => {
  test("remaps box data paths onto the model-visible root", () => {
    assert.equal(
      toModelVisiblePath(`${SAND_BOX_DATA_ROOT}/agents/a.json`),
      `${SAND_BOX_MODEL_VISIBLE_DATA_ROOT}/agents/a.json`,
    );
    assert.equal(toModelVisiblePath(SAND_BOX_DATA_ROOT), SAND_BOX_MODEL_VISIBLE_DATA_ROOT, "inclusive: the root itself maps");
  });

  test("leaves everything outside the box data root untouched", () => {
    assert.equal(toModelVisiblePath("/home/box/other/file.txt"), "/home/box/other/file.txt");
    assert.equal(toModelVisiblePath("/etc/passwd"), "/etc/passwd");
    assert.equal(toModelVisiblePath("/home/box/sand-data-extra/x"), "/home/box/sand-data-extra/x", "prefix must match a full segment");
  });
});

describe("readUserDataDirArg()", () => {
  test("accepts --user-data-dir X, --user-data-dir=X, and rejects flag-ish values", () => {
    assert.equal(readUserDataDirArg(["--user-data-dir", "/data"]), "/data");
    assert.equal(readUserDataDirArg(["--user-data-dir=/data"]), "/data");
    assert.equal(readUserDataDirArg(["--user-data-dir", "--next-flag"]), null);
    assert.equal(readUserDataDirArg(["--user-data-dir"]), null);
    assert.equal(readUserDataDirArg(["unrelated"]), null);
  });
});

describe("resolveSandUserDataDir()", () => {
  test("argv beats env; empty and blank values are null", () => {
    const env = { SAND_USER_DATA_DIR: "/from-env" };
    assert.equal(resolveSandUserDataDir(["--user-data-dir", "/from-argv"], env), "/from-argv");
    assert.equal(resolveSandUserDataDir([], env), "/from-env");
    assert.equal(resolveSandUserDataDir([], { SAND_USER_DATA_DIR: "   " }), null);
    assert.equal(resolveSandUserDataDir([], {}), null);
  });

  test("relative dirs resolve against cwd", () => {
    assert.equal(resolveSandUserDataDir(["--user-data-dir", "proj/data"], {}, "/w"), "/w/proj/data");
  });
});

describe("resolveSandDataRootOverride()", () => {
  test("only a non-empty absolute path counts as an override", () => {
    assert.equal(resolveSandDataRootOverride({ SAND_DATA_ROOT: "/tmp/root" }), "/tmp/root");
    assert.equal(resolveSandDataRootOverride({ SAND_DATA_ROOT: "relative/root" }), null);
    assert.equal(resolveSandDataRootOverride({ SAND_DATA_ROOT: "" }), null);
    assert.equal(resolveSandDataRootOverride({ SAND_DATA_ROOT: "  " }), null);
    assert.equal(resolveSandDataRootOverride({}), null);
  });
});

describe("getSandRootDir() precedence", () => {
  test("1) SAND_DATA_ROOT override wins over everything", () => {
    withEnv({ SAND_DATA_ROOT: "/tmp/override", SAND_USER_DATA_DIR: "/tmp/udd", SAND_PACKAGED: "1" });
    assert.equal(getSandRootDir("/home/u"), "/tmp/override");
  });

  test("2) user-data-dir (env) appends the sand-data segment", () => {
    withEnv({ SAND_USER_DATA_DIR: "/tmp/profile", SAND_PACKAGED: "1" });
    assert.equal(getSandRootDir("/home/u"), join("/tmp/profile", "sand-data"));
  });

  test("3) packaged sand variant uses ~/.grokbot; dev variant uses ~/.cursor/sand-dev", () => {
    withEnv({ SAND_PACKAGED: "1" });
    assert.equal(getSandRootDir("/home/u"), getSandProductionRootDir("/home/u"));
    assert.equal(getSandProductionRootDir("/home/u"), join("/home/u", ".grokbot"));
    withEnv({}); // neither packaged nor lab
    assert.equal(getSandRootDir("/home/u"), join("/home/u", ".cursor", "sand-dev"));
    withEnv({ SAND_PACKAGED: "1", SAND_LAB: "1" });
    assert.equal(getSandRootDir("/home/u"), join("/home/u", ".cursor", "sand-lab"));
  });

  test("gateway discovery path hangs off the resolved root", () => {
    withEnv({ SAND_DATA_ROOT: "/tmp/override" });
    assert.equal(getGatewayDiscoveryPath("/home/u"), join("/tmp/override", "gateway.json"));
  });
});

describe("reanchorSandPath()", () => {
  test("paths already inside the current root pass through unchanged", () => {
    withEnv({ SAND_DATA_ROOT: "/tmp/root" });
    assert.equal(reanchorSandPath("/tmp/root/agents/a.json"), "/tmp/root/agents/a.json");
    assert.equal(reanchorSandPath("/tmp/root"), "/tmp/root");
  });

  test("legacy .grokbot tails re-anchor into the current root", () => {
    withEnv({ SAND_DATA_ROOT: "/tmp/root" });
    assert.equal(
      reanchorSandPath("/old/home/.grokbot/agents/a.json"),
      join("/tmp/root", "agents", "a.json"),
    );
  });

  test("legacy .cursor/sand* tails re-anchor too, with windows separators tolerated", () => {
    withEnv({ SAND_DATA_ROOT: "/tmp/root" });
    assert.equal(
      reanchorSandPath("/old/home/.cursor/sand/agents/a.json"),
      join("/tmp/root", "agents", "a.json"),
    );
    assert.equal(
      reanchorSandPath(String.raw`C:\Users\old\.cursor\sand-lab\agents\a.json`),
      join("/tmp/root", "agents", "a.json"),
    );
  });

  test("traversal attempts and unrelated paths are left untouched", () => {
    withEnv({ SAND_DATA_ROOT: "/tmp/root" });
    assert.equal(
      reanchorSandPath("/old/.grokbot/../etc/passwd"),
      "/old/.grokbot/../etc/passwd",
      ".. must not be re-anchored (no escape into arbitrary dirs)",
    );
    assert.equal(reanchorSandPath("/completely/unrelated/path"), "/completely/unrelated/path");
    assert.equal(reanchorSandPath("/old/.grokbot/"), "/old/.grokbot/", "empty tail segment is not re-anchored");
  });

  test("uses a writable tmp root end-to-end (sanity against a read-only override)", () => {
    const root = join(tmpdir(), "sand-paths-test-root");
    withEnv({ SAND_DATA_ROOT: root });
    assert.equal(reanchorSandPath("/old/.grokbot/x/y.json"), join(root, "x", "y.json"));
  });
});
