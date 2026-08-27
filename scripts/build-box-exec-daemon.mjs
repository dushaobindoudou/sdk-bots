/**
 * Bundles the loopback box exec-daemon into a single CJS file at
 * dist/box-exec-daemon/main.cjs — the location the host resolvers probe
 * (both dev runs via tsx and packaged runs resolve it under dist/).
 *
 * Usage: node scripts/build-box-exec-daemon.mjs [outfile]
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = process.argv[2] ?? path.join(root, "dist", "box-exec-daemon", "main.cjs");
await mkdir(path.dirname(outfile), { recursive: true });
await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: [path.join(root, "src/box-exec-daemon/cli.ts")],
  format: "cjs",
  platform: "node",
  target: "node22",
  outfile,
  legalComments: "none",
  logLevel: "silent",
  banner: { js: "// Reconstructed loopback box exec-daemon; Connect/protobuf transport, no desktop local-exec dependency." },
});
process.stdout.write(`${outfile}\n`);
