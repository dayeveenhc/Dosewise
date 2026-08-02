import type { WalkthroughStep } from "../types";

const ON_NOTIFICATIONS: WalkthroughStep["screen"] = { mode: "elderly", tab: "notifications" };

// Spotlight tour of the elder Notifications tab (ElderlyNotificationsScreen.tsx),
// centred on the MOCK low-stock/refill alert (there is no live push infra — the
// card is a static demo row carrying the stable anchors notif-refill-row /
// notif-ack-btn). Owned by the s19 low-stock-reorder scenario agent.
//
// Steps 1 and 3 are `act` and step 2 is an act-less `reveal` (the alert row is
// a plain container with no click handler, so pretending to click it would be a
// lie) → all three are autonomous, each gets a PaceController, and each holds at
// its commit gate until the person taps Next. Nothing advances on a timer.
//
// Step 1 has NO onEnter: its whole point is the person tapping Notifications to
// travel there (the nav is always mounted, so it needs no screen switch first).
// Steps 2–3 DO carry onEnter: they spotlight controls that only mount on the
// Notifications tab, so — mirroring request_refill's per-step onEnter — they
// assert the tab even though step 1's tap already switched it (a harmless no-op
// if already there), keeping the target present no matter the entry point.
// AI-automated (2026-07-28): Mei auto-advances the spotlight herself at the slow
// PACING rate — the person just watches. The card is a static mock (no real
// notification is dismissed on the backend), so auto-clicking through it is safe.
export const notificationsTourSteps: WalkthroughStep[] = [
  {
    id: "notif.go-to-notifications",
    screen: ON_NOTIFICATIONS,
    selector: '[data-tour="nav-notifications"]', // ElderlyApp bottom nav — always mounted
    instructionKey: "walk.notificationsTour.step1",
    act: { kind: "click", selector: '[data-tour="nav-notifications"]' },
  },
  {
    id: "notif.refill-row",
    screen: ON_NOTIFICATIONS,
    onEnter: ON_NOTIFICATIONS,
    selector: '[data-walk="notif-refill-row"]',
    instructionKey: "walk.notificationsTour.step2",
    // The alert row is a plain container with no click handler — act:click here
    // did nothing while reporting an interaction. Pulse it honestly instead.
    reveal: { screen: ON_NOTIFICATIONS, selector: '[data-walk="notif-refill-row"]' },
  },
  {
    id: "notif.ack",
    screen: ON_NOTIFICATIONS,
    onEnter: ON_NOTIFICATIONS,
    selector: '[data-walk="notif-ack-btn"]',
    instructionKey: "walk.notificationsTour.step3",
    // Tapping Got it dismisses the mock card and completes the tour.
    act: { kind: "click", selector: '[data-walk="notif-ack-btn"]' },
  },
];
