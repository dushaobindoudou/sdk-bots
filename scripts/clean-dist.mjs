/**
 * Removes the build output directory so every build starts from a clean
 * state (stale artifacts from previous layouts must never leak into a
 * fresh dist/ — or into the published package).
 *
 * Usage: node scripts/clean-dist.mjs
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
rmSync(path.join(root, "dist"), { recursive: true, force: true });
process.stdout.write("dist/ cleaned\n");
