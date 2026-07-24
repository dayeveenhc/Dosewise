import type { WalkthroughStep } from "../types";

const ON_AI: WalkthroughStep["screen"] = { mode: "elderly", tab: "ai" };

// Travel Mode setup — apps/web/src/app/screens/TravelModeSheet.tsx. The sheet
// opens as a modal over the elder chat tab (no screen switch of its own), so
// every step stays on { mode: "elderly", tab: "ai" }.
export const travelModeSetupSteps: WalkthroughStep[] = [
  {
    id: "travel.open-quickhelp",
    screen: ON_AI,
    selector: '[data-tour="elder-quickhelp"]', // ElderlyAIScreen.tsx — existing, reused
    instructionKey: "walk.travel.openQuickHelp",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "travel.tap-tile",
    screen: ON_AI,
    selector: '[data-walk="elder-travelmode-tile"]',
    instructionKey: "walk.travel.tapTile",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "travel.enable-toggle",
    screen: ON_AI,
    selector: '[data-walk="travel-enable-toggle"] button',
    instructionKey: "walk.travel.enableToggle",
    waitFor: { type: "toggle", source: "dom", expected: true },
  },
  {
    id: "travel.start-date",
    screen: ON_AI,
    selector: '[data-walk="travel-start-date"]',
    instructionKey: "walk.travel.startDate",
    waitFor: { type: "input", source: "dom", on: "change", validate: "nonEmpty" },
  },
  {
    id: "travel.end-date",
    screen: ON_AI,
    selector: '[data-walk="travel-end-date"]',
    instructionKey: "walk.travel.endDate",
    waitFor: { type: "input", source: "dom", on: "change", validate: "nonEmpty" },
  },
  {
    id: "travel.timezone",
    screen: ON_AI,
    selector: '[data-walk="travel-timezone-select"]',
    instructionKey: "walk.travel.timezone",
    waitFor: { type: "select-change", source: "dom" },
  },
  {
    id: "travel.save",
    screen: ON_AI,
    selector: '[data-walk="travel-save-button"]',
    instructionKey: "walk.travel.save",
    // Gated on the sheet's own real, resolved write (handleSave's emit after
    // await saveProfile()), never the click — that button is also disabled
    // while dates are incomplete, so click timing alone isn't a safe signal.
    waitFor: { type: "write-committed", source: "app-event", event: "travel-plan-saved" },
  },
];
