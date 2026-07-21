// Completeness gate: (a) all 6 language tables have identical key sets,
// (b) every t(lang, "key") literal used across src/ resolves to a real key.
// Not checked into the repo — recreate from CLAUDE.md's pointer if needed.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const LANGS = ["en", "zh", "hokkien", "yue", "ta", "ms"];

const langSrc = readFileSync(join(ROOT, "src/app/lib/language.ts"), "utf8");
const lines = langSrc.split("\n");
const starts = {};
for (const l of LANGS) starts[l] = lines.findIndex(x => x === `  ${l}: {`);
const ends = {};
for (const l of LANGS) {
  for (let i = starts[l] + 1; i < lines.length; i++) if (lines[i] === "  },") { ends[l] = i; break; }
}
const keysets = {};
for (const l of LANGS) {
  const body = lines.slice(starts[l] + 1, ends[l]).join("\n");
  keysets[l] = new Set([...body.matchAll(/^\s*"([^"]+)":/gm)].map(m => m[1]));
}

let ok = true;
const enKeys = keysets.en;
for (const l of LANGS) {
  const missing = [...enKeys].filter(k => !keysets[l].has(k));
  const extra = [...keysets[l]].filter(k => !enKeys.has(k));
  if (missing.length || extra.length) {
    ok = false;
    console.error(`[${l}] missing: ${missing.length}, extra: ${extra.length}`);
    if (missing.length) console.error("  missing:", missing);
    if (extra.length) console.error("  extra:", extra);
  }
}
console.log(`Key parity: ${enKeys.size} keys x ${LANGS.length} languages${ok ? " — OK" : " — FAILED"}`);

// Walk src/ for every t(..., "literal-key") call and confirm it resolves.
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) { if (entry !== "node_modules") walk(p, out); }
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(p);
  }
  return out;
}
const files = walk(join(ROOT, "src"));
const used = new Set();
const callRe = /\bt\(\s*(?:language|lang)\s*,\s*"([^"]+)"/g;
for (const f of files) {
  const content = readFileSync(f, "utf8");
  for (const m of content.matchAll(callRe)) used.add(m[1]);
}
const unresolved = [...used].filter(k => !enKeys.has(k));
if (unresolved.length) {
  ok = false;
  console.error(`Unresolved t() keys (${unresolved.length}):`, unresolved);
} else {
  console.log(`All ${used.size} used t() keys resolve — OK`);
}

process.exit(ok ? 0 : 1);
