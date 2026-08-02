export type MedStatus = "taken" | "missed" | "upcoming" | "skipped";
export type Screen = "dashboard" | "patient" | "timeline" | "notifications" | "ai" | "messages" | "settings";
export type AppMode = "onboarding" | "caregiver" | "elderly";

// The elder's usual meal clock times, used to anchor "after breakfast"-style
// doses. Shared by Patient (below) and ProfileDetails (lib/profile.ts).
export interface MealTimes { breakfast?: string; lunch?: string; dinner?: string }

export interface Medication {
  id: number;
  medicationId?: string; // real Supabase medications.id (uuid), when backed by real data
  name: string;
  dose: string;
  time: string;
  times?: string[];
  status: MedStatus;
  takenAt?: string;
  refillDaysLeft?: number;
  pillsRemaining?: number;
  purpose: string;
  colour: string;
}

export interface Contact {
  name: string;
  role: string;
  phone: string;
  isPrimary?: boolean;
}

export interface Patient {
  id: number;
  name: string;
  nickname: string;
  age: number;
  relation: string;
  photo: string;
  bloodType: string;
  conditions: string[];
  allergies: string[];
  medications: Medication[];
  contacts: Contact[];
  adherenceToday: number;
  adherenceWeek: number;
  lastChecked: string;
  // Extended profile fields collected by the guided setup wizard — optional
  // since mock/caregiver-created patients won't have them.
  gender?: string;
  weightKg?: number;
  heightCm?: number;
  wakeTime?: string;
  mealTimes?: MealTimes;
  sleepTime?: string;
  pastMedications?: { id: string; name: string; dose: string; purpose: string }[];
  travelPlan?: { startDate: string; endDate: string; timezone: string };
  // One-time reminder snoozes written by Mei's snooze_dose tool into
  // profiles.accessibility.dose_snoozes (snake_case keys as stored —
  // lib/profile.ts's DoseSnooze). Threaded from fetchProfile so the Home
  // schedule can show a "Snoozed until …" chip on today's card.
  doseSnoozes?: { medication_id: string; name?: string; slot: string; date: string; until: string }[];
}

export interface Notification {
  id: number;
  type: "missed" | "refill" | "info" | "reminder";
  title: string;
  body: string;
  time: string;
  read: boolean;
  patientId: number;
}

export interface Message {
  id: number;
  author: string;
  role: string;
  body: string;
  time: string;
  isMe: boolean;
  /** Demo/seed messages only: a translation-key PREFIX ("messages.demo1") whose
   *  `.role`/`.body`/`.time` keys the Reminders screen renders instead of the
   *  literals above. Seeded English text is the largest block of untranslated
   *  copy on that page, and it cannot be localized at seed time — the seed is
   *  created above LanguageProvider and would freeze whatever language was
   *  current at first mount. Person NAMES are never translated. */
  i18nKey?: string;
}
