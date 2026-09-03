import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildWorkspaceSeatbeltProfile,
  ensureWorkspaceSeatbeltProfile,
  resolveAgentWorkspaceJail,
  applyWorkspaceJailToShellArgs,
  WorkspaceJailConfigError,
} from "../../src/host/runner/agent-workspace-jail.js";
import { buildHostShellArgs } from "../../src/host/box/box-shell-command.js";
import {
  getSandSettingsPath,
  readSandSettingsFile,
  writeSandSettingsFile,
} from "../../src/host/agents/settings-file.js";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "ws-jail-test-"));
  const agentsDir = join(root, "agents");
  const jailsDir = join(root, "jails");
  const boxWorkspaceRoot = join(root, "box-workspace");
  const sandboxExecPath = join(root, "sandbox-exec-fake");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(sandboxExecPath, "#!/bin/sh\n");
  const deps = { agentsDir, jailsDir, boxWorkspaceRoot, platform: "darwin" as NodeJS.Platform, sandboxExecPath };
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, agentsDir, jailsDir, boxWorkspaceRoot, deps, cleanup };
}

function writeAgentSettings(agentsDir: string, agentId: string, settings: Record<string, unknown>): void {
  const path = getSandSettingsPath(join(agentsDir, agentId));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings)}\n`, "utf8");
}

test("settings round-trip preserves workspace jail fields", () => {
  const { root, cleanup } = makeFixture();
  try {
    const path = getSandSettingsPath(join(root, "a1"));
    writeSandSettingsFile(path, {
      notifyOnAgentUpdates: true,
      workspaceRoot: "/workspace/douyin-producer",
      workspaceAllowPaths: ["/Users/liepin/.sdk-bots/swarm"],
    });
    const read = readSandSettingsFile(path);
    assert.equal(read.workspaceRoot, "/workspace/douyin-producer");
    assert.deepEqual(read.workspaceAllowPaths, ["/Users/liepin/.sdk-bots/swarm"]);

    const plain = readSandSettingsFile(getSandSettingsPath(join(root, "a2")));
    assert.equal(plain.workspaceRoot, undefined);
    assert.equal(plain.workspaceAllowPaths, undefined);
    assert.equal(plain.notifyOnAgentUpdates, true);
  } finally {
    cleanup();
  }
});

test("resolveAgentWorkspaceJail: virtual root normalizes to host root", () => {
  const { agentsDir, boxWorkspaceRoot, deps, cleanup } = makeFixture();
  try {
    writeAgentSettings(agentsDir, "agent-1", { workspaceRoot: "/workspace/douyin-producer" });
    const jail = resolveAgentWorkspaceJail("agent-1", deps);
    assert.ok(jail);
    assert.equal(jail.virtualRoot, "/workspace/douyin-producer");
    assert.equal(jail.hostRoot, join(boxWorkspaceRoot, "douyin-producer"));
    assert.equal(jail.profilePath, join(deps.jailsDir, "agent-1.sb"));
  } finally {
    cleanup();
  }
});

test("resolveAgentWorkspaceJail: absolute path inside box root normalizes", () => {
  const { agentsDir, boxWorkspaceRoot, deps, cleanup } = makeFixture();
  try {
    writeAgentSettings(agentsDir, "agent-2", { workspaceRoot: join(boxWorkspaceRoot, "director") });
    const jail = resolveAgentWorkspaceJail("agent-2", deps);
    assert.ok(jail);
    assert.equal(jail.virtualRoot, "/workspace/director");
  } finally {
    cleanup();
  }
});

test("resolveAgentWorkspaceJail: unjailed, disabled, and non-darwin agents", () => {
  const { agentsDir, deps, cleanup } = makeFixture();
  try {
    assert.equal(resolveAgentWorkspaceJail("agent-3", deps), undefined);
    writeAgentSettings(agentsDir, "agent-3", { workspaceRoot: "/workspace/x" });
    assert.ok(resolveAgentWorkspaceJail("agent-3", deps));
    assert.equal(
      resolveAgentWorkspaceJail("agent-3", { ...deps, env: { SAND_AGENT_WORKSPACE_JAIL: "0" } }),
      undefined,
    );
    assert.equal(
      resolveAgentWorkspaceJail("agent-3", { ...deps, platform: "linux" }),
      undefined,
    );
  } finally {
    cleanup();
  }
});

test("resolveAgentWorkspaceJail: malformed configs fail loudly", () => {
  const { agentsDir, boxWorkspaceRoot, deps, cleanup } = makeFixture();
  try {
    const bad = ["relative/path", "/etc", boxWorkspaceRoot, "/workspace/../escape", "/workspace/a/b"];
    for (const [index, root] of bad.entries()) {
      writeAgentSettings(agentsDir, `bad-${index}`, { workspaceRoot: root });
      assert.throws(() => resolveAgentWorkspaceJail(`bad-${index}`, deps), WorkspaceJailConfigError);
    }
    writeAgentSettings(agentsDir, "bad-allow", {
      workspaceRoot: "/workspace/ok",
      workspaceAllowPaths: ["not-absolute"],
    });
    assert.throws(() => resolveAgentWorkspaceJail("bad-allow", deps), WorkspaceJailConfigError);
  } finally {
    cleanup();
  }
});

test("seatbelt profile denies default and allows jail root in both path forms", () => {
  const { agentsDir, deps, cleanup } = makeFixture();
  try {
    writeAgentSettings(agentsDir, "agent-4", { workspaceRoot: "/workspace/director" });
    const jail = resolveAgentWorkspaceJail("agent-4", {
      ...deps,
      boxWorkspaceRoot: "/var/folders/box-workspace",
    });
    assert.ok(jail, "jail expected for agent-4 fixture");
    assert.equal(jail.hostRoot, "/var/folders/box-workspace/director");
    const profile = buildWorkspaceSeatbeltProfile(jail, "/var/folders/tmp-x");
    assert.match(profile, /\(deny default\)/);
    assert.match(profile, /\(allow file-read\*\)/);
    assert.match(profile, /\(subpath "\/var\/folders\/box-workspace\/director"\)/);
    assert.match(profile, /\(subpath "\/private\/var\/folders\/box-workspace\/director"\)/);
    assert.match(profile, /\(subpath "\/var\/folders\/tmp-x"\)/);
    assert.match(profile, /\(subpath "\/private\/var\/folders\/tmp-x"\)/);
    assert.match(profile, /ttys\[0-9\]\+/);
  } finally {
    cleanup();
  }
});

test("profile includes configured extra allow paths", () => {
  const { agentsDir, deps, cleanup } = makeFixture();
  try {
    writeAgentSettings(agentsDir, "agent-5", {
      workspaceRoot: "/workspace/cutter",
      workspaceAllowPaths: ["/Users/liepin/.sdk-bots/swarm"],
    });
    const jail = resolveAgentWorkspaceJail("agent-5", deps);
    assert.ok(jail);
    const profile = buildWorkspaceSeatbeltProfile(jail);
    assert.match(profile, /\(subpath "\/Users\/liepin\/\.sdk-bots\/swarm"\)/);
  } finally {
    cleanup();
  }
});

test("applyWorkspaceJailToShellArgs wraps command, escapes quotes, forces cwd", () => {
  const { agentsDir, deps, cleanup } = makeFixture();
  try {
    writeAgentSettings(agentsDir, "agent-6", { workspaceRoot: "/workspace/gaffer" });
    const jail = resolveAgentWorkspaceJail("agent-6", deps);
    assert.ok(jail);
    const args = buildHostShellArgs({
      command: "echo 'hello world' > out.txt",
      name: "Shell",
      workingDirectory: "/workspace",
      toolCallId: "t1",
    });
    const jailed = applyWorkspaceJailToShellArgs(args, jail);
    assert.notEqual(jailed, args);
    assert.equal(jailed.workingDirectory, "/workspace/gaffer");
    assert.match(jailed.command, /^\/usr\/bin\/sandbox-exec -f '.+' \/bin\/sh -c '/);
    assert.ok(jailed.command.includes(`'echo '\\''hello world'\\'' > out.txt'`));
    assert.equal(args.command, "echo 'hello world' > out.txt", "original args must stay untouched");
    const profileOnDisk = readFileSync(jail.profilePath, "utf8");
    assert.match(profileOnDisk, /\(deny default\)/);
  } finally {
    cleanup();
  }
});

test("ensureWorkspaceSeatbeltProfile rewrites only when content changes", () => {
  const { agentsDir, deps, cleanup } = makeFixture();
  try {
    writeAgentSettings(agentsDir, "agent-7", { workspaceRoot: "/workspace/editor" });
    const jail = resolveAgentWorkspaceJail("agent-7", deps);
    assert.ok(jail);
    const first = ensureWorkspaceSeatbeltProfile(jail);
    const before = readFileSync(first, "utf8");
    const again = ensureWorkspaceSeatbeltProfile(jail);
    assert.equal(again, first);
    assert.equal(readFileSync(first, "utf8"), before);
  } finally {
    cleanup();
  }
});
