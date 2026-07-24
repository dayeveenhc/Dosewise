import { useEffect, useRef, useState } from "react";
import type { AgentAction } from "../lib/hermes";
import type { ElderlyTab } from "../screens/elderly/types";
import type { Screen } from "../types";
import { describeChange, findEntityElement, targetFor, testIdFor } from "../lib/changeHighlight";
import { HighlightCaption } from "./HighlightCaption";

// How long to keep polling for the target element after a write. The list refetch
// that surfaces the new/changed record is async (a chat turn just committed it),
// so the element may not be in the DOM the instant we navigate.
const SEARCH_MS = 5000;
const POLL_MS = 200;
// How long the ring + caption stay up once the element is found.
const SHOW_MS = 3500;

type Phase = "idle" | "searching" | "shown";

// Guided Auto-Navigation's canonical "prove exactly what changed" layer. Given a
// committed AgentAction that carries entity_type/entity_id/changed_fields, it:
//   1. navigates to that entity_type's home screen,
//   2. finds the exact DOM record by data-testid="{entity_type}-{entity_id}"
//      (polling, since the list refetch is async; scrolls it into view),
//   3. pulses a ring AROUND that element and shows a caption built FROM
//      changed_fields (e.g. "Updated: dose time 6:00 PM → 8:00 PM"),
//   4. logs LOUDLY if the element genuinely can't be found — never fails silently.
// Replaces the old name-string match + selector pulse for the flows it covers.
export function ChangeHighlight({ change, mode, onNavigate, onDone }: {
  change: AgentAction | null;
  mode: "elderly" | "caregiver";
  onNavigate: (target: ElderlyTab | Screen) => void;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [rect, setRect] = useState<DOMRect | null>(null);
  const elRef = useRef<HTMLElement | null>(null);
  // Identity token so a new change cancels an in-flight highlight cleanly.
  const runRef = useRef(0);

  useEffect(() => {
    if (!change) return;
    const target = targetFor(change);
    if (!target) {
      // No screen mapping for this entity_type — nothing to highlight, but say so.
      console.error("[ChangeHighlight] no screen target for entity_type", change.entity_type, change);
      onDone();
      return;
    }

    const run = ++runRef.current;
    setPhase("searching");
    setRect(null);
    elRef.current = null;
    onNavigate(mode === "elderly" ? target.elderly : target.caregiver);

    let pollTimer: number | undefined;
    let showTimer: number | undefined;
    const deadline = Date.now() + SEARCH_MS;

    const cleanupEl = () => {
      elRef.current?.classList.remove("change-highlight");
    };

    const finish = () => {
      if (runRef.current !== run) return;
      cleanupEl();
      setPhase("idle");
      setRect(null);
      onDone();
    };

    const poll = () => {
      if (runRef.current !== run) return;
      const el = findEntityElement(change);
      if (el) {
        elRef.current = el;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("change-highlight");
        setRect(el.getBoundingClientRect());
        setPhase("shown");
        showTimer = window.setTimeout(finish, SHOW_MS);
        return;
      }
      if (Date.now() >= deadline) {
        // The element truly isn't on screen. This is a bug worth surfacing — the
        // change committed server-side but the UI can't point at it.
        console.error(
          `[ChangeHighlight] element not found for data-testid="${testIdFor(change)}" ` +
          `(entity_type=${change.entity_type}, entity_id=${change.entity_id}) after ${SEARCH_MS}ms`,
          change,
        );
        finish();
        return;
      }
      pollTimer = window.setTimeout(poll, POLL_MS);
    };
    poll();

    return () => {
      window.clearTimeout(pollTimer);
      window.clearTimeout(showTimer);
      cleanupEl();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change]);

  // Keep the caption glued to the element while it's shown (scroll/resize/layout).
  useEffect(() => {
    if (phase !== "shown") return;
    let raf = 0;
    const track = () => {
      if (elRef.current) setRect(elRef.current.getBoundingClientRect());
      raf = requestAnimationFrame(track);
    };
    raf = requestAnimationFrame(track);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  if (phase !== "shown" || !rect || !change) return null;

  const { verb, text } = describeChange(change);
  return <HighlightCaption rect={rect} verb={verb} text={text} />;
}
