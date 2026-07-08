export type ElderlyTab = "home" | "prescriptions" | "ai" | "notifications" | "settings";

export interface DoctorQ {
  id: number;
  question: string;
  addedAt: string;
  answered: boolean;
}

export interface EMsg {
  id: number;
  role: "user" | "agent";
  text: string;
  time: string;
  isClinic?: boolean;
  // A "✓ Added to your schedule"-style chip shown after the agent commits a write,
  // just before redirecting to the page that shows the change.
  isConfirmation?: boolean;
}
