import type { WalkthroughParams, WalkthroughStep, WalkthroughTaskName } from "../types";
import { travelModeSetupSteps } from "./travel_mode_setup";
import { onboardingSteps } from "./onboarding";
import { requestRefillSteps } from "./request_refill";
import { caregiverLinkRequestSteps, elderLinkSteps } from "./link_caregiver";
import { addPrescriptionAutoSteps } from "./add_prescription_auto";
import { addConditionAutoSteps } from "./add_condition_auto";
import { travelModeAutoSteps } from "./travel_mode_auto";
import { editProfileAutoSteps } from "./edit_profile_auto";
import { acceptCaregiverLinkSteps } from "./accept_caregiver_link";

// The step library, keyed by task_name — the same names Hermes's
// start_walkthrough tool accepts (services/hermes/src/hermes/tools/
// walkthrough.py::TASK_NAMES). Content only, no agent logic: a new walkthrough
// is added here without touching the tool or the /agent/turn contract.
//
// link_caregiver is genuinely TWO independent walkthroughs run on two
// different accounts (the caregiver scans + sends a request; the elder shows
// their QR, then later accepts) — the same task_name means something
// different depending on which app shell is asking, so it's resolved by role
// rather than a single flat lookup.
// Autonomous ('*_auto') walkthroughs are param BUILDERS: Mei passes the
// patient's real values (params) and the builder injects them into the fill +
// verify steps. Highlight-only walkthroughs are static and ignore params.
export function resolveWalkthroughSteps(
  taskName: WalkthroughTaskName,
  role: "elder" | "caregiver",
  params: WalkthroughParams = {}
): WalkthroughStep[] {
  if (taskName === "link_caregiver") {
    return role === "caregiver" ? caregiverLinkRequestSteps : elderLinkSteps;
  }
  switch (taskName) {
    case "onboarding": return onboardingSteps;
    case "travel_mode_setup": return travelModeSetupSteps;
    case "request_refill": return requestRefillSteps;
    case "add_prescription_auto": return addPrescriptionAutoSteps(params);
    case "add_condition_auto": return addConditionAutoSteps(params);
    case "travel_mode_auto": return travelModeAutoSteps(params);
    case "edit_profile_auto": return editProfileAutoSteps(params);
    case "accept_caregiver_link": return acceptCaregiverLinkSteps;
    default: return [];
  }
}
