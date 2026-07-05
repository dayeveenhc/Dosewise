import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Droplets, ArrowLeft, Bell, MessageSquare } from "lucide-react";
import type { AppMode, Screen, Patient, Medication } from "./types";
import { supabase } from "./lib/supabase";
import { fetchMyProfile, fetchPatients, addPrescription, archiveMedication, createLinkedElder } from "./data/api";
import type { Profile } from "./data/api";
import { NOTIFICATIONS } from "./data/patients";
import { NAV_ITEMS } from "./nav";
import { PatientSwitcher } from "./components/shared";
import { OnboardingScreen } from "./screens/OnboardingScreen";
import { AuthScreen } from "./screens/AuthScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { PatientScreen } from "./screens/PatientScreen";
import { TimelineScreen } from "./screens/TimelineScreen";
import { NotificationsScreen } from "./screens/NotificationsScreen";
import { AskMeiScreen } from "./screens/AskMeiScreen";
import { MessagesScreen } from "./screens/MessagesScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { AddPrescriptionSheet } from "./screens/AddPrescriptionSheet";
import { AddCareRecipientSheet } from "./screens/AddCareRecipientSheet";
import { EditProfileSheet } from "./screens/EditProfileSheet";
import { ElderlyApp } from "./screens/elderly/ElderlyApp";
import { AccessibilityProvider } from "./accessibility.tsx";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pendingRole, setPendingRole] = useState<"elder" | "caregiver" | null>(null);
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [selectedPatient, setSelectedPatient] = useState(0);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [showAddPrescription, setShowAddPrescription] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [showAddCareRecipient, setShowAddCareRecipient] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setProfile(null); return; }
    fetchMyProfile(session.user.id).then(setProfile).catch(console.error);
  }, [session]);

  const reloadPatients = () => {
    if (!profile) return;
    fetchPatients(profile).then(setPatients).catch(console.error);
  };

  useEffect(() => {
    if (profile) reloadPatients();
    else setPatients([]);
    setScreen("dashboard");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const patient = patients[selectedPatient];
  const currentUserId = session?.user.id ?? "";

  const handleAddPrescription = async (med: Omit<Medication, "id" | "medicationId" | "status" | "colour">) => {
    if (!patient) return;
    await addPrescription(patient.id, med);
    reloadPatients();
  };

  const handleArchiveMedication = async (medicationId: string) => {
    await archiveMedication(medicationId);
    reloadPatients();
  };

  const handleAddCareRecipient = async (fullName: string, relationship: string) => {
    await createLinkedElder(currentUserId, fullName, relationship);
    reloadPatients();
  };

  const unreadCount = NOTIFICATIONS.filter(n => !n.read).length;
  const activeTab = ["dashboard", "timeline", "ai", "patient"].includes(screen)
    ? screen
    : "settings";

  const showPatientSwitcher = ["dashboard", "patient", "timeline"].includes(screen);
  const showBack = ["messages"].includes(screen);

  if (!session || !profile) {
    if (!pendingRole) {
      return (
        <div className="min-h-screen bg-stone-300 flex items-center justify-center p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
          <div className="w-[390px] h-[844px] bg-background relative overflow-hidden rounded-[3rem] shadow-2xl border-[6px] border-stone-800 flex flex-col">
            <OnboardingScreen onSelect={(mode) => setPendingRole(mode === "caregiver" ? "caregiver" : "elder")} />
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-screen bg-stone-300 flex items-center justify-center p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <div className="w-[390px] h-[844px] bg-background relative overflow-hidden rounded-[3rem] shadow-2xl border-[6px] border-stone-800 flex flex-col">
          <AuthScreen
            role={pendingRole}
            onBack={() => setPendingRole(null)}
            onAuthed={(userId) => { fetchMyProfile(userId).then(setProfile).catch(console.error); }}
          />
        </div>
      </div>
    );
  }

  const appMode: AppMode = profile.role === "elder" ? "elderly" : "caregiver";

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setPendingRole(null);
  };

  if (appMode === "elderly") {
    return (
      <div className="min-h-screen bg-stone-300 flex items-center justify-center p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <div className="w-[390px] h-[844px] bg-background relative overflow-hidden rounded-[3rem] shadow-2xl border-[6px] border-stone-800 flex flex-col">
          <AccessibilityProvider>
            {patient && (
              <ElderlyApp
                patient={patient}
                onUpdatePatient={reloadPatients}
                onBack={handleSignOut}
              />
            )}
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
            <PatientSwitcher
              patients={patients}
              selected={selectedPatient}
              onSelect={setSelectedPatient}
              onAddCareRecipient={() => setShowAddCareRecipient(true)}
            />
          )}
        </div>

        {/* Screen content */}
        <div className={`flex-1 ${screen === "ai" ? "overflow-hidden flex flex-col" : "overflow-y-auto scrollbar-none"}`}>
          {patient && screen === "dashboard" && <DashboardScreen patient={patient} onNavigate={setScreen} />}
          {patient && screen === "patient" && (
            <PatientScreen
              patient={patient}
              onEditProfile={() => setShowEditProfile(true)}
              onAddPrescription={() => setShowAddPrescription(true)}
              onDeleteMedication={handleArchiveMedication}
            />
          )}
          {patient && screen === "timeline" && <TimelineScreen patient={patient} />}
          {screen === "notifications" && <NotificationsScreen />}
          {patient && screen === "ai" && <AskMeiScreen patient={patient} />}
          {patient && screen === "messages" && <MessagesScreen patient={patient} currentUserId={currentUserId} />}
          {screen === "settings" && <SettingsScreen onSwitchMode={handleSignOut} />}
        </div>

        {/* Modals */}
        {showAddPrescription && (
          <AddPrescriptionSheet
            onClose={() => setShowAddPrescription(false)}
            onAdd={handleAddPrescription}
          />
        )}
        {showEditProfile && patient && (
          <EditProfileSheet
            patient={patient}
            onClose={() => setShowEditProfile(false)}
            onSave={() => setShowEditProfile(false)}
          />
        )}
        {showAddCareRecipient && (
          <AddCareRecipientSheet
            onClose={() => setShowAddCareRecipient(false)}
            onAdd={handleAddCareRecipient}
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
