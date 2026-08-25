/**
 * Copies the prebuilt runtime artifacts (box exec-daemon bundle) from src/
 * into dist/ so packaged layouts resolve them relative to their emit root.
 *
 * Usage: node scripts/copy-build-assets.mjs   (wired into `npm run build`)
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const copies = [
  ["src/box-exec-daemon/main.cjs", "dist/box-exec-daemon/main.cjs"],
];
for (const [from, to] of copies) {
  await mkdir(path.dirname(path.join(root, to)), { recursive: true });
  try {
    await copyFile(path.join(root, from), path.join(root, to));
    process.stdout.write(`${to}\n`);
  } catch (error) {
    // Missing source artifact is not fatal for type-only builds.
    process.stdout.write(`(skipped) ${to}: ${String(error)}\n`);
  }
}
