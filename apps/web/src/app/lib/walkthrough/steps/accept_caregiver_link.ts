import type { WalkthroughStep } from "../types";

// Guided Auto-Navigation — CONSENT flow. Mei navigates to the pending caregiver
// request, but the elder taps Accept THEMSELVES (a human waitFor step — never an
// act; linking grants account access). Only after that real, RLS-enforced write
// (ElderlyNotificationsScreen emits "care-link-activated" on success) does the
// final act-less step VERIFY the link is really active.

const ON_NOTIF: WalkthroughStep["screen"] = { mode: "elderly", tab: "notifications" };

export const acceptCaregiverLinkSteps: WalkthroughStep[] = [
  {
    id: "acceptLink.open",
    screen: ON_NOTIF,
    onEnter: ON_NOTIF,
    // The bottom-nav Notifications button (a real <button>); clicking it lands us
    // on the tab and advances.
    selector: '[data-tour="nav-notifications"]',
    instructionKey: "walk.acceptLink.open",
    act: { kind: "click", selector: '[data-tour="nav-notifications"]' },
  },
  {
    id: "acceptLink.accept",
    screen: ON_NOTIF,
    // Consent: the elder taps Accept. NO `act` — Mei must never auto-grant
    // account access. Ends only on the real, committed activation.
    selector: '[data-walk^="care-link-accept-"]',
    instructionKey: "walk.acceptLink.accept",
    waitFor: { type: "write-committed", source: "app-event", event: "care-link-activated" },
    skippable: false,
  },
  {
    id: "acceptLink.verify",
    screen: ON_NOTIF,
    // Act-less Verify: re-query care_links to confirm the link is really active
    // before the walkthrough finishes.
    selector: '[data-tour="nav-notifications"]',
    instructionKey: "walk.acceptLink.verify",
    verify: { kind: "care-link-active" },
    reveal: { screen: ON_NOTIF, selector: '[data-tour="nav-notifications"]' },
  },
];
