import type { WalkthroughStep } from "../types";

// Requesting a refill is deliberately NOT folded into AddPrescriptionSheet
// (that's for a *new* prescription) — it rides the chat -> request_refill path
// (services/hermes/src/hermes/tools/refills.py), which queues the request in the
// Ask-a-Doctor thread (the caregiver sees it too), NOT the pill-count table,
// reached via a "Request refill" button added to the Supply block
// (ElderlyPrescriptionScreen.tsx) that opens Ask Mei with the message
// pre-filled — the elder still taps Send themselves.
export const requestRefillSteps: WalkthroughStep[] = [
  {
    id: "refill.tap-request",
    screen: { mode: "elderly", tab: "prescriptions" },
    // Mei triggers this walkthrough from chat (the AI tab), so the first step
    // must switch to Prescriptions itself — otherwise the spotlight target
    // (`med-request-refill-btn`, rendered only on Prescriptions) never mounts
    // and the user-driven step can't advance (no Next on waitFor steps). Mirrors
    // step 2's onEnter to the AI tab.
    onEnter: { mode: "elderly", tab: "prescriptions" },
    selector: '[data-walk="med-request-refill-btn"]',
    instructionKey: "walk.refill.tapRequest",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "refill.send-message",
    screen: { mode: "elderly", tab: "ai" },
    onEnter: { mode: "elderly", tab: "ai" },
    selector: '[data-walk="elder-ai-send-button"]',
    instructionKey: "walk.refill.sendMessage",
    // The elder's own tap on Send — Mei never sends the pre-filled message
    // on their behalf.
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "refill.confirmed",
    screen: { mode: "elderly", tab: "ai" },
    selector: '[data-walk="elder-ai-send-button"]',
    instructionKey: "walk.refill.confirmed",
    // Gated on Hermes's committed_actions containing request_refill (the refill
    // request lands in the Ask-a-Doctor thread, not the pill-count table), never
    // tools_used/actions alone (CONTEXT.md's propose-vs-commit distinction) — a
    // DOM click/navigation listener can't know whether the turn actually wrote
    // anything or just chatted.
    waitFor: { type: "agent-action-committed", source: "app-event", tool: "request_refill" },
    timeoutMs: 20000,
  },
];
