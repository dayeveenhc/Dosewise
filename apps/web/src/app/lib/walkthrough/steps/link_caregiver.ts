import type { WalkthroughStep } from "../types";

// Linking a caregiver to an elder's account is genuinely TWO independent
// walkthroughs, run on two different signed-in accounts (often two different
// devices, possibly hours apart) — not one continuous flow. The caregiver
// scans the elder's QR and sends a request (ScanLinkSheet.tsx); the elder
// shows their QR, then later opens Notifications and accepts. Per
// supabase/migrations/0005_care_links_consent_hardening.sql, the elder's own
// accept tap is the ONLY code path that can ever activate the link — which is
// why that step carries no `act`: no act means the overlay never classes it as
// autonomous, so it renders no Next and Mei cannot advance past it.

export const caregiverLinkRequestSteps: WalkthroughStep[] = [
  {
    id: "link.cg.open-switcher",
    screen: { mode: "caregiver", screen: "dashboard" },
    selector: '[data-tour="cg-patientswitcher"]',
    instructionKey: "walk.link.openSwitcher",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "link.cg.tap-scan-qr",
    screen: { mode: "caregiver", screen: "dashboard" },
    selector: '[data-walk="patientswitcher-scan-qr"]',
    instructionKey: "walk.link.tapScanQr",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "link.cg.scan-camera",
    screen: { mode: "caregiver", screen: "dashboard" }, // ScanLinkSheet is a modal, not a route
    selector: "#care-link-scanner",
    instructionKey: "walk.link.holdUpCamera",
    // Not a tap/keystroke — the camera reacting to a real QR code, still
    // fully user-driven (the human is physically pointing the phone). A DOM
    // click/input listener has nothing to attach to here.
    waitFor: { type: "automatic-detection", source: "app-event", event: "qr-code-decoded" },
    timeoutMs: 20000,
  },
  {
    id: "link.cg.pick-relationship",
    screen: { mode: "caregiver", screen: "dashboard" },
    selector: '[data-walk="scanlink-relationship-chips"] button',
    instructionKey: "walk.link.pickRelationship",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "link.cg.send-request",
    screen: { mode: "caregiver", screen: "dashboard" },
    selector: '[data-walk="scanlink-send-button"]',
    instructionKey: "walk.link.sendRequest",
    // Gated on createLinkRequest resolving "sent"/"already_pending" — the
    // "already_active"/"self"/"error" branches must NOT satisfy this.
    waitFor: { type: "write-committed", source: "app-event", event: "care-link-request-sent" },
    timeoutMs: 20000, // a signal that never arrives must surface, not hang
  },
];

export const elderLinkSteps: WalkthroughStep[] = [
  {
    id: "link.elder.go-to-settings",
    screen: { mode: "elderly", tab: "settings" },
    onEnter: { mode: "elderly", tab: "settings" },
    selector: '[data-tour="nav-settings"]',
    instructionKey: "walk.link.goToSettings",
    // Mei taps Settings herself (mirrors accept_caregiver_link.ts's first step).
    // This was a `navigation` waitFor whose `to` equalled its own `screen`, and
    // the overlay's guard is `sameScreen(cur, to) && !sameScreen(cur, screen)`
    // — with to === screen that is `X && !X`, i.e. NEVER true. Combined with an
    // onEnter that pre-navigated there, the step could not be satisfied even in
    // principle: the elder side of link_caregiver was dead at step 1.
    act: { kind: "click", selector: '[data-tour="nav-settings"]' },
  },
  {
    // Mei reveals the code first. Without this step the next one spotlighted
    // `elder-qr-gotit`, which only mounts inside `{showQr && …}` — and nothing
    // anywhere pointed at the button that flips it, so the flow dead-ended here
    // with a "can't find that" and only Exit. Same class as the deleted
    // `elder-emergency-section` anchor.
    id: "link.elder.reveal-qr",
    screen: { mode: "elderly", tab: "settings" },
    selector: '[data-walk="elder-qr-show"]',
    instructionKey: "walk.link.revealQr",
    act: { kind: "click", selector: '[data-walk="elder-qr-show"]' },
  },
  {
    id: "link.elder.show-qr",
    screen: { mode: "elderly", tab: "settings" },
    selector: '[data-walk="elder-qr-gotit"]',
    instructionKey: "walk.link.showQr",
    // No DOM signal exists for "showed this to someone" (a physical action
    // outside the app) — a tap on the shown code is the least-arbitrary real
    // action available; see ElderlySettingsScreen.tsx's QR button.
    waitFor: { type: "acknowledge", source: "dom" },
  },
  // --- real-world time gap: minutes or days before the caregiver scans and
  // the request lands in Notifications ---
  {
    id: "link.elder.open-notifications",
    screen: { mode: "elderly", tab: "notifications" },
    onEnter: { mode: "elderly", tab: "notifications" },
    selector: '[data-tour="nav-notifications"]',
    instructionKey: "walk.link.openNotifications",
    // Same unsatisfiable-navigation fix as the Settings step above.
    act: { kind: "click", selector: '[data-tour="nav-notifications"]' },
  },
  {
    id: "link.elder.accept",
    screen: { mode: "elderly", tab: "notifications" },
    // Parameterized per pending request (ElderlyNotificationsScreen.tsx) — an
    // attribute-prefix selector matches whichever request is showing.
    selector: '[data-walk^="care-link-accept-"]',
    instructionKey: "walk.link.acceptRequest",
    waitFor: { type: "write-committed", source: "app-event", event: "care-link-activated" },
    timeoutMs: 20000, // a signal that never arrives must surface, not hang
  },
];
