export type ElderlyTab = "home" | "prescriptions" | "ai" | "notifications" | "settings";

export interface DoctorQ {
  // Real doctor_questions rows carry a uuid; seed/local-only items use a string
  // marker (e.g. "seed-1"). String so ChangeHighlight can target the real DB id
  // via data-testid="doctor_message-{id}".
  id: string;
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
  // The rate-limit fallback (HTTP 429) — rendered as a distinct system notice,
  // not a normal agent reply, so the user has a visible cue to slow down.
  isRateLimited?: boolean;
  // Data-URL of an image the user attached (e.g. a prescription photo), rendered
  // inside their message bubble so they can see what they sent.
  image?: string;
}
