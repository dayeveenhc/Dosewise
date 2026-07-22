import { useState } from "react";
import { Droplets, HelpCircle, UserRound, Hourglass } from "lucide-react";
import type { Patient, Screen } from "../../types";
import type { DoctorQ } from "../elderly/types";
import { PatientSwitcher } from "../../components/shared";
import { BottomNav } from "../../components/BottomNav";
import { SendReminderSheet } from "../SendReminderSheet";
import { WalkthroughCaregiverDashboard } from "./WalkthroughCaregiverDashboard";
import { WalkthroughCaregiverPatientScreen } from "./WalkthroughCaregiverPatientScreen";
import { WalkthroughCaregiverTimelineScreen } from "./WalkthroughCaregiverTimelineScreen";
import { WalkthroughCaregiverAIScreen } from "./WalkthroughCaregiverAIScreen";

// Shown on every tab while the selected patient is Margaret and she hasn't
// yet accepted the pairing request sent during onboarding — the caregiver's
// other patients (already linked) are unaffected, only Margaret's row in the
// PatientSwitcher is gated like this.
function PendingCaregiverState({ patientName }: { patientName: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-8 text-center gap-3">
      <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center">
        <Hourglass size={22} className="text-primary" />
      </div>
      <h2 className="font-['Fraunces'] text-lg font-semibold text-foreground">Waiting for {patientName}</h2>
      <p className="text-sm text-muted-foreground max-w-[260px]">
        Your request is on its way to {patientName}'s Notifications — once she accepts, her medications, schedule and medical history will show up here.
      </p>
    </div>
  );
}

// Caregiver-side shell for walkthrough 2 — mirrors App.tsx's caregiver-mode
// JSX (status bar, header, PatientSwitcher, tab switch, BottomNav), but
// pinned to this scenario's own fixed clock rather than the real one, and
// scoped to the one screens this scenario actually visits (no
// Notifications/Messages, and Settings is a placeholder).
export function WalkthroughCaregiverApp({
  patients, selectedPatient, onSelectPatient, pendingPatientId, pinnedNow, doctorQuestions, onAddDoctorQ, onMarkAnswered, onDeleteQuestion,
  onReminderSent, onTabChange,
}: {
  patients: Patient[];
  selectedPatient: number;
  onSelectPatient: (i: number) => void;
  // Id of the one patient still awaiting acceptance (Margaret, until she
  // accepts) — null once there's nothing pending. Only that patient's tabs
  // show PendingCaregiverState; the others (already linked) work normally.
  pendingPatientId: number | null;
  pinnedNow: Date;
  doctorQuestions: DoctorQ[];
  onAddDoctorQ: (q: string) => void;
  onMarkAnswered: (id: number) => void;
  onDeleteQuestion: (id: number) => void;
  onReminderSent: (text: string) => void;
  onTabChange: (tab: Screen) => void;
}) {
  const [tab, setTab] = useState<Screen>("dashboard");
  const [showSendReminder, setShowSendReminder] = useState<{ medName?: string } | null>(null);
  const patient = patients[selectedPatient];
  const isPending = patient.id === pendingPatientId;

  const changeTab = (next: Screen) => {
    setTab(next);
    onTabChange(next);
  };

  const title = tab === "dashboard" ? "Dashboard" : tab === "patient" ? "Medications" : tab === "timeline" ? "Schedule" : tab === "ai" ? "Ask Mei" : "Settings";

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Status bar — pinned to the scenario's own clock, not the real one. */}
      <div className="flex items-center justify-between px-6 pt-3 pb-1 shrink-0 bg-background/80 backdrop-blur-sm">
        <span className="text-xs font-semibold text-foreground font-mono">
          {pinnedNow.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit" })}
        </span>
        <div className="flex items-center gap-1.5">
          <div className="flex gap-0.5 items-end h-3">{[2, 3, 4, 4].map((ht, i) => <div key={i} className="w-1 bg-foreground rounded-sm" style={{ height: `${ht * 3}px` }} />)}</div>
          <Droplets size={11} className="text-foreground" />
          <span className="text-xs font-semibold text-foreground font-mono">100%</span>
        </div>
      </div>

      {/* Header */}
      <div className="relative z-30 px-4 pt-2 pb-3 bg-background/80 backdrop-blur-sm border-b border-border shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium tracking-[0.2em]">DOSEWISE</p>
            <h1 className="font-['Fraunces'] text-lg font-semibold text-foreground leading-tight">{title}</h1>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-card border border-border rounded-xl flex items-center justify-center">
              <HelpCircle size={15} className="text-muted-foreground" />
            </div>
            <div className="w-8 h-8 bg-card border border-border rounded-xl flex items-center justify-center">
              <UserRound size={15} className="text-primary" />
            </div>
          </div>
        </div>
        {(tab === "dashboard" || tab === "patient" || tab === "timeline") && (
          <PatientSwitcher patients={patients} selected={selectedPatient} onSelect={onSelectPatient} onAdd={() => {}} />
        )}
      </div>

      {/* Screen content */}
      <div className={`flex-1 ${tab === "ai" ? "overflow-hidden flex flex-col" : "overflow-y-auto scrollbar-none"}`}>
        {isPending ? (
          <PendingCaregiverState patientName={patient.nickname} />
        ) : (
          <>
            {tab === "dashboard" && (
              <WalkthroughCaregiverDashboard
                patient={patient}
                onNavigate={changeTab}
                onSendReminder={medName => setShowSendReminder({ medName })}
              />
            )}
            {tab === "patient" && (
              <WalkthroughCaregiverPatientScreen
                patient={patient}
                onEditProfile={() => {}}
                onAddPrescription={() => {}}
                onDeleteMedication={() => {}}
              />
            )}
            {tab === "timeline" && (
              <WalkthroughCaregiverTimelineScreen
                patient={patient}
                pinnedNow={pinnedNow}
                onSendReminder={medName => setShowSendReminder({ medName })}
              />
            )}
            {tab === "ai" && (
              <WalkthroughCaregiverAIScreen
                patient={patient}
                doctorQuestions={doctorQuestions}
                onAddDoctorQ={onAddDoctorQ}
                onMarkAnswered={onMarkAnswered}
                onDeleteQuestion={onDeleteQuestion}
              />
            )}
            {tab === "settings" && (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">Not part of this demo.</div>
            )}
          </>
        )}
      </div>

      {showSendReminder && (
        <SendReminderSheet
          patientName={patient.nickname}
          medName={showSendReminder.medName}
          onClose={() => setShowSendReminder(null)}
          onSend={text => { onReminderSent(text); }}
        />
      )}

      <BottomNav activeTab={tab} onSelect={changeTab} />
    </div>
  );
}
