/**
 * Unit tests for src/sdk/entry.ts — host bootstrap helpers.
 *
 * Covers defaultDataDir() (SDK data root isolation), randomId() and the
 * gateway discovery waiter: accepting a valid discovery record, rejecting a
 * stale pid, rejecting a non-positive port, parsing the token and timing out
 * when nothing appears.
 *
 * Run:  npm run test:unit
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultDataDir, randomId, waitForDiscovery } from "../../src/sdk/entry.ts";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "sdk-bots-unit-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("defaultDataDir()", () => {
  test("roots the SDK data dir at ~/.sdk-bots (never ~/.cursor)", () => {
    assert.equal(defaultDataDir(), join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".sdk-bots"));
  });
});

describe("randomId()", () => {
  test("returns a UUID v4", () => {
    const id = randomId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("returns distinct values", () => {
    assert.notEqual(randomId(), randomId());
  });
});

describe("waitForDiscovery()", () => {
  test("resolves with port + token for a fresh discovery record", async () => {
    const dir = tempDataDir();
    try {
      writeFileSync(join(dir, "gateway.json"), JSON.stringify({ pid: process.pid, port: 50885, token: "t-123" }));
      const discovery = await waitForDiscovery(dir, 2000, 20);
      assert.deepEqual(discovery, { port: 50885, token: "t-123" });
    } finally {
      cleanup(dir);
    }
  });

  test("resolves without a token when the record omits one", async () => {
    const dir = tempDataDir();
    try {
      writeFileSync(join(dir, "gateway.json"), JSON.stringify({ pid: process.pid, port: 7000 }));
      const discovery = await waitForDiscovery(dir, 2000, 20);
      assert.deepEqual(discovery, { port: 7000 });
      assert.equal("token" in discovery, false);
    } finally {
      cleanup(dir);
    }
  });

  test("rejects a stale discovery record from another pid", async () => {
    const dir = tempDataDir();
    try {
      writeFileSync(join(dir, "gateway.json"), JSON.stringify({ pid: process.pid + 1, port: 7000 }));
      await assert.rejects(() => waitForDiscovery(dir, 300, 20), /did not write gateway discovery/);
    } finally {
      cleanup(dir);
    }
  });

  test("rejects a record with a non-positive port", async () => {
    const dir = tempDataDir();
    try {
      writeFileSync(join(dir, "gateway.json"), JSON.stringify({ pid: process.pid, port: 0 }));
      await assert.rejects(() => waitForDiscovery(dir, 300, 20), /did not write gateway discovery/);
    } finally {
      cleanup(dir);
    }
  });

  test("keeps polling until a valid record appears (late write)", async () => {
    const dir = tempDataDir();
    try {
      setTimeout(() => {
        writeFileSync(join(dir, "gateway.json"), JSON.stringify({ pid: process.pid, port: 8123, token: "late" }));
      }, 60);
      const discovery = await waitForDiscovery(dir, 2000, 20);
      assert.deepEqual(discovery, { port: 8123, token: "late" });
    } finally {
      cleanup(dir);
    }
  });

  test("times out with a descriptive error when no record is ever written", async () => {
    const dir = tempDataDir();
    try {
      await assert.rejects(
        () => waitForDiscovery(dir, 300, 20),
        (err: Error) => {
          assert.match(err.message, /did not write gateway discovery/);
          assert.match(err.message, /\.sdk-bots.*gateway\.json|gateway\.json/);
          assert.match(err.message, /300ms/);
          return true;
        }
      );
    } finally {
      cleanup(dir);
    }
  });
});
