import type { Patient, Notification, Message } from "../types";

export const PATIENTS: Patient[] = [
  {
    id: 1,
    name: "Mdm Tan Bee Leng",
    nickname: "Ah Ma",
    age: 78,
    relation: "Mother",
    bloodType: "B+",
    conditions: ["Type 2 Diabetes", "Hypertension", "Osteoarthritis"],
    allergies: ["Penicillin", "Sulfa drugs"],
    adherenceToday: 75,
    adherenceWeek: 82,
    lastChecked: "8 mins ago",
    medications: [
      { id: 1, name: "Metformin", dose: "500mg", time: "7:00 AM", status: "taken", takenAt: "7:14 AM", purpose: "Diabetes", colour: "#0D5C8A", refillDaysLeft: 28 },
      { id: 2, name: "Amlodipine", dose: "5mg", time: "7:00 AM", status: "taken", takenAt: "7:14 AM", purpose: "Blood Pressure", colour: "#2E7D32", refillDaysLeft: 21 },
      { id: 3, name: "Celecoxib", dose: "200mg", time: "12:00 PM", status: "missed", purpose: "Joint Pain", colour: "#B91C1C", refillDaysLeft: 14 },
      { id: 4, name: "Metformin", dose: "500mg", time: "6:00 PM", status: "upcoming", refillDaysLeft: 4, purpose: "Diabetes", colour: "#0D5C8A" },
      { id: 5, name: "Atorvastatin", dose: "20mg", time: "9:00 PM", status: "upcoming", refillDaysLeft: 12, purpose: "Cholesterol", colour: "#7B3F9E" },
      { id: 9, name: "Latanoprost Eye Drops", dose: "1 drop each eye", time: "9:00 PM", status: "upcoming", refillDaysLeft: 3, purpose: "Glaucoma", colour: "#2E7D32" },
    ],
    contacts: [
      { name: "Tan Wei Ming", role: "Son (Primary Caregiver)", phone: "+65 9123 4567", isPrimary: true },
      { name: "Dr Priya Nair", role: "GP — Ang Mo Kio Polyclinic", phone: "+65 6355 3000" },
      { name: "Tan Shu Fen", role: "Daughter", phone: "+65 9234 5678" },
      { name: "995 (SCDF)", role: "Emergency Services", phone: "995" },
    ],
  },
  {
    id: 2,
    name: "Mr Wong Kah Wai",
    nickname: "Ah Gong",
    age: 83,
    relation: "Father-in-law",
    bloodType: "O+",
    conditions: ["Atrial Fibrillation", "Chronic Kidney Disease (Stage 3)", "Glaucoma"],
    allergies: ["Aspirin", "Iodine contrast"],
    adherenceToday: 100,
    adherenceWeek: 91,
    lastChecked: "3 mins ago",
    medications: [
      { id: 6, name: "Warfarin", dose: "3mg", time: "6:00 PM", status: "upcoming", refillDaysLeft: 9, purpose: "Blood Thinning", colour: "#C05621" },
      { id: 7, name: "Bisoprolol", dose: "2.5mg", time: "8:00 AM", status: "taken", takenAt: "8:02 AM", purpose: "Heart Rate", colour: "#0D5C8A" },
      { id: 8, name: "Latanoprost Eye Drops", dose: "1 drop each eye", time: "9:00 PM", status: "upcoming", refillDaysLeft: 3, purpose: "Glaucoma", colour: "#2E7D32" },
    ],
    contacts: [
      { name: "Lily Tan (Daughter-in-law)", role: "Primary Caregiver", phone: "+65 9345 6789", isPrimary: true },
      { name: "Dr Marcus Goh", role: "Cardiologist — TTSH", phone: "+65 6357 8000" },
      { name: "Wong Beng Huat", role: "Son", phone: "+65 9456 7890" },
    ],
  },
];

// Same key-prefix split as MESSAGES below: `i18nKey`'s `.title`/`.body`/`.time`
// are what the screen renders; the literals here are the English source and the
// fallback for anything real that arrives without a key.
export const NOTIFICATIONS: Notification[] = [
  { id: 1, type: "missed", title: "Missed dose — Celecoxib", body: "Mdm Tan did not take her 12:00 PM Celecoxib 200mg dose.", time: "12:45 PM", read: false, patientId: 1, i18nKey: "notifications.seed1" },
  { id: 2, type: "refill", title: "Refill needed soon — Metformin", body: "Metformin 500mg has ~4 days remaining. Order before Fri.", time: "10:00 AM", read: false, patientId: 1, i18nKey: "notifications.seed2" },
  { id: 3, type: "refill", title: "Refill needed — Latanoprost Eye Drops", body: "Mr Wong's eye drops have only 3 days left.", time: "9:30 AM", read: false, patientId: 2, i18nKey: "notifications.seed3" },
  { id: 4, type: "info", title: "Weekly adherence report ready", body: "AI summary for Mdm Tan's medication adherence this week is ready to view.", time: "8:00 AM", read: true, patientId: 1, i18nKey: "notifications.seed4" },
  { id: 5, type: "reminder", title: "Reminder sent to helper", body: "You sent a 6:00 PM dose reminder to Siti Nuraini.", time: "5:45 PM Yesterday", read: true, patientId: 1, i18nKey: "notifications.seed5" },
];

// `i18nKey` is a key PREFIX whose `.role`/`.body` the screen renders instead of
// the literals here (Message.i18nKey in types.ts explains why the seed can't be
// localized at creation time). `author` is a person's name and is never
// translated; "You" is resolved at render, not stored here.
export const MESSAGES: Message[] = [
  { id: 1, author: "Siti Nuraini", role: "Helper", body: "Good morning! Mdm Tan took her morning meds with breakfast. She seemed a bit tired today but ate well.", time: "7:22 AM", isMe: false, i18nKey: "messages.thread1" },
  { id: 2, author: "You", role: "Son", body: "Thanks Siti. Please remind her to do her foot exercises after lunch too.", time: "9:05 AM", isMe: true, i18nKey: "messages.thread2" },
  { id: 3, author: "Shu Fen", role: "Sister", body: "I'll be visiting on Saturday, can we check the celecoxib situation then? She keeps forgetting the midday one.", time: "11:30 AM", isMe: false, i18nKey: "messages.thread3" },
  { id: 4, author: "You", role: "Son", body: "Good idea. I'll leave a note with Siti. Maybe we should put the pill on the dining table at 11:30 as a visual reminder.", time: "11:45 AM", isMe: true, i18nKey: "messages.thread4" },
  { id: 5, author: "Siti Nuraini", role: "Helper", body: "Noted! I'll put it out with a small cup of water. She forgot again today at lunch — said she was watching TV.", time: "1:10 PM", isMe: false, i18nKey: "messages.thread5" },
];

// `day` stays the stable English token (it is the React key and the chart's
// series identity); `dayKey` is what gets rendered, resolved at paint time so
// the axis follows the language setting. Same split as `i18nKey` above.
export const WEEKLY_DATA = [
  { day: "Mon", dayKey: "common.dayShort.mon", adherence: 100 },
  { day: "Tue", dayKey: "common.dayShort.tue", adherence: 83 },
  { day: "Wed", dayKey: "common.dayShort.wed", adherence: 100 },
  { day: "Thu", dayKey: "common.dayShort.thu", adherence: 67 },
  { day: "Fri", dayKey: "common.dayShort.fri", adherence: 83 },
  { day: "Sat", dayKey: "common.dayShort.sat", adherence: 83 },
  { day: "Sun", dayKey: "common.dayShort.sun", adherence: 75 },
];
