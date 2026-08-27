import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

const root = process.cwd();
const exts = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"]);
const builtins = new Set(builtinModules);
const found = new Set();

function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      walk(p);
    } else if (exts.has(path.extname(e.name))) {
      try {
        const s = fs.readFileSync(p, "utf8");
        const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
        let m;
        while ((m = re.exec(s))) {
          const spec = m[1];
          if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) continue;
          const at = spec.startsWith("@");
          const parts = spec.split("/");
          const name = at ? parts.slice(0, 2).join("/") : parts[0];
          if (!builtins.has(name) && !name.startsWith("@types/")) found.add(name);
        }
      } catch {}
    }
  }
}

walk(path.join(root, "src"));

const inst = new Set();
for (const n of fs.readdirSync(path.join(root, "node_modules"))) {
  if (n.startsWith(".")) continue;
  if (n.startsWith("@")) {
    if (n === "@types") continue;
    try {
      for (const s of fs.readdirSync(path.join(root, "node_modules", n))) inst.add(`${n}/${s}`);
    } catch {}
  } else inst.add(n);
}

const missing = [...found].filter((n) => !inst.has(n)).sort();
console.log(`缺失依赖 (${missing.length}):`);
console.log(missing.join("\n"));
