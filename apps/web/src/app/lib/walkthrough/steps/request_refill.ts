import type { WalkthroughStep } from "../types";

// Requesting a refill is deliberately NOT folded into AddPrescriptionSheet
// (that's for a *new* prescription) — it rides the existing, zero-new-backend
// chat -> log_refill path (services/hermes/src/hermes/tools/refills.py),
// reached via a "Request refill" button added to the Supply block
// (ElderlyPrescriptionScreen.tsx) that opens Ask Mei with the message
// pre-filled — the elder still taps Send themselves.
export const requestRefillSteps: WalkthroughStep[] = [
  {
    id: "refill.tap-request",
    screen: { mode: "elderly", tab: "prescriptions" },
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
    // Gated on Hermes's committed_actions containing log_refill, never
    // tools_used/actions alone (CONTEXT.md's propose-vs-commit distinction) —
    // a DOM click/navigation listener can't know whether the turn actually
    // wrote anything or just chatted.
    waitFor: { type: "agent-action-committed", source: "app-event", tool: "log_refill" },
    timeoutMs: 20000,
  },
];
