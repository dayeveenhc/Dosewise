export type ElderlyTab = "home" | "prescriptions" | "ai" | "notifications" | "settings";

export interface DoctorQ {
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
}
