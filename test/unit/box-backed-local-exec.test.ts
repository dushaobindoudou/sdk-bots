/**
 * Box exec-daemon writeArgs + box-backed local-exec file store.
 *
 * Pins the path that ExternalShell/CopyToBox use when the computer is the box
 * (including a daemon that is not this process's disk).
 *
 * Run:  npm run test:unit
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startBoxExecDaemon } from "../../src/box-exec-daemon/server.ts";
import { createBoxLocalExecFileStore } from "../../src/host/local-exec/box-backed-executor.ts";

describe("box-backed local-exec file store", () => {
  let workspaceRoot: string | undefined;
  let stop: (() => Promise<void>) | undefined;

  after(async () => {
    await stop?.();
    if (workspaceRoot != null) await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("writes and reads through the daemon, not the host process disk layout", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "sdk-bots-box-write-"));
    const handle = await startBoxExecDaemon({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      authToken: "test-token",
    });
    stop = () => handle.stop();
    const store = createBoxLocalExecFileStore({
      host: "127.0.0.1",
      port: handle.port,
      authToken: "test-token",
    });
    const payload = Buffer.from("hello from a remote box");
    await store.write("/workspace/notes.txt", payload);
    const roundTrip = await store.read("/workspace/notes.txt");
    assert.equal(Buffer.from(roundTrip).toString("utf8"), "hello from a remote box");
    const onDisk = await readFile(join(handle.workspaceRoot, "notes.txt"), "utf8");
    assert.equal(onDisk, "hello from a remote box");
  });
});
