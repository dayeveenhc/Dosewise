import { useEffect, useRef, useState } from "react";
import { Droplets, Home, Pill, Brain, Bell, Settings, HelpCircle, ChevronLeft } from "lucide-react";
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
import { logDoseTaken, unlogDoseTaken, addMedication, fetchElderMedications, to24h } from "../../lib/medications";
import { defaultDoseTime } from "../../components/TimesPicker";
import { MED_COLOURS } from "../../data/medications";
import { useLanguage } from "../../lib/languageContext";
import { useAccessibility } from "../../accessibility.tsx";
import { t } from "../../lib/language";
import { Walkthrough } from "../../components/Walkthrough";
import { resolveWalkthroughSteps } from "../../lib/walkthrough/steps";
import type { WalkthroughScreen, WalkthroughTaskName, VerifyDirective, RevealDirective, WalkthroughParams } from "../../lib/walkthrough/types";
import { loadWalkthroughSession, saveWalkthroughSession, clearWalkthroughSession } from "../../lib/walkthroughState";
import { markWalkthroughCompleted, fetchProfile } from "../../lib/profile";
import { fetchDoctorQuestions, createDoctorQuestion } from "../../lib/doctor";
import { hasActiveCareLink } from "../../lib/careLinks";

export function ElderlyApp({ patient, elderId, onUpdatePatient, onBack, onSignOut, startTour, careMessages, onDismissCareMessage, onReplyCareMessage }: {
  patient: Patient;
  elderId?: string;
  onUpdatePatient: (p: Patient | ((prev: Patient) => Patient)) => void;
  onBack: () => void;
  onSignOut: () => void;
  startTour?: boolean;
  careMessages: Message[];
  onDismissCareMessage: (id: number) => void;
  onReplyCareMessage: (id: number, text: string) => void;
}) {
  const [tab, setTab] = useState<ElderlyTab>("home");
  // A screen with its own sub-view (the chat, an Ask Mei category, a Settings
  // page) REPLACES this header instead of stacking a second one under it. The
  // owning screen clears it on unmount, so no reset is needed here.
  const [headerOverride, setHeaderOverride] = useState<{ title: string; onBack: () => void; action?: React.ReactNode } | null>(null);
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
  const { notifications: notifyPrefs } = useAccessibility();

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
      if (Notification.permission !== "granted" || !notifyPrefs.doseReminders) return;
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
  }, [patient.medications, notifyPrefs.doseReminders]);

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
    setWalkthroughTask(taskName);
    setWalkthroughStepIndex(0);
    setWalkthroughParams(params);
    saveWalkthroughSession(elderId, { taskName, stepIndex: 0, startedAt: Date.now(), params });
  };

  // Guided Auto-Navigation Verify phase: re-query REAL state (never trust the
  // write's own "Saved"). Polls briefly since the sheet's write is async and the
  // Verify fires right after Mei taps Save.
  const handleWalkthroughVerify = async (verify: VerifyDirective): Promise<boolean> => {
    if (!elderId) return false;
    if (verify.kind === "medication-exists") {
      const wanted = verify.name.trim().toLowerCase();
      for (let attempt = 0; attempt < 12; attempt++) {
        const meds = await fetchElderMedications(elderId);
        if (meds.some(m => m.name.trim().toLowerCase() === wanted)) return true;
        await new Promise(r => setTimeout(r, 400));
      }
      return false;
    }
    if (verify.kind === "travel-plan-saved") {
      for (let attempt = 0; attempt < 12; attempt++) {
        const profile = await fetchProfile(elderId);
        if (profile?.details.travelPlan?.startDate) return true;
        await new Promise(r => setTimeout(r, 400));
      }
      return false;
    }
    if (verify.kind === "profile-field") {
      const want = verify.value.trim();
      for (let attempt = 0; attempt < 12; attempt++) {
        const profile = await fetchProfile(elderId);
        const actual = profile?.details[verify.field as keyof typeof profile.details];
        if (actual !== undefined && actual !== null && String(actual) === want) return true;
        await new Promise(r => setTimeout(r, 400));
      }
      return false;
    }
    if (verify.kind === "profile-list-includes") {
      const want = verify.value.trim().toLowerCase();
      for (let attempt = 0; attempt < 12; attempt++) {
        const profile = await fetchProfile(elderId);
        const list = profile?.details[verify.field as keyof typeof profile.details];
        if (Array.isArray(list) && list.some(v => String(v).trim().toLowerCase() === want)) return true;
        await new Promise(r => setTimeout(r, 400));
      }
      return false;
    }
    if (verify.kind === "doctor-question-exists") {
      const want = verify.question.trim().toLowerCase();
      for (let attempt = 0; attempt < 12; attempt++) {
        const rows = await fetchDoctorQuestions(elderId);
        if (rows.some(r => r.question.trim().toLowerCase() === want)) return true;
        await new Promise(r => setTimeout(r, 400));
      }
      return false;
    }
    if (verify.kind === "care-link-active") {
      for (let attempt = 0; attempt < 12; attempt++) {
        if (await hasActiveCareLink(elderId)) return true;
        await new Promise(r => setTimeout(r, 400));
      }
      return false;
    }
    return true;
  };

  // Guided Auto-Navigation Reveal phase: navigate to where the result lives and
  // pulse-highlight it so the change is unmistakable. Meds already get their own
  // name-keyed "Just added" card highlight (flagJustAdded); this generic pulse
  // covers the rest (a condition chip's field, a saved travel plan, etc.).
  const handleWalkthroughReveal = (reveal: RevealDirective) => {
    if (reveal.screen.mode === "elderly") setTab(reveal.screen.tab);
    if (reveal.pulse === false) return;
    // Defer so the destination screen has mounted before we find + pulse the target.
    setTimeout(() => {
      const el = document.querySelector<HTMLElement>(reveal.selector);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("walk-reveal-pulse");
      setTimeout(() => el.classList.remove("walk-reveal-pulse"), 2600);
      // Show the same changed-fields-style caption ChangeHighlight uses, tracked
      // to the element while the pulse is up (~2.6s).
      if (reveal.caption) {
        const track = () => {
          setRevealCaption({ rect: el.getBoundingClientRect(), ...reveal.caption! });
          revealCaptionRaf.current = requestAnimationFrame(track);
        };
        track();
        setTimeout(() => {
          window.cancelAnimationFrame(revealCaptionRaf.current!);
          setRevealCaption(null);
        }, 2600);
      }
    }, 350);
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
  // Bumped when a doctor_message change is highlighted, so the Reminders screen
  // opens its doctor tab and the highlight has a card to land on.
  const [openQuestionsSignal, setOpenQuestionsSignal] = useState(0);
  const [doctorQuestions, setDoctorQuestions] = useState<DoctorQ[]>([
    { id: "seed-1", question: "Can I take Celecoxib and Metformin at the same time?",           addedAt: "Added by Mei · Today",     answered: false },
    { id: "seed-2", question: "Is it normal to feel a little dizzy after taking Amlodipine?",  addedAt: "Added by Mei · Yesterday", answered: false },
  ]);
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

  // Refresh when the elder opens Reminders (where the doctor thread now lives).
  useEffect(() => {
    if (tab === "notifications") void refreshDoctorQuestions();
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

  // Undo a mis-logged dose. Mirrors handleLogDose: optimistic local flip back to
  // "upcoming" (the Home screen re-derives missed-vs-upcoming from the clock),
  // plus the real write. Supply goes back up by the day logging it consumed.
  const handleUnlogDose = (medId: number) => {
    onUpdatePatient({
      ...patient,
      medications: patient.medications.map(m => m.id === medId ? {
        ...m, status: "upcoming" as MedStatus, takenAt: undefined,
        refillDaysLeft: m.refillDaysLeft !== undefined ? m.refillDaysLeft + 1 : undefined,
      } : m),
    });
    const med = patient.medications.find(m => m.id === medId);
    if (elderId && med?.medicationId) void unlogDoseTaken(med.medicationId, elderId);
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

  // Persists for real (doctor_questions, RLS as the elder) so the question
  // survives a reload and an autonomous walkthrough can VERIFY it landed. Falls
  // back to a local-only row if there's no signed-in elder or the write fails,
  // rather than dropping what they typed.
  const handleAddDoctorQ = async (q: string) => {
    const local: DoctorQ = {
      id: `local-${Date.now()}`, question: q,
      addedAt: `Added · ${new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" })}`,
      answered: false,
    };
    const saved = elderId ? await createDoctorQuestion(elderId, q) : null;
    setDoctorQuestions(prev => [saved ?? local, ...prev]);
  };

  const NAV: { id: ElderlyTab; icon: any; label: string; fab?: boolean }[] = [
    { id: "home",          icon: Home,        label: t(language, "nav.home") },
    { id: "prescriptions", icon: Pill,        label: t(language, "nav.medicines") },
    { id: "ai",            icon: Brain,       label: t(language, "nav.askMei"), fab: true },
    { id: "notifications", icon: Bell,        label: t(language, "nav.reminders") },
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

      {/* Header — app name centred, help and profile in the corners. The screen
          title moved into each screen, so this bar stays one constant, always
          recognisable anchor rather than text that changes under you. */}
      <div className="px-3 py-2 bg-background/80 backdrop-blur-sm border-b border-border/60 shrink-0">
        {headerOverride ? (
          <div className="flex items-center gap-2.5">
            <button
              onClick={headerOverride.onBack}
              aria-label={t(language, "common.back")}
              className="w-11 h-11 rounded-full bg-card border border-border flex items-center justify-center shrink-0 active:bg-muted transition-colors"
            >
              <ChevronLeft size={22} className="text-foreground" />
            </button>
            <h1 className="flex-1 min-w-0 truncate text-[19px] font-bold text-foreground">{headerOverride.title}</h1>
            {headerOverride.action}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => setShowTourConfirm(true)}
              aria-label={t(language, "header.help")}
              className="w-11 h-11 rounded-full bg-card border border-border flex items-center justify-center active:bg-muted transition-colors"
            >
              <HelpCircle size={22} className="text-primary" />
            </button>
            <h1 className="font-['Fraunces'] text-[25px] font-semibold tracking-tight text-primary leading-none">Dosewise</h1>
            <button
              onClick={() => setTab("settings")}
              aria-label={t(language, "header.profile")}
              className="w-11 h-11 rounded-full overflow-hidden border-2 border-primary/30 shrink-0 active:opacity-80 transition-opacity"
            >
              <img src={patient.photo} alt="" className="w-full h-full object-cover" />
            </button>
          </div>
        )}
      </div>

      {/* Screen content */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {tab === "home"          && <ElderlyHomeScreen         patient={patient} onLogDose={handleLogDose} onUnlogDose={handleUnlogDose} onOpenTravel={() => setShowTravel(true)} justAddedMed={justAddedMed} />}
        {tab === "prescriptions" && <ElderlyPrescriptionScreen patient={patient} onAddRx={() => setAddRx("manual")} onRequestRefill={name => openAIPrefill(t(language, "ai.refillRequestMsg", { name }))} justAddedMed={justAddedMed} />}
        {tab === "ai"            && (
          <ElderlyAIScreen
            patient={patient}
            elderId={elderId}
            onNavigate={setTab}
            onMedsChanged={refreshMeds}
            onMedAdded={flagJustAdded}
            onHighlightChange={setHighlightChange}
            onOpenTravel={() => setShowTravel(true)}
            autoMessage={pendingAIMessage}
            prefillMessage={pendingPrefill}
            onAutoMessageConsumed={() => setPendingAIMessage(undefined)}
            onPrefillConsumed={() => setPendingPrefill(undefined)}
            onWalkthroughStart={handleWalkthroughStart}
            onHeaderOverride={setHeaderOverride}
          />
        )}
        {tab === "notifications" && (
          <ElderlyNotificationsScreen
            careMessages={careMessages}
            elderId={elderId}
            doctorQuestions={doctorQuestions}
            onAddDoctorQ={q => void handleAddDoctorQ(q)}
            onMarkAnswered={(id: string) => setDoctorQuestions(p => p.map(q => q.id === id ? { ...q, answered: true } : q))}
            onDeleteQuestion={(id: string) => setDoctorQuestions(p => p.filter(q => q.id !== id))}
            onDismissMessage={onDismissCareMessage}
            onReplyMessage={onReplyCareMessage}
            openQuestionsSignal={openQuestionsSignal}
          />
        )}
        {tab === "settings"      && <ElderlySettingsScreen     patient={patient} elderId={elderId} onUpdatePatient={onUpdatePatient} onBack={onBack} onSignOut={onSignOut} onHeaderOverride={setHeaderOverride} />}
      </div>

      {/* Bottom nav — z-40 keeps it (and the Ask Mei FAB peeking above it) painting
          over any scrolled content behind it, regardless of that content's own layout. */}
      {/* Icon-only. The visible labels are gone at the user's request, so each
          control carries an aria-label — without one an icon-only tab bar is
          silent to a screen reader. */}
      {/* Row is items-END so every control shares one baseline: the FAB's
          negative margin then only controls how far it rises above the bar, not
          where it sits in it (with items-center it drifted a few px high). Five
          flex-1 columns keep the spacing exactly equal. */}
      <div className="relative z-40 shrink-0 bg-card/95 backdrop-blur-md border-t border-border px-3 pt-4 pb-6">
        <div className="flex items-end">
          {NAV.map(item => {
            const isActive = tab === item.id;
            if (item.fab) {
              return (
                <div key={item.id} className="relative z-40 flex-1 flex justify-center">
                  <button onClick={() => setTab(item.id)} data-tour={`nav-${item.id}`} aria-label={item.label} aria-current={isActive ? "page" : undefined} className={`relative z-40 w-16 h-16 rounded-full flex items-center justify-center -mt-6 -top-1 shadow-lg active:scale-95 transition-transform bg-primary ${isActive ? "ring-4 ring-accent/40" : ""}`}>
                    <Brain size={30} className="text-primary-foreground" />
                  </button>
                </div>
              );
            }
            return (
              <button key={item.id} onClick={() => setTab(item.id)} data-tour={`nav-${item.id}`} aria-label={item.label} aria-current={isActive ? "page" : undefined} className="flex-1 min-w-0 flex justify-center">
                {/* Active state is a coloured icon plus a dot, not a filled
                    pill: with the labels gone, a filled active tab was visually
                    identical to the filled Ask Mei circle. Only the FAB is
                    filled now, so "where am I" and "the assistant" never read
                    as the same thing. */}
                <div className="w-16 h-12 flex flex-col items-center justify-end gap-1.5">
                  <item.icon size={26} className={`transition-colors ${isActive ? "text-primary" : "text-muted-foreground/70"}`} />
                  <span className={`h-1.5 w-1.5 rounded-full transition-colors ${isActive ? "bg-primary" : "bg-transparent"}`} />
                </div>
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
          // A doctor-question change now lands on the Reminders tab — pull the
          // fresh row so the highlight has a real element to attach to.
          if (highlightChange?.entity_type === "doctor_message") {
            setOpenQuestionsSignal(n => n + 1);
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
