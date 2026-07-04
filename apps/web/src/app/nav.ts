import { Home, Clock, Brain, User, Settings } from "lucide-react";
import type { Screen } from "./types";

export const NAV_ITEMS: { id: Screen; icon: any; label: string; fab?: boolean }[] = [
  { id: "dashboard", icon: Home, label: "Home" },
  { id: "timeline", icon: Clock, label: "Schedule" },
  { id: "ai", icon: Brain, label: "Ask Mei", fab: true },
  { id: "patient", icon: User, label: "Patient" },
  { id: "settings", icon: Settings, label: "Settings" },
];
