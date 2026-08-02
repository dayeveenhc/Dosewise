import { Home, Clock, Brain, User, Settings } from "lucide-react";
import type { Screen } from "./types";

// labelKey is a translation key (see lib/language.ts) so the caregiver bottom nav
// tracks the language toggle like every other screen. Rendered via t() in
// components/BottomNav.tsx.
export const NAV_ITEMS: { id: Screen; icon: any; labelKey: string; fab?: boolean }[] = [
  { id: "dashboard", icon: Home, labelKey: "common.home" },
  { id: "timeline", icon: Clock, labelKey: "common.schedule" },
  { id: "ai", icon: Brain, labelKey: "common.askMei", fab: true },
  { id: "patient", icon: User, labelKey: "nav.profile" },
  { id: "settings", icon: Settings, labelKey: "common.settings" },
];
