import { useEffect, useMemo, useRef, useState } from "react";
import { Home, Pill, Brain, Bell, Settings, HelpCircle, ChevronLeft } from "lucide-react";
import type { Patient, Medication, MedStatus, Message } from "../../types";
import { ProfileAvatar, LiveStatusBar } from "../../components/shared";
import type { ElderlyTab, DoctorQ } from "./types";
import { ElderlyHomeScreen } from "./ElderlyHomeScreen";
import { ElderlyPrescriptionScreen } from "./ElderlyPrescriptionScreen";
import type { GroupedMed } from "./ElderlyPrescriptionScreen";
import { ElderlyAIScreen } from "./ElderlyAIScreen";
import { ElderlyNotificationsScreen } from "./ElderlyNotificationsScreen";
import { ElderlySettingsScreen } from "./ElderlySettingsScreen";
import { AddPrescriptionSheet } from "../AddPrescriptionSheet";
import { TravelModeSheet } from "../TravelModeSheet";
import { ChangeHighlight } from "../../components/ChangeHighlight";
import { HighlightCaption } from "../../components/HighlightCaption";
import type { AgentAction, AgentAlert, WalkthroughRisk } from "../../lib/hermes";
import { GuidedTour } from "../../components/GuidedTour";
import type { TourStep } from "../../components/GuidedTour";
import { useContentZoom } from "../../accessibility";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { buildAlerts, pickPopupAlert, inQuietHours, type Alert } from "../../lib/alerts";
import { loadAlertState, saveAlertState, poppedKey, ALERT_POPUP_COOLDOWN_MS } from "../../lib/alertState";
import { UrgentAlertPopup } from "../../components/UrgentAlertPopup";
import { logDoseTaken, unlogDoseTaken, addMedication, updateMedication, archiveMedication, fetchElderMedications, fetchArchivedMedications, to24h, anyMedicationRunningLow, isDueOn } from "../../lib/medications";
import { defaultDoseTime } from "../../components/TimesPicker";
import { MED_COLOURS, localizeCatalogValue } from "../../data/medications";
import { useLanguage } from "../../lib/languageContext";
import { useAccessibility } from "../../accessibility.tsx";
import { t } from "../../lib/language";
import { Walkthrough } from "../../components/Walkthrough";
import { resolveWalkthroughSteps, walkthroughShellFor } from "../../lib/walkthrough/steps";
import { AUTONOMOUS_TASKS } from "../../lib/walkthrough/types";
import { PACING, TRUST_MODE_THRESHOLD } from "../../lib/walkthrough/pacing";
import { highlightableEntities } from "../../lib/changeHighlight";
import { buildVerifyRunner } from "../../lib/walkthrough/verify";
import type { WalkthroughScreen, WalkthroughTaskName, VerifyDirective, RevealDirective, WalkthroughParams } from "../../lib/walkthrough/types";
import { loadWalkthroughSession, saveWalkthroughSession, clearWalkthroughSession } from "../../lib/walkthroughState";
import { markWalkthroughCompleted, fetchProfile } from "../../lib/profile";
import { fetchDoctorQuestions, createDoctorQuestion } from "../../lib/doctor";
import { hasActiveCareLink, fetchPendingLinkRequests, type PendingLinkRequest } from "../../lib/careLinks";

export function ElderlyApp({ patient, elderId, onUpdatePatient, onSignOut, startTour, careMessages, onDismissCareMessage, onReplyCareMessage, onStartOnboardingWizard }: {
  patient: Patient;
  elderId?: string;
  onUpdatePatient: (p: Patient | ((prev: Patient) => Patient)) => void;
  onSignOut: () => void;
  startTour?: boolean;
  careMessages: Message[];
  onDismissCareMessage: (id: number) => void;
  onReplyCareMessage: (id: number, text: string) => void;
  // Chat asked for the "onboarding" walkthrough — its steps live on the
  // wizard, a separate stage this shell can't spotlight, so the host (App)
  // switches into it and resumes back here on exit.
  onStartOnboardingWizard?: () => void;
}) {
  const [tab, setTab] = useState<ElderlyTab>("home");
  // A screen with its own sub-view (the chat, an Ask Mei category, a Settings
  // page) REPLACES this header instead of stacking a second one under it. The
  // owning screen clears it on unmount, so no reset is needed here.
  const [headerOverride, setHeaderOverride] = useState<{ title: string; onBack: () => void; action?: React.ReactNode } | null>(null);
  // The "Text size" accessibility setting. The app's text is almost all in
  // absolute-px Tailwind utilities (not rem), so the html --font-size var alone
  // barely moved anything — the slider looked broken. Proportionally zoom the
  // scrollable content area (chrome/nav excluded, so nothing clips) so the whole
  // elder reading surface actually grows/shrinks with the setting. "large" is the
  // default → scale 1 (no change out of the box).
  const contentZoom = useContentZoom();

  const [pendingAIMessage, setPendingAIMessage] = useState<string | undefined>();
  // "Open Ask Mei on the conversation, not the help tiles" — consumed and
  // cleared by ElderlyAIScreen exactly like pendingAIMessage below it.
  const [pendingChatView, setPendingChatView] = useState(false);
  // Pre-fills Ask Mei's input box WITHOUT sending — the elder still taps Send
  // themselves (unlike pendingAIMessage above, which auto-sends).
  const [pendingPrefill, setPendingPrefill] = useState<string | undefined>();
  const [walkthroughTask, setWalkthroughTask] = useState<WalkthroughTaskName | null>(null);
  const [walkthroughStepIndex, setWalkthroughStepIndex] = useState(0);
  const [walkthroughParams, setWalkthroughParams] = useState<WalkthroughParams>({});
  // RiskClassifier result for the walkthrough currently running (Item 5's
  // Confirm phase reads this — decision B). Set once, at start, from the real
  // Hermes turn; NOT part of lib/walkthroughState.ts's persisted session
  // shape, so a same-tab restore (below) loses it and a risk-flagged instance
  // falls back to the non-tap Confirm path on that specific path only — a
  // known gap, not silently accepted: see the restore effect's own comment.
  const [walkthroughRisk, setWalkthroughRisk] = useState<WalkthroughRisk | undefined>();
  // Bumped when a walkthrough starts: screens that hold their own internal view
  // state (Ask Mei's help-vs-chat, Settings' sub-pages/search, the Reminders
  // demo alert) return to the state a tour's first step expects. Same mechanism
  // as openQuestionsSignal below — the host can't reach into a child's state, and
  // a tour's onEnter only switches tabs. Ignoring the initial 0 keeps it from
  // clobbering anything on mount.
  const [screenResetSignal, setScreenResetSignal] = useState(0);
  // Whether an ACTIVE caregiver link exists. The emergency contact IS the
  // linked caregiver now (2026-08-02) — it used to be a mock fixture that was
  // always present, which quietly guaranteed emergency_contact_tour's final
  // target existed. With real data that card can be absent, and that step is a
  // consent waitFor: unreachable target = a scrim with only Exit. Refreshed on
  // the Reminders tab, where a link is accepted.
  //
  // TRI-STATE: `undefined` means "not looked yet". Only a definite `false`
  // refuses the tour. Starting at `false` refused it during the ~100ms before
  // the first fetch resolves — telling someone who DOES have a caregiver that
  // they don't, which is worse than the other way round: with no caregiver the
  // tour merely reaches its final step's own timeoutMs and says so honestly.
  const [hasCaregiver, setHasCaregiver] = useState<boolean | undefined>(undefined);
  const [addRx, setAddRx] = useState<null | "scan" | "manual">(null);
  // Set when AddPrescriptionSheet is opened from a medication's Edit button
  // rather than the "+" add flow — see handleSavePrescription below.
  const [editingMed, setEditingMed] = useState<GroupedMed | null>(null);
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
  const {
    notifications: notifyPrefs, timeFormat,
    walkthroughManualMode, walkthroughCompletionCount, incrementWalkthroughCompletionCount,
  } = useAccessibility();
  // TrustMode (Item 2, decision C): first-timers/manual-mode keep today's
  // unconditional tap gate; a veteran (past TRUST_MODE_THRESHOLD completions,
  // manual mode off) gets the new auto-advance path instead.
  const requireExplicitAdvance = walkthroughManualMode || walkthroughCompletionCount < TRUST_MODE_THRESHOLD;

  // Entity ids the current ChangeHighlight is trying to ring — handed to
  // screens that keep content behind a collapsed section, so they can reveal it
  // before the highlight's 5s search gives up.
  const highlightEntityIds = highlightChange
    ? highlightableEntities(highlightChange).map(e => e.entity_id).filter((id): id is string => !!id)
    : undefined;

  const flagJustAdded = (name?: string) => {
    if (!name) return;
    setJustAddedMed(name);
    window.clearTimeout(justAddedTimer.current);
    justAddedTimer.current = window.setTimeout(() => setJustAddedMed(null), 6000);
  };

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

  // --- Urgent alerts (item 5) ---------------------------------------------
  // ONE evaluation feeding three surfaces — the Reminders list, the nav badge
  // and the popup — so the same thing can never be reported three times, and
  // acknowledging it anywhere clears it everywhere.
  // Whether patient.medications holds REAL, fetched data yet. Until it does it
  // holds data/patients.ts's demo fixture, whose Metformin and Latanoprost
  // carry refillDaysLeft 4 and 3 — under both supply thresholds. Without this
  // gate every elder session opened with a full-screen alert about medicines
  // the person does not take, which is the same dishonesty CONTEXT.md's "real
  // medical facts have NO mock fallback" rule already forbids elsewhere.
  //
  // Set on SUCCESS only, deliberately. refreshMeds is a bare Promise.all with
  // no catch, so a rejected fetch leaves the fixture in place — flipping this
  // on settle would build alerts from exactly the data it exists to exclude.
  // The trade is that a failed fetch means no alerts for that session, which is
  // the right way round for a medication app: don't warn about data you don't
  // have.
  const [medsLoaded, setMedsLoaded] = useState(false);
  const [linkRequests, setLinkRequests] = useState<PendingLinkRequest[]>([]);
  const [acknowledgedAlerts, setAcknowledgedAlerts] = useState<Set<string>>(new Set());
  const [popupAlert, setPopupAlert] = useState<Alert | null>(null);
  const [agentAlerts, setAgentAlerts] = useState<Alert[]>([]);
  const [alertNow, setAlertNow] = useState(() => new Date());
  const alerts = useMemo(
    () => [
      // Mei's own alerts are about THIS conversation, not about stored
      // medication state, so they don't wait on the fetch.
      ...agentAlerts,
      ...(medsLoaded
        ? buildAlerts({ medications: patient.medications, careMessages, linkRequests, now: alertNow })
        : []),
    ],
    [agentAlerts, medsLoaded, patient.medications, careMessages, linkRequests, alertNow],
  );
  const liveAlerts = alerts.filter(a => !acknowledgedAlerts.has(a.id));
  const urgentCount = liveAlerts.filter(a => a.severity !== "notice").length;

  // Never stack modals: a walkthrough owns the screen while it runs (and its
  // callout is the only host of Exit), a tour likewise, and a sheet is a form
  // the person is mid-way through.
  const alertsSuppressed = walkthroughTask !== null || showTour || addRx !== null || showTravel;

  // Mei raised something urgent from a chat turn. Folded into the SAME array
  // and the same pickPopupAlert gate as the derived alerts, so it inherits
  // every anti-nag rule rather than being a second, unguarded way to interrupt.
  // Kept in state (not derived) because it is an event, not a condition — there
  // is nothing to re-derive it from on the next poll.
  const handleAgentAlert = (raised: AgentAlert) => {
    setAgentAlerts(prev => {
      // Keyed on the title so the same warning repeated across turns doesn't
      // stack up — raise_alert already refuses a second one per turn, but a
      // conversation can revisit the same subject.
      const id = `agent:${raised.title}`;
      if (prev.some(a => a.id === id)) return prev;
      return [...prev, {
        id,
        kind: "agent" as const,
        severity: raised.severity,
        // PROSE, not keys. The model already wrote these in the reader's own
        // language (Hermes holds no translation table — the same reason the
        // client owns the synthesized Yes/No pair), and the popup renders every
        // alert through t(). That works only because `t()` ends in `?? key` and
        // echoes anything it doesn't recognise; if that ever changed, an agent
        // alert would render a blank modal. Locked in by alerts.test.ts's
        // "an agent-raised alert renders its own prose".
        titleKey: raised.title,
        bodyKey: raised.body,
        params: {},
        medName: raised.medication_name ?? undefined,
        pref: "doseReminders" as const,
      }];
    });
  };

  const dismissPopupAlert = () => {
    const alert = popupAlert;
    setPopupAlert(null);
    if (!alert) return;
    // Recorded as seen for the rest of the day AND acknowledged in the list, so
    // dismissing here doesn't leave the same item shouting from the badge.
    const state = loadAlertState("elder", elderId);
    saveAlertState("elder", elderId, {
      popped: [...new Set([...state.popped, poppedKey(alert.id)])],
      cooldownUntil: Date.now() + ALERT_POPUP_COOLDOWN_MS,
    });
    setAcknowledgedAlerts(prev => new Set(prev).add(alert.id));
  };
  useEffect(() => {
    if (typeof window === "undefined") return;
    const canNotify = "Notification" in window;
    const check = () => {
      // Advance the alert clock on the SAME tick — one interval, two jobs.
      // Deliberately outside the permission gate below: an in-app popup has no
      // dependency on the browser's Notification permission, and inheriting
      // that gate would silently disable urgent alerts for everyone who
      // declined (or never saw) the OS prompt.
      setAlertNow(new Date());
      if (!canNotify || Notification.permission !== "granted" || !notifyPrefs.doseReminders) return;
      const now = new Date();
      const nowLabel = now.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase();
      const today = now.toISOString().slice(0, 10);
      for (const med of patient.medications) {
        // A medicine that isn't due today (weekly / every-N-days cadence) must
        // not fire a reminder just because the clock matched one of its times.
        if (!isDueOn(med, now)) continue;
        if (med.status !== "upcoming" || med.time.toUpperCase() !== nowLabel) continue;
        const key = `${med.id}|${today}`;
        if (notifiedRef.current.has(key)) continue;
        notifiedRef.current.add(key);
        // Localized, like everything else the person reads. This was the last
        // hardcoded-English surface in the elder shell — and the least
        // forgivable one, since a dose reminder is exactly the message someone
        // reads at a glance without the app open. `purpose` goes through
        // localizeCatalogValue so it matches how the same value renders on the
        // medication card.
        new Notification(t(language, "notifications.doseReminderTitle", { med: med.name }), {
          body: t(language, "notifications.doseReminderBody", {
            dose: med.dose || "",
            purpose: med.purpose
              ? localizeCatalogValue(med.purpose, k => t(language, k))
              : t(language, "notifications.doseReminderPurposeFallback"),
          }).trim(),
        });
      }
    };
    check();
    const interval = setInterval(check, 30_000);
    return () => clearInterval(interval);
    // `language` included so a switch takes effect on the NEXT reminder rather
    // than only after something else happens to remount this.
  }, [patient.medications, notifyPrefs.doseReminders, language]);

  // Whether an alert may INTERRUPT is decided entirely in lib/alerts.ts, so
  // every anti-nag rule (tier, preference toggle, once-per-day dedupe, cooldown,
  // quiet hours, other modals) lives in one testable place rather than being
  // spread across this component.
  useEffect(() => {
    // Suppression is checked BEFORE the already-open short-circuit, and that
    // order is the whole point. It used to be the other way round, so
    // `alertsSuppressed` only stopped a NEW popup opening — one already on
    // screen when a walkthrough started just stayed there, and its z-[120]
    // backdrop swallowed every tap beneath it, including the walkthrough's own
    // Save button. (Found by s15-edit-profile, which fails on exactly that:
    // sign in -> popup -> start walkthrough -> Save is unclickable.)
    //
    // Deliberately does NOT record it as popped-for-the-day: the situation is
    // still urgent, so it should be free to re-raise once the overlay is gone.
    // Swallowing it because a walkthrough happened to start is the opposite
    // failure to the one being fixed.
    if (alertsSuppressed) {
      if (popupAlert) setPopupAlert(null);
      return;
    }
    if (popupAlert) return;
    const state = loadAlertState("elder", elderId);
    const next = pickPopupAlert(liveAlerts, {
      popped: new Set(state.popped),
      prefs: notifyPrefs,
      suppressed: alertsSuppressed,
      quiet: inQuietHours(alertNow, { start: patient.sleepTime, end: patient.wakeTime }),
      cooldownUntil: state.cooldownUntil,
    });
    if (next) setPopupAlert(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveAlerts, alertsSuppressed, notifyPrefs, elderId, alertNow]);

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
  // NOTE: walkthroughRisk is deliberately NOT restored here — it isn't part of
  // the persisted session shape (loadWalkthroughSession), so a resume lands
  // back on a risk-flagged instance with risk undefined, and its Confirm step
  // falls back to the non-tap path unless requireExplicitAdvance is also true.
  // Acceptable for this pass (Confirm only ships on add_prescription_auto,
  // whose fill steps take seconds, not enough to realistically resume across),
  // but a real gap if a future *_auto flow's fill takes long enough to resume.
  useEffect(() => {
    const session = loadWalkthroughSession("elder", elderId);
    if (session) {
      setWalkthroughTask(session.taskName);
      setWalkthroughStepIndex(session.stepIndex);
      setWalkthroughParams(session.params ?? {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const walkthroughSteps = walkthroughTask ? resolveWalkthroughSteps(walkthroughTask, "elder", walkthroughParams) : [];

  // Returns null when the walkthrough started, or a translation key explaining
  // why it did not. Every refusal used to be console.warn-only, so Mei said "I'll
  // show you now" and then absolutely nothing happened — indistinguishable from
  // the app being broken, and the single most confusing failure this shell had.
  // The chat screen renders the reason instead.
  const handleWalkthroughStart = (
    taskName: WalkthroughTaskName,
    params: WalkthroughParams = {},
    risk?: WalkthroughRisk,
  ): string | null => {
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
      return null;
    }
    // The request_refill walkthrough spotlights the per-card Request-refill
    // button, which only exists on a LOW card (lib/medications.ts::isRunningLow;
    // a medication with no refills row defaults to 30/30). With nothing low it
    // has nothing to point at. Ask Mei's own row already gates on this — the
    // chat path did not, so Mei could start a tour that dead-ends immediately.
    if (taskName === "request_refill" && !anyMedicationRunningLow(patient.medications)) {
      console.warn("[dosewise] walkthrough \"request_refill\" needs a medication running low — not starting it");
      return "walk.refused.nothingLow";
    }
    // Same shape again, and NEW as of the alerts work: the Reminders row this
    // tour spotlights (notif-refill-row / notif-ack-btn) used to be a hardcoded
    // demo card that was always present. It is real data now, so an elder with
    // nothing outstanding has no card to point at.
    // `medsLoaded &&` is load-bearing: without it the tour is refused during
    // the window before the first fetch resolves, i.e. we'd claim "nothing to
    // show" for someone who does have alerts. Refuse only when we KNOW the tab
    // is empty. (s19 seeds real low stock and starts this tour before its own
    // wait-for-the-card step, so it races exactly this window.)
    if (taskName === "notifications_tour" && medsLoaded && liveAlerts.length === 0) {
      console.warn("[dosewise] walkthrough \"notifications_tour\" needs something on the Reminders tab — not starting it");
      return "walk.refused.nothingToShow";
    }
    // Same shape as the refill gate above: this tour ends on a CONSENT tap of
    // the emergency-contact Call button, which only renders when a caregiver is
    // actually linked. Offering the tour without one points at nothing.
    if (taskName === "emergency_contact_tour" && hasCaregiver === false) {
      console.warn("[dosewise] walkthrough \"emergency_contact_tour\" needs a linked caregiver — not starting it");
      return "walk.refused.noCaregiver";
    }
    // Shell guard. Hermes offers every task name to both shells with no role
    // filter, so an elder can be offered a caregiver-only tour — whose very
    // first target can never exist here. Decline honestly instead of mounting
    // an overlay that would spotlight nothing.
    const shell = walkthroughShellFor(taskName, "elder");
    if (shell && shell !== "elder") {
      console.warn(`[dosewise] walkthrough "${taskName}" targets the ${shell} shell — not starting it in the elder view`);
      return "walk.refused.wrongShell";
    }
    // Put the screens a walkthrough needs into the state its FIRST step assumes.
    // Every step's onEnter can only switch bottom-nav tabs, so a screen already
    // mounted in some other internal state (Ask Mei showing the conversation
    // rather than the help tiles, Settings sitting inside a sub-page) never
    // resets — and the tour's opening target simply doesn't exist. Chat is
    // exactly where a walkthrough is started from, so this was the common case,
    // not an edge one.
    setScreenResetSignal(n => n + 1);
    setWalkthroughTask(taskName);
    setWalkthroughStepIndex(0);
    setWalkthroughParams(params);
    setWalkthroughRisk(risk);
    saveWalkthroughSession("elder", elderId, { taskName, stepIndex: 0, startedAt: Date.now(), params });
    return null;
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
      fetchDoctorQuestions,
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

  // The dev hook below registers ONCE (empty deps, deliberately — see App.tsx's
  // note on the window-property race), so it would capture the FIRST render's
  // handleWalkthroughStart and with it that render's `hasCaregiver` (false) and
  // `patient` (the pre-hydration fixture). Every gate in it would then answer
  // from stale data forever: emergency_contact_tour refused even with a linked
  // caregiver, request_refill judged against the wrong medication list. Route
  // the hook through a ref that tracks the latest closure instead. The real
  // production path is unaffected — the chat gets this as a prop each render.
  const startWalkthroughRef = useRef(handleWalkthroughStart);
  useEffect(() => { startWalkthroughRef.current = handleWalkthroughStart; });

  // Dev-only deterministic trigger so an e2e drive can start an autonomous
  // walkthrough without depending on the LLM choosing start_walkthrough. The
  // optional 3rd arg (Item 2, TrustMode verification) lets a live drive force
  // a risk-flagged instance without depending on RiskClassifier actually
  // flagging real params through a live Hermes turn — proving the CLIENT
  // wiring (does risk still force a tap on a veteran account?) independent of
  // the server-side classifier, which is verified separately.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    type Hook = (t: string, p?: WalkthroughParams, risk?: WalkthroughRisk) => void;
    (window as unknown as { __dwStartWalkthrough?: Hook }).__dwStartWalkthrough = (task, params, risk) =>
      startWalkthroughRef.current(task as WalkthroughTaskName, params ?? {}, risk);
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
      // An AUTONOMOUS walkthrough is not a one-time introduction — it is how the
      // write is performed — so it never joins the "already shown" list. Hermes
      // subtracts AUTONOMOUS_TASKS from completed_walkthroughs anyway (that is
      // the load-bearing fix), but recording them here would keep growing the
      // stored list with entries that mean nothing and hand the same category
      // error to the next reader of this column.
      if (elderId && !AUTONOMOUS_TASKS.has(walkthroughTask)) void markWalkthroughCompleted(elderId, "elder", walkthroughTask);
      // TrustMode (Item 2, decision E): a DIFFERENT "completed" concept from
      // markWalkthroughCompleted above — a plain device-local tally of ANY
      // finished walkthrough (autonomous ones included), so it deliberately
      // is NOT gated on AUTONOMOUS_TASKS the way that call is.
      incrementWalkthroughCompletionCount();
      clearWalkthroughSession("elder", elderId);
      setWalkthroughTask(null);
      setWalkthroughStepIndex(0);
      return;
    }
    const next = walkthroughStepIndex + 1;
    setWalkthroughStepIndex(next);
    // `params` MUST ride along. Dropping it here (the start-save above carries
    // it) meant a mid-run remount rebuilt the steps from the builder DEFAULTS —
    // so a walkthrough adding "Lisinopril 10mg" silently resumed as
    // "Metformin 500mg", and then Verify checked for a medicine nobody asked for.
    saveWalkthroughSession("elder", elderId, { taskName: walkthroughTask, stepIndex: next, startedAt: Date.now(), params: walkthroughParams });
  };

  // Step back one, for when something went wrong on the step just finished.
  // The overlay only offers this where lib/walkthrough/gating.ts::canGoBack
  // agrees (never across a committed write, never back into a click act), so
  // this side just moves the index — and persists it the same way the advance
  // path does, params included, so a mid-run remount lands on the same step.
  const handleWalkthroughBack = () => {
    if (!walkthroughTask || walkthroughStepIndex <= 0) return;
    const prev = walkthroughStepIndex - 1;
    setWalkthroughStepIndex(prev);
    saveWalkthroughSession("elder", elderId, { taskName: walkthroughTask, stepIndex: prev, startedAt: Date.now(), params: walkthroughParams });
  };

  // Exiting/skipping clears client state only — nothing is ever written back
  // for an abandoned walkthrough, only genuine completion (above).
  const handleWalkthroughExit = () => {
    clearWalkthroughSession("elder", elderId);
    setWalkthroughTask(null);
    setWalkthroughStepIndex(0);
  };

  // IdleTimeout (Item 6) "Talk to Mei": exit first (the overlay would
  // otherwise sit on top of the chat sheet it's supposed to hand off to,
  // same reason a walkthrough start closes the chat sheet elsewhere), then
  // land on Ask Mei's chat. openAI() with no message, NOT openAIPrefill —
  // this must not spend a real turn or risk Mei launching another
  // walkthrough on top of the one just exited.
  //
  // pendingChatView is what makes it land on the CONVERSATION. Exiting +
  // switching tabs alone was not enough: Ask Mei seeds its view from the
  // restored thread, and someone who launched the walkthrough from the help
  // tiles has no thread to restore — so a button reading "Talk to Mei"
  // reliably showed the category tiles instead of Mei.
  const handleWalkthroughTalkToMei = () => {
    handleWalkthroughExit();
    setPendingChatView(true);
    openAI();
  };
  // Bumped when a doctor_message change is highlighted, so the Reminders screen
  // opens its doctor tab and the highlight has a card to land on.
  const [openQuestionsSignal, setOpenQuestionsSignal] = useState(0);
  const [doctorQuestions, setDoctorQuestions] = useState<DoctorQ[]>([
    { id: "seed-1", question: "Can I take Celecoxib and Metformin at the same time?",           addedAt: "", source: "agent", answered: false, i18nKey: "ai.demoQ1" },
    { id: "seed-2", question: "Is it normal to feel a little dizzy after taking Amlodipine?",  addedAt: "", source: "agent", answered: false, i18nKey: "ai.demoQ2" },
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
    if (!elderId) return;
    void hasActiveCareLink(elderId).then(setHasCaregiver);
  }, [elderId, tab]);

  // Pending caregiver link requests are fetched HERE rather than inside the
  // Reminders screen, because the badge and the urgent popup both need to know
  // about them while that tab is closed — which is precisely when an
  // unanswered consent request matters.
  useEffect(() => {
    if (!elderId) return;
    void fetchPendingLinkRequests(elderId).then(setLinkRequests);
  }, [elderId, tab]);

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
    // Pass the TAPPED card's own slot so a medication with more than one
    // pending dose today flips the one the elder actually tapped, not
    // whichever is latest — found live, Phase-4 spot-check of scenario s03.
    if (elderId && med?.medicationId) logDoseTaken(med.medicationId, elderId, to24h(med.time));
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
      ? await addMedication(elderId, {
          name: med.name, dosage: med.dose, purpose: med.purpose, timeHHMMs,
          refillDays: med.refillDaysLeft, days: med.days, intervalDays: med.intervalDays,
          endDate: med.endDate,
        })
      : undefined;
    onUpdatePatient({ ...patient, medications: [...patient.medications, { ...med, id: nextId, medicationId, status: "upcoming" as MedStatus }] });
    flagJustAdded(med.name);
  };

  // Retires a medicine whose fixed course has run out, from the card's own
  // "Move to past medicines" button. Uses the same archive write
  // discontinue_medication makes — never a delete, and never automatic: the
  // course ending stops the DOSES (isDueOn), but leaving the active list is the
  // person's own call.
  const handleArchivePrescription = async (med: GroupedMed) => {
    if (!elderId || !med.medicationId) return;
    await archiveMedication(med.medicationId);
    await refreshMeds();
  };

  // Saves an edit from a medication card's detail popup. Real, Supabase-backed
  // medications (medicationId set) go through updateMedication + a refetch, so
  // the schedule/refill logic reads back exactly as Hermes would see it; local
  // demo/seed data (no medicationId) has nothing to update server-side, so its
  // per-time-slot rows are rebuilt in place instead.
  const handleEditPrescription = async (original: GroupedMed, med: Omit<Medication, "id" | "status"> & { times?: string[] }) => {
    const timeHHMMs = (med.times && med.times.length ? med.times : [med.time]).map(t => to24h(t));
    if (elderId && original.medicationId) {
      await updateMedication(original.medicationId, {
        name: med.name, dosage: med.dose, purpose: med.purpose, timeHHMMs,
        days: med.days, intervalDays: med.intervalDays, endDate: med.endDate,
      });
      await refreshMeds();
    } else {
      const key = original.medicationId ?? original.name;
      const others = patient.medications.filter(m => (m.medicationId ?? m.name) !== key);
      let nextId = patient.medications.reduce((max, m) => Math.max(max, m.id), 0);
      const rows: Medication[] = timeHHMMs.map((time, i) => ({
        ...original, name: med.name, dose: med.dose, purpose: med.purpose, time,
        days: med.days, intervalDays: med.intervalDays, endDate: med.endDate,
        id: i === 0 ? original.id : ++nextId,
      }));
      onUpdatePatient({ ...patient, medications: [...others, ...rows] });
    }
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
    // Only now is it safe to reason about supply — see medsLoaded's own note.
    setMedsLoaded(true);
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

  // Persists for real (doctor_questions, RLS as the elder) so the question
  // survives a reload and an autonomous walkthrough can VERIFY it landed. Falls
  // back to a local-only row if there's no signed-in elder or the write fails,
  // rather than dropping what they typed.
  const handleAddDoctorQ = async (q: string) => {
    const local: DoctorQ = {
      id: `local-${Date.now()}`, question: q,
      addedAt: new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" }),
      source: "elder",
      answered: false,
    };
    const saved = elderId ? await createDoctorQuestion(elderId, q) : null;
    setDoctorQuestions(prev => [saved ?? local, ...prev]);
  };

  const NAV: { id: ElderlyTab; icon: any; label: string; fab?: boolean }[] = [
    { id: "home",          icon: Home,        label: t(language, "nav.home") },
    { id: "prescriptions", icon: Pill,        label: t(language, "nav.medications") },
    { id: "ai",            icon: Brain,       label: t(language, "nav.askMei"), fab: true },
    { id: "notifications", icon: Bell,        label: t(language, "nav.notifications") },
    { id: "settings",      icon: Settings,    label: t(language, "nav.settings") },
  ];

  return (
    <div className="flex flex-col h-full bg-background dw-app-bg">
      {/* Status bar — the shared component, not a copy. This shell used to
          carry a hand-inlined duplicate, which meant the app's PRIMARY surface
          silently kept the old bar whenever the component was restyled. */}
      <LiveStatusBar timeFormat={timeFormat} />

      {/* Header — app name centred, help and profile in the corners. The screen
          title moved into each screen, so this bar stays one constant, always
          recognisable anchor rather than text that changes under you. */}
      <div className="px-3 py-1 bg-background/70 backdrop-blur-md border-b border-border/50 shrink-0">
        {headerOverride ? (
          <div className="flex items-center gap-2.5">
            <button
              onClick={headerOverride.onBack}
              aria-label={t(language, "common.back")}
              className="w-11 h-11 rounded-full bg-card border border-border flex items-center justify-center shrink-0 active:bg-muted transition-colors"
            >
              <ChevronLeft size={22} className="text-foreground" />
            </button>
            <h1 className="flex-1 min-w-0 truncate text-[calc(19px*var(--dw-text,1))] font-bold text-foreground">{headerOverride.title}</h1>
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
            <h1 className="font-['Fraunces'] text-[calc(25px*var(--dw-text,1))] font-semibold tracking-tight text-primary leading-none">Dosewise</h1>
            <button
              onClick={() => setTab("settings")}
              aria-label={t(language, "header.profile")}
              className="w-11 h-11 rounded-full overflow-hidden border-2 border-primary/30 shrink-0 active:opacity-80 transition-opacity"
            >
              <ProfileAvatar photo={patient.photo} size={44} />
            </button>
          </div>
        )}
      </div>

      {/* Screen content */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col" style={{ zoom: contentZoom } as React.CSSProperties}>
        {tab === "home"          && <ElderlyHomeScreen         patient={patient} elderId={elderId} onLogDose={handleLogDose} onUnlogDose={handleUnlogDose} onOpenTravel={() => setShowTravel(true)} justAddedMed={justAddedMed} onAskMei={openAIPrefill} />}
        {tab === "prescriptions" && <ElderlyPrescriptionScreen patient={patient} onAddRx={() => setAddRx("manual")} onRequestRefill={name => openAIPrefill(t(language, "ai.refillRequestMsg", { name }))} onEditRx={med => { setEditingMed(med); setAddRx("manual"); }} onArchiveRx={handleArchivePrescription} justAddedMed={justAddedMed} highlightIds={highlightEntityIds} />}
        {tab === "ai"            && (
          <ElderlyAIScreen
            patient={patient}
            elderId={elderId}
            onNavigate={setTab}
            onMedsChanged={refreshMeds}
            onMedAdded={flagJustAdded}
            onHighlightChange={setHighlightChange}
            onAgentAlert={handleAgentAlert}
            onOpenTravel={() => setShowTravel(true)}
            autoMessage={pendingAIMessage}
            prefillMessage={pendingPrefill}
            onAutoMessageConsumed={() => setPendingAIMessage(undefined)}
            onPrefillConsumed={() => setPendingPrefill(undefined)}
            openChatView={pendingChatView}
            onOpenChatViewConsumed={() => setPendingChatView(false)}
            onWalkthroughStart={handleWalkthroughStart}
            onHeaderOverride={setHeaderOverride}
            // "Is a guided overlay on screen RIGHT NOW", not "has one ever
            // started" — see the prop's own comment in ElderlyAIScreen. Both
            // overlays need this screen showing its help tiles: the autonomous
            // walkthrough spotlights the category rows, and the passive tour's
            // Ask-Mei step spotlights [data-tour="elder-quickhelp"], which only
            // exists in the help view.
            guidedViewActive={walkthroughTask !== null || showTour}
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
            walkthroughResetSignal={screenResetSignal}
            alerts={liveAlerts}
            onAcknowledgeAlert={id => setAcknowledgedAlerts(prev => new Set(prev).add(id))}
            onRequestRefill={name => openAIPrefill(t(language, "ai.refillRequestMsg", { name }))}
            linkRequests={linkRequests}
            onLinkRequestsChanged={() => { if (elderId) void fetchPendingLinkRequests(elderId).then(setLinkRequests); }}
          />
        )}
        {tab === "settings"      && <ElderlySettingsScreen     patient={patient} elderId={elderId} onUpdatePatient={onUpdatePatient} onSignOut={onSignOut} onHeaderOverride={setHeaderOverride} walkthroughResetSignal={screenResetSignal} />}
      </div>

      {/* Bottom nav — z-40 keeps it (and the Ask Mei FAB peeking above it) painting
          over any scrolled content behind it, regardless of that content's own layout. */}
      {/* Row is items-END so every control shares one baseline: the FAB's
          negative margin then only controls how far it rises above the bar, not
          where it sits in it (with items-center it drifted a few px high). Five
          flex-1 columns keep the spacing exactly equal. */}
      <div className="relative z-40 shrink-0 bg-background dw-shadow-up border-t border-border/60 px-3 pt-4 pb-6">
        <div className="flex items-end">
          {NAV.map(item => {
            const isActive = tab === item.id;
            if (item.fab) {
              return (
                <div key={item.id} className="relative z-40 flex-1 flex justify-center">
                  <button onClick={() => setTab(item.id)} data-tour={`nav-${item.id}`} aria-label={item.label} aria-current={isActive ? "page" : undefined} className={`relative z-40 w-16 h-16 rounded-full flex items-center justify-center -mt-6 -top-1 dw-float dw-press bg-gradient-to-br from-primary to-accent ${isActive ? "ring-4 ring-accent/40" : ""}`}>
                    <Brain size={30} className="text-primary-foreground" />
                  </button>
                </div>
              );
            }
            return (
              <button key={item.id} onClick={() => setTab(item.id)} data-tour={`nav-${item.id}`} aria-label={item.label} aria-current={isActive ? "page" : undefined} className="flex-1 min-w-0 flex justify-center">
                {/* Active state pops the icon up a size and colours both the
                    icon and its label, so "where am I" reads at a glance. */}
                <div className="w-16 h-12 flex flex-col items-center justify-end gap-1">
                  {/* Count of things still waiting on this person. Urgent ones
                      recolour it, so the badge distinguishes "you have mail"
                      from "you are out of a critical medicine".

                      It OVERLAPS the bell's top-right corner on purpose — that
                      is the conventional badge, and it is what was asked for.
                      An earlier pass read "the number overlaps the bell" as
                      "remove the overlap" and pushed it fully clear with
                      bottom-full; the result read as a detached number floating
                      above the tab. Do not "fix" the overlap again. The corner
                      is where a Bell glyph has whitespace (its dome curves away
                      from x>22), so the digits sit beside the ink, not on it,
                      and ring-2 keeps a hard edge between the two.

                      Anchored to the ICON's own wrapper, not to the column: the
                      active tab's glyph is scale-125 and grows from its centre,
                      so a column-anchored badge shifts relative to the icon
                      exactly when the tab is selected. The wrapper is not
                      scaled, so the offset is constant in both states. */}
                  <span className="relative inline-flex">
                    {item.id === "notifications" && liveAlerts.length > 0 && (
                      <span
                        aria-label={t(language, "alerts.badgeLabel", { count: liveAlerts.length })}
                        className={`absolute -top-1.5 -right-2.5 min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center text-[calc(10px*var(--dw-text,1))] font-bold text-white ring-2 ring-background ${
                          urgentCount > 0 ? "bg-missed-fg" : "bg-primary"
                        }`}
                      >
                        {liveAlerts.length > 99 ? "99+" : liveAlerts.length}
                      </span>
                    )}
                    <item.icon size={26} className={`transition-all duration-150 ${isActive ? "text-primary scale-125" : "text-muted-foreground/70 scale-100"}`} />
                  </span>
                  <span className={`text-[calc(10px*var(--dw-text,1))] font-medium leading-none transition-colors ${isActive ? "text-primary" : "text-muted-foreground/70"}`}>{item.label}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {addRx && (
        <AddPrescriptionSheet
          initialTab={addRx}
          editing={editingMed ?? undefined}
          routine={{ ...patient.mealTimes, sleepTime: patient.sleepTime }}
          // So an autonomous run can CLICK a real control for a course length
          // outside the sheet's three presets, instead of snapping to the
          // nearest one and quietly changing what the doctor prescribed.
          // Renders an extra preset only; nothing is pre-selected, so Mei still
          // performs the taps in view.
          initialDurationDays={Number.parseInt(walkthroughParams.duration_days ?? "", 10) || undefined}
          onClose={() => { setAddRx(null); setEditingMed(null); }}
          onAdd={med => editingMed ? handleEditPrescription(editingMed, med) : handleAddPrescription(med)}
          onAdded={() => { setEditingMed(null); if (!walkthroughTask) setTab("prescriptions"); }}
          onAgentAdded={(name?: string) => { void refreshMeds(); flagJustAdded(name); setTab("prescriptions"); }}
          // SpotlightVisual-Fix's hook point, wired (Item 5): the walkthrough's
          // OWN Confirm phase already risk-gated and tapped through the SAME
          // dosage-jump signal this dialog would otherwise re-ask about, so a
          // THIRD confirm on one write is redundant. Narrow on purpose — keyed
          // on "dosage_jump" specifically (not risk.flagged broadly), since
          // most add_prescription_auto risk flags are "unknown_medication"
          // (any brand-new drug, by construction) and have nothing to do with
          // THIS dialog's own trigger. Never suppressed on the direct-UI path
          // (walkthroughTask unset there), which stays this dialog's only net.
          suppressDoseConfirm={walkthroughTask === "add_prescription_auto" && !!walkthroughRisk?.signals.includes("dosage_jump")}
        />
      )}
      {showTravel && (
        <TravelModeSheet
          patient={patient}
          elderId={elderId}
          onClose={() => setShowTravel(false)}
          onSaved={plan => onUpdatePatient({ ...patient, travelPlan: plan })}
        />
      )}
      {popupAlert && (
        <UrgentAlertPopup
          alert={popupAlert}
          onDismiss={dismissPopupAlert}
          // "Show me" is offered only when there is somewhere specific to land.
          onView={() => {
            const target = popupAlert.kind === "low_supply" || popupAlert.kind === "out_of_supply"
              ? "prescriptions" as const
              : "notifications" as const;
            dismissPopupAlert();
            setTab(target);
          }}
          onTalkToMei={() => {
            const alert = popupAlert;
            dismissPopupAlert();
            openAIPrefill(t(language, alert.titleKey, alert.params));
          }}
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
          onBack={handleWalkthroughBack}
          onExit={handleWalkthroughExit}
          onVerify={handleWalkthroughVerify}
          onReveal={handleWalkthroughReveal}
          onVerifyFailed={handleWalkthroughVerifyFailed}
          risk={walkthroughRisk}
          requireExplicitAdvance={requireExplicitAdvance}
          // AutoNav starts on unless the person explicitly asked to be walked
          // through step by step — the trust signal above still decides the
          // Confirm recap's tap, but where the callout's switch STARTS is a
          // stated preference, not an inferred one.
          autoNavDefault={!walkthroughManualMode}
          onTalkToMei={handleWalkthroughTalkToMei}
        />
      )}
      {showTourConfirm && (
        <ConfirmDialog
          title={t(language, "confirm.replayTourTitle")}
          body={t(language, "confirm.replayTourBodyElder")}
          confirmLabel={t(language, "confirm.replay")}
          // Same preparation handleWalkthroughStart does, and for the same
          // reason: several tour steps spotlight targets that only exist when
          // a screen is on its HUB (Settings' font-size/language/QR rows) —
          // replaying from a sub-page pointed them at nothing. The chat screen
          // is handled separately, by guidedViewActive.
          onConfirm={() => { setShowTourConfirm(false); setScreenResetSignal(n => n + 1); setShowTour(true); }}
          onCancel={() => setShowTourConfirm(false)}
        />
      )}
    </div>
  );
}
