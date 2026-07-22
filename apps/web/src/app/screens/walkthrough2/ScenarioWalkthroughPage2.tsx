import { useEffect, useRef, useState } from "react";
import { Bell, ArrowLeftRight } from "lucide-react";
import type { Patient, Screen } from "../../types";
import type { DoctorQ } from "../elderly/types";
import { WalkthroughApp } from "../walkthrough/WalkthroughApp";
import { WalkthroughCaregiverApp } from "./WalkthroughCaregiverApp";
import { WalkthroughCaregiverLogin } from "./WalkthroughCaregiverLogin";
import { WalkthroughCaregiverSetupMethod } from "./WalkthroughCaregiverSetupMethod";
import { WelcomeScreen } from "../setup/WelcomeScreen";
import { OnboardingScreen } from "../OnboardingScreen";
import { PATIENTS } from "../../data/patients";
import { AccessibilityProvider } from "../../accessibility.tsx";
import { LanguageProvider } from "../../lib/languageContext";

// Walkthrough 2 — a dual-interface scenario (unlike walkthrough 1, which is
// elder-only): Wei Liang (caregiver) and Margaret (elder) share one Patient
// record, and the demo is driven by manually switching between their two
// interfaces, exactly like the real app would look from each side at once.
// The caregiver side is a fresh, purpose-built duplicate (screens/walkthrough2/);
// the elder side reuses screens/walkthrough/WalkthroughApp as-is via its
// initialDemoToday prop, so there's exactly one elder-interface implementation
// to keep in sync, not two.
//
// The onboarding chain leading into it reuses the real WelcomeScreen and
// OnboardingScreen as-is (pure presentational, no backend calls), but forks
// SetupMethodScreen/ScanLovedOneSheet into walkthrough2/ versions — those two
// touch supabase (file-extraction + signUp) internally, so they need scripted
// stand-ins like every other walkthrough screen.

const PATIENT_NAME = "Margaret";
const CAREGIVER_NAME = "Wei Liang";

// Wei Liang already manages these two (seeded in data/patients.ts, same as
// the real app's caregiver mode) — Margaret gets added alongside them once
// he scans her QR code, so the dashboard reads as "one more patient, still
// pending" rather than "no patients at all."
const AH_MA = PATIENTS[0];
const AH_GONG = PATIENTS[1];

const MARGARET: Patient = {
  id: 9101,
  name: "Margaret Tan",
  nickname: PATIENT_NAME,
  age: 76,
  relation: "Mother",
  photo: "https://images.unsplash.com/photo-1566616213894-2d4e1baee5d8?w=80&h=80&fit=crop&auto=format",
  bloodType: "O+",
  conditions: ["Type 2 Diabetes", "Hypertension", "High Cholesterol"],
  allergies: [],
  medications: [
    { id: 1, name: "Metformin", dose: "500mg", time: "8:00 AM", status: "taken", takenAt: "8:05 AM", purpose: "Diabetes", colour: "#0D5C8A" },
    { id: 2, name: "Atorvastatin", dose: "20mg", time: "8:00 AM", status: "taken", takenAt: "8:05 AM", purpose: "Cholesterol", colour: "#7B3F9E" },
    // The afternoon dose this whole scenario is about — starts upcoming,
    // flips to "missed" once the caregiver revisits Home after Medications
    // (see onTabChange below).
    { id: 3, name: "Amlodipine", dose: "5mg", time: "2:00 PM", status: "upcoming", purpose: "Blood Pressure", colour: "#2E7D32" },
  ],
  contacts: [
    { name: CAREGIVER_NAME, role: "Son (Primary Caregiver)", phone: "+65 9123 4567", isPrimary: true },
  ],
  adherenceToday: 67,
  adherenceWeek: 85,
  lastChecked: "Just now",
  mealTimes: { breakfast: "08:00", lunch: "12:30", dinner: "19:00" },
  sleepTime: "22:00",
};

function pinnedTime(hours: number, minutes: number): Date {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function ReminderToast({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div className="absolute top-3 left-3 right-3 z-[300] bg-card border border-border rounded-2xl shadow-xl px-4 py-3 flex items-start gap-3 animate-in slide-in-from-top duration-500">
      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
        <Bell size={14} className="text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground truncate">Reminder from {CAREGIVER_NAME}</p>
        <p className="text-xs text-muted-foreground leading-snug">{text}</p>
      </div>
      <button onClick={onDismiss} className="shrink-0 text-muted-foreground text-xs font-bold px-1">✕</button>
    </div>
  );
}

const CAREGIVER_RELATIONSHIP = "Son";

export function ScenarioWalkthroughPage2() {
  // "welcome" (Get Started / Sign in) -> "signin" (existing-account path) or
  // "mode" (Who is this for -> For a loved one) -> "method" (how to set up ->
  // scan a loved one's QR code) -> "app" (the caregiver/elder switcher below).
  const [phase, setPhase] = useState<"welcome" | "signin" | "mode" | "method" | "app">("welcome");
  // Whether Margaret has accepted the pairing request yet — gates only her
  // own tabs in WalkthroughCaregiverApp (see PendingCaregiverState there).
  const [linked, setLinked] = useState(false);
  const [patients, setPatients] = useState<Patient[]>([AH_MA, AH_GONG]);
  const [selectedPatient, setSelectedPatient] = useState(0);
  const [view, setView] = useState<"caregiver" | "elder">("caregiver");
  const [pinnedNow, setPinnedNow] = useState(() => pinnedTime(8, 40));
  const [doctorQuestions, setDoctorQuestions] = useState<DoctorQ[]>([]);
  const [reminderPing, setReminderPing] = useState<string | null>(null);
  const [showReminderToast, setShowReminderToast] = useState(false);

  const margaret = patients.find(p => p.id === MARGARET.id) ?? MARGARET;

  // "Home -> Medications -> back to Home" is the scripted trigger for the
  // 8:40 AM -> 2:40 PM jump, matching how the scenario is meant to be
  // driven by hand rather than firing on a timer. Only arms while Margaret
  // herself is the selected patient — poking around Ah Ma/Ah Gong's tabs
  // shouldn't affect her schedule.
  const visitedPatientTab = useRef(false);
  const jumped = useRef(false);
  const onTabChange = (tab: Screen) => {
    if (!linked || patients[selectedPatient]?.id !== MARGARET.id) return;
    if (tab === "patient") visitedPatientTab.current = true;
    if (tab === "dashboard" && visitedPatientTab.current && !jumped.current) {
      jumped.current = true;
      setPinnedNow(pinnedTime(14, 40));
      setPatients(prev => prev.map(p => p.id !== MARGARET.id ? p : {
        ...p,
        medications: p.medications.map(m => m.name === "Amlodipine" && m.status !== "taken" ? { ...m, status: "missed" } : m),
      }));
    }
  };

  const onUpdatePatient = (p: Patient | ((prev: Patient) => Patient)) => {
    setPatients(prev => prev.map(pt => pt.id !== MARGARET.id ? pt : (typeof p === "function" ? (p as (prev: Patient) => Patient)(pt) : p)));
  };

  const onReminderSent = (text: string) => setReminderPing(text);

  const onAddDoctorQ = (q: string) => {
    const time = new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });
    setDoctorQuestions(prev => [{ id: Date.now(), question: q, addedAt: `Added by Mei · ${time}`, answered: false }, ...prev]);
  };
  const onMarkAnswered = (id: number) => setDoctorQuestions(prev => prev.map(q => q.id === id ? { ...q, answered: true } : q));
  const onDeleteQuestion = (id: number) => setDoctorQuestions(prev => prev.filter(q => q.id !== id));

  // Show the reminder toast once, the first time Margaret's interface opens
  // after Wei Liang has actually sent one.
  const toastShownFor = useRef<string | null>(null);
  useEffect(() => {
    if (view !== "elder" || !reminderPing || toastShownFor.current === reminderPing) return;
    toastShownFor.current = reminderPing;
    setShowReminderToast(true);
    const timer = window.setTimeout(() => setShowReminderToast(false), 6000);
    return () => window.clearTimeout(timer);
  }, [view, reminderPing]);

  const onRespondLinkRequest = (accept: boolean) => {
    if (accept) setLinked(true);
  };

  // Scanning Margaret's QR code during onboarding adds her to the patient
  // list alongside Ah Ma/Ah Gong, but pending — see pendingPatientId below.
  const onScanConfirmed = () => {
    setPatients(prev => prev.some(p => p.id === MARGARET.id) ? prev : [...prev, MARGARET]);
    setPhase("app");
  };

  const resetDemo = () => {
    setPhase("welcome");
    setLinked(false);
    setPatients([AH_MA, AH_GONG]);
    setSelectedPatient(0);
    setView("caregiver");
    setPinnedNow(pinnedTime(8, 40));
    setDoctorQuestions([]);
    setReminderPing(null);
    setShowReminderToast(false);
    visitedPatientTab.current = false;
    jumped.current = false;
    toastShownFor.current = null;
  };

  return (
    <LanguageProvider>
      <div className="min-h-screen bg-stone-300 flex flex-col items-center justify-center gap-4 p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        {phase === "app" && (
          <button
            onClick={() => setView(v => (v === "caregiver" ? "elder" : "caregiver"))}
            className="flex items-center gap-2 bg-card border border-border rounded-full px-4 py-2 text-sm font-bold text-foreground shadow-sm active:scale-[0.98] transition-transform"
          >
            <ArrowLeftRight size={15} className="text-primary" />
            Switch to {view === "caregiver" ? `${PATIENT_NAME}'s` : `${CAREGIVER_NAME}'s`} interface
          </button>
        )}

        <div className="w-[390px] h-[844px] bg-background relative overflow-hidden rounded-[3rem] shadow-2xl border-[6px] border-stone-800 flex flex-col">
          <AccessibilityProvider>
            {phase === "welcome" ? (
              <WelcomeScreen onSignIn={() => setPhase("signin")} onGetStarted={() => setPhase("mode")} />
            ) : phase === "signin" ? (
              <WalkthroughCaregiverLogin onBack={() => setPhase("welcome")} onLoggedIn={() => setPhase("mode")} />
            ) : phase === "mode" ? (
              <OnboardingScreen
                onSelect={mode => { if (mode === "caregiver") setPhase("method"); }}
                onBack={() => setPhase("welcome")}
              />
            ) : phase === "method" ? (
              <WalkthroughCaregiverSetupMethod onBack={() => setPhase("mode")} onScanConfirmed={onScanConfirmed} />
            ) : view === "caregiver" ? (
              <WalkthroughCaregiverApp
                patients={patients}
                selectedPatient={selectedPatient}
                onSelectPatient={setSelectedPatient}
                pendingPatientId={linked ? null : MARGARET.id}
                pinnedNow={pinnedNow}
                doctorQuestions={doctorQuestions}
                onAddDoctorQ={onAddDoctorQ}
                onMarkAnswered={onMarkAnswered}
                onDeleteQuestion={onDeleteQuestion}
                onReminderSent={onReminderSent}
                onTabChange={onTabChange}
              />
            ) : (
              <WalkthroughApp
                patient={margaret}
                elderId={undefined}
                onUpdatePatient={onUpdatePatient}
                onBack={() => setView("caregiver")}
                onSignOut={resetDemo}
                careMessages={[]}
                initialDemoToday={pinnedNow}
                pendingLinkRequest={!linked ? { caregiverName: CAREGIVER_NAME, relationship: CAREGIVER_RELATIONSHIP } : null}
                onRespondLinkRequest={onRespondLinkRequest}
              />
            )}
          </AccessibilityProvider>

          {phase === "app" && view === "elder" && showReminderToast && reminderPing && (
            <ReminderToast text={reminderPing} onDismiss={() => setShowReminderToast(false)} />
          )}
        </div>
      </div>
    </LanguageProvider>
  );
}
