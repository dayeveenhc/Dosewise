// Item 4 live check: does a CONVERSATIONAL yes/no now arrive with tappable
// answers instead of forcing the person to type?
//
// The web chat renders buttons from exactly two signals (lib/chatChoices.ts):
// `choices` (the offer_choices tool) or `awaiting_confirmation` (set only by a
// tool's PROPOSE branch). A question with no tool behind it — "Shall I look
// that up for you?" — used to carry neither. The fix is a prompt one (soul.md +
// prompts.py's ANSWER BUTTONS block + a widened offer_choices description), so
// it is probabilistic: this samples it rather than proving it.
//
// Reuses an account from scratchpad/.dw-elder-pool.json so it costs no Supabase
// signup. Run against the SCRATCH hermes on :8901, never pm2's :8000/:5010:
//
//   node scratchpad/yesno-check.mjs            (from apps/web)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n").filter(l => l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

// Hermes rate-limits per user, and this script burns several turns — pick a
// different pooled account with ACCT=n when one gets 429'd.
const pool = JSON.parse(readFileSync("scratchpad/.dw-elder-pool.json", "utf8"));
const accounts = pool.elder?.accounts ?? pool.elder ?? [];
const creds = accounts[Number(process.env.ACCT ?? 0) % Math.max(accounts.length, 1)];
if (!creds) throw new Error("no pooled elder to borrow — run the sweep first, or use createThrowawayElder");

const supa = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
const { data, error } = await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
if (error) throw new Error(`sign-in failed: ${error.message}`);
const jwt = data.session.access_token;

// Deliberately NOT a medication add: that routes to a propose→confirm tool,
// which sets awaiting_confirmation and would have produced buttons even before
// this change. These are questions Mei answers conversationally.
const PROMPTS = [
  "What is metformin for?",
  "I have been feeling dizzy in the mornings.",
  "Can you help me with my medicines?",
  "I keep forgetting my evening tablet.",
  "My knee has been sore for a week.",
  "I want to ask my doctor something next visit.",
];

let withButtons = 0;
// STREAM_ONLY=1 skips straight to the stream check below — the REST loop burns
// six turns of this account's rate-limit allowance.
for (const message of (process.env.STREAM_ONLY ? [] : PROMPTS)) {
  const resp = await fetch("http://127.0.0.1:8901/agent/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hermes-Api-Key": env.VITE_HERMES_API_KEY ?? "" },
    body: JSON.stringify({ message, jwt, app_role: "elder" }),
  });
  const body = await resp.json();
  const choices = body.choices ?? null;
  const awaiting = body.awaiting_confirmation ?? false;
  // What the browser would actually paint, per lib/chatChoices.ts::buttonsFor.
  const paints = !!(choices?.length) || awaiting;
  if (paints) withButtons++;
  const reply = String(body.reply ?? "").replace(/\s+/g, " ");
  console.log(`\n─ "${message}"`);
  console.log(`  http=${resp.status} tools=${JSON.stringify(body.tools_used ?? [])}`);
  console.log(`  reply: ${reply.slice(0, 200)}${reply.length > 200 ? "…" : ""}`);
  console.log(`  choices=${JSON.stringify(choices)} awaiting_confirmation=${awaiting}`);
  console.log(`  => browser paints answer buttons: ${paints ? "YES" : "no"}`);
  // Regression guard on the other half of item 4: Mei must not tell a web user
  // to tap a symbol that only exists on Telegram.
  if (/tap\s*✅|press\s*✅|✅\s*button/i.test(reply)) {
    console.log("  !! reply tells the person to tap ✅ — soul.md leak");
  }
}
console.log(`\n[ITEM 4] ${withButtons}/${PROMPTS.length} conversational turns carried tappable answers`);

// The ELDER chat uses /agent/turn/stream, not /agent/turn — MEMORY's harness
// trap #1 is a whole debugging session lost to assuming otherwise. The two
// `final` shapes have diverged on `choices` before, so prove it on the wire.
const streamResp = await fetch("http://127.0.0.1:8901/agent/turn/stream", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Hermes-Api-Key": env.VITE_HERMES_API_KEY ?? "" },
  body: JSON.stringify({ message: "My knee has been sore for a week.", jwt, app_role: "elder" }),
});
const raw = await streamResp.text();
const final = raw.split("\n")
  .filter(l => l.startsWith("data:"))
  .map(l => { try { return JSON.parse(l.slice(5)); } catch { return null; } })
  .filter(Boolean)
  .find(f => f.type === "final");
const sReply = String(final?.reply ?? "").replace(/\s+/g, " ");
const lastLine = String(final?.reply ?? "").trim().split("\n").filter(l => l.trim()).pop() ?? "";
console.log(`\n[ITEM 4 stream] http=${streamResp.status} final keys=${JSON.stringify(Object.keys(final ?? {}))}`);
console.log(`[ITEM 4 stream] reply: ${sReply.slice(0, 220)}`);
// The gate only spends a completion when the LAST line ends in a question mark,
// so an absent `choices` is only a divergence if this says true.
console.log(`[ITEM 4 stream] last line ends in '?': ${/[?？]$/.test(lastLine.trim())}`);
console.log(`[ITEM 4 stream] final.choices=${JSON.stringify(final?.choices ?? null)}`);
console.log(`[ITEM 4 stream] elder chat would paint buttons: ${(final?.choices?.length ?? 0) > 0 ? "YES" : "no"}`);
