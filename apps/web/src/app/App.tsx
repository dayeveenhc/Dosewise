import { useState } from "react";
import { Droplets, ArrowLeft, Bell, MessageSquare } from "lucide-react";
import type { AppMode, Screen, Patient, Medication } from "./types";
import { PATIENTS, NOTIFICATIONS } from "./data/patients";
import { NAV_ITEMS } from "./nav";
import { PatientSwitcher } from "./components/shared";
import { OnboardingScreen } from "./screens/OnboardingScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { PatientScreen } from "./screens/PatientScreen";
import { TimelineScreen } from "./screens/TimelineScreen";
import { NotificationsScreen } from "./screens/NotificationsScreen";
import { AskMeiScreen } from "./screens/AskMeiScreen";
import { MessagesScreen } from "./screens/MessagesScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { AddPrescriptionSheet } from "./screens/AddPrescriptionSheet";
import { EditProfileSheet } from "./screens/EditProfileSheet";
import { ElderlyApp } from "./screens/elderly/ElderlyApp";
import { AccessibilityProvider } from "./accessibility.tsx";

export default function App() {
  const [appMode, setAppMode] = useState<AppMode>("onboarding");
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [selectedPatient, setSelectedPatient] = useState(0);
  const [patients, setPatients] = useState<Patient[]>(PATIENTS);
  const [showAddPrescription, setShowAddPrescription] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);

  const patient = patients[selectedPatient];
  let nextMedId = patients.flatMap(p => p.medications).reduce((max, m) => Math.max(max, m.id), 0) + 1;

  const handleAddPrescription = (med: Omit<Medication, "id" | "status">) => {
    setPatients(prev => prev.map((p, i) => i !== selectedPatient ? p : {
      ...p,
      medications: [...p.medications, { ...med, id: nextMedId++, status: "upcoming" }],
    }));
  };

  const handleUpdatePatient = (updated: Patient) => {
    setPatients(prev => prev.map((p, i) => i === selectedPatient ? updated : p));
  };

  const unreadCount = NOTIFICATIONS.filter(n => !n.read).length;
  const activeTab = ["dashboard", "timeline", "ai", "patient"].includes(screen)
    ? screen
    : "settings";

  const showPatientSwitcher = ["dashboard", "patient", "timeline"].includes(screen);
  const showBack = ["messages"].includes(screen);

  if (appMode === "onboarding") {
    return (
      <div className="min-h-screen bg-stone-300 flex items-center justify-center p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <div className="w-[390px] h-[844px] bg-background relative overflow-hidden rounded-[3rem] shadow-2xl border-[6px] border-stone-800 flex flex-col">
          <OnboardingScreen onSelect={(mode) => { setScreen("dashboard"); setAppMode(mode); }} />
        </div>
      </div>
    );
  }

  if (appMode === "elderly") {
    return (
      <div className="min-h-screen bg-stone-300 flex items-center justify-center p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <div className="w-[390px] h-[844px] bg-background relative overflow-hidden rounded-[3rem] shadow-2xl border-[6px] border-stone-800 flex flex-col">
          <AccessibilityProvider>
            <ElderlyApp
              patient={patients[0]}
              onUpdatePatient={(p) => setPatients(prev => [p, ...prev.slice(1)])}
              onBack={() => setAppMode("onboarding")}
            />
          </AccessibilityProvider>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-300 flex items-center justify-center p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {/* Phone frame */}
      <div className="w-[390px] h-[844px] bg-background relative overflow-hidden rounded-[3rem] shadow-2xl border-[6px] border-stone-800 flex flex-col">
        {/* Status bar */}
        <div className="flex items-center justify-between px-6 pt-3 pb-1 shrink-0 bg-background/80 backdrop-blur-sm">
          <span className="text-xs font-semibold text-foreground font-mono">9:41</span>
          <div className="flex items-center gap-1.5">
            <div className="flex gap-0.5 items-end h-3">
              {[2, 3, 4, 4].map((h, i) => <div key={i} className="w-1 bg-foreground rounded-sm" style={{ height: `${h * 3}px` }} />)}
            </div>
            <Droplets size={11} className="text-foreground" />
            <div className="text-xs font-semibold text-foreground font-mono">100%</div>
          </div>
        </div>

        {/* App header */}
        <div className="px-4 pt-2 pb-3 bg-background/80 backdrop-blur-sm border-b border-border shrink-0">
          {showBack ? (
            <div className="flex items-center gap-2 mb-2">
              <button onClick={() => setScreen("dashboard")} className="w-8 h-8 bg-card border border-border rounded-xl flex items-center justify-center">
                <ArrowLeft size={14} className="text-foreground" />
              </button>
              <span className="text-sm font-medium text-muted-foreground">Care Team Notes</span>
            </div>
          ) : (
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium tracking-[0.2em]">DOSEWISE</p>
                <h1 className="font-['Fraunces'] text-lg font-semibold text-foreground leading-tight">
                  {screen === "dashboard" ? "Dashboard" : screen === "patient" ? "Patient" : screen === "timeline" ? "Schedule" : screen === "ai" ? "Ask Mei" : screen === "settings" ? "Settings" : "Notifications"}
                </h1>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setScreen("messages")} className="w-8 h-8 bg-card border border-border rounded-xl flex items-center justify-center">
                  <MessageSquare size={15} className="text-accent" />
                </button>
                <button onClick={() => setScreen("notifications")} className="w-8 h-8 bg-card border border-border rounded-xl flex items-center justify-center relative">
                  <Bell size={15} className="text-primary" />
                  {unreadCount > 0 && (
                    <div className="absolute -top-1 -right-1 w-4 h-4 bg-destructive rounded-full flex items-center justify-center text-[9px] font-bold text-white">{unreadCount}</div>
                  )}
                </button>
              </div>
            </div>
          )}
          {showPatientSwitcher && (
            <PatientSwitcher patients={patients} selected={selectedPatient} onSelect={setSelectedPatient} />
          )}
        </div>

        {/* Screen content */}
        <div className={`flex-1 ${screen === "ai" ? "overflow-hidden flex flex-col" : "overflow-y-auto scrollbar-none"}`}>
          {screen === "dashboard" && <DashboardScreen patient={patient} onNavigate={setScreen} />}
          {screen === "patient" && (
            <PatientScreen
              patient={patient}
              onEditProfile={() => setShowEditProfile(true)}
              onAddPrescription={() => setShowAddPrescription(true)}
              onDeleteMedication={(id) => setPatients(prev => prev.map((p, i) => i !== selectedPatient ? p : { ...p, medications: p.medications.filter(m => m.id !== id) }))}
            />
          )}
          {screen === "timeline" && <TimelineScreen patient={patient} />}
          {screen === "notifications" && <NotificationsScreen />}
          {screen === "ai" && <AskMeiScreen patient={patient} />}
          {screen === "messages" && <MessagesScreen />}
          {screen === "settings" && <SettingsScreen onSwitchMode={() => setAppMode("onboarding")} />}
        </div>

        {/* Modals */}
        {showAddPrescription && (
          <AddPrescriptionSheet
            onClose={() => setShowAddPrescription(false)}
            onAdd={handleAddPrescription}
          />
        )}
        {showEditProfile && (
          <EditProfileSheet
            patient={patient}
            onClose={() => setShowEditProfile(false)}
            onSave={handleUpdatePatient}
          />
        )}

        {/* Bottom navigation */}
        <div className="shrink-0 bg-card/95 backdrop-blur-md border-t border-border px-2 pb-6 pt-2">
          <div className="flex items-end">
            {NAV_ITEMS.map(item => {
              const isActive = activeTab === item.id;
              if (item.fab) {
                return (
                  <div key={item.id} className="flex-1 flex flex-col items-center">
                    <button
                      onClick={() => setScreen(item.id)}
                      className={`w-14 h-14 rounded-full flex items-center justify-center -mt-7 shadow-lg active:scale-95 transition-transform bg-primary ${isActive ? "ring-4 ring-primary/25" : ""}`}
                    >
                      <item.icon size={24} className="text-primary-foreground" />
                    </button>
                    <span className={`text-[10px] font-medium mt-1 ${isActive ? "text-primary" : "text-muted-foreground"}`}>{item.label}</span>
                  </div>
                );
              }
              return (
                <button
                  key={item.id}
                  onClick={() => setScreen(item.id)}
                  className="flex-1 flex flex-col items-center gap-1 py-1 relative"
                >
                  <div className={`w-10 h-7 rounded-2xl flex items-center justify-center transition-colors ${isActive ? "bg-primary" : ""}`}>
                    <item.icon size={18} className={isActive ? "text-primary-foreground" : "text-muted-foreground"} />
                  </div>
                  <span className={`text-[10px] font-medium transition-colors ${isActive ? "text-primary" : "text-muted-foreground"}`}>
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
