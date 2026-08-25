/**
 * Reverse dependency scanner: finds package.json dependencies that are never
 * referenced from the migrated source (source/ + src/ + test/ + scripts/).
 *
 * Handles: static imports, dynamic import(), require/createRequire string args,
 * and sub-path imports (@scope/pkg/sub -> @scope/pkg).
 *
 * Usage: node scripts/scan-unused-deps.mjs
 */

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const exts = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"]);

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const deps = { ...pkg.dependencies, ...(pkg.optionalDependencies ?? {}) };

// Collect every bare import specifier used anywhere in migrated code.
const used = new Map(); // dep name -> Set(files)
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
      walk(p);
    } else if (exts.has(path.extname(e.name))) {
      const src = fs.readFileSync(p, "utf8");
      const patterns = [
        /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g,
        /createRequire\([^)]*\)\(\s*['"]([^'"]+)['"]/g,
      ];
      for (const re of patterns) {
        let m;
        while ((m = re.exec(src))) {
          const spec = m[1];
          if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) continue;
          const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
          if (!used.has(name)) used.set(name, new Set());
          used.get(name).add(path.relative(root, p));
        }
      }
      // Escape hatch for loader-based references: any quoted string that is
      // exactly a declared dependency name counts as a use (e.g.
      // loadRuntimeDependency("tree-sitter-bash")).
      for (const dep of Object.keys(deps)) {
        if (src.includes(`"${dep}"`) || src.includes(`'${dep}'`)) {
          if (!used.has(dep)) used.set(dep, new Set());
          used.get(dep).add(path.relative(root, p));
        }
      }
    }
  }
}
for (const dir of ["source", "src", "test", "scripts"]) walk(path.join(root, dir));

const rows = [];
for (const dep of Object.keys(deps).sort()) {
  const files = used.get(dep);
  rows.push({ dep, count: files?.size ?? 0, files: [...(files ?? [])].slice(0, 3) });
}

const unused = rows.filter(r => r.count === 0);
const usedRows = rows.filter(r => r.count > 0);

console.log(`依赖总数: ${rows.length}`);
console.log(`\n未引用 (${unused.length}) — 可从 package.json 删除:`);
for (const r of unused) console.log(`  - ${r.dep}`);
console.log(`\n已引用 (${usedRows.length}):`);
for (const r of usedRows) console.log(`  ${r.dep} (${r.count} 文件) 例: ${r.files.join(", ")}`);
