import type { WalkthroughParams, WalkthroughStep } from "../types";

// Guided Auto-Navigation — autonomous Travel Mode setup. Mei opens the sheet,
// turns Travel Mode on, fills the dates + destination timezone, saves, then
// VERIFIES the plan really persisted (host re-queries fetchProfile) before the
// walkthrough completes. Reuses TravelModeSheet's existing data-walk anchors.
//
// Dates are fixed demo values; the elder watches. Note <input type="date">
// only accepts a complete valid value, so the char-by-char fill lands as one
// final set — end state is correct even if the intermediate typing isn't shown.

const ON_AI: WalkthroughStep["screen"] = { mode: "elderly", tab: "ai" };

export function travelModeAutoSteps(p: WalkthroughParams = {}): WalkthroughStep[] {
  const startDate = p.start_date?.trim() || "2026-08-01";
  const endDate = p.end_date?.trim() || "2026-08-07";
  const timezone = p.timezone?.trim() || "Japan (UTC+9)";
  return [
  {
    id: "autoTravel.open",
    screen: ON_AI,
    onEnter: ON_AI,
    // Ask Mei groups its actions into category tiles now — Travel Mode lives
    // under "My medicines", so that tile has to be opened first.
    selector: '[data-walk="elder-cat-medicines"]',
    instructionKey: "walk.autoTravel.open",
    act: { kind: "click", selector: '[data-walk="elder-cat-medicines"]' },
  },
  {
    id: "autoTravel.tile",
    screen: ON_AI,
    selector: '[data-walk="elder-travelmode-tile"]',
    instructionKey: "walk.autoTravel.tile",
    act: { kind: "click", selector: '[data-walk="elder-travelmode-tile"]' },
  },
  {
    id: "autoTravel.enable",
    screen: ON_AI,
    selector: '[data-walk="travel-enable-toggle"] button',
    instructionKey: "walk.autoTravel.enable",
    act: { kind: "click", selector: '[data-walk="travel-enable-toggle"] button' },
  },
  {
    id: "autoTravel.start",
    screen: ON_AI,
    selector: '[data-walk="travel-start-date"]',
    instructionKey: "walk.autoTravel.start",
    act: { kind: "fill", selector: '[data-walk="travel-start-date"]', value: startDate },
  },
  {
    id: "autoTravel.end",
    screen: ON_AI,
    selector: '[data-walk="travel-end-date"]',
    instructionKey: "walk.autoTravel.end",
    act: { kind: "fill", selector: '[data-walk="travel-end-date"]', value: endDate },
  },
  {
    id: "autoTravel.timezone",
    screen: ON_AI,
    selector: '[data-walk="travel-timezone-select"]',
    instructionKey: "walk.autoTravel.timezone",
    act: { kind: "select", selector: '[data-walk="travel-timezone-select"]', value: timezone },
  },
  {
    id: "autoTravel.save",
    screen: ON_AI,
    selector: '[data-walk="travel-save-button"]',
    instructionKey: "walk.autoTravel.save",
    act: { kind: "click", selector: '[data-walk="travel-save-button"]' },
    verify: { kind: "travel-plan-saved" },
    reveal: { screen: ON_AI, selector: '[data-walk="travel-save-button"]' },
  },
  ];
}
