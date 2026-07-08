import { useEffect, useState } from "react";
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
import { logDoseTaken, addMedication, to24h } from "../../lib/medications";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";

export function ElderlyApp({ patient, elderId, onUpdatePatient, onBack, onSignOut, startTour }: {
  patient: Patient;
  elderId?: string;
  onUpdatePatient: (p: Patient) => void;
  onBack: () => void;
  onSignOut: () => void;
  startTour?: boolean;
}) {
  const [tab, setTab] = useState<ElderlyTab>("home");
  const [currentTime, setCurrentTime] = useState(new Date());
  const [pendingAIMessage, setPendingAIMessage] = useState<string | undefined>();
  const [addRx, setAddRx] = useState<null | "scan" | "manual">(null);
  const [showTravel, setShowTravel] = useState(false);
  const [showTour, setShowTour] = useState(!!startTour);
  const [showTourConfirm, setShowTourConfirm] = useState(false);
  const { language } = useLanguage();

  useEffect(() => {
    const intervalId = window.setInterval(() => setCurrentTime(new Date()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const tourSteps: TourStep[] = [
    {
      target: '[data-tour="elder-schedule"]', navTarget: '[data-tour="nav-home"]', onEnter: () => setTab("home"),
      title: "Your daily schedule", body: "Your medicines for the day appear here, at the time you take them. Tap a card to mark it as taken.",
    },
    {
      target: '[data-tour="elder-medlist"]', navTarget: '[data-tour="nav-prescriptions"]', onEnter: () => setTab("prescriptions"),
      title: "Your medications", body: "See every medicine you're taking, how to take it, and how much supply you have left.",
    },
    {
      target: '[data-tour="elder-add-prescription"]', navTarget: '[data-tour="nav-prescriptions"]', onEnter: () => setTab("prescriptions"),
      title: "Add a new prescription", body: "Tap here to add a medicine by typing it in, or snap a photo of the label.",
    },
    {
      target: '[data-tour="elder-quickhelp"]', navTarget: '[data-tour="nav-ai"]', onEnter: () => setTab("ai"),
      title: "Ask Mei", body: "Chat with Mei anytime — add a prescription by photo, ask about a medicine, or plan a trip with Travel Mode.",
    },
    {
      target: '[data-tour="elder-profile-section"]', navTarget: '[data-tour="nav-settings"]', onEnter: () => setTab("settings"),
      title: "Your profile", body: "Update your age, conditions, allergies, and more here anytime — this is what Mei uses to keep you safe.",
    },
    {
      target: '[data-tour="elder-fontsize"]', navTarget: '[data-tour="nav-settings"]', onEnter: () => setTab("settings"),
      title: "Make text easier to read", body: "Drag this to make text bigger or smaller, whatever's comfortable for you.",
    },
    {
      target: '[data-tour="elder-language"]', navTarget: '[data-tour="nav-settings"]', onEnter: () => setTab("settings"),
      title: "Language & voice", body: "Change the language Mei speaks and types in, and turn her spoken replies on or off.",
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

  const handleAddPrescription = async (med: Omit<Medication, "id" | "status">) => {
    const nextId = patient.medications.reduce((max, m) => Math.max(max, m.id), 0) + 1;
    const medicationId = elderId
      ? await addMedication(elderId, { name: med.name, dosage: med.dose, purpose: med.purpose, timeHHMM: to24h(med.time), refillDays: med.refillDaysLeft })
      : undefined;
    onUpdatePatient({ ...patient, medications: [...patient.medications, { ...med, id: nextId, medicationId, status: "upcoming" as MedStatus }] });
  };

  const handleAddDoctorQ = (q: string) => {
    setDoctorQuestions(prev => [{ id: Date.now(), question: q, addedAt: `Added by Mei · ${new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" })}`, answered: false }, ...prev]);
  };

  const CARE_MSGS: Message[] = [
    { id: 1, author: "Tan Wei Ming", role: "Son",      body: "Hi Ah Ma, remember your Celecoxib after lunch today. Dr. Priya called — blood test is next Tuesday at 10am.", time: "10:30 AM",  isMe: false },
    { id: 2, author: "Tan Shu Fen",  role: "Daughter", body: "Ma, I refilled your Atorvastatin — it's in the cabinet above the stove 💙",                                   time: "Yesterday", isMe: false },
  ];

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
      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === "home"          && <ElderlyHomeScreen         patient={patient} onLogDose={handleLogDose} onOpenTravel={() => setShowTravel(true)} />}
        {tab === "prescriptions" && <ElderlyPrescriptionScreen patient={patient} onOpenAI={openAI} onAddRx={() => setAddRx("manual")} />}
        {tab === "ai"            && (
          <ElderlyAIScreen
            patient={patient}
            onLogDose={handleLogDose}
            onNavigate={setTab}
            onAddRxPhoto={() => setAddRx("scan")}
            onOpenTravel={() => setShowTravel(true)}
            doctorQuestions={doctorQuestions}
            onAddDoctorQ={handleAddDoctorQ}
            onMarkAnswered={(id: number) => setDoctorQuestions(p => p.map(q => q.id === id ? { ...q, answered: true } : q))}
            onDeleteQuestion={(id: number) => setDoctorQuestions(p => p.filter(q => q.id !== id))}
            autoMessage={pendingAIMessage}
          />
        )}
        {tab === "notifications" && <ElderlyNotificationsScreen careMessages={CARE_MSGS} />}
        {tab === "settings"      && <ElderlySettingsScreen     patient={patient} elderId={elderId} onUpdatePatient={onUpdatePatient} onBack={onBack} onSignOut={onSignOut} />}
      </div>

      {/* Bottom nav */}
      <div className="shrink-0 bg-card/95 backdrop-blur-md border-t border-border px-2 pb-6 pt-2">
        <div className="flex items-end">
          {NAV.map(item => {
            if (item.fab) {
              return (
                <div key={item.id} className="flex-1 flex flex-col items-center">
                  <button onClick={() => setTab(item.id)} data-tour={`nav-${item.id}`} className={`relative w-14 h-14 rounded-full flex items-center justify-center -mt-7 shadow-lg active:scale-95 transition-transform bg-primary ${tab === item.id ? "ring-4 ring-primary/25" : ""}`}>
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

      {addRx && <AddPrescriptionSheet initialTab={addRx} onClose={() => setAddRx(null)} onAdd={handleAddPrescription} onAdded={() => setTab("prescriptions")} />}
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
          title="Replay guided tour?"
          body="We'll walk you through the main features again, starting from Home."
          confirmLabel="Replay"
          onConfirm={() => { setShowTourConfirm(false); setShowTour(true); }}
          onCancel={() => setShowTourConfirm(false)}
        />
      )}
    </div>
  );
}
