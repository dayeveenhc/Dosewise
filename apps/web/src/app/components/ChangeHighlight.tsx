import { useEffect, useRef, useState } from "react";
import type { AgentAction } from "../lib/hermes";
import type { ElderlyTab } from "../screens/elderly/types";
import type { Screen } from "../types";
import { describeBatch, findEntityElement, highlightableEntities, targetFor, testIdFor } from "../lib/changeHighlight";
import { HighlightCaption } from "./HighlightCaption";

// How long to keep polling for the target element(s) after a write. The list
// refetch that surfaces the new/changed records is async (a chat turn just
// committed them), so the elements may not be in the DOM the instant we navigate.
const SEARCH_MS = 5000;
const POLL_MS = 200;
// How long the ring + caption stay up once the first element is found.
const SHOW_MS = 3500;

type Phase = "idle" | "searching" | "shown";

// Guided Auto-Navigation's canonical "prove exactly what changed" layer. Given a
// committed AgentAction that carries entity_type/entity_id/changed_fields — or a
// BULK action carrying entities[] — it:
//   1. navigates ONCE to the (first) entity's home screen,
//   2. finds each affected DOM record by data-testid="{entity_type}-{entity_id}"
//      (polling, since the list refetch is async; scrolls the FIRST found one
//      into view),
//   3. rings ALL affected elements SIMULTANEOUSLY and shows ONE caption — for a
//      single change built FROM changed_fields ("Updated: dose time 6:00 PM →
//      8:00 PM"), for a batch a count-style summary ("Taken: 3 missed doses
//      marked taken"). Simultaneous on purpose: sequential per-record pulses
//      would turn a 15-dose batch into ~45s of forced watching, while rings +
//      a count communicate instantly and each ringed card shows its own state.
//   4. logs LOUDLY if any element genuinely can't be found — never fails
//      silently, even when the rest of the batch was ringed.
// A single action is exactly the 1-element case of this path.
export function ChangeHighlight({ change, mode, onNavigate, onDone }: {
  change: AgentAction | null;
  mode: "elderly" | "caregiver";
  onNavigate: (target: ElderlyTab | Screen) => void;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [rect, setRect] = useState<DOMRect | null>(null);
  // Every ringed element, in the order found. The FIRST found element is the
  // anchor: it's scrolled into view and the caption glues to its rect.
  const elsRef = useRef<HTMLElement[]>([]);
  // Identity token so a new change cancels an in-flight highlight cleanly.
  const runRef = useRef(0);

  useEffect(() => {
    if (!change) return;
    const target = targetFor(change);
    const entities = highlightableEntities(change);
    if (!target || entities.length === 0) {
      // No screen mapping / no resolvable entity — nothing to highlight, but say so.
      console.error("[ChangeHighlight] no screen target for entity_type", change.entity_type, change);
      onDone();
      return;
    }

    const run = ++runRef.current;
    setPhase("searching");
    setRect(null);
    const found: HTMLElement[] = [];
    elsRef.current = found;
    onNavigate(mode === "elderly" ? target.elderly : target.caregiver);

    let pollTimer: number | undefined;
    let showTimer: number | undefined;
    const deadline = Date.now() + SEARCH_MS;
    // Entities whose element hasn't been found yet; keeps shrinking as rings land.
    let pending = entities.slice();

    const cleanupEls = () => {
      for (const el of found) el.classList.remove("change-highlight");
    };

    // Entities that never resolved are a bug worth surfacing — the change
    // committed server-side but the UI can't point at those records. Logged
    // exactly once, at the deadline or when the highlight ends, whichever comes
    // first; the ones that WERE found stay ringed until the highlight ends.
    const reportMissing = () => {
      if (pending.length === 0) return;
      console.error(
        "[ChangeHighlight] element(s) never found for: " +
        pending.map(e => `data-testid="${testIdFor(e)}" (entity_type=${e.entity_type}, entity_id=${e.entity_id})`).join(", ") +
        ` (searched up to ${SEARCH_MS}ms)`,
        change,
      );
      pending = [];
    };

    const finish = () => {
      if (runRef.current !== run) return;
      window.clearTimeout(pollTimer);
      reportMissing();
      cleanupEls();
      setPhase("idle");
      setRect(null);
      onDone();
    };

    const poll = () => {
      if (runRef.current !== run) return;
      const still: typeof pending = [];
      for (const e of pending) {
        const el = findEntityElement(e);
        if (!el) {
          still.push(e);
          continue;
        }
        // Two entities can resolve to the same card via the suffix fallback —
        // count it found, ring it once.
        if (found.includes(el)) continue;
        if (found.length === 0) {
          // First hit anchors everything: scroll it into view, start showing.
          // Do NOT measure here: the smooth scroll hasn't settled, so this rect
          // is stale (the element's pre-scroll position). Enter "shown" with a
          // null rect — the tracking loop below measures once the scroll
          // stabilises, so the first painted caption is at the final position,
          // not a flash.
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          setPhase("shown");
          showTimer = window.setTimeout(finish, SHOW_MS);
        }
        el.classList.add("change-highlight");
        found.push(el);
      }
      pending = still;
      if (pending.length === 0) return; // every entity ringed
      if (Date.now() >= deadline) {
        reportMissing();
        if (found.length === 0) finish();
        return;
      }
      pollTimer = window.setTimeout(poll, POLL_MS);
    };
    poll();

    return () => {
      window.clearTimeout(pollTimer);
      window.clearTimeout(showTimer);
      cleanupEls();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change]);

  // Keep the caption glued to the ANCHOR element while shown (scroll/resize/
  // layout). Two guards live here:
  //   - Stabilise-before-show: only publish a rect once the smooth scrollIntoView
  //     has settled (two consecutive frames at the same top), so the caption
  //     appears at the final position instead of flying in from the stale one.
  //   - Detached-node guard: if the anchor unmounts (e.g. the user switches tab)
  //     while shown, getBoundingClientRect returns a zero rect and the pill jumps
  //     to (0,0). Bail out cleanly the moment it's disconnected — the effect
  //     cleanup above removes the ring from EVERY element, not just the anchor.
  useEffect(() => {
    if (phase !== "shown") return;
    let raf = 0;
    let prevTop = NaN;
    const track = () => {
      const el = elsRef.current[0];
      if (!el || !el.isConnected) {
        // End the whole highlight: strip the ring from EVERY element (not just
        // the detached anchor) — the parent nulling `change` also re-runs the
        // effect cleanup, but don't depend on it for visual correctness.
        for (const ringed of elsRef.current) ringed.classList.remove("change-highlight");
        setPhase("idle");
        setRect(null);
        onDone();
        return;
      }
      const r = el.getBoundingClientRect();
      // Publish only once the scroll has stopped moving (stable top between
      // frames). While scrolling, keep the last published rect (or stay hidden
      // on the very first frames), avoiding the stale first-paint flash.
      if (Math.abs(r.top - prevTop) < 0.5) setRect(r);
      prevTop = r.top;
      raf = requestAnimationFrame(track);
    };
    raf = requestAnimationFrame(track);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  if (phase !== "shown" || !rect || !change) return null;

  const { verb, text } = describeBatch(change);
  return <HighlightCaption rect={rect} verb={verb} text={text} />;
}
