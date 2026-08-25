/**
 * Integration-suite runner: executes each case file in its own process
 * (clean host shutdown via SIGTERM per case), sequentially, and reports a
 * pass/fail matrix. Exit code is non-zero when any case fails.
 *
 * Usage:  npm run test:integration [-- <case-substring>]
 * Env:    IT_CASE_TIMEOUT_MS (default 240_000 per case)
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..", "..");

const CASES = [
  { file: "01-lifecycle-crud.mjs" },
  { file: "02-single-agent-turn.mjs" },
  { file: "03-group-turn.mjs" },
  { file: "04-multi-turn-state.mjs" },
  { file: "05-token-auth.mjs" },
  { file: "06-error-cases.mjs" },
  { file: "07-restart-persistence.mjs", phases: 2 },
];

const filter = process.argv[2];
const timeoutMs = Number(process.env.IT_CASE_TIMEOUT_MS ?? 240_000);

const selected = filter ? CASES.filter((c) => c.file.includes(filter)) : CASES;
if (selected.length === 0) {
  console.error(`[it-run] no case matches "${filter}"`);
  process.exit(1);
}

const results = [];
for (const testCase of selected) {
  const env = { ...process.env };
  if (testCase.phases === 2) {
    env.IT_DATA_DIR = join(mkdtempSync(join(tmpdir(), "it-shared-")), "data");
  }
  const phases = testCase.phases ?? 1;
  let ok = true;
  for (let phase = 1; phase <= phases; phase += 1) {
    const label = phases === 2 ? `${testCase.file} (phase ${phase})` : testCase.file;
    console.log(`\n[it-run] === ${label} ===`);
    const runEnv = phases === 2 ? { ...env, IT_PHASE: String(phase) } : env;
    const run = spawnSync("node", ["--import", "tsx", join(here, testCase.file)], {
      cwd: root,
      env: runEnv,
      stdio: "inherit",
      timeout: timeoutMs,
    });
    const phaseOk = run.status === 0;
    if (!phaseOk) {
      console.error(`[it-run] ${label} FAILED (exit=${run.status}, signal=${run.signal ?? "none"})`);
    }
    ok = ok && phaseOk;
    results.push({ label, ok: phaseOk });
  }
}

console.log("\n[it-run] ================= integration matrix =================");
for (const r of results) console.log(`${r.ok ? "  PASS " : "  FAIL "} ${r.label}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`[it-run] ${results.length - failed}/${results.length} cases passed`);
process.exit(failed > 0 ? 1 : 0);
