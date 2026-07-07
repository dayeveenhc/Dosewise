export type MedStatus = "taken" | "missed" | "upcoming" | "skipped";
export type Screen = "dashboard" | "patient" | "timeline" | "notifications" | "ai" | "messages" | "settings";
export type AppMode = "onboarding" | "caregiver" | "elderly";

export interface Medication {
  id: number;
  medicationId?: string; // real Supabase medications.id (uuid), when backed by real data
  name: string;
  dose: string;
  time: string;
  status: MedStatus;
  takenAt?: string;
  refillDaysLeft?: number;
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
  mealTimes?: { breakfast?: string; lunch?: string; dinner?: string };
  sleepTime?: string;
  pastMedications?: { id: string; name: string; dose: string; purpose: string }[];
  travelPlan?: { startDate: string; endDate: string; timezone: string };
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
}
