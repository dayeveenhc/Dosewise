export type ElderlyTab = "home" | "prescriptions" | "ai" | "notifications" | "settings";

export interface DoctorQ {
  // Real doctor_questions rows carry a uuid; seed/local-only items use a string
  // marker (e.g. "seed-1"). String so ChangeHighlight can target the real DB id
  // via data-testid="doctor_message-{id}".
  id: string;
  question: string;
  /** Timestamp part only ("Today", "14:05", "3 Aug") — the "Added by Mei · "
   *  prefix is composed at RENDER time from `source`, so it can be localized. */
  addedAt: string;
  /** Who queued it. The Reminders thread splits "flagged by Mei" from the
   *  elder's own questions on THIS, not on searching addedAt for the word
   *  "Mei" — translating that label would otherwise silently collapse every
   *  question into the manual list. */
  source: "agent" | "elder" | "caregiver";
  answered: boolean;
  /** Demo/seed questions only: a translation key rendered INSTEAD of `question`.
   *  Same mechanism as Message.i18nKey — a seeded string can't be localized at
   *  seed time (the seed outlives any one language choice), and these two sat in
   *  English on the Reminders page in every language. A real question the person
   *  or Mei wrote has no key and renders exactly as written. */
  i18nKey?: string;
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
  // Tappable answer buttons the agent offered with this reply (offer_choices):
  // {label shown, value sent when tapped}. Only ever on the latest agent message.
  choices?: { label: string; value: string }[];
  // Hermes flagged that a tool PROPOSED something on this turn and is waiting on
  // a yes/no. The chat synthesizes a localized Yes/No pair from this when the
  // agent didn't call offer_choices itself (lib/chatChoices.ts).
  awaitingConfirmation?: boolean;
}
