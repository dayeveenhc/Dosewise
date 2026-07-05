import type { Notification } from "../types";

export const NOTIFICATIONS: Notification[] = [
  { id: 1, type: "missed", title: "Missed dose — Celecoxib", body: "Mdm Tan did not take her 12:00 PM Celecoxib 200mg dose.", time: "12:45 PM", read: false, patientId: 1 },
  { id: 2, type: "refill", title: "Refill needed soon — Metformin", body: "Metformin 500mg has ~4 days remaining. Order before Fri.", time: "10:00 AM", read: false, patientId: 1 },
  { id: 3, type: "refill", title: "Refill needed — Latanoprost Eye Drops", body: "Mr Wong's eye drops have only 3 days left.", time: "9:30 AM", read: false, patientId: 2 },
  { id: 4, type: "info", title: "Weekly adherence report ready", body: "AI summary for Mdm Tan's medication adherence this week is ready to view.", time: "8:00 AM", read: true, patientId: 1 },
  { id: 5, type: "reminder", title: "Reminder sent to helper", body: "You sent a 6:00 PM dose reminder to Siti Nuraini.", time: "5:45 PM Yesterday", read: true, patientId: 1 },
];

export const WEEKLY_DATA = [
  { day: "Mon", adherence: 100 },
  { day: "Tue", adherence: 83 },
  { day: "Wed", adherence: 100 },
  { day: "Thu", adherence: 67 },
  { day: "Fri", adherence: 83 },
  { day: "Sat", adherence: 83 },
  { day: "Sun", adherence: 75 },
];
