import { useState } from "react";
import { Droplets, Home, Pill, Brain, Bell, Settings } from "lucide-react";
import type { Patient, MedStatus, Message } from "../../types";
import type { ElderlyTab, DoctorQ } from "./types";
import { ElderlyHomeScreen } from "./ElderlyHomeScreen";
import { ElderlyPrescriptionScreen } from "./ElderlyPrescriptionScreen";
import { ElderlyAIScreen } from "./ElderlyAIScreen";
import { ElderlyNotificationsScreen } from "./ElderlyNotificationsScreen";
import { ElderlySettingsScreen } from "./ElderlySettingsScreen";

export function ElderlyApp({ patient, onUpdatePatient, onBack }: {
  patient: Patient;
  onUpdatePatient: (p: Patient) => void;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<ElderlyTab>("home");
  const [pendingAIMessage, setPendingAIMessage] = useState<string | undefined>();

  const openAI = (msg?: string) => {
    setPendingAIMessage(msg);
    setTab("ai");
  };
  const [doctorQuestions, setDoctorQuestions] = useState<DoctorQ[]>([
    { id: 1, question: "Can I take Celecoxib and Metformin at the same time?",           addedAt: "Added by Mei · Today",     answered: false },
    { id: 2, question: "Is it normal to feel a little dizzy after taking Amlodipine?",  addedAt: "Added by Mei · Yesterday", answered: false },
  ]);

  const handleLogDose = (medId: number) => {
    const t = new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });
    onUpdatePatient({ ...patient, medications: patient.medications.map(m => m.id === medId ? { ...m, status: "taken" as MedStatus, takenAt: t } : m) });
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
    { id: "home",          icon: Home,        label: "Home"     },
    { id: "prescriptions", icon: Pill,        label: "Medicines" },
    { id: "ai",            icon: Brain,       label: "Ask Mei",  fab: true },
    { id: "notifications", icon: Bell,        label: "Notifications" },
    { id: "settings",      icon: Settings,    label: "Settings" },
  ];

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Status bar */}
      <div className="flex items-center justify-between px-6 pt-3 pb-1 shrink-0 bg-background/80 backdrop-blur-sm">
        <span className="text-xs font-semibold text-foreground font-mono">9:41</span>
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
              {tab === "home" ? "Home" : tab === "prescriptions" ? "My Medicines" : tab === "ai" ? "Ask Mei" : tab === "notifications" ? "Notifications" : "Settings"}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <img src={patient.photo} alt={patient.nickname} className="w-9 h-9 rounded-full object-cover border-2 border-primary/30" />
          </div>
        </div>
      </div>

      {/* Screen content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === "home"          && <ElderlyHomeScreen         patient={patient} onLogDose={handleLogDose} onNavigate={setTab} />}
        {tab === "prescriptions" && <ElderlyPrescriptionScreen patient={patient} onOpenAI={openAI} />}
        {tab === "ai"            && (
          <ElderlyAIScreen
            patient={patient}
            onLogDose={handleLogDose}
            onNavigate={setTab}
            doctorQuestions={doctorQuestions}
            onAddDoctorQ={handleAddDoctorQ}
            onMarkAnswered={(id: number) => setDoctorQuestions(p => p.map(q => q.id === id ? { ...q, answered: true } : q))}
            onDeleteQuestion={(id: number) => setDoctorQuestions(p => p.filter(q => q.id !== id))}
            autoMessage={pendingAIMessage}
          />
        )}
        {tab === "notifications" && <ElderlyNotificationsScreen careMessages={CARE_MSGS} />}
        {tab === "settings"      && <ElderlySettingsScreen     patient={patient} onBack={onBack} />}
      </div>

      {/* Bottom nav */}
      <div className="shrink-0 bg-card/95 backdrop-blur-md border-t border-border px-2 pb-6 pt-2">
        <div className="flex items-end">
          {NAV.map(item => {
            if (item.fab) {
              return (
                <div key={item.id} className="flex-1 flex flex-col items-center">
                  <button onClick={() => setTab(item.id)} className={`relative w-14 h-14 rounded-full flex items-center justify-center -mt-7 shadow-lg active:scale-95 transition-transform bg-primary ${tab === item.id ? "ring-4 ring-primary/25" : ""}`}>
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
              <button key={item.id} onClick={() => setTab(item.id)} className="flex-1 flex flex-col items-center gap-1 py-1">
                <div className={`w-10 h-7 rounded-2xl flex items-center justify-center transition-colors relative ${tab === item.id ? "bg-primary" : ""}`}>
                  <item.icon size={18} className={tab === item.id ? "text-primary-foreground" : "text-muted-foreground"} />
                </div>
                <span className={`text-[10px] font-medium ${tab === item.id ? "text-primary" : "text-muted-foreground"}`}>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
