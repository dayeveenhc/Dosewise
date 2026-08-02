import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { ArrowLeft, Bell, HelpCircle, UserRound } from "lucide-react";
import type { AppMode, Screen, Patient, Medication, Notification, Message } from "./types";
import { PATIENTS, NOTIFICATIONS } from "./data/patients";
import { BottomNav } from "./components/BottomNav";
import { LiveStatusBar, PatientSwitcher } from "./components/shared";
import { supabase } from "./lib/supabase";
import { ensureProfile, fetchElderMedications, fetchArchivedMedications, addMedication, archiveMedication, to24h } from "./lib/medications";
import { fetchProfileRole, fetchProfile, calculateAge } from "./lib/profile";
import type { WizardPrefill } from "./lib/profile";
import { normalizeAllergies } from "./lib/changeHighlight";
import { readStoredAppMode, persistAppMode } from "./lib/sessionState";
import { WelcomeScreen } from "./screens/setup/WelcomeScreen";
import { SetupMethodScreen } from "./screens/setup/SetupMethodScreen";
import { GuidedSetupWizard } from "./screens/setup/GuidedSetupWizard";
import { LoginScreen } from "./screens/LoginScreen";
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
import { ChangeHighlight } from "./components/ChangeHighlight";
import type { AgentAction } from "./lib/hermes";
import { AccessibilityProvider, useContentZoom } from "./accessibility.tsx";
import { GuidedTour } from "./components/GuidedTour";
import type { TourStep } from "./components/GuidedTour";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ToastStack } from "./components/Toast";
import type { ToastItem } from "./components/Toast";
import { SendReminderSheet } from "./screens/SendReminderSheet";
import { ScanLinkSheet } from "./components/ScanLinkSheet";
import { LanguageProvider, readStoredLanguage } from "./lib/languageContext";
import { t } from "./lib/language";
import { Walkthrough } from "./components/Walkthrough";
import { resolveWalkthroughSteps, walkthroughShellFor } from "./lib/walkthrough/steps";
import { AUTONOMOUS_TASKS } from "./lib/walkthrough/types";
import { buildVerifyRunner } from "./lib/walkthrough/verify";
import { PACING } from "./lib/walkthrough/pacing";
import type { WalkthroughScreen, WalkthroughTaskName, WalkthroughParams, VerifyDirective, RevealDirective } from "./lib/walkthrough/types";
import { defaultDoseTime } from "./components/TimesPicker";
import { MED_COLOURS } from "./data/medications";
import { loadWalkthroughSession, saveWalkthroughSession, clearWalkthroughSession } from "./lib/walkthroughState";
import { markWalkthroughCompleted } from "./lib/profile";

// Proportionally zooms the caregiver screen-content area from the Text-size
// setting — the counterpart to ElderlyApp's content zoom. Rendered inside
// AccessibilityProvider (so the hook resolves); chrome/nav stay outside it so
// nothing clips. Without this the caregiver Text-size slider barely moved,
// because the app's text is nearly all absolute-px utilities that ignore the
// html --font-size var.
function ZoomContent({ className, children }: { className?: string; children: ReactNode }) {
  const zoom = useContentZoom();
  return (
    <div className={className} style={{ zoom } as CSSProperties}>
      {children}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [appMode, setAppMode] = useState<AppMode>("onboarding");
  // Sub-stage shown while appMode is "onboarding" — walks a new user through
  // Sign-in-or-Get-started -> Caregiver-or-Myself -> HealthHub-or-Guided -> wizard.
  const [preAuthStage, setPreAuthStage] = useState<"welcome" | "signin" | "mode" | "method" | "wizard">("welcome");
  const [pendingMode, setPendingMode] = useState<"caregiver" | "elderly">("elderly");
  // Set right before an already-onboarded user previews the other mode from
  // Settings, so backing out of the picker can restore what they were on
  // instead of stranding them mid-"onboarding".
  const [modeBeforeSwitch, setModeBeforeSwitch] = useState<AppMode>("caregiver");
  // The signed-in caregiver's own identity, for the caregiver Settings
  // Account card — kept separate from `patients` (the elder being cared for)
  // so the two never get conflated.
  const [caregiverAccount, setCaregiverAccount] = useState<{ name: string | null; email: string | null }>({ name: null, email: null });
  // True only when a session exists but has no profile row yet (e.g. signed in
  // without ever finishing setup) — routes back through the wizard instead of
  // treating the mode picker as a quick preview-mode switch.
  const [needsWizard, setNeedsWizard] = useState(false);
  // Fields extracted from an uploaded record on the setup-method screen; seeds
  // the guided wizard so the user reviews pre-filled answers instead of typing
  // everything (undefined = manual guided setup).
  const [wizardPrefill, setWizardPrefill] = useState<WizardPrefill | undefined>(undefined);
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [selectedPatient, setSelectedPatient] = useState(0);
  const [patients, setPatients] = useState<Patient[]>(PATIENTS);
  const [showAddPrescription, setShowAddPrescription] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);
  // Set true the moment the guided setup wizard finishes, so the app that
  // follows can auto-start the tour exactly once. Cleared shortly after so a
  // later mode-switch remount doesn't auto-start it again.
  const [justOnboarded, setJustOnboarded] = useState(false);
  const [showCaregiverTour, setShowCaregiverTour] = useState(false);
  const [showCaregiverTourConfirm, setShowCaregiverTourConfirm] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [elderToasts, setElderToasts] = useState<ToastItem[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>(NOTIFICATIONS);
  // Lifted out of ElderlyApp so a caregiver-sent reminder (created while the
  // caregiver view is showing) can be pushed into the elder's own Notifications
  // tab too, not just a transient toast.
  const [careMessages, setCareMessages] = useState<Message[]>([
    // Demo content. role/body/time are rendered from i18nKey (see Message) so
    // they follow the language setting; the names stay as written.
    { id: 1, author: "Tan Wei Ming", role: "Son",      body: "Hi Ah Ma, remember your Celecoxib after lunch today. Dr. Priya called — blood test is next Tuesday at 10am.", time: "10:30 AM",  isMe: false, i18nKey: "messages.demo1" },
    { id: 2, author: "Tan Shu Fen",  role: "Daughter", body: "Ma, I refilled your Atorvastatin — it's in the cabinet above the stove 💙",                                   time: "Yesterday", isMe: false, i18nKey: "messages.demo2" },
  ]);
  const [showSendReminder, setShowSendReminder] = useState<{ medName?: string } | null>(null);
  const [showScanLink, setShowScanLink] = useState(false);
  const [walkthroughTask, setWalkthroughTask] = useState<WalkthroughTaskName | null>(null);
  const [walkthroughStepIndex, setWalkthroughStepIndex] = useState(0);
  // Every caregiver-shell task is a static tour today, so params are unused by
  // the resolver here — but they are still stored and restored, so this shell
  // cannot silently lose them the way the elder shell did if a param-driven
  // caregiver walkthrough is ever added.
  const [walkthroughParams, setWalkthroughParams] = useState<WalkthroughParams>({});
  // The committed change being pulse-highlighted caregiver-side (mirrors
  // ElderlyApp's proof layer — the caregiver app previously had none).
  const [highlightChange, setHighlightChange] = useState<AgentAction | null>(null);
  // Set when an ACTIVE elder session asked for the "onboarding" walkthrough:
  // the wizard is a separate stage, so we switch into it and this flag routes
  // the wizard's exit/completion back into the elder app instead of the
  // normal post-setup path.
  const [resumeElderAfterWizard, setResumeElderAfterWizard] = useState(false);

  // Demo pop-up notifications — fires a couple of sample alerts a little
  // after landing in the caregiver app, so the top-of-screen toast UI has
  // something to show (there's no live push infra behind this yet).
  useEffect(() => {
    if (appMode !== "caregiver") return;
    const timers = [
      window.setTimeout(() => {
        const lang = readStoredLanguage();
        setToasts(prev => [...prev, {
          id: Date.now(),
          title: t(lang, "toast.missedDoseTitle", { med: "Celecoxib" }),
          body: t(lang, "toast.missedDoseBody", { name: "Mdm Tan", time: "12:00 PM", med: "Celecoxib", dose: "200mg" }),
        }]);
      }, 4000),
      window.setTimeout(() => {
        const lang = readStoredLanguage();
        setToasts(prev => [...prev, {
          id: Date.now() + 1,
          title: t(lang, "toast.refillNeededTitle", { med: "Metformin" }),
          body: t(lang, "toast.refillNeededBody", { med: "Metformin 500mg", days: 4 }),
        }]);
      }, 16000),
    ];
    return () => timers.forEach(window.clearTimeout);
  }, [appMode]);

  useEffect(() => {
    if (!justOnboarded) return;
    if (appMode === "caregiver") setShowCaregiverTour(true);
    const timer = setTimeout(() => setJustOnboarded(false), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justOnboarded, appMode]);

  // Not reactive to a live language toggle (App.tsx sits above LanguageProvider,
  // so it can't use the useLanguage() hook) — a point-in-time read is fine here
  // since these are demo tour/toast strings the provider's own localStorage
  // write keeps in sync on the next natural re-render.
  const uiLang = readStoredLanguage();
  const caregiverTourSteps: TourStep[] = [
    {
      target: '[data-tour="cg-dashboard"]', navTarget: '[data-tour="nav-dashboard"]', onEnter: () => setScreen("dashboard"),
      title: t(uiLang, "tour.cgDashboardTitle"), body: t(uiLang, "tour.cgDashboardBody"),
    },
    {
      target: '[data-tour="cg-patientswitcher"]', onEnter: () => setScreen("dashboard"),
      title: t(uiLang, "tour.cgPatientLinkTitle"), body: t(uiLang, "tour.cgPatientLinkBody"),
    },
    {
      target: '[data-tour="cg-medlist"]', navTarget: '[data-tour="nav-patient"]', onEnter: () => setScreen("patient"),
      title: t(uiLang, "tour.cgMedsTitle"), body: t(uiLang, "tour.cgMedsBody"),
    },
    {
      target: '[data-tour="cg-askmei"]', navTarget: '[data-tour="nav-ai"]', onEnter: () => setScreen("ai"),
      title: t(uiLang, "tour.cgAskMeiTitle"), body: t(uiLang, "tour.cgAskMeiBody"),
    },
    {
      target: '[data-tour="cg-settings"]', navTarget: '[data-tour="nav-settings"]', onEnter: () => setScreen("settings"),
      title: t(uiLang, "tour.cgNotifTitle"), body: t(uiLang, "tour.cgNotifBody"),
    },
  ];

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Routes a session into the right app view by looking up its role — covers both
  // a returning user's sign-in and reopening the app with a persisted session.
  // Skipped while mid-wizard: the wizard creates its own session as its first step
  // and must not be yanked into the main app before the later steps run.
  useEffect(() => {
    if (!session || preAuthStage === "wizard") return;
    (async () => {
      const role = await fetchProfileRole(session.user.id);
      if (role) {
        setNeedsWizard(false);
        // Prefer the interface this user last used on this browser (e.g. a
        // caregiver-preview they expect to stick), falling back to the role
        // default. Role is stored correctly, so a fresh browser still lands right.
        setAppMode(readStoredAppMode(session.user.id) ?? (role === "elder" ? "elderly" : "caregiver"));
      } else {
        setNeedsWizard(true);
        setPreAuthStage("mode");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, preAuthStage === "wizard"]);

  // Sign-out: drop back to the welcome screen instead of leaving a stale app view
  // (with no elderId) on screen.
  useEffect(() => {
    if (!session && appMode !== "onboarding") {
      setAppMode("onboarding");
      setPreAuthStage("welcome");
      setNeedsWizard(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const elderId = session?.user.id;

  // Remember the interface the user is actually on, per account, so leaving and
  // reopening the site lands back on it (caregiver stays caregiver, not elderly).
  // Captures every transition: role-init, the Settings preview switch, and the
  // wizard finishing. "onboarding" is never persisted (guarded in persistAppMode).
  useEffect(() => {
    if (elderId && appMode !== "onboarding") persistAppMode(elderId, appMode);
  }, [elderId, appMode]);

  // Already-onboarded users switching preview mode from Settings (not new setup).
  const openModeSwitch = () => { setModeBeforeSwitch(appMode); setNeedsWizard(false); setPreAuthStage("mode"); setAppMode("onboarding"); };

  // Loads the signed-in user's real medications into the first (only, for now)
  // patient slot on login, keeping the mock cosmetic fields (photo, contacts, etc.)
  // that have no equivalent column in the real schema.
  useEffect(() => {
    // Gated to elderly mode specifically — not just "not onboarding". elderId
    // is the signed-in account's own id regardless of which mode they're in,
    // so without this a caregiver's own profile (name, age, conditions...)
    // would overwrite the elder patient record's display fields below.
    if (!elderId || appMode !== "elderly") return;
    (async () => {
      await ensureProfile(elderId);
      const [medications, profile, pastMedications] = await Promise.all([
        fetchElderMedications(elderId),
        fetchProfile(elderId),
        fetchArchivedMedications(elderId),
      ]);
      const taken = medications.filter(m => m.status === "taken").length;
      const adherenceToday = medications.length ? Math.round((taken / medications.length) * 100) : 0;
      // Never fall back to the account email here — it's not a name, and the
      // wizard's account step is the only thing that should feed this.
      const displayName = profile?.fullName || "You";
      // The wizard only ever collects one name field ("preferred name") — it IS
      // the nickname, not a formal name to be split down to its first word.
      const preferredName = profile?.fullName || displayName;
      setPatients(prev => [{
        ...prev[0],
        name: displayName,
        nickname: preferredName,
        // Prefer age derived from the stored date of birth; `details.age` is a
        // legacy fallback for profiles saved before dob collection existed.
        age: profile?.details.dob ? calculateAge(profile.details.dob) : (profile?.details.age ?? prev[0].age),
        gender: profile?.details.gender ?? prev[0].gender,
        weightKg: profile?.details.weightKg ?? prev[0].weightKg,
        heightCm: profile?.details.heightCm ?? prev[0].heightCm,
        wakeTime: profile?.details.wakeTime ?? prev[0].wakeTime,
        mealTimes: profile?.details.mealTimes ?? prev[0].mealTimes,
        sleepTime: profile?.details.sleepTime ?? prev[0].sleepTime,
        travelPlan: profile?.details.travelPlan ?? prev[0].travelPlan,
        doseSnoozes: profile?.details.dose_snoozes ?? prev[0].doseSnoozes,
        // Nothing anywhere persists a blood type — the caregiver's editor keeps
        // it in memory only — so inheriting the demo fixture's "B+" put an
        // invented medical fact on a real person's record. Say we don't know.
        bloodType: "Unknown",
        // Same reasoning as bloodType above, and the same class of bug: nothing
        // persists an emergency contact, so inheriting the fixture's
        // "Tan Wei Ming / +65 9123 4567" put a fabricated person AND a
        // fabricated phone number on a real account — while Mei, reading real
        // care_links, correctly said there was no caregiver. The real emergency
        // contact is the linked caregiver; Settings reads it from care_links.
        contacts: [],
        // NO mock fallback for medical facts. These used to fall back to
        // data/patients.ts's seeded demo patient when the real profile was
        // empty, which put "Type 2 Diabetes", "Hypertension" and "Osteoarthritis"
        // on real accounts that had never recorded a condition — and, being
        // fixture text rather than catalog values, they were also untranslatable,
        // which is how this surfaced as "the conditions don't change language".
        // An empty list is the truth; the screens render their own empty state.
        conditions: profile?.details.conditions ?? [],
        // Allergy entries may be legacy strings or promoted {name, severity}
        // objects — Patient.allergies stays a plain name list.
        allergies: [
          ...normalizeAllergies(profile?.details.allergies).map(a => a.name).filter(Boolean),
          ...(profile?.details.drugAllergies ?? []),
        ],
        medications,
        pastMedications,
        adherenceToday,
        adherenceWeek: adherenceToday, // no historical "missed" records exist to compute a real week figure
      }, ...prev.slice(1)]);
    })();
  }, [elderId, appMode]);

  // The caregiver's own name/email for their Settings Account card — loaded
  // independently of the elder-data effect above so switching modes never
  // lets one identity leak into the other's display.
  useEffect(() => {
    if (!elderId || appMode !== "caregiver") return;
    (async () => {
      await ensureProfile(elderId);
      const profile = await fetchProfile(elderId);
      setCaregiverAccount({ name: profile?.fullName ?? null, email: session?.user.email ?? null });
    })();
  }, [elderId, appMode]);

  const patient = patients[selectedPatient];
  let nextMedId = patients.flatMap(p => p.medications).reduce((max, m) => Math.max(max, m.id), 0) + 1;

  // No caregiver-to-elder linking exists in the backend yet (invite code, email
  // link, etc.) — this appends a locally-held patient at the same mock depth as
  // PATIENTS, not a real linked account. Revisit once that backend exists.
  const handleAddPatient = (name: string, relation: string) => {
    const initials = name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
    const photo = `data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="40" fill="#D9CFC1"/><text x="50%" y="50%" dy=".35em" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#5B4636">${initials}</text></svg>`
    )}`;
    const newId = patients.reduce((max, p) => Math.max(max, p.id), 0) + 1;
    setPatients(prev => [...prev, {
      id: newId, name, nickname: name.split(" ")[0], age: 0, relation, photo,
      bloodType: "Unknown", conditions: [], allergies: [], medications: [], contacts: [],
      adherenceToday: 0, adherenceWeek: 0, lastChecked: "Just added",
    }]);
    setSelectedPatient(patients.length);
  };

  // Resume a same-tab, in-progress walkthrough (e.g. switched to another
  // screen mid-way and came back) — never across a hard refresh.
  useEffect(() => {
    const restored = loadWalkthroughSession("caregiver", elderId);
    if (restored) {
      setWalkthroughTask(restored.taskName);
      setWalkthroughStepIndex(restored.stepIndex);
      setWalkthroughParams(restored.params ?? {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const walkthroughSteps = walkthroughTask ? resolveWalkthroughSteps(walkthroughTask, "caregiver", walkthroughParams) : [];

  // Returns null when the walkthrough started, or a translation key saying why
  // it did not — mirror of ElderlyApp's. A console.warn-only refusal left Mei
  // promising a walkthrough that never appeared.
  const handleWalkthroughStart = (taskName: WalkthroughTaskName, params: WalkthroughParams = {}): string | null => {
    // The add-prescription walkthrough is elder-shell only (its steps drive the
    // elderly screens); the caregiver shell can't run it. So here Mei's "add it"
    // is fulfilled by a direct save from the same params, then we land on the
    // patient's med list (the caregiver view that shows the "Just added" highlight).
    if (taskName === "add_prescription_auto") {
      void handleAddPrescription({
        name: params.name || "",
        dose: params.dose || "",
        purpose: params.purpose || "",
        colour: MED_COLOURS[0].hex,
        time: defaultDoseTime({ ...patient.mealTimes, sleepTime: patient.sleepTime }),
        times: [],
      });
      setScreen("patient");
      flagJustAdded(params.name);
      return null;
    }
    // Shell guard — mirror of ElderlyApp's. Hermes offers every task name to
    // both shells with no role filter, so the caregiver can be offered an
    // elder-only walkthrough whose selectors never mount here.
    const shell = walkthroughShellFor(taskName, "caregiver");
    if (shell && shell !== "caregiver") {
      console.warn(`[dosewise] walkthrough "${taskName}" targets the ${shell} shell — not starting it in the caregiver view`);
      return "walk.refused.wrongShell";
    }
    setWalkthroughTask(taskName);
    setWalkthroughStepIndex(0);
    setWalkthroughParams(params);
    saveWalkthroughSession("caregiver", elderId, { taskName, stepIndex: 0, startedAt: Date.now(), params });
    return null;
  };

  // Dev-only deterministic triggers, mirroring ElderlyApp.tsx's caregiver-side
  // gap: an e2e drive can start a caregiver walkthrough or fire ChangeHighlight
  // with a committed action (real entity_id) without depending on the LLM.
  // Gated on appMode==="caregiver" (and re-run on every appMode change, so the
  // cleanup fires the INSTANT it stops being true): `App` itself is the root
  // component and never unmounts, so an unconditional `useEffect(...,[])` here
  // would register these once for the whole SPA session and then RACE against
  // ElderlyApp's own registration of the exact same two window properties the
  // moment appMode flips to "elderly" — whichever mounts/re-renders last wins,
  // a real, timing-dependent bug found live re-running the full scenario
  // regression suite (every elder-mode dev-hook scenario intermittently landed
  // on a plain Home screen with no overlay at all — the caregiver's
  // no-op-for-this-task handleWalkthroughStart had silently won the race).
  // See ElderlyApp: the hook must call the LATEST closure, not the one from
  // the render that registered it, or every gate inside answers from stale
  // state forever.
  const startWalkthroughRef = useRef(handleWalkthroughStart);
  useEffect(() => { startWalkthroughRef.current = handleWalkthroughStart; });

  useEffect(() => {
    if (!import.meta.env.DEV || appMode !== "caregiver") return;
    type Hook = (t: string, p?: WalkthroughParams) => void;
    (window as unknown as { __dwStartWalkthrough?: Hook }).__dwStartWalkthrough = (task, params) =>
      startWalkthroughRef.current(task as WalkthroughTaskName, params ?? {});
    type HlHook = (action: AgentAction) => void;
    (window as unknown as { __dwHighlightChange?: HlHook }).__dwHighlightChange = action =>
      setHighlightChange(action);
    return () => {
      delete (window as unknown as { __dwStartWalkthrough?: Hook }).__dwStartWalkthrough;
      delete (window as unknown as { __dwHighlightChange?: HlHook }).__dwHighlightChange;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appMode]);

  const handleWalkthroughNavigate = (target: WalkthroughScreen) => {
    if (target.mode === "caregiver") setScreen(target.screen);
  };

  const handleWalkthroughAdvance = () => {
    if (!walkthroughTask) return;
    if (walkthroughStepIndex >= walkthroughSteps.length - 1) {
      // An AUTONOMOUS walkthrough is not a one-time introduction — it is how the
      // write is performed — so it never joins the "already shown" list. Hermes
      // subtracts AUTONOMOUS_TASKS from completed_walkthroughs anyway (that is
      // the load-bearing fix), but recording them here would keep growing the
      // stored list with entries that mean nothing and hand the same category
      // error to the next reader of this column.
      if (elderId && !AUTONOMOUS_TASKS.has(walkthroughTask)) void markWalkthroughCompleted(elderId, "caregiver", walkthroughTask);
      clearWalkthroughSession("caregiver", elderId);
      setWalkthroughTask(null);
      setWalkthroughStepIndex(0);
      return;
    }
    const next = walkthroughStepIndex + 1;
    setWalkthroughStepIndex(next);
    // params ride along — see ElderlyApp: dropping them made a mid-run remount
    // silently rebuild the steps from the builder defaults.
    saveWalkthroughSession("caregiver", elderId, { taskName: walkthroughTask, stepIndex: next, startedAt: Date.now(), params: walkthroughParams });
  };

  // Exiting/skipping clears client state only — never written back for an
  // abandoned walkthrough, only genuine completion (above).
  const handleWalkthroughExit = () => {
    clearWalkthroughSession("caregiver", elderId);
    setWalkthroughTask(null);
    setWalkthroughStepIndex(0);
  };

  // Caregiver-shell Verify: real re-queries for checks the signed-in
  // CAREGIVER's own data can answer (their profile/accessibility); kinds that
  // need ELDER data (medications, archived meds, the elder-side care-link
  // check) get honest stubs that return false — never a faked pass this
  // context can't actually prove.
  const handleWalkthroughVerify = async (verify: VerifyDirective): Promise<boolean> => {
    if (!elderId) return false;
    return buildVerifyRunner({
      elderId,
      fetchProfile,
      fetchAccessibility: async id => (await fetchProfile(id))?.details ?? null,
      fetchElderMedications: async () => [],
      fetchArchivedMedications: async () => [],
      hasActiveCareLink: async () => false,
      fetchDoctorQuestions: async () => [],
    })(verify);
  };

  // Caregiver-shell Reveal: navigate + pulse the real element (minimal mirror
  // of ElderlyApp's handleWalkthroughReveal; no caption tracker here).
  const handleWalkthroughReveal = (reveal: RevealDirective) => {
    if (reveal.screen.mode === "caregiver") setScreen(reveal.screen.screen);
    if (reveal.pulse === false) return;
    setTimeout(() => {
      const el = document.querySelector<HTMLElement>(reveal.selector);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("walk-reveal-pulse");
      setTimeout(() => el.classList.remove("walk-reveal-pulse"), PACING.REVEAL_PULSE_MS);
    }, PACING.NAVIGATE_MS);
  };

  // Chat→wizard entry: an ACTIVE elder session received start_walkthrough
  // ("onboarding"), whose steps live on the wizard — a separate onboarding
  // stage the elder shell can't spotlight. Switch into the wizard;
  // resumeElderAfterWizard routes its exit/completion back into the elder app.
  // Scenario s30 finishes the UX on top of this pathway.
  const handleElderOnboardingWalkthrough = async () => {
    if (!session) return; // guarded: only an active session can round-trip back
    // The wizard always starts from BLANK local state here (no prefill
    // threading exists for this entry point) and its own finish() does a
    // full profile save from that state — so re-running it for an elder who
    // already has real profile data would silently wipe it. Re-query the
    // REAL profile rather than trust local `patients` state: `patients`
    // initializes from the mock PATIENTS literal (which already has non-empty
    // conditions/allergies baked in) until the async fetch replaces it, so a
    // synchronous check here can read stale mock data for a genuinely blank
    // elder — found live re-verifying scenario s30's own fix. `wakeTime`/
    // weight/height are wizard-routine-only fields (never set on the mock
    // default), but conditions/allergies can ALSO be populated with no wizard
    // run at all (e.g. a caregiver-entered diagnosis) — also found live by
    // s30, which seeded exactly that shape. A real prefill-and-merge flow is
    // future work if "redo onboarding" is ever wanted as an intentional
    // feature; refusing outright is the safe default until then.
    const real = await fetchProfile(elderId);
    const d = real?.details;
    const alreadyHasProfile =
      !!d?.wakeTime || !!d?.weightKg || !!d?.heightCm ||
      (d?.conditions?.length ?? 0) > 0 || (d?.allergies?.length ?? 0) > 0;
    if (alreadyHasProfile) return;
    setResumeElderAfterWizard(true);
    setPendingMode("elderly");
    setWizardPrefill(undefined);
    setPreAuthStage("wizard");
    setAppMode("onboarding");
  };

  const handleAddPrescription = async (med: Omit<Medication, "id" | "status"> & { times?: string[] }) => {
    if (!elderId) return;
    const timeHHMMs = (med.times && med.times.length ? med.times : [med.time]).map(t => to24h(t));
    const medicationId = await addMedication(elderId, {
      name: med.name, dosage: med.dose, purpose: med.purpose,
      timeHHMMs, refillDays: med.refillDaysLeft,
      days: med.days, intervalDays: med.intervalDays,
    });
    setPatients(prev => prev.map((p, i) => i !== selectedPatient ? p : {
      ...p,
      medications: [...p.medications, { ...med, id: nextMedId++, medicationId, status: "upcoming" }],
    }));
  };

  // After the agent commits a scanned prescription server-side, refetch the list
  // (that path writes via Hermes, not the local handleAddPrescription).
  const refreshMedications = async () => {
    if (!elderId) return;
    const medications = await fetchElderMedications(elderId);
    setPatients(prev => prev.map((p, i) => i !== selectedPatient ? p : { ...p, medications }));
  };

  // Name of a just-added medication, so the timeline/patient list can highlight
  // it as visible proof it landed (mirrors the elder shell). Auto-clears after 6s.
  const [justAddedMed, setJustAddedMed] = useState<string | null>(null);
  const justAddedTimer = useRef<number>();
  const flagJustAdded = (name?: string) => {
    if (!name) return;
    setJustAddedMed(name);
    window.clearTimeout(justAddedTimer.current);
    justAddedTimer.current = window.setTimeout(() => setJustAddedMed(null), 6000);
  };

  // Safety net for the chat's post-write refetch: if that never fired (e.g. the
  // agent committed a write the client couldn't detect in `actions`), re-pull
  // medications whenever the user lands on a screen that shows them, so the
  // timeline/dashboard/patient view can't sit on stale data until a full reload.
  useEffect(() => {
    if (!elderId || appMode === "onboarding") return;
    if (!["timeline", "patient", "dashboard"].includes(screen)) return;
    void refreshMedications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, elderId, appMode]);

  // "Send reminder" is a caregiver-to-elder nudge — it should notify the care
  // recipient, not open the caregiver's own care-team chat thread. Opens a
  // compose sheet (default options + free text) instead of firing immediately.
  const handleSendReminder = (medName?: string) => setShowSendReminder({ medName });

  // No live push infra exists, so "sent" means: log it in the caregiver's own
  // Notifications tab, add it to the elder's own Notifications tab (persists,
  // unlike the toast below), and queue a pop-up toast for whenever the
  // elderly interface is next shown (this is a single-device demo, not real delivery).
  const handleReminderSent = (text: string) => {
    const lang = readStoredLanguage();
    setNotifications(prev => [{
      id: Date.now(), type: "reminder", title: t(lang, "toast.reminderSent"), body: text,
      time: "Just now", read: true, patientId: patients[selectedPatient].id,
    }, ...prev]);
    setCareMessages(prev => [{ id: Date.now() + 1, author: t(lang, "messages.yourCaregiver"), role: t(lang, "messages.reminderRole"), body: text, time: t(lang, "common.justNow"), isMe: false }, ...prev]);
    setElderToasts(prev => [...prev, { id: Date.now() + 2, title: t(lang, "toast.reminderFromCaregiver"), body: text }]);
  };

  const handleDeleteMedication = async (id: number) => {
    const med = patients[selectedPatient].medications.find(m => m.id === id);
    if (med?.medicationId) await archiveMedication(med.medicationId);
    setPatients(prev => prev.map((p, i) => i !== selectedPatient ? p : {
      ...p,
      medications: p.medications.filter(m => m.id !== id),
      pastMedications: med?.medicationId
        ? [...(p.pastMedications ?? []), { id: med.medicationId, name: med.name, dose: med.dose, purpose: med.purpose }]
        : p.pastMedications,
    }));
  };

  const handleUpdatePatient = (updated: Patient) => {
    setPatients(prev => prev.map((p, i) => i === selectedPatient ? updated : p));
  };

  const unreadCount = notifications.filter(n => !n.read).length;
  const activeTab = ["dashboard", "timeline", "ai", "patient"].includes(screen)
    ? screen
    : "settings";

  const showPatientSwitcher = ["dashboard", "patient", "timeline"].includes(screen);
  const showBack = ["messages"].includes(screen);

  if (authLoading) {
    return (
      <LanguageProvider>
        <div className="min-h-dvh flex items-center justify-center bg-[#CBC7B8] md:p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
          <div className="w-full h-dvh bg-background dw-app-bg relative overflow-hidden flex flex-col md:w-[390px] md:h-[844px] md:rounded-[3rem] md:shadow-2xl md:border-[6px] md:border-black" />
        </div>
      </LanguageProvider>
    );
  }

  if (appMode === "onboarding") {
    return (
      <LanguageProvider>
        {/* AccessibilityProvider is REQUIRED here, not optional chrome. The
            wizard's routine step renders TimeFields, and current-meds /
            med-history render TimesPicker via MedList — all three call
            useAccessibility() (for the 12h/24h setting), and that hook THROWS
            when the provider is missing. Without this wrapper the hook threw
            during render, React unmounted the whole tree, and every new user
            hit a blank white screen the moment they reached "When do you
            usually eat and sleep?". Caught by scenario s30. */}
        <AccessibilityProvider>
        <div className="min-h-dvh flex items-center justify-center bg-[#CBC7B8] md:p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
          <div className="w-full h-dvh bg-background dw-app-bg relative overflow-hidden flex flex-col md:w-[390px] md:h-[844px] md:rounded-[3rem] md:shadow-2xl md:border-[6px] md:border-black">
            {preAuthStage === "welcome" && (
              <WelcomeScreen onSignIn={() => setPreAuthStage("signin")} onGetStarted={() => setPreAuthStage("mode")} />
            )}
            {preAuthStage === "signin" && (
              <LoginScreen onBack={() => setPreAuthStage("welcome")} onGetStarted={() => setPreAuthStage("mode")} />
            )}
            {preAuthStage === "mode" && (
              <OnboardingScreen
                onSelect={(mode) => {
                  if (session && !needsWizard) { setScreen("dashboard"); setAppMode(mode); }
                  else { setPendingMode(mode); setPreAuthStage("method"); }
                }}
                onBack={
                  !session ? () => setPreAuthStage("welcome")
                  : !needsWizard ? () => setAppMode(modeBeforeSwitch)
                  : undefined // mid-setup with no completed profile yet — nothing sensible to go back to
                }
              />
            )}
            {preAuthStage === "method" && (
              <SetupMethodScreen
                onBack={() => setPreAuthStage("mode")}
                onGuided={() => { setWizardPrefill(undefined); setPreAuthStage("wizard"); }}
                onExtracted={(prefill) => { setWizardPrefill(prefill); setPreAuthStage("wizard"); }}
              />
            )}
            {preAuthStage === "wizard" && (
              <GuidedSetupWizard
                mode={pendingMode}
                hasSession={!!session}
                elderId={elderId}
                prefill={wizardPrefill}
                onComplete={() => {
                  setNeedsWizard(false); setWizardPrefill(undefined); setScreen("dashboard");
                  if (resumeElderAfterWizard) {
                    // Chat-initiated onboarding run: back into the elder app,
                    // without re-triggering the post-setup auto-tour.
                    setResumeElderAfterWizard(false);
                    setAppMode("elderly");
                  } else {
                    setJustOnboarded(true);
                    setAppMode(pendingMode);
                  }
                }}
                onExit={() => {
                  if (resumeElderAfterWizard) { setResumeElderAfterWizard(false); setAppMode("elderly"); }
                  else setPreAuthStage("method");
                }}
              />
            )}
          </div>
        </div>
        </AccessibilityProvider>
      </LanguageProvider>
    );
  }

  if (appMode === "elderly") {
    return (
      <LanguageProvider>
        <div className="min-h-dvh flex items-center justify-center bg-[#CBC7B8] md:p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
          <div className="w-full h-dvh bg-background dw-app-bg relative overflow-hidden flex flex-col md:w-[390px] md:h-[844px] md:rounded-[3rem] md:shadow-2xl md:border-[6px] md:border-black">
            <AccessibilityProvider>
              <ElderlyApp
                patient={patients[0]}
                elderId={elderId}
                onUpdatePatient={(p) => setPatients(prev => [typeof p === "function" ? p(prev[0]) : p, ...prev.slice(1)])}
                onSignOut={() => supabase.auth.signOut()}
                startTour={justOnboarded}
                careMessages={careMessages}
                onDismissCareMessage={id => setCareMessages(prev => prev.filter(m => m.id !== id))}
                // The care-message thread is local state on both sides (there is
                // no elder<->caregiver messages table yet — see MEMORY.md), so a
                // reply joins the same in-memory thread rather than pretending to
                // send anywhere.
                onReplyCareMessage={(id, text) => setCareMessages(prev => {
                  const target = prev.find(m => m.id === id);
                  return [...prev, {
                    id: Date.now(),
                    author: patients[0].nickname || patients[0].name,
                    role: target ? `→ ${target.author}` : "",
                    body: text,
                    time: new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" }),
                    isMe: true,
                  }];
                })}
                onStartOnboardingWizard={handleElderOnboardingWalkthrough}
              />
            </AccessibilityProvider>
            <ToastStack
              toasts={elderToasts}
              onDismiss={id => setElderToasts(prev => prev.filter(t => t.id !== id))}
            />
          </div>
        </div>
      </LanguageProvider>
    );
  }

  return (
    <LanguageProvider>
      <div className="min-h-dvh flex items-center justify-center bg-[#CBC7B8] md:p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        {/* Phone frame — fills the viewport on a real phone; the bezel mockup is
            desktop-only, hence every frame class being md:-prefixed. */}
        <div className="w-full h-dvh bg-background dw-app-bg relative overflow-hidden flex flex-col md:w-[390px] md:h-[844px] md:rounded-[3rem] md:shadow-2xl md:border-[6px] md:border-black">
        <AccessibilityProvider>
          {/* Status bar */}
          <LiveStatusBar className="bg-background/80 backdrop-blur-sm" />

          {/* App header — `relative z-30` here (not just on PatientSwitcher
              itself) matters: backdrop-blur-sm below creates its own stacking
              context, which traps PatientSwitcher's z-[200] dropdown inside
              it. Without an explicit z-index on this header, that trapped
              context has no z-index of its own either, so the "Screen
              content" sibling below — later in the DOM, same default stacking
              level — paints on top of the whole header, dropdown included,
              whenever the dropdown is open and overlaps it. */}
          <div className="relative z-30 px-4 pt-2 pb-3 bg-background/70 backdrop-blur-md border-b border-border/60 shrink-0">
            {showBack ? (
              <div className="flex items-center gap-2.5 mb-2">
                <button onClick={() => setScreen("dashboard")} aria-label={t(uiLang, "common.back")} className="w-11 h-11 bg-card border border-border rounded-full flex items-center justify-center active:bg-muted transition-colors">
                  <ArrowLeft size={20} className="text-foreground" />
                </button>
                <span className="text-base font-semibold text-foreground">{t(uiLang, "common.careTeamNotes")}</span>
              </div>
            ) : (
              /* Mirrors the elder header: app name centred, help left, profile
                 right, all three controls round. Messages moved out — the
                 dashboard already links to it. */
              <div className="flex items-center justify-between gap-2 mb-2">
                <button onClick={() => setShowCaregiverTourConfirm(true)} aria-label={t(uiLang, "header.help")} className="w-11 h-11 bg-card border border-border rounded-full flex items-center justify-center active:bg-muted transition-colors">
                  <HelpCircle size={22} className="text-primary" />
                </button>
                <h1 className="dw-display text-[calc(24px*var(--dw-text,1))] font-semibold tracking-tight text-primary leading-none">Dosewise</h1>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => setScreen("notifications")} aria-label={t(uiLang, "nav.notifications")} className="w-11 h-11 bg-card border border-border rounded-full flex items-center justify-center relative active:bg-muted transition-colors">
                    <Bell size={22} className="text-primary" />
                    {unreadCount > 0 && (
                      <div className="absolute -top-1 -right-1 min-w-5 h-5 px-1 bg-destructive rounded-full flex items-center justify-center text-[calc(11px*var(--dw-text,1))] font-bold text-destructive-foreground">{unreadCount}</div>
                    )}
                  </button>
                  {/* The caregiver's OWN account, not the elder's — deliberately
                      an icon, not a photo: the PatientSwitcher directly below
                      already carries the care recipient's face. */}
                  <button onClick={() => setScreen("settings")} aria-label={t(uiLang, "header.profile")} className="w-11 h-11 bg-card border border-border rounded-full flex items-center justify-center active:bg-muted transition-colors" title={t(uiLang, "common.openSettings")}>
                    <UserRound size={22} className="text-primary" />
                  </button>
                </div>
              </div>
            )}
            {showPatientSwitcher && (
              <PatientSwitcher patients={patients} selected={selectedPatient} onSelect={setSelectedPatient} onAdd={handleAddPatient} onScan={() => setShowScanLink(true)} />
            )}
          </div>

          {/* Screen content */}
          <ZoomContent className={`flex-1 ${screen === "ai" ? "overflow-hidden flex flex-col" : "overflow-y-auto scrollbar-none"}`}>
            {screen === "dashboard" && <DashboardScreen patient={patient} onNavigate={setScreen} onSendReminder={handleSendReminder} />}
            {screen === "patient" && (
              <PatientScreen
                patient={patient}
                justAddedMed={justAddedMed}
                onEditProfile={() => setShowEditProfile(true)}
                onAddPrescription={() => setShowAddPrescription(true)}
                onDeleteMedication={handleDeleteMedication}
              />
            )}
            {screen === "timeline" && <TimelineScreen patient={patient} justAddedMed={justAddedMed} onSendReminder={handleSendReminder} />}
            {screen === "notifications" && (
              <NotificationsScreen
                notifications={notifications}
                patient={patient}
                onMarkAllRead={() => setNotifications(prev => prev.map(n => ({ ...n, read: true })))}
                onDismiss={id => setNotifications(prev => prev.filter(n => n.id !== id))}
              />
            )}
            {screen === "ai" && <AskMeiScreen patient={patient} elderId={elderId} onUpdatePatient={handleUpdatePatient} onNavigate={setScreen} onSendReminder={() => handleSendReminder()} onMedsChanged={refreshMedications} onMedAdded={flagJustAdded} onHighlightChange={setHighlightChange} onWalkthroughStart={handleWalkthroughStart} />}
            {screen === "messages" && <MessagesScreen elderId={elderId} />}
            {screen === "settings" && <SettingsScreen patient={patient} caregiverAccount={caregiverAccount} onSwitchMode={openModeSwitch} onSignOut={() => supabase.auth.signOut()} onEditProfile={() => setShowEditProfile(true)} />}
          </ZoomContent>

          {/* Modals */}
          {showAddPrescription && (
            <AddPrescriptionSheet
              onClose={() => setShowAddPrescription(false)}
              routine={{ ...patient.mealTimes, sleepTime: patient.sleepTime }}
              onAdd={handleAddPrescription}
              onAdded={() => setScreen("patient")}
              onAgentAdded={(name) => { void refreshMedications(); flagJustAdded(name); }}
            />
          )}
          {showEditProfile && (
            <EditProfileSheet
              patient={patient}
              onClose={() => setShowEditProfile(false)}
              onSave={handleUpdatePatient}
            />
          )}
          {showSendReminder && (
            <SendReminderSheet
              patientName={patient.nickname}
              medName={showSendReminder.medName}
              onClose={() => setShowSendReminder(null)}
              onSend={handleReminderSent}
            />
          )}
          {showScanLink && (
            <ScanLinkSheet
              onClose={() => setShowScanLink(false)}
              onLinked={(name, relation) => handleAddPatient(name, relation)}
            />
          )}
          <ToastStack
            toasts={toasts}
            onDismiss={id => setToasts(prev => prev.filter(t => t.id !== id))}
            onClick={id => { setToasts(prev => prev.filter(t => t.id !== id)); setScreen("notifications"); }}
          />

          {/* Caregiver proof-of-change layer — mirrors ElderlyApp's wiring. */}
          <ChangeHighlight
            change={highlightChange}
            mode="caregiver"
            onNavigate={target => setScreen(target as Screen)}
            onDone={() => setHighlightChange(null)}
          />
          {showCaregiverTour && <GuidedTour steps={caregiverTourSteps} onFinish={() => setShowCaregiverTour(false)} />}
          {walkthroughTask && walkthroughSteps.length > 0 && (
            <Walkthrough
              steps={walkthroughSteps}
              stepIndex={Math.min(walkthroughStepIndex, walkthroughSteps.length - 1)}
              currentScreen={{ mode: "caregiver", screen }}
              onNavigate={handleWalkthroughNavigate}
              onAdvance={handleWalkthroughAdvance}
              onExit={handleWalkthroughExit}
              onVerify={handleWalkthroughVerify}
              onReveal={handleWalkthroughReveal}
            />
          )}
          {showCaregiverTourConfirm && (
            <ConfirmDialog
              title={t(uiLang, "confirm.replayTourTitle")}
              body={t(uiLang, "confirm.replayTourBody")}
              confirmLabel={t(uiLang, "confirm.replay")}
              onConfirm={() => { setShowCaregiverTourConfirm(false); setShowCaregiverTour(true); }}
              onCancel={() => setShowCaregiverTourConfirm(false)}
            />
          )}

          {/* Bottom navigation */}
          <BottomNav activeTab={activeTab} onSelect={setScreen} />
        </AccessibilityProvider>
        </div>
      </div>
    </LanguageProvider>
  );
}
