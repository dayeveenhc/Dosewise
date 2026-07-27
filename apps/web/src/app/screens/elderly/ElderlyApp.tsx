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
import { ChangeHighlight } from "../../components/ChangeHighlight";
import { HighlightCaption } from "../../components/HighlightCaption";
import type { AgentAction } from "../../lib/hermes";
import { GuidedTour } from "../../components/GuidedTour";
import type { TourStep } from "../../components/GuidedTour";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { logDoseTaken, addMedication, fetchElderMedications, fetchArchivedMedications, to24h } from "../../lib/medications";
import { defaultDoseTime } from "../../components/TimesPicker";
import { MED_COLOURS } from "../../data/medications";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";
import { Walkthrough } from "../../components/Walkthrough";
import { resolveWalkthroughSteps } from "../../lib/walkthrough/steps";
import { PACING } from "../../lib/walkthrough/pacing";
import { buildVerifyRunner } from "../../lib/walkthrough/verify";
import type { WalkthroughScreen, WalkthroughTaskName, VerifyDirective, RevealDirective, WalkthroughParams } from "../../lib/walkthrough/types";
import { loadWalkthroughSession, saveWalkthroughSession, clearWalkthroughSession } from "../../lib/walkthroughState";
import { markWalkthroughCompleted, fetchProfile } from "../../lib/profile";
import { fetchDoctorQuestions } from "../../lib/doctor";
import { hasActiveCareLink } from "../../lib/careLinks";

export function ElderlyApp({ patient, elderId, onUpdatePatient, onBack, onSignOut, startTour, careMessages, onStartOnboardingWizard }: {
  patient: Patient;
  elderId?: string;
  onUpdatePatient: (p: Patient | ((prev: Patient) => Patient)) => void;
  onBack: () => void;
  onSignOut: () => void;
  startTour?: boolean;
  careMessages: Message[];
  // Chat asked for the "onboarding" walkthrough — its steps live on the
  // wizard, a separate stage this shell can't spotlight, so the host (App)
  // switches into it and resumes back here on exit.
  onStartOnboardingWizard?: () => void;
}) {
  const [tab, setTab] = useState<ElderlyTab>("home");
  const [currentTime, setCurrentTime] = useState(new Date());
  const [pendingAIMessage, setPendingAIMessage] = useState<string | undefined>();
  // Pre-fills Ask Mei's input box WITHOUT sending — the elder still taps Send
  // themselves (unlike pendingAIMessage above, which auto-sends).
  const [pendingPrefill, setPendingPrefill] = useState<string | undefined>();
  const [walkthroughTask, setWalkthroughTask] = useState<WalkthroughTaskName | null>(null);
  const [walkthroughStepIndex, setWalkthroughStepIndex] = useState(0);
  const [walkthroughParams, setWalkthroughParams] = useState<WalkthroughParams>({});
  const [addRx, setAddRx] = useState<null | "scan" | "manual">(null);
  const [showTravel, setShowTravel] = useState(false);
  const [showTour, setShowTour] = useState(!!startTour);
  const [showTourConfirm, setShowTourConfirm] = useState(false);
  // Name of a just-added medication, so the schedule/prescription screens can show a
  // "Just added" highlight as visible proof it landed. Auto-clears after a few seconds.
  const [justAddedMed, setJustAddedMed] = useState<string | null>(null);
  const justAddedTimer = useRef<number>();
  // The committed change currently being pulse-highlighted by ChangeHighlight
  // (the canonical "here's the exact record that changed" layer). One at a time.
  const [highlightChange, setHighlightChange] = useState<AgentAction | null>(null);
  // A transient walkthrough-Reveal caption (client-driven writes: travel, profile,
  // condition/allergy) — glued to the pulsed element via the same shared bubble
  // ChangeHighlight uses, so both prove WHAT changed identically.
  const [revealCaption, setRevealCaption] = useState<{ rect: DOMRect; verb: string; text: string } | null>(null);
  const revealCaptionRaf = useRef<number>();
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
    {
      target: '[data-tour="elder-qr-link"]', navTarget: '[data-tour="nav-settings"]', onEnter: () => setTab("settings"),
      title: t(language, "tour.elderQrTitle"), body: t(language, "tour.elderQrBody"),
    },
  ];

  const openAI = (msg?: string) => {
    setPendingAIMessage(msg);
    setTab("ai");
  };

  const openAIPrefill = (msg: string) => {
    setPendingPrefill(msg);
    setTab("ai");
  };

  // Resume a same-tab, in-progress walkthrough (e.g. the elder switched to
  // chat mid-way and came back) — never across a hard refresh, matching the
  // onboarding wizard's own existing (accepted) behaviour of not surviving one.
  useEffect(() => {
    const session = loadWalkthroughSession(elderId);
    if (session) {
      setWalkthroughTask(session.taskName);
      setWalkthroughStepIndex(session.stepIndex);
      setWalkthroughParams(session.params ?? {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const walkthroughSteps = walkthroughTask ? resolveWalkthroughSteps(walkthroughTask, "elder", walkthroughParams) : [];

  const handleWalkthroughStart = (taskName: WalkthroughTaskName, params: WalkthroughParams = {}) => {
    // "onboarding" steps live on the wizard, not this shell — running them here
    // would stall on selectors that never mount. Surface it to App instead
    // (chat→wizard entry; scenario s30 finishes the UX). Deliberately does NOT
    // save a walkthrough session: this shell's own <Walkthrough> never runs
    // for this task, so a saved session would only get restored on return
    // (after the wizard hands back via resumeElderAfterWizard) and mount an
    // overlay whose first selector doesn't exist here — a permanent stuck
    // scrim with no Exit, found live by scenario s30.
    if (taskName === "onboarding" && onStartOnboardingWizard) {
      onStartOnboardingWizard();
      return;
    }
    setWalkthroughTask(taskName);
    setWalkthroughStepIndex(0);
    setWalkthroughParams(params);
    saveWalkthroughSession(elderId, { taskName, stepIndex: 0, startedAt: Date.now(), params });
  };

  // Guided Auto-Navigation Verify phase: re-query REAL state (never trust the
  // write's own "Saved"). All checks live in lib/walkthrough/verify.ts's
  // buildVerifyRunner — this host only injects its real data fetchers (that
  // module must not import anything Supabase-backed itself).
  const handleWalkthroughVerify = async (verify: VerifyDirective): Promise<boolean> => {
    if (!elderId) return false;
    return buildVerifyRunner({
      elderId,
      fetchElderMedications,
      fetchProfile,
      hasActiveCareLink,
      fetchArchivedMedications,
      fetchAccessibility: async id => (await fetchProfile(id))?.details ?? null,
    })(verify);
  };

  // Guided Auto-Navigation Reveal phase: navigate to where the result lives and
  // pulse-highlight it so the change is unmistakable. Meds already get their own
  // name-keyed "Just added" card highlight (flagJustAdded); this generic pulse
  // covers the rest (a condition chip's field, a saved travel plan, etc.).
  const handleWalkthroughReveal = (reveal: RevealDirective) => {
    if (reveal.screen.mode === "elderly") setTab(reveal.screen.tab);
    if (reveal.pulse === false) return;
    // Defer one paced screen-settle so the destination has mounted before we
    // find + pulse the target.
    setTimeout(() => {
      const el = document.querySelector<HTMLElement>(reveal.selector);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("walk-reveal-pulse");
      // Teardown matches the CSS animation exactly: one iteration of
      // var(--dw-pulse-ms) = PACING.REVEAL_PULSE_MS (applyPacingCssVars).
      setTimeout(() => el.classList.remove("walk-reveal-pulse"), PACING.REVEAL_PULSE_MS);
      // Show the same changed-fields-style caption ChangeHighlight uses, tracked
      // to the element while the pulse is up.
      if (reveal.caption) {
        const track = () => {
          setRevealCaption({ rect: el.getBoundingClientRect(), ...reveal.caption! });
          revealCaptionRaf.current = requestAnimationFrame(track);
        };
        track();
        setTimeout(() => {
          window.cancelAnimationFrame(revealCaptionRaf.current!);
          setRevealCaption(null);
        }, PACING.REVEAL_PULSE_MS);
      }
    }, PACING.NAVIGATE_MS);
  };

  // Fallback when the add-prescription walkthrough can't prove the save (Verify
  // failed): re-query once — if the med IS there the Verify simply raced, so just
  // highlight it (never double-insert); if it's genuinely absent, save it directly
  // from Mei's params and land on Home. A real write failure (addMedication throws)
  // leaves the honest walk.verifyFailed message up rather than faking success.
  const handleWalkthroughVerifyFailed = async (verify: VerifyDirective) => {
    if (verify.kind !== "medication-exists" || !elderId) return;
    const wanted = verify.name.trim().toLowerCase();
    const p = walkthroughParams;
    try {
      const meds = await fetchElderMedications(elderId);
      if (meds.some(m => m.name.trim().toLowerCase() === wanted)) {
        flagJustAdded(verify.name);
      } else {
        await handleAddPrescription({
          name: p.name || verify.name,
          dose: p.dose || "",
          purpose: p.purpose || "",
          colour: MED_COLOURS[0].hex,
          time: defaultDoseTime({ ...patient.mealTimes, sleepTime: patient.sleepTime }),
          times: [],
        });
      }
      setTab("home");
      handleWalkthroughExit();
    } catch {
      // Genuine write failure — keep the walkthrough's honest error visible.
    }
  };

  // Dev-only deterministic trigger so an e2e drive can start an autonomous
  // walkthrough without depending on the LLM choosing start_walkthrough.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    type Hook = (t: string, p?: WalkthroughParams) => void;
    (window as unknown as { __dwStartWalkthrough?: Hook }).__dwStartWalkthrough = (task, params) =>
      handleWalkthroughStart(task as WalkthroughTaskName, params ?? {});
    // Companion hook: fire ChangeHighlight with a committed action (real
    // entity_id) so an e2e can prove the highlight lands on a real record
    // without depending on the LLM choosing a write tool.
    type HlHook = (action: AgentAction) => void;
    (window as unknown as { __dwHighlightChange?: HlHook }).__dwHighlightChange = action =>
      setHighlightChange(action);
    return () => {
      delete (window as unknown as { __dwStartWalkthrough?: Hook }).__dwStartWalkthrough;
      delete (window as unknown as { __dwHighlightChange?: HlHook }).__dwHighlightChange;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleWalkthroughNavigate = (screen: WalkthroughScreen) => {
    if (screen.mode === "elderly") setTab(screen.tab);
  };

  const handleWalkthroughAdvance = () => {
    if (!walkthroughTask) return;
    const isLast = walkthroughStepIndex >= walkthroughSteps.length - 1;
    if (isLast) {
      if (elderId) void markWalkthroughCompleted(elderId, "elder", walkthroughTask);
      clearWalkthroughSession(elderId);
      setWalkthroughTask(null);
      setWalkthroughStepIndex(0);
      return;
    }
    const next = walkthroughStepIndex + 1;
    setWalkthroughStepIndex(next);
    saveWalkthroughSession(elderId, { taskName: walkthroughTask, stepIndex: next, startedAt: Date.now() });
  };

  // Exiting/skipping clears client state only — nothing is ever written back
  // for an abandoned walkthrough, only genuine completion (above).
  const handleWalkthroughExit = () => {
    clearWalkthroughSession(elderId);
    setWalkthroughTask(null);
    setWalkthroughStepIndex(0);
  };
  const [doctorQuestions, setDoctorQuestions] = useState<DoctorQ[]>([
    { id: "seed-1", question: "Can I take Celecoxib and Metformin at the same time?",           addedAt: "Added by Mei · Today",     answered: false },
    { id: "seed-2", question: "Is it normal to feel a little dizzy after taking Amlodipine?",  addedAt: "Added by Mei · Yesterday", answered: false },
  ]);
  // Signals ElderlyAIScreen to switch to its "Ask a doctor" sub-tab (bumped when a
  // doctor_message change is highlighted, so ChangeHighlight lands on the thread).
  const [openDoctorSignal, setOpenDoctorSignal] = useState(0);

  // Pull the elder's REAL doctor_questions and merge them in (dedupe by id, keep
  // the seed + any local manual adds). Without this, a question Mei queued via
  // chat writes to the DB but never appears in the elder's thread.
  const refreshDoctorQuestions = async () => {
    if (!elderId) return;
    const real = await fetchDoctorQuestions(elderId);
    if (!real.length) return;
    setDoctorQuestions(prev => {
      const seen = new Set(prev.map(q => q.id));
      const additions = real.filter(q => !seen.has(q.id));
      const updated = prev.map(q => {
        const match = real.find(r => r.id === q.id);
        return match ? { ...q, answered: match.answered } : q;
      });
      return [...additions, ...updated];
    });
  };

  useEffect(() => {
    void refreshDoctorQuestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elderId]);

  // Refresh when the elder opens the AI screen (where the doctor thread lives).
  useEffect(() => {
    if (tab === "ai") void refreshDoctorQuestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, elderId]);

  const handleLogDose = (medId: number, takenAt?: string) => {
    const takenLabel = takenAt ?? new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });
    onUpdatePatient({
      ...patient,
      medications: patient.medications.map(m => m.id === medId ? {
        ...m, status: "taken" as MedStatus, takenAt: takenLabel,
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
  // Also re-pulls archived meds (a discontinue_medication moves a med there —
  // the prescriptions screen renders them as Stopped cards) and the profile's
  // dose_snoozes (a snooze_dose writes there — the Home card shows the chip);
  // the Home timeline itself still renders only active meds' doses.
  const refreshMeds = async () => {
    if (!elderId) return;
    const [medications, pastMedications, profile] = await Promise.all([
      fetchElderMedications(elderId),
      fetchArchivedMedications(elderId),
      fetchProfile(elderId),
    ]);
    onUpdatePatient(prev => ({
      ...prev,
      medications,
      pastMedications,
      doseSnoozes: profile?.details.dose_snoozes ?? prev.doseSnoozes,
    }));
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
    setDoctorQuestions(prev => [{ id: `local-${Date.now()}`, question: q, addedAt: `Added by Mei · ${new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" })}`, answered: false }, ...prev]);
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
        {tab === "prescriptions" && <ElderlyPrescriptionScreen patient={patient} onOpenAI={openAI} onAddRx={() => setAddRx("manual")} onRequestRefill={name => openAIPrefill(t(language, "ai.refillRequestMsg", { name }))} justAddedMed={justAddedMed} />}
        {tab === "ai"            && (
          <ElderlyAIScreen
            patient={patient}
            elderId={elderId}
            onNavigate={setTab}
            onMedsChanged={refreshMeds}
            onMedAdded={flagJustAdded}
            onHighlightChange={setHighlightChange}
            onOpenTravel={() => setShowTravel(true)}
            doctorQuestions={doctorQuestions}
            openDoctorSignal={openDoctorSignal}
            onAddDoctorQ={handleAddDoctorQ}
            onMarkAnswered={(id: string) => setDoctorQuestions(p => p.map(q => q.id === id ? { ...q, answered: true } : q))}
            onDeleteQuestion={(id: string) => setDoctorQuestions(p => p.filter(q => q.id !== id))}
            autoMessage={pendingAIMessage}
            prefillMessage={pendingPrefill}
            onAutoMessageConsumed={() => setPendingAIMessage(undefined)}
            onPrefillConsumed={() => setPendingPrefill(undefined)}
            onWalkthroughStart={handleWalkthroughStart}
          />
        )}
        {tab === "notifications" && <ElderlyNotificationsScreen careMessages={careMessages} elderId={elderId} />}
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

      {addRx && <AddPrescriptionSheet initialTab={addRx} routine={{ ...patient.mealTimes, sleepTime: patient.sleepTime }} onClose={() => setAddRx(null)} onAdd={handleAddPrescription} onAdded={() => { if (!walkthroughTask) setTab("prescriptions"); }} onAgentAdded={(name?: string) => { void refreshMeds(); flagJustAdded(name); setTab("prescriptions"); }} />}
      {showTravel && (
        <TravelModeSheet
          patient={patient}
          elderId={elderId}
          onClose={() => setShowTravel(false)}
          onSaved={plan => onUpdatePatient({ ...patient, travelPlan: plan })}
        />
      )}
      <ChangeHighlight
        change={highlightChange}
        mode="elderly"
        onNavigate={target => {
          setTab(target as ElderlyTab);
          // A doctor-question change lives in the AI screen's "Ask a doctor"
          // sub-tab: open it and pull the fresh row so the highlight can land.
          if (highlightChange?.entity_type === "doctor_message") {
            setOpenDoctorSignal(s => s + 1);
            void refreshDoctorQuestions();
          }
        }}
        onDone={() => setHighlightChange(null)}
      />
      {revealCaption && <HighlightCaption rect={revealCaption.rect} verb={revealCaption.verb} text={revealCaption.text} />}
      {showTour && <GuidedTour steps={tourSteps} onFinish={() => setShowTour(false)} />}
      {walkthroughTask && walkthroughSteps.length > 0 && (
        <Walkthrough
          steps={walkthroughSteps}
          stepIndex={Math.min(walkthroughStepIndex, walkthroughSteps.length - 1)}
          currentScreen={{ mode: "elderly", tab }}
          onNavigate={handleWalkthroughNavigate}
          onAdvance={handleWalkthroughAdvance}
          onExit={handleWalkthroughExit}
          onVerify={handleWalkthroughVerify}
          onReveal={handleWalkthroughReveal}
          onVerifyFailed={handleWalkthroughVerifyFailed}
        />
      )}
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
