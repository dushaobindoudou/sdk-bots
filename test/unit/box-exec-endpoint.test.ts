/**
 * Box exec-daemon addressing: loopback vs remote, bind vs connect, spawn policy.
 *
 * Run:  npm run test:unit
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  boxComputerWorkspaceRoot,
  boxExecPingHost,
  isLoopbackBoxHost,
  isStandaloneBoxExecDaemon,
  resolveBoxExecEndpoint,
  shouldSpawnLocalBoxExecDaemon,
} from "../../src/host/box/box-exec-endpoint.ts";
import { localExecConnectionFromEnv } from "../../src/host/local-exec/local-exec-daemon.ts";

describe("resolveBoxExecEndpoint()", () => {
  test("defaults to loopback listen and connect", () => {
    const endpoint = resolveBoxExecEndpoint({});
    assert.equal(endpoint.host, "127.0.0.1");
    assert.equal(endpoint.bindHost, "127.0.0.1");
    assert.equal(endpoint.port, 1337);
    assert.equal(endpoint.authToken, "local");
  });

  test("a non-loopback connect host is a remote box (bind 0.0.0.0, do not spawn)", () => {
    const env = { SAND_BOX_EXEC_DAEMON_HOST: "10.0.0.8", SAND_BOX_EXEC_DAEMON_AUTH_TOKEN: "secret" };
    const endpoint = resolveBoxExecEndpoint(env);
    assert.equal(endpoint.host, "10.0.0.8");
    assert.equal(endpoint.bindHost, "0.0.0.0");
    assert.equal(endpoint.authToken, "secret");
    assert.equal(shouldSpawnLocalBoxExecDaemon(env), false);
    assert.equal(isStandaloneBoxExecDaemon(env), true);
  });

  test("explicit bind host is kept when connecting over loopback", () => {
    const env = { SAND_BOX_EXEC_DAEMON_BIND_HOST: "0.0.0.0" };
    const endpoint = resolveBoxExecEndpoint(env);
    assert.equal(endpoint.host, "127.0.0.1");
    assert.equal(endpoint.bindHost, "0.0.0.0");
    assert.equal(shouldSpawnLocalBoxExecDaemon(env), true);
    assert.equal(boxExecPingHost(endpoint), "127.0.0.1");
  });

  test("SAND_USE_EXISTING_BOX_EXEC_DAEMON=1 skips local spawn", () => {
    assert.equal(shouldSpawnLocalBoxExecDaemon({ SAND_USE_EXISTING_BOX_EXEC_DAEMON: "1" }), false);
  });
});

describe("isLoopbackBoxHost()", () => {
  test("treats localhost aliases as loopback", () => {
    assert.equal(isLoopbackBoxHost("127.0.0.1"), true);
    assert.equal(isLoopbackBoxHost("localhost"), true);
    assert.equal(isLoopbackBoxHost("::1"), true);
    assert.equal(isLoopbackBoxHost("10.0.0.1"), false);
  });
});

describe("boxComputerWorkspaceRoot()", () => {
  test("honors SAND_BOX_WORKSPACE_ROOT", () => {
    assert.equal(boxComputerWorkspaceRoot({ SAND_BOX_WORKSPACE_ROOT: "/tmp/box" }), "/tmp/box");
  });
});

describe("localExecConnectionFromEnv()", () => {
  test("reads the standalone daemon attach URL", () => {
    const connection = localExecConnectionFromEnv({
      SAND_LOCAL_EXEC_GATEWAY_URL: "http://10.0.0.2:18789",
      SAND_GATEWAY_TOKEN: "tok",
    });
    assert.deepEqual(connection, { baseUrl: "http://10.0.0.2:18789", token: "tok" });
  });

  test("returns null when the URL is unset", () => {
    assert.equal(localExecConnectionFromEnv({}), null);
  });
});
