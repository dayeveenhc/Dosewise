import { useEffect, useRef, useState } from "react";
import { Bell, MessageSquare, ArrowLeft, Check, X } from "lucide-react";
import type { Patient } from "../../types";
import { WalkthroughApp } from "./WalkthroughApp";
import { AccessibilityProvider } from "../../accessibility.tsx";
import { LanguageProvider } from "../../lib/languageContext";

// A duplicate of the real elderly interface (WalkthroughApp + its own copies
// of every nav-bar screen under this folder), seeded with one fixed scenario
// — Margaret's 8:30 AM morning routine — so it can be demoed by hand. Only
// what the script actually needs is layered on top or changed in the copies:
// a pinned demo clock (WalkthroughHomeScreen), a scripted offline AI reply
// (WalkthroughAIScreen), and the three narrative beats that don't exist in
// the product at all (the mealtime takeover, the WhatsApp interruption, the
// "caregiver notified" toast), added here.

const PATIENT_NAME = "Margaret";
const CAREGIVER_NAME = "Wei Liang";
const MORNING_TIME = "8:30 AM";

const MARGARET: Patient = {
  id: 9001,
  name: "Margaret Tan",
  nickname: PATIENT_NAME,
  age: 76,
  relation: "Mother",
  photo: "https://images.unsplash.com/photo-1566616213894-2d4e1baee5d8?w=80&h=80&fit=crop&auto=format",
  bloodType: "O+",
  conditions: ["Type 2 Diabetes", "Hypertension", "High Cholesterol"],
  allergies: [],
  // Latanoprost Eye Drops is deliberately NOT here — it's added mid-scenario
  // via the "Add refill / prescription" scripted scan (see
  // WalkthroughAddPrescriptionSheet), the same way Margaret would enter a
  // fresh polyclinic prescription for the first time.
  medications: [
    { id: 1, name: "Metformin", dose: "500mg", time: MORNING_TIME, status: "upcoming", purpose: "Diabetes", colour: "#0D5C8A" },
    { id: 2, name: "Amlodipine", dose: "5mg", time: MORNING_TIME, status: "upcoming", purpose: "Blood Pressure", colour: "#2E7D32" },
    { id: 3, name: "Atorvastatin", dose: "20mg", time: MORNING_TIME, status: "upcoming", purpose: "Cholesterol", colour: "#7B3F9E" },
    // Metformin is twice-daily — a separate (medication, time-slot) entry, same
    // as the real data model. The Medications tab groups same-named entries
    // back into one card, so this alone makes it show "Twice a day" with both chips.
    { id: 4, name: "Metformin", dose: "500mg", time: "9:00 PM", status: "upcoming", purpose: "Diabetes", colour: "#0D5C8A" },
  ],
  contacts: [
    { name: CAREGIVER_NAME, role: "Son (Primary Caregiver)", phone: "+65 9123 4567", isPrimary: true },
  ],
  adherenceToday: 0,
  adherenceWeek: 88,
  lastChecked: "Just now",
  // Breakfast pinned to 8:30 AM so the "Morning" quick-time chip in the
  // Add-prescription sheet's time picker (used when re-entering Metformin's
  // now-illegible dose/time by hand) lands back on 8:30 AM — matching her
  // other two morning doses — rather than the app's generic 8:00 AM default.
  // Bedtime pinned to 9 PM so the scripted eye-drops scan (which slots into
  // "bedtime") lands on 9:00 PM as asked, not the app's generic 10 PM default.
  mealTimes: { breakfast: "08:30", lunch: "12:30", dinner: "19:00" },
  sleepTime: "21:00",
};

// ---------- the three narrative beats with no equivalent in the real app ----------

function MealtimeNotification({ patient, onDismiss }: { patient: Patient; onDismiss: () => void }) {
  const dueNow = patient.medications.filter(m => m.time === MORNING_TIME);
  return (
    <div className="flex-1 flex flex-col bg-gradient-to-b from-primary to-[#083f5e] text-white overflow-y-auto">
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-6 py-8">
        <div className="w-16 h-16 rounded-full bg-white/15 flex items-center justify-center shrink-0">
          <Bell size={28} className="text-white" />
        </div>
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-white/70 font-bold mb-1">After Breakfast · Dosewise</p>
          <h2 className="text-2xl font-bold leading-snug">Time for your morning medicines</h2>
        </div>
        <div className="w-full space-y-3">
          {dueNow.map(m => (
            <div key={m.id} className="bg-white/10 border border-white/20 rounded-2xl px-4 py-3.5 text-left">
              <p className="text-xl font-bold leading-snug">{m.name} <span className="text-white/70 text-base font-medium">{m.dose}</span></p>
              <p className="text-base text-white/85 mt-1 leading-relaxed">Take {m.purpose === "Diabetes" ? "with breakfast" : "after breakfast"}, as directed.</p>
            </div>
          ))}
        </div>
        <button onClick={onDismiss} className="w-full bg-white text-primary font-bold rounded-2xl py-3.5 text-[15px] active:scale-[0.98] transition-transform">
          View my medicines
        </button>
      </div>
    </div>
  );
}

function WhatsAppBanner({ onTap }: { onTap: () => void }) {
  return (
    <div
      onClick={onTap}
      className="absolute top-3 left-3 right-3 z-[300] bg-card border border-border rounded-2xl shadow-xl px-4 py-3 flex items-start gap-3 animate-in slide-in-from-top duration-500 cursor-pointer"
    >
      <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center shrink-0 mt-0.5">
        <MessageSquare size={13} className="text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground truncate">Family Group 💬</p>
        <p className="text-xs text-muted-foreground leading-snug truncate">{CAREGIVER_NAME}: Ma, don't forget Ah Kong's birthday lunch on Sunday!</p>
      </div>
    </div>
  );
}

function AwayScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-neutral-100">
      <button
        onClick={onBack}
        className="flex items-center gap-2 bg-card border border-border rounded-full px-5 py-3 text-sm font-bold text-foreground shadow-sm active:scale-[0.98] transition-transform"
      >
        <ArrowLeft size={15} /> Go back to Dosewise
      </button>
    </div>
  );
}

function CaregiverNotifiedToast({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="absolute top-3 left-3 right-3 z-[300] bg-card border border-emerald-200 rounded-2xl shadow-xl px-4 py-3 flex items-start gap-3 animate-in slide-in-from-top duration-500">
      <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0 mt-0.5">
        <Check size={14} className="text-emerald-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground">Latanoprost Eye Drops — only 4 days left</p>
        <p className="text-xs text-muted-foreground leading-snug">{CAREGIVER_NAME} has been notified to arrange a refill.</p>
      </div>
      <button onClick={onDismiss} className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors">
        <X size={12} />
      </button>
    </div>
  );
}

// ---------- root ----------

export function ScenarioWalkthroughPage() {
  const [patient, setPatient] = useState<Patient>(MARGARET);
  const [phase, setPhase] = useState<"notification" | "app" | "away">("notification");
  const [whatsappOpen, setWhatsappOpen] = useState(false);
  const [caregiverToastOpen, setCaregiverToastOpen] = useState(false);
  const whatsappShown = useRef(false);
  const caregiverToastShown = useRef(false);

  const morningTaken = patient.medications.filter(m => m.time === MORNING_TIME && m.status === "taken").length;
  const lowRefillEyeDrops = patient.medications.find(m => m.name === "Latanoprost Eye Drops" && (m.refillDaysLeft ?? 99) <= 5);

  // WhatsApp group message pops up right after the second morning dose is marked done.
  useEffect(() => {
    if (morningTaken !== 2 || whatsappShown.current) return;
    whatsappShown.current = true;
    const timer = window.setTimeout(() => setWhatsappOpen(true), 900);
    return () => window.clearTimeout(timer);
  }, [morningTaken]);

  // Caregiver-notified toast fires once the morning routine is done AND the
  // eye drops have actually been added (via the scripted scan) with a low
  // supply — whichever of those two happens second, in whatever order the
  // demo is driven.
  useEffect(() => {
    if (morningTaken !== 3 || !lowRefillEyeDrops || caregiverToastShown.current) return;
    caregiverToastShown.current = true;
    const timer = window.setTimeout(() => setCaregiverToastOpen(true), 900);
    return () => window.clearTimeout(timer);
  }, [morningTaken, lowRefillEyeDrops]);

  const handleUpdatePatient = (p: Patient | ((prev: Patient) => Patient)) => {
    setPatient(prev => (typeof p === "function" ? (p as (prev: Patient) => Patient)(prev) : p));
  };

  // "Switch to caregiver" / "Sign out" in Settings have nowhere real to go in
  // this standalone demo — treat both as a restart of the scenario.
  const resetDemo = () => {
    setPatient(MARGARET);
    setPhase("notification");
    setWhatsappOpen(false);
    setCaregiverToastOpen(false);
    whatsappShown.current = false;
    caregiverToastShown.current = false;
  };

  const onBannerTap = () => { setWhatsappOpen(false); setPhase("away"); };

  return (
    <LanguageProvider>
      <div className="min-h-screen bg-stone-300 flex items-center justify-center p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <div className="w-[390px] h-[844px] bg-background relative overflow-hidden rounded-[3rem] shadow-2xl border-[6px] border-stone-800 flex flex-col">
          <AccessibilityProvider>
            {phase === "notification" && <MealtimeNotification patient={patient} onDismiss={() => setPhase("app")} />}
            {phase === "away" && <AwayScreen onBack={() => setPhase("app")} />}
            {phase === "app" && (
              <WalkthroughApp
                patient={patient}
                elderId={undefined}
                onUpdatePatient={handleUpdatePatient}
                onBack={resetDemo}
                onSignOut={resetDemo}
                careMessages={[]}
              />
            )}
          </AccessibilityProvider>

          {whatsappOpen && <WhatsAppBanner onTap={onBannerTap} />}
          {caregiverToastOpen && <CaregiverNotifiedToast onDismiss={() => setCaregiverToastOpen(false)} />}
        </div>
      </div>
    </LanguageProvider>
  );
}
