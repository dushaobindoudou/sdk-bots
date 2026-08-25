/**
 * Bundles the loopback box exec-daemon into a single CJS file at the location
 * the host resolver expects (../box-exec-daemon/main.cjs relative to the host
 * entry): src/box-exec-daemon/main.cjs for dev runs, and copied into
 * dist/box-exec-daemon/main.cjs by `npm run build` for packaged runs.
 *
 * Usage: node scripts/build-box-exec-daemon.mjs [outfile]
 */
import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = process.argv[2] ?? path.join(root, "src", "box-exec-daemon", "main.cjs");
await mkdir(path.dirname(outfile), { recursive: true });
await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: [path.join(root, "source/box-exec-daemon/cli.ts")],
  format: "cjs",
  platform: "node",
  target: "node22",
  outfile,
  legalComments: "none",
  logLevel: "silent",
  banner: { js: "// Reconstructed loopback box exec-daemon; Connect/protobuf transport, no desktop local-exec dependency." },
});
process.stdout.write(`${outfile}\n`);
