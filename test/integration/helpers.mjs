/**
 * Shared helpers for integration cases (test/integration/*.mjs).
 *
 * Each case runs in its OWN process with its OWN dataDir so the in-process
 * host can shut down cleanly via SIGTERM (the host owns process-level signal
 * handlers — one in-process host per process is the supported shape).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHost } from "../../src/sdk/entry.ts";

export function workDataDir(name) {
  if (process.env.IT_DATA_DIR) return process.env.IT_DATA_DIR;
  return join(mkdtempSync(join(tmpdir(), `it-${name}-`)), "data");
}

export async function boot({ name, reply, dataDir, token, port }) {
  if (reply !== undefined) process.env.SAND_AGENT_MOCK_RESPONSE = reply;
  const host = await startHost({
    dataDir: dataDir ?? workDataDir(name),
    ...(token !== undefined ? { token } : {}),
    ...(port !== undefined ? { port } : {}),
  });
  return host;
}

/** Resolves with the first transcript-channel event matching the marker. */
export function waitTranscript(sdk, marker, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose();
      reject(new Error(`timed out waiting for "${marker}" on the transcript channel`));
    }, timeoutMs);
    const dispose = sdk.subscribe((ev) => {
      if (ev?.channel !== "transcript") return;
      const text = JSON.stringify(ev?.payload ?? {});
      if (text.includes(marker)) {
        clearTimeout(timer);
        dispose();
        resolve(ev.payload);
      }
    });
  });
}

export function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * Graceful per-case shutdown: SIGTERM lets the host clear gateway.json /
 * host.lock; the 8s watchdog guarantees the process still exits.
 */
export function finish(tag, error) {
  if (error) {
    console.error(`[${tag}] FAIL:`, error);
    process.exitCode = 1;
  } else {
    console.log(`[${tag}] PASS`);
  }
  setTimeout(() => {
    process.kill(process.pid, "SIGTERM");
    setTimeout(() => process.exit(process.exitCode ?? 0), 8_000);
  }, 300);
}

export function agentId(result) {
  const id = result?.agent?.id ?? result?.id;
  if (!id) throw new Error(`agent id missing in ${JSON.stringify(result).slice(0, 200)}`);
  return id;
}

/** Counts transcript-tail entries whose message content includes marker. */
export function countTranscriptMatches(tail, marker) {
  const entries = tail?.entries ?? tail?.transcript?.entries ?? [];
  let count = 0;
  for (const entry of entries) {
    const content = entry?.message?.content;
    if (typeof content === "string" && content.includes(marker)) count += 1;
  }
  return { count, total: entries.length };
}
