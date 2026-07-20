import { useEffect, useRef, useState } from "react";
import { Droplets, Home, Pill, Brain, Bell, Settings, HelpCircle } from "lucide-react";
import type { Patient, Medication, MedStatus, Message } from "../../types";
import type { ElderlyTab, DoctorQ } from "./types";
import { ElderlyHomeScreen } from "./ElderlyHomeScreen";
import { ElderlyPrescriptionScreen } from "./ElderlyPrescriptionScreen";
import { ElderlyAIScreen } from "./ElderlyAIScreen";
import { ElderlyNotificationsScreen } from "./ElderlyNotificationsScreen";
import { ElderlySettingsScreen } from "./ElderlySettingsScreen";
import { AddPrescriptionSheet } from "../AddPrescriptionSheet";
import { TravelModeSheet } from "../TravelModeSheet";
import { GuidedTour } from "../../components/GuidedTour";
import type { TourStep } from "../../components/GuidedTour";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { logDoseTaken, addMedication, fetchElderMedications, to24h } from "../../lib/medications";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";

export function ElderlyApp({ patient, elderId, onUpdatePatient, onBack, onSignOut, startTour, careMessages }: {
  patient: Patient;
  elderId?: string;
  onUpdatePatient: (p: Patient | ((prev: Patient) => Patient)) => void;
  onBack: () => void;
  onSignOut: () => void;
  startTour?: boolean;
  careMessages: Message[];
}) {
  const [tab, setTab] = useState<ElderlyTab>("home");
  const [currentTime, setCurrentTime] = useState(new Date());
  const [pendingAIMessage, setPendingAIMessage] = useState<string | undefined>();
  const [addRx, setAddRx] = useState<null | "scan" | "manual">(null);
  const [showTravel, setShowTravel] = useState(false);
  const [showTour, setShowTour] = useState(!!startTour);
  const [showTourConfirm, setShowTourConfirm] = useState(false);
  // Name of a just-added medication, so the schedule/prescription screens can show a
  // "Just added" highlight as visible proof it landed. Auto-clears after a few seconds.
  const [justAddedMed, setJustAddedMed] = useState<string | null>(null);
  const justAddedTimer = useRef<number>();
  const { language } = useLanguage();

  const flagJustAdded = (name?: string) => {
    if (!name) return;
    setJustAddedMed(name);
    window.clearTimeout(justAddedTimer.current);
    justAddedTimer.current = window.setTimeout(() => setJustAddedMed(null), 6000);
  };

  useEffect(() => {
    const intervalId = window.setInterval(() => setCurrentTime(new Date()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  // Ask once for permission to pop a browser notification at dose time. Only
  // works while this tab is open (no service worker / push infra) — that's a
  // known limit, not a bug: see CONTEXT.md notification-tier notes.
  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // Fires a browser notification the minute a medication's scheduled time
  // arrives, for whatever's currently "upcoming" in patient.medications (kept
  // fresh by refreshMeds after the agent adds/reminds via chat or photo scan).
  // notifiedRef tracks "id|date" so a slot notifies once per day, not every poll tick.
  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    const check = () => {
      if (Notification.permission !== "granted") return;
      const now = new Date();
      const nowLabel = now.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase();
      const today = now.toISOString().slice(0, 10);
      for (const med of patient.medications) {
        if (med.status !== "upcoming" || med.time.toUpperCase() !== nowLabel) continue;
        const key = `${med.id}|${today}`;
        if (notifiedRef.current.has(key)) continue;
        notifiedRef.current.add(key);
        new Notification(`💊 Time for ${med.name}`, {
          body: `${med.dose || ""} — ${med.purpose || "your medicine"}`.trim(),
        });
      }
    };
    check();
    const interval = setInterval(check, 30_000);
    return () => clearInterval(interval);
  }, [patient.medications]);

  const tourSteps: TourStep[] = [
    {
      target: '[data-tour="elder-schedule"]', navTarget: '[data-tour="nav-home"]', onEnter: () => setTab("home"),
      title: t(language, "tour.elderScheduleTitle"), body: t(language, "tour.elderScheduleBody"),
    },
    {
      target: '[data-tour="elder-medlist"]', navTarget: '[data-tour="nav-prescriptions"]', onEnter: () => setTab("prescriptions"),
      title: t(language, "tour.elderMedsTitle"), body: t(language, "tour.elderMedsBody"),
    },
    {
      target: '[data-tour="elder-add-prescription"]', navTarget: '[data-tour="nav-prescriptions"]', onEnter: () => setTab("prescriptions"),
      title: t(language, "tour.elderAddRxTitle"), body: t(language, "tour.elderAddRxBody"),
    },
    {
      target: '[data-tour="elder-quickhelp"]', navTarget: '[data-tour="nav-ai"]', onEnter: () => setTab("ai"),
      title: t(language, "tour.elderAskMeiTitle"), body: t(language, "tour.elderAskMeiBody"),
    },
    {
      target: '[data-tour="elder-profile-section"]', navTarget: '[data-tour="nav-settings"]', onEnter: () => setTab("settings"),
      title: t(language, "tour.elderProfileTitle"), body: t(language, "tour.elderProfileBody"),
    },
    {
      target: '[data-tour="elder-fontsize"]', navTarget: '[data-tour="nav-settings"]', onEnter: () => setTab("settings"),
      title: t(language, "tour.elderFontTitle"), body: t(language, "tour.elderFontBody"),
    },
    {
      target: '[data-tour="elder-language"]', navTarget: '[data-tour="nav-settings"]', onEnter: () => setTab("settings"),
      title: t(language, "tour.elderLangTitle"), body: t(language, "tour.elderLangBody"),
    },
  ];

  const openAI = (msg?: string) => {
    setPendingAIMessage(msg);
    setTab("ai");
  };
  const [doctorQuestions, setDoctorQuestions] = useState<DoctorQ[]>([
    { id: 1, question: "Can I take Celecoxib and Metformin at the same time?",           addedAt: "Added by Mei · Today",     answered: false },
    { id: 2, question: "Is it normal to feel a little dizzy after taking Amlodipine?",  addedAt: "Added by Mei · Yesterday", answered: false },
  ]);

  const handleLogDose = (medId: number, takenAt?: string) => {
    const t = takenAt ?? new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });
    onUpdatePatient({
      ...patient,
      medications: patient.medications.map(m => m.id === medId ? {
        ...m, status: "taken" as MedStatus, takenAt: t,
        refillDaysLeft: m.refillDaysLeft !== undefined ? Math.max(0, m.refillDaysLeft - 1) : undefined,
      } : m),
    });
    const med = patient.medications.find(m => m.id === medId);
    if (elderId && med?.medicationId) logDoseTaken(med.medicationId, elderId);
  };

  const handleAddPrescription = async (med: Omit<Medication, "id" | "status"> & { times?: string[] }) => {
    const nextId = patient.medications.reduce((max, m) => Math.max(max, m.id), 0) + 1;
    const timeHHMMs = (med.times && med.times.length ? med.times : [med.time]).map(t => to24h(t));
    const medicationId = elderId
      ? await addMedication(elderId, { name: med.name, dosage: med.dose, purpose: med.purpose, timeHHMMs, refillDays: med.refillDaysLeft })
      : undefined;
    onUpdatePatient({ ...patient, medications: [...patient.medications, { ...med, id: nextId, medicationId, status: "upcoming" as MedStatus }] });
    flagJustAdded(med.name);
  };

  // After the agent writes a medication change server-side (photo prescription,
  // chat-logged dose/refill), refetch so the local list isn't stale. Merge with a
  // functional update rather than spreading a closed-over `patient`, so a
  // concurrent change (e.g. a dose just logged) isn't clobbered by a stale copy.
  const refreshMeds = async () => {
    if (!elderId) return;
    const medications = await fetchElderMedications(elderId);
    onUpdatePatient(prev => ({ ...prev, medications }));
  };

  // Safety net (mirrors the caregiver App): re-pull medications when returning to
  // a screen that shows them, so an agent write the chat couldn't detect in
  // `actions` can't leave the home schedule or prescription list stale.
  useEffect(() => {
    if (tab !== "home" && tab !== "prescriptions") return;
    void refreshMeds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, elderId]);

  const handleAddDoctorQ = (q: string) => {
    setDoctorQuestions(prev => [{ id: Date.now(), question: q, addedAt: `Added by Mei · ${new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" })}`, answered: false }, ...prev]);
  };

  const unasked = doctorQuestions.filter(q => !q.answered).length;

  const NAV: { id: ElderlyTab; icon: any; label: string; fab?: boolean }[] = [
    { id: "home",          icon: Home,        label: t(language, "nav.home") },
    { id: "prescriptions", icon: Pill,        label: t(language, "nav.medications") },
    { id: "ai",            icon: Brain,       label: t(language, "nav.askMei"), fab: true },
    { id: "notifications", icon: Bell,        label: t(language, "nav.notifications") },
    { id: "settings",      icon: Settings,    label: t(language, "nav.settings") },
  ];

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Status bar */}
      <div className="flex items-center justify-between px-6 pt-3 pb-1 shrink-0 bg-background/80 backdrop-blur-sm">
        <span className="text-xs font-semibold text-foreground font-mono">
          {currentTime.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit" })}
        </span>
        <div className="flex items-center gap-1.5">
          <div className="flex gap-0.5 items-end h-3">{[2,3,4,4].map((ht,i) => <div key={i} className="w-1 bg-foreground rounded-sm" style={{ height: `${ht*3}px` }} />)}</div>
          <Droplets size={11} className="text-foreground" />
          <span className="text-xs font-semibold text-foreground font-mono">100%</span>
        </div>
      </div>

      {/* Header */}
      <div className="px-4 pt-2 pb-3 bg-background/80 backdrop-blur-sm border-b border-border shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-[0.2em] font-medium">DOSEWISE</p>
            <h1 className="font-['Fraunces'] text-lg font-semibold text-foreground leading-tight">
              {tab === "home" ? t(language, "header.hello", { name: patient.nickname || patient.name.split(" ")[1] }) : tab === "prescriptions" ? t(language, "nav.medications") : tab === "ai" ? t(language, "nav.askMei") : tab === "notifications" ? t(language, "nav.notifications") : t(language, "nav.settings")}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowTourConfirm(true)} className="w-8 h-8 rounded-full bg-card border border-border flex items-center justify-center">
              <HelpCircle size={15} className="text-muted-foreground" />
            </button>
            <img src={patient.photo} alt={patient.nickname} className="w-9 h-9 rounded-full object-cover border-2 border-primary/30" />
          </div>
        </div>
      </div>

      {/* Screen content */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {tab === "home"          && <ElderlyHomeScreen         patient={patient} onLogDose={handleLogDose} onOpenTravel={() => setShowTravel(true)} justAddedMed={justAddedMed} />}
        {tab === "prescriptions" && <ElderlyPrescriptionScreen patient={patient} onOpenAI={openAI} onAddRx={() => setAddRx("manual")} justAddedMed={justAddedMed} />}
        {tab === "ai"            && (
          <ElderlyAIScreen
            patient={patient}
            elderId={elderId}
            onLogDose={handleLogDose}
            onNavigate={setTab}
            onMedsChanged={refreshMeds}
            onMedAdded={flagJustAdded}
            onOpenTravel={() => setShowTravel(true)}
            doctorQuestions={doctorQuestions}
            onAddDoctorQ={handleAddDoctorQ}
            onMarkAnswered={(id: number) => setDoctorQuestions(p => p.map(q => q.id === id ? { ...q, answered: true } : q))}
            onDeleteQuestion={(id: number) => setDoctorQuestions(p => p.filter(q => q.id !== id))}
            autoMessage={pendingAIMessage}
          />
        )}
        {tab === "notifications" && <ElderlyNotificationsScreen careMessages={careMessages} />}
        {tab === "settings"      && <ElderlySettingsScreen     patient={patient} elderId={elderId} onUpdatePatient={onUpdatePatient} onBack={onBack} onSignOut={onSignOut} />}
      </div>

      {/* Bottom nav — z-40 keeps it (and the Ask Mei FAB peeking above it) painting
          over any scrolled content behind it, regardless of that content's own layout. */}
      <div className="relative z-40 shrink-0 bg-card/95 backdrop-blur-md border-t border-border px-2 pb-6 pt-2">
        <div className="flex items-end">
          {NAV.map(item => {
            if (item.fab) {
              return (
                <div key={item.id} className="relative z-40 flex-1 flex flex-col items-center">
                  <button onClick={() => setTab(item.id)} data-tour={`nav-${item.id}`} className={`relative z-40 w-14 h-14 rounded-full flex items-center justify-center -mt-7 shadow-lg active:scale-95 transition-transform bg-primary ${tab === item.id ? "ring-4 ring-primary/25" : ""}`}>
                    <Brain size={24} className="text-primary-foreground" />
                    {unasked > 0 && (
                      <div className="absolute -top-1 -right-0.5 w-4 h-4 bg-amber-500 rounded-full text-[9px] font-bold text-white flex items-center justify-center">{unasked}</div>
                    )}
                  </button>
                  <span className={`text-[10px] font-medium mt-1 ${tab === item.id ? "text-primary" : "text-muted-foreground"}`}>{item.label}</span>
                </div>
              );
            }
            return (
              <button key={item.id} onClick={() => setTab(item.id)} data-tour={`nav-${item.id}`} className="flex-1 flex flex-col items-center gap-1 py-1">
                <div className={`w-10 h-7 rounded-2xl flex items-center justify-center transition-colors relative ${tab === item.id ? "bg-primary" : ""}`}>
                  <item.icon size={18} className={tab === item.id ? "text-primary-foreground" : "text-muted-foreground"} />
                </div>
                <span className={`text-[10px] font-medium ${tab === item.id ? "text-primary" : "text-muted-foreground"}`}>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {addRx && <AddPrescriptionSheet initialTab={addRx} routine={{ ...patient.mealTimes, sleepTime: patient.sleepTime }} onClose={() => setAddRx(null)} onAdd={handleAddPrescription} onAdded={() => setTab("prescriptions")} onAgentAdded={(name?: string) => { void refreshMeds(); flagJustAdded(name); setTab("prescriptions"); }} />}
      {showTravel && (
        <TravelModeSheet
          patient={patient}
          elderId={elderId}
          onClose={() => setShowTravel(false)}
          onSaved={plan => onUpdatePatient({ ...patient, travelPlan: plan })}
        />
      )}
      {showTour && <GuidedTour steps={tourSteps} onFinish={() => setShowTour(false)} />}
      {showTourConfirm && (
        <ConfirmDialog
          title={t(language, "confirm.replayTourTitle")}
          body={t(language, "confirm.replayTourBodyElder")}
          confirmLabel={t(language, "confirm.replay")}
          onConfirm={() => { setShowTourConfirm(false); setShowTour(true); }}
          onCancel={() => setShowTourConfirm(false)}
        />
      )}
    </div>
  );
}
