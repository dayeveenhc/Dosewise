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
  // Data-URL of an image the user attached (e.g. a prescription photo), rendered
  // inside their message bubble so they can see what they sent.
  image?: string;
}
