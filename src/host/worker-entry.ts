/**
 * Shared worker_threads entry resolver for the SDK layout.
 *
 * The recovered resolvers assumed the packaged single-bundle layout, where
 * every resolver file's __dirname IS the host bundle root (dist/host) and the
 * worker artifact sits at dist/host/<subdir>/<name>.cjs. This SDK executes
 * TypeScript per-file, so those joins double the subdirectory and miss.
 *
 * Worker bundles live ONLY under dist/host-workers (built by
 * scripts/build-host-workers.mjs into the single build output directory);
 * there is no copy inside src/. Dev runs reach dist/ by climbing from the
 * caller module, packaged runs find it beside the emitted host code.
 *
 * Probe order (first existing file wins):
 *   1. <any ancestor>/dist/host-workers/<name>.cjs  (dev repo root and pkg root)
 *   2. <caller dir>/<name>.cjs              (artifact emitted beside the source)
 *   3. <caller dir>/<subdir>/<name>.cjs     (original packaged bundle layout)
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveHostWorkerEntry(
  callerModuleUrl: string,
  packagedSubdir: string,
  workerFileName: string,
): string {
  let here = dirname(fileURLToPath(callerModuleUrl));
  const candidates: string[] = [];
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(join(here, "dist", "host-workers", workerFileName));
    const parent = dirname(here);
    if (parent === here) break;
    here = parent;
  }
  candidates.push(
    join(dirname(fileURLToPath(callerModuleUrl)), workerFileName),
    join(dirname(fileURLToPath(callerModuleUrl)), packagedSubdir, workerFileName),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Nothing built yet: return the packaged-layout path so the failure message
  // matches the documented artifact location.
  return candidates[candidates.length - 1]!;
}
