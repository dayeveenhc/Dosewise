import type { WalkthroughStep } from "../types";

const ON_NOTIFICATIONS: WalkthroughStep["screen"] = { mode: "elderly", tab: "notifications" };

// Spotlight tour of the elder Notifications tab (ElderlyNotificationsScreen.tsx)
// — highlight-only skeleton around the mock low-stock/refill row. Owned/refined
// by its scenario agent.
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
    selector: '[data-walk="notif-refill-row"]',
    instructionKey: "walk.notificationsTour.step2",
    waitFor: { type: "acknowledge", source: "dom" },
  },
  {
    id: "notif.ack",
    screen: ON_NOTIFICATIONS,
    selector: '[data-walk="notif-ack-btn"]',
    instructionKey: "walk.notificationsTour.step3",
    waitFor: { type: "click", source: "dom" },
  },
];
