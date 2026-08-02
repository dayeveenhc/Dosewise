import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, createThrowawayElder, parkOnChat,
  saveTurnArtifact, signIn, startWalkthrough, walkthroughStep,
  advanceWalkthroughUntil,
} from "../helpers";
import type { TurnResult } from "../helpers";

// s33 walkthrough re-run + real-chat entry — REGRESSION.
//
// Two structural blind spots in the rest of the suite, both of which hid a real
// user-reported defect:
//
//  A. NOTHING ever ran the same walkthrough TWICE on one elder. Every other
//     scenario uses a fresh elder with an empty `completedWalkthroughs`, so a
//     39/39 green suite still shipped "the guided walkthrough for adding
//     medicine doesn't work any more" — once add_prescription_auto completed, it
//     landed in profiles.accessibility.completedWalkthroughs and prompts.py's
//     "already shown" rail told Mei never to guide them through it again. The
//     *_auto family is not a tutorial; it is HOW the write is performed.
//
//  B. Every walkthrough spec enters via the DEV window.__dwStartWalkthrough hook
//     immediately after signIn — i.e. from the HOME tab. In production a
//     walkthrough is queued by a Hermes reply while the person is sitting on the
//     Ask Mei tab in CHAT mode. Screens don't remount on a tab that's already
//     showing, so a tour's first target can be absent on exactly the path
//     nothing tested.
const ARTIFACTS = "e2e/artifacts/s33";
const SHOTS = "e2e/design-shots/scenarios/s33";

test("s33a: a completed *_auto walkthrough is still offered and still runs the second time", async () => {
  test.setTimeout(180_000);

  // The SAME dialogue s01 drives — opening → frequency → confirm — because
  // soul.md's contract is propose (add_prescription, confirmed=false) → confirm
  // → start_walkthrough. One message can never reach the walkthrough, and
  // shouldn't: the interaction check has to run first. The only difference from
  // s01 is that this elder has already completed add_prescription_auto.
  //
  // Retries create a FRESH elder and re-run the WHOLE dialogue: Hermes replays
  // per-elder_id session history, so re-asking on one elder means later attempts
  // read the earlier replies as context and follow them — effective attempt
  // count 1, not 3 (MEMORY.md's 2026-08-02 entry, which bit s03 and s32).
  const supa = anonClient();
  let queued: TurnResult["walkthrough"] = null;
  let committedWrite = false;
  let lastReply = "";

  for (let attempt = 1; attempt <= 3 && !queued; attempt++) {
    const creds = await createThrowawayElder();
    const { data, error } = await supa.auth.signInWithPassword({
      email: creds.email, password: creds.password,
    });
    expect(error, error?.message).toBeNull();
    const jwt = data!.session!.access_token;

    // Mark it done exactly as a real completion would (lib/profile.ts's
    // markWalkthroughCompleted read-merge-writes this same key).
    const { error: pErr } = await supa
      .from("profiles")
      .update({ accessibility: { completedWalkthroughs: ["add_prescription_auto"] } })
      .eq("id", creds.userId);
    expect(pErr, pErr?.message).toBeNull();

    const messages = [
      "The doctor gave me a new medicine — Lisinopril, 10mg, for blood pressure",
      "Once a day, in the morning",
      "yes please",
      "yes please",
    ];
    for (let i = 0; i < messages.length && !queued; i++) {
      const t = await agentTurn8901(jwt, messages[i]);
      saveTurnArtifact(ARTIFACTS, `a${attempt}-turn-${i + 1}`, t);
      expect(t.http).toBe(200);
      lastReply = t.reply;
      if (t.actions.some(a => a.tool === "add_prescription")) committedWrite = true;
      if (t.walkthrough?.task_name === "add_prescription_auto") queued = t.walkthrough;
      console.log(`[s33a] a${attempt}.${i + 1}: tools=${JSON.stringify(t.tools_used)} walk=${JSON.stringify(t.walkthrough)}`);
    }
  }

  // THE assertion. Before the fix, add_prescription_auto sitting in
  // completedWalkthroughs put it in the prompt's "ALREADY been shown … DO NOT
  // offer to show, guide, walk, or take them through it again" block — so a
  // patient adding their SECOND medicine never got the walkthrough at all and
  // Mei silently did a direct write instead.
  expect(
    queued?.task_name,
    `add_prescription_auto was already marked complete, and the full propose→confirm ` +
    `dialogue still has to reach it. last reply="${lastReply.slice(0, 200)}"`,
  ).toBe("add_prescription_auto");
  expect(queued?.params?.name, "walkthrough carries the real drug name").toBe("Lisinopril");
  // And the safety rail still holds: the chat never commits the write itself.
  expect(committedWrite, "chat must not commit the write directly on web").toBe(false);
});

test("s33b: a walkthrough launched while the chat is open still finds its first target", async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });

  const creds = await createThrowawayElder();
  await signIn(page, creds);

  // Put the app where a real chat-launched walkthrough actually starts from:
  // the AI tab, in CHAT mode. travel_mode_auto's first step targets
  // [data-walk="elder-cat-medicines"], which ONLY exists in the help view — and
  // a tour's onEnter can only switch tabs, so on this path the screen never
  // reset and the very first act failed. Deterministic (no LLM routing).
  await parkOnChat(page);
  await startWalkthrough(page, "travel_mode_auto", {
    start_date: "2026-09-01", end_date: "2026-09-10", timezone: "Japan (UTC+9)",
  });

  const first = await walkthroughStep(page);
  expect(first, "the overlay never mounted").not.toBeNull();

  // It must actually MOVE. A stalled tour shows "I can't find that on this
  // screen" and hides Next — reaching step 2 proves the first act ran.
  await advanceWalkthroughUntil(page, async () => ((await walkthroughStep(page))?.current ?? 0) >= 2, 4);
  await expect(page.getByText(/can't find that on this screen/i)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/chat-entry-step2.png` });
});
