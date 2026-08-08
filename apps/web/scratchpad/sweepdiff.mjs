/**
 * Diff two highlight-sweep reports on (task, shell, step, kind).
 *
 * NOT on the whole row: the iOS status bar grew 28->40px on 2026-08-08, which
 * shifts every target down ~12px, so every `detail` string's coordinates differ even
 * where nothing regressed. Keying on detail would report the entire baseline as
 * both removed and re-added.
 *
 * Usage: node scratchpad/sweepdiff.mjs <baseline.json> <fresh.json>
 */
import { readFileSync } from "node:fs";

const [, , basePath, freshPath] = process.argv;
const load = p => JSON.parse(readFileSync(p, "utf8"));
const base = load(basePath);
const fresh = load(freshPath);

const key = f => `${f.task}|${f.shell}|${f.step}|${f.kind}`;
const index = rs => new Map(rs.map(f => [key(f), f]));
const B = index(base.findings);
const F = index(fresh.findings);

// The kinds that must never be non-zero. A green run means these are absent
// regardless of what else moved.
const GATE = [/^cutout-misaligned$/, /^glow-/, /^nav-cutout-/, /^nav-glow-/, /^change-/, /^zoom-boundary-not-reached$/];

const counts = rs => rs.reduce((m, f) => (m[f.kind] = (m[f.kind] ?? 0) + 1, m), {});
console.log(`baseline ${basePath}: ${base.findings.length} findings, ${base.log.length} log rows`);
console.log(`fresh    ${freshPath}: ${fresh.findings.length} findings, ${fresh.log.length} log rows, pool=${JSON.stringify(fresh.pool)}`);
console.log("\nbaseline kinds:", JSON.stringify(counts(base.findings)));
console.log("fresh kinds:   ", JSON.stringify(counts(fresh.findings)));

const gateHits = fresh.findings.filter(f => GATE.some(re => re.test(f.kind)));
console.log(`\n=== HARD GATE (must be empty): ${gateHits.length} ===`);
for (const f of gateHits) console.log(`  !! ${key(f)} :: ${f.detail}`);

const added = [...F.values()].filter(f => !B.has(key(f)));
const gone = [...B.values()].filter(f => !F.has(key(f)));

console.log(`\n=== NEW vs baseline: ${added.length} ===`);
for (const f of added) console.log(`  + ${f.task} | ${f.shell} | #${f.step} ${f.stepId} | ${f.kind}\n      ${f.detail}`);

console.log(`\n=== GONE (baseline rows not reproduced): ${gone.length} ===`);
for (const f of gone) console.log(`  - ${f.task} | ${f.shell} | #${f.step} ${f.stepId} | ${f.kind}`);

// Log rows matter as much as findings: a task that never started reports no
// geometry at all, which reads as "clean" unless you look here.
const logKey = l => `${l.task}|${l.shell}`;
const BL = new Map(base.log.map(l => [logKey(l), l]));
console.log(`\n=== TASK COVERAGE ===`);
for (const l of fresh.log) {
  const prev = BL.get(logKey(l));
  const delta = prev && prev.visited !== l.visited ? `  (was ${prev.visited})` : "";
  console.log(`  ${l.task} | ${l.shell} | visited=${l.visited}${delta}${l.stoppedAt ? ` | stopped: ${l.stoppedAt}` : ""}`);
}
const missing = base.log.filter(l => !fresh.log.some(x => logKey(x) === logKey(l)));
if (missing.length) console.log(`\n  !! tasks in baseline but NOT in this run: ${missing.map(logKey).join(", ")}`);
