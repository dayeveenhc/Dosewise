export type MedStatus = "taken" | "missed" | "upcoming" | "skipped";
export type Screen = "dashboard" | "patient" | "timeline" | "notifications" | "ai" | "messages" | "settings";
export type AppMode = "onboarding" | "caregiver" | "elderly";

export interface Medication {
  id: string;             // doses.id — this specific scheduled instance
  medicationId: string;   // medications.id — the underlying drug record
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
  id: string;
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
  id: string;
  author: string;
  role: string;
  body: string;
  time: string;
  isMe: boolean;
}
