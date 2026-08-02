import type { WalkthroughStep } from "../types";

const ON_NOTIFICATIONS: WalkthroughStep["screen"] = { mode: "elderly", tab: "notifications" };

// Spotlight tour of the elder Notifications tab (ElderlyNotificationsScreen.tsx),
// centred on the MOCK low-stock/refill alert (there is no live push infra — the
// card is a static demo row carrying the stable anchors notif-refill-row /
// notif-ack-btn). Owned by the s19 low-stock-reorder scenario agent.
//
// Every step is user-driven (waitFor, never `act`) → the overlay classes the
// tour as non-autonomous, so it renders Exit but NO Next button (the whole
// Next/Replay block in Walkthrough.tsx is gated on `autonomous`). The person
// taps each real control themselves, exactly like the request_refill consent
// flow. Because nothing is paced (no PaceController is instantiated for waitFor
// steps), the tour records ZERO walkthrough phase-log entries — the honest shape
// a user-driven tour has.
//
// Step 1 has NO onEnter: its whole point is the person tapping Notifications to
// travel there (the nav is always mounted, so it needs no screen switch first).
// Steps 2–3 DO carry onEnter: they spotlight controls that only mount on the
// Notifications tab, so — mirroring request_refill's per-step onEnter — they
// assert the tab even though step 1's tap already switched it (a harmless no-op
// if already there), keeping the target present no matter the entry point.
export const notificationsTourSteps: WalkthroughStep[] = [
  {
    id: "notif.go-to-notifications",
    screen: ON_NOTIFICATIONS,
    selector: '[data-tour="nav-notifications"]', // ElderlyApp bottom nav — always mounted
    instructionKey: "walk.notificationsTour.step1",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "notif.refill-row",
    screen: ON_NOTIFICATIONS,
    onEnter: ON_NOTIFICATIONS,
    selector: '[data-walk="notif-refill-row"]',
    instructionKey: "walk.notificationsTour.step2",
    // "acknowledge" is satisfied by a real click on the spotlighted row itself
    // (Walkthrough.tsx treats click|acknowledge identically) — the person taps
    // the alert to read it, NOT the Got it button inside it (that's step 3).
    waitFor: { type: "acknowledge", source: "dom" },
  },
  {
    id: "notif.ack",
    screen: ON_NOTIFICATIONS,
    onEnter: ON_NOTIFICATIONS,
    selector: '[data-walk="notif-ack-btn"]',
    instructionKey: "walk.notificationsTour.step3",
    // Tapping Got it dismisses the mock card AND, as the last step, completes
    // the tour (the click bubbles to the button's own waitFor listener).
    waitFor: { type: "click", source: "dom" },
  },
];
