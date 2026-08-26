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

/**
 * Resolves when `marker` appears as a *new* transcript hit after this wait
 * starts. Does not block the caller — start this, then sendPrompt, then await
 * the returned promise.
 *
 * Matching against the current tail is not enough: a previous turn's mock
 * reply stays in the transcript, so the next wait would resolve immediately
 * without seeing a new SendMessage.
 */
export function waitTranscript(sdk, marker, timeoutMs = 90_000, agentId) {
  let settled = false;
  let resolve;
  let reject;
  const seen = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let dispose = () => {};
  let poll;
  const finishOk = (payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (poll != null) clearInterval(poll);
    dispose();
    resolve(payload);
  };
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    if (poll != null) clearInterval(poll);
    dispose();
    reject(new Error(`timed out waiting for "${marker}" on the transcript channel`));
  }, timeoutMs);

  const hitAfterBaseline = (tail, baseline) =>
    countTranscriptMatches(tail, marker).count > baseline;

  void (async () => {
    let baseline = 0;
    if (agentId != null) {
      try {
        const tail = await sdk.getAgentTranscriptTail({ id: agentId });
        if (settled) return;
        baseline = countTranscriptMatches(tail, marker).count;
      } catch {
        /* empty agent or not yet open */
      }
    }
    try {
      dispose = await sdk.subscribeWhenReady((ev) => {
        if (!JSON.stringify(ev ?? {}).includes(marker)) return;
        if (agentId == null) {
          finishOk(ev?.payload ?? ev);
          return;
        }
        void sdk.getAgentTranscriptTail({ id: agentId }).then((tail) => {
          if (hitAfterBaseline(tail, baseline)) finishOk(tail);
        }).catch(() => {});
      });
    } catch {
      /* SSE failed; tail polling still runs */
    }
    if (agentId == null || settled) return;
    poll = setInterval(() => {
      void sdk.getAgentTranscriptTail({ id: agentId }).then((tail) => {
        if (hitAfterBaseline(tail, baseline)) finishOk(tail);
      }).catch(() => {});
    }, 250);
  })();

  return seen;
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

/** Counts assistant/send-message entries whose content includes marker. User prompts are skipped so a marker mentioned in the prompt cannot false-green a wait. */
export function countTranscriptMatches(tail, marker) {
  const entries = tail?.entries ?? tail?.transcript?.entries ?? [];
  let count = 0;
  for (const entry of entries) {
    if (entry?.kind === "message" && entry?.role === "user") continue;
    const content = entry?.message?.content ?? entry?.content;
    const blob = typeof content === "string" ? content : JSON.stringify(entry ?? {});
    if (blob.includes(marker)) count += 1;
  }
  return { count, total: entries.length };
}
