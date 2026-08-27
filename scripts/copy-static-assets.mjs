/**
 * Copies non-TS static assets that the compiled runtime resolves relative to
 * its emit root (tsc does not move them):
 *   - src/host/gateway-console.html -> dist/host/gateway-console.html
 *     (serveGatewayConsole reads it via import.meta.url; without this copy
 *     the packaged /console route 500s)
 *
 * Usage: node scripts/copy-static-assets.mjs   (wired into `npm run build`)
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const copies = [
  ["src/host/gateway-console.html", "dist/host/gateway-console.html"],
];
for (const [from, to] of copies) {
  await mkdir(path.dirname(path.join(root, to)), { recursive: true });
  await copyFile(path.join(root, from), path.join(root, to));
  process.stdout.write(`${to}\n`);
}
