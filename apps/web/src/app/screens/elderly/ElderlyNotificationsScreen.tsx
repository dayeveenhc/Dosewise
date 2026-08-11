import { useEffect, useState } from "react";
import { MessageSquare, User, ShieldQuestion, Check, X, Loader2, Plus, Trash2, Circle, Brain, AlertTriangle, CornerUpLeft, Send, Stethoscope, RefreshCw, ArrowRight } from "lucide-react";
import type { Message } from "../../types";
import type { DoctorQ } from "./types";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";
import { respondToLinkRequest, type PendingLinkRequest } from "../../lib/careLinks";
import { canViewAlert, canTellCaregiver, type Alert } from "../../lib/alerts";
import { emitWalkthroughEvent } from "../../lib/walkthrough/bus";

export function ElderlyNotificationsScreen({ careMessages, elderId, doctorQuestions, onAddDoctorQ, onMarkAnswered, onDeleteQuestion, onDismissMessage, onReplyMessage, openQuestionsSignal, walkthroughResetSignal, alerts = [], onAcknowledgeAlert, onRequestRefill, onAlertNavigate, onTellCaregiver, linkRequests, onLinkRequestsChanged }: {
  careMessages: Message[];
  elderId?: string;
  // Questions for the doctor moved here from the Ask Mei screen: this tab is
  // now the one place everything waiting on the elder lives, so Ask Mei could
  // drop its tab switcher and become a pure list of things Mei can do.
  doctorQuestions: DoctorQ[];
  onAddDoctorQ: (q: string) => void;
  onMarkAnswered: (id: string) => void;
  onDeleteQuestion: (id: string) => void;
  onDismissMessage: (id: number) => void;
  onReplyMessage: (id: number, text: string) => void;
  // Bumped by the host to force the doctor tab open — a doctor_message
  // ChangeHighlight has to be able to reach its card even if Messages is
  // showing. Ignore the initial 0 so it can't steal focus on mount.
  openQuestionsSignal?: number;
  // Bumped when a walkthrough starts. notifications_tour's step 2 points at the
  // demo low-stock row and its step 3 DISMISSES it, so replaying the tour used
  // to dead-end on its own previous run. Restore the row (and the Messages tab
  // the tour opens on) so it can be shown again.
  walkthroughResetSignal?: number;
  // Everything outstanding, most severe first — computed ONCE by the host
  // (lib/alerts.ts) and shared with the nav badge and the urgent popup, so the
  // three surfaces cannot disagree or report the same thing three times.
  alerts?: Alert[];
  onAcknowledgeAlert?: (id: string) => void;
  onRequestRefill?: (medName: string) => void;
  // Takes the person to the thing the alert is ABOUT — the medicine's card, the
  // missed dose on the timeline. The host owns the routing (ElderlyApp's
  // goToAlert → lib/alerts.ts::destinationFor), so this screen only decides
  // whether to offer it, via the same canViewAlert the popup uses.
  onAlertNavigate?: (alert: Alert) => void;
  // The "what do I do next" half: hands the alert to Mei as a ready-to-send
  // message about telling the caregiver. Prefill, never auto-send.
  onTellCaregiver?: (alert: Alert) => void;
  // Pending link requests are fetched by the host now (the badge and popup need
  // them while this tab is closed), so this screen renders what it is given.
  linkRequests?: PendingLinkRequest[];
  onLinkRequestsChanged?: () => void;
}) {
  const { language } = useLanguage();
  const requests = linkRequests ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [showQInput, setShowQInput] = useState(false);
  const [newQ, setNewQ] = useState("");
  const [replyingTo, setReplyingTo] = useState<number | null>(null);
  const [replyText, setReplyText] = useState("");
  const [tab, setTab] = useState<"messages" | "questions">("messages");

  useEffect(() => {
    if (openQuestionsSignal) setTab("questions");
  }, [openQuestionsSignal]);

  useEffect(() => {
    if (!walkthroughResetSignal) return;
    // Close the question composer (add_doctor_question_auto opens it itself,
    // and its step targets the Add button, which only exists while it's shut).
    // Deliberately does NOT restore a dismissed alert. These are real now, not
    // a demo row: an alert the person acknowledged must not be resurrected by
    // replaying a tour. Replaying with nothing outstanding is instead refused at
    // dispatch by ElderlyApp (walk.refused.nothingToShow), which is an honest
    // answer rather than a tour spotlighting a card that isn't there.
    //
    // Deliberately does NOT touch `tab`: a ChangeHighlight can navigate here and
    // open the Questions tab (openQuestionsSignal) in the same beat a
    // walkthrough starts, and forcing Messages back would unmount the very card
    // the highlight is trying to ring. The tour's own anchors don't need it —
    // the demo alert sits ABOVE the tab strip, and the doctor-question flow
    // clicks its tab itself.
    setShowQInput(false);
  }, [walkthroughResetSignal]);


  // Link requests and caregiver messages already have their own dedicated
  // sections below — rendering them again as generic cards would report the
  // same thing twice on one screen. They stay in `alerts` for the badge and the
  // popup, which have no such section.
  const cardAlerts = alerts.filter(a => a.kind !== "care_link_request" && a.kind !== "care_message");
  // notifications_tour's anchors ride the first SUPPLY alert (what it narrates),
  // falling back to the first card of any kind — so they exist whenever any card
  // does. The tour only ever touches notif-refill-row and notif-ack-btn, both of
  // which every card renders; notif-request-refill-btn is supply-only and is
  // spotlighted by nothing.
  const anchorIndex = Math.max(0, cardAlerts.findIndex(a => a.kind === "low_supply" || a.kind === "out_of_supply"));

  const respond = async (id: string, accept: boolean) => {
    setBusy(id);
    const ok = await respondToLinkRequest(id, accept);
    setBusy(null);
    if (ok) {
      onLinkRequestsChanged?.();
      // Gated on the real, RLS-enforced write actually succeeding — never the
      // Accept button's click, and never `busy` clearing (that happens on
      // both the accept and the failure branch). Per supabase/migrations/
      // 0005_care_links_consent_hardening.sql, this is the ONLY code path
      // that can ever activate a care_links row — the walkthrough must ride
      // its real result, not simulate or assume it.
      if (accept) emitWalkthroughEvent("care-link-activated");
    }
  };

  // Demo/seed messages carry a key prefix so their role/body/time follow the
  // language setting; anything real (a caregiver's actual message) has no key
  // and renders exactly as written.
  const localized = (msg: Message, field: "role" | "body" | "time") =>
    msg.i18nKey ? t(language, `${msg.i18nKey}.${field}`) : msg[field];

  const sendReply = (id: number) => {
    const text = replyText.trim();
    if (!text) return;
    onReplyMessage(id, text);
    setReplyText("");
    setReplyingTo(null);
  };

  // Split on the STRUCTURED source, never on searching the label for "Mei" —
  // that string-sniff meant localizing the label silently dropped every question
  // into the manual list.
  const flagged  = doctorQuestions.filter(q => !q.answered && q.source === "agent");
  const manual   = doctorQuestions.filter(q => !q.answered && q.source !== "agent");
  // "Added by Mei · 14:05" / "Added · Today", composed here so both halves are
  // in the person's language. An unparseable timestamp yields just the prefix.
  // Seeded demo questions carry a key so they follow the language setting; a
  // real one (typed by the person, or queued by Mei) renders as written.
  const questionText = (q: DoctorQ) => (q.i18nKey ? t(language, q.i18nKey) : q.question);
  const addedLabel = (q: DoctorQ) =>
    [t(language, q.source === "agent" ? "ai.addedByMei" : "ai.added"), q.addedAt]
      .filter(Boolean).join(" · ");
  const answered = doctorQuestions.filter(q => q.answered);

  const qActions = (q: DoctorQ) => (
    <div className="flex gap-2 mt-3">
      <button onClick={() => onMarkAnswered(q.id)} className="flex-1 h-12 rounded-xl bg-primary/10 text-[calc(14px*var(--dw-text,1))] font-bold text-primary active:opacity-80 transition-opacity">
        {t(language, "ai.askedMark")}
      </button>
      <button onClick={() => onDeleteQuestion(q.id)} aria-label={t(language, "common.delete")} className="w-12 h-12 rounded-xl bg-destructive/10 text-destructive flex items-center justify-center shrink-0 active:opacity-80 transition-opacity">
        <Trash2 size={18} />
      </button>
    </div>
  );

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex-1 overflow-y-auto scrollbar-none px-4 pb-28 pt-3 space-y-3">
        {/* Caregiver access requests sit ABOVE the tabs and are never hidden by
            one: granting someone access to your medications is the single most
            consequential thing on this screen. */}
        {requests.length > 0 && (
          <div className="space-y-3">
            <p className="text-[calc(13px*var(--dw-text,1))] font-bold text-primary uppercase tracking-wider px-1">{t(language, "notifications.accessRequests")}</p>
            {requests.map(req => (
              <div key={req.id} className="bg-card rounded-2xl border-2 border-primary/40 p-4">
                <div className="flex items-center gap-3 mb-2.5">
                  <div className="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <ShieldQuestion size={20} className="text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[calc(17px*var(--dw-text,1))] font-bold text-foreground break-words leading-tight">{req.caregiverName}</p>
                    <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground">{req.relationship || t(language, "link.reqDefaultRelation")}</p>
                  </div>
                </div>
                <p className="text-[calc(15px*var(--dw-text,1))] text-foreground leading-relaxed mb-3">
                  {t(language, "link.reqBody", { name: req.caregiverName })}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => respond(req.id, true)}
                    disabled={busy === req.id}
                    data-walk={`care-link-accept-${req.id}`}
                    className="flex-1 bg-primary text-primary-foreground rounded-xl py-3 text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-2 disabled:opacity-40"
                  >
                    {busy === req.id ? <Loader2 size={19} className="animate-spin" /> : <Check size={19} />}
                    {t(language, "link.accept")}
                  </button>
                  <button
                    onClick={() => respond(req.id, false)}
                    disabled={busy === req.id}
                    className="flex-1 bg-muted text-foreground rounded-xl py-3 text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-2 disabled:opacity-40"
                  >
                    <X size={19} />{t(language, "link.decline")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Real, data-driven alerts — this used to be a hardcoded "Metformin,
            4 days" literal. Sits above the tabs so nothing urgent can be hidden
            behind one, and so notifications_tour's anchors are on screen from
            its first step. Those anchors ride the FIRST supply alert (or the
            first alert of any kind), rather than a fixed medicine, so the tour
            still has something to point at whatever the person's real data is —
            and the host refuses to start it at all when there is nothing here.

            Severity is carried by border + icon + text as well as background:
            under .contrast-max every *-bg token collapses to white, so a
            tint-only tier would silently read as no tier at all. */}
        {cardAlerts.map((alert, i) => {
          const critical = alert.severity === "critical";
          const supply = alert.kind === "low_supply" || alert.kind === "out_of_supply";
          const isTourAnchor = i === anchorIndex;
          return (
            <div
              key={alert.id}
              data-walk={isTourAnchor ? "notif-refill-row" : undefined}
              data-testid={alert.medicationId ? `alert-${alert.medicationId}` : undefined}
              className={`rounded-2xl border-2 p-4 ${
                critical ? "border-missed-border bg-missed-bg"
                  : alert.severity === "urgent" ? "border-warn-border bg-warn-bg"
                    : "border-border bg-card"
              }`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-9 h-9 rounded-full bg-card flex items-center justify-center shrink-0">
                  {critical
                    ? <AlertTriangle size={15} className="text-missed-fg" strokeWidth={2.5} />
                    : <RefreshCw size={15} className="text-warn-fg" />}
                </div>
                <p className={`text-[calc(15px*var(--dw-text,1))] font-bold flex-1 ${critical ? "text-missed-fg" : "text-warn-fg"}`}>
                  {t(language, alert.titleKey, alert.params)}
                </p>
              </div>
              <p className={`text-[calc(15px*var(--dw-text,1))] leading-relaxed mb-3 ${critical ? "text-missed-fg/90" : "text-warn-fg/90"}`}>
                {t(language, alert.bodyKey, alert.params)}
              </p>
              {/* Two rows of two rather than one row of four: on a 390px frame
                  at the largest text size, four flex-1 buttons are unreadable.
                  Row A is "where do I go / what do I do next" and only renders
                  when the alert actually offers one of them; row B is the
                  original acknowledge pair, untouched — notifications_tour
                  auto-clicks notif-ack-btn inside it.

                  Deliberately buttons, NOT a click handler on the card: the row
                  already contains controls, and a button cannot live inside a
                  button (same reason as ElderlyHomeScreen's missed-dose row).
                  steps/notifications_tour.ts documents the container as
                  click-less and pulses it instead — keep that true.

                  Both outline, not filled: "Request refill" below is the action
                  that actually RESOLVES the alert, so it stays the one solid
                  button on the card. Two competing fills would flatten that. */}
              {(canViewAlert(alert) || canTellCaregiver(alert)) && (
                <div className="flex gap-2 mb-2">
                  {canViewAlert(alert) && (
                    <button
                      onClick={() => onAlertNavigate?.(alert)}
                      className="flex-1 bg-card border border-border text-foreground rounded-xl py-2.5 text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform"
                    >
                      <ArrowRight size={16} />{t(language, "alerts.popupView")}
                    </button>
                  )}
                  {canTellCaregiver(alert) && (
                    <button
                      onClick={() => onTellCaregiver?.(alert)}
                      className="flex-1 bg-card border border-border text-foreground rounded-xl py-2.5 text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform"
                    >
                      <User size={16} />{t(language, "alerts.tellCaregiver")}
                    </button>
                  )}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => onAcknowledgeAlert?.(alert.id)}
                  data-walk={isTourAnchor ? "notif-ack-btn" : undefined}
                  className="flex-1 bg-card border border-border text-foreground rounded-xl py-2.5 text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform"
                >
                  <Check size={16} />{t(language, "notifications.dismiss")}
                </button>
                {supply && (
                  <button
                    onClick={() => {
                      const name = alert.medName ?? "";
                      if (onRequestRefill) onRequestRefill(name);
                      else onAddDoctorQ(t(language, "ai.refillRequestMsg", { name }));
                      onAcknowledgeAlert?.(alert.id);
                    }}
                    data-walk={isTourAnchor ? "notif-request-refill-btn" : undefined}
                    className={`flex-1 text-white rounded-xl py-2.5 text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform ${critical ? "bg-missed-fg" : "bg-warn-fg"}`}
                  >
                    <RefreshCw size={16} />{t(language, "prescription.requestRefill")}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        <div className="flex gap-1.5 bg-muted/70 rounded-2xl p-1.5">
          {([["messages", t(language, "notifications.tabMessages")], ["questions", t(language, "notifications.tabQuestions")]] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              data-walk={id === "questions" ? "elder-doctorq-tab" : undefined}
              aria-pressed={tab === id}
              className={`flex-1 py-2.5 rounded-xl text-[calc(15px*var(--dw-text,1))] font-bold transition-colors ${tab === id ? "bg-card text-foreground dw-shadow" : "text-muted-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>


        {tab === "messages" && (careMessages.length === 0 ? (
          <div className="dw-surface p-6 text-center">
            <MessageSquare size={32} className="text-muted-foreground mx-auto mb-2" />
            <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground">{t(language, "notifications.empty")}</p>
          </div>
        ) : careMessages.map(msg => (
          <div key={msg.id} className={`rounded-2xl border p-4 ${msg.isMe ? "bg-secondary border-primary/20" : "bg-card border-border"}`}>
            <div className="flex items-center gap-2.5 mb-2">
              <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <User size={16} className="text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[calc(17px*var(--dw-text,1))] font-bold text-foreground break-words leading-tight">{msg.author}</p>
                <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground">{localized(msg, "role")} · {localized(msg, "time")}</p>
              </div>
              <button
                onClick={() => onDismissMessage(msg.id)}
                aria-label={t(language, "notifications.dismiss")}
                className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground shrink-0 active:bg-border transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-[calc(15px*var(--dw-text,1))] text-foreground leading-relaxed">{localized(msg, "body")}</p>
            {!msg.isMe && (replyingTo === msg.id ? (
              <div className="mt-3">
                <textarea
                  autoFocus
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  placeholder={t(language, "notifications.replyPlaceholder")}
                  className="w-full bg-input-background border border-border rounded-xl px-3.5 py-3 text-[calc(15px*var(--dw-text,1))] text-foreground outline-none resize-none leading-relaxed placeholder:text-muted-foreground min-h-[72px] focus:border-primary transition-colors"
                />
                <div className="flex gap-2 mt-2">
                  <button onClick={() => sendReply(msg.id)} disabled={!replyText.trim()} className="flex-1 h-12 rounded-xl bg-primary text-primary-foreground text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-2 disabled:opacity-40">
                    <Send size={18} />{t(language, "notifications.send")}
                  </button>
                  <button onClick={() => { setReplyingTo(null); setReplyText(""); }} className="px-4 h-12 rounded-xl border border-border text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground">
                    {t(language, "common.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => { setReplyingTo(msg.id); setReplyText(""); }}
                className="mt-3 w-full h-12 rounded-xl border border-border text-[calc(15px*var(--dw-text,1))] font-bold text-foreground flex items-center justify-center gap-2 active:bg-muted transition-colors"
              >
                <CornerUpLeft size={18} />{t(language, "notifications.reply")}
              </button>
            ))}
          </div>
        )))}

        {tab === "questions" && (
        <div data-walk="elder-doctor-questions" className="space-y-3">
          {flagged.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <AlertTriangle size={17} className="text-warn shrink-0" />
                <p className="text-[calc(14px*var(--dw-text,1))] font-bold text-warn-fg">{t(language, "ai.notSureAskDoctor")}</p>
              </div>
              {flagged.map(q => (
                <div key={q.id} data-testid={`doctor_message-${q.id}`} className="bg-warn-bg border border-warn-border rounded-2xl px-4 py-3.5">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Brain size={13} className="text-warn" />
                    <p className="text-[calc(12px*var(--dw-text,1))] text-warn-fg font-bold uppercase tracking-wide">{t(language, "ai.fromChatWithMei")}</p>
                  </div>
                  <p className="text-[calc(15px*var(--dw-text,1))] text-foreground leading-relaxed">{questionText(q)}</p>
                  <p className="text-[calc(14px*var(--dw-text,1))] text-warn-fg/80 mt-1">{addedLabel(q)}</p>
                  {qActions(q)}
                </div>
              ))}
            </div>
          )}

          {/* The newest unanswered question (prepends on save — ElderlyApp's
              handleAddDoctorQ) carries its own anchor so the walkthrough's
              verify step can spotlight ONE card instead of the whole list —
              a full-list target is taller than the viewport band and the
              callout can't clear it. */}
          {manual.map((q, i) => (
            <div key={q.id} data-testid={`doctor_message-${q.id}`} {...(i === 0 ? { "data-walk": "elder-doctor-q-latest" } : {})} className="dw-surface p-4">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full border-2 border-primary/40 flex items-center justify-center shrink-0 mt-0.5">
                  <Circle size={9} className="text-primary fill-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[calc(15px*var(--dw-text,1))] text-foreground leading-relaxed">{questionText(q)}</p>
                  <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground mt-1">{addedLabel(q)}</p>
                </div>
              </div>
              {qActions(q)}
            </div>
          ))}

          {showQInput ? (
            <div className="dw-surface p-4">
              <textarea
                data-walk="elder-doctor-q-input"
                value={newQ}
                onChange={e => setNewQ(e.target.value)}
                placeholder={t(language, "ai.questionForDoctorPlaceholder")}
                className="w-full bg-input-background border border-border rounded-xl px-3.5 py-3 text-foreground text-[calc(15px*var(--dw-text,1))] outline-none resize-none leading-relaxed placeholder:text-muted-foreground min-h-[92px] focus:border-primary transition-colors"
                autoFocus
              />
              <div className="flex gap-2 mt-3">
                <button
                  data-walk="elder-doctor-q-save"
                  onClick={() => { if (newQ.trim()) { onAddDoctorQ(newQ.trim()); setNewQ(""); setShowQInput(false); } }}
                  className="flex-1 h-13 py-3.5 rounded-xl bg-primary text-primary-foreground text-[calc(15px*var(--dw-text,1))] font-bold"
                >
                  {t(language, "common.save")}
                </button>
                <button onClick={() => { setShowQInput(false); setNewQ(""); }} className="px-5 h-13 py-3.5 rounded-xl border border-border text-foreground text-[calc(15px*var(--dw-text,1))] font-semibold">
                  {t(language, "common.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <button
              data-walk="elder-add-doctor-q"
              onClick={() => setShowQInput(true)}
              className="w-full h-13 py-3.5 rounded-2xl border-2 border-dashed border-border text-muted-foreground text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-2 active:bg-muted transition-colors"
            >
              <Plus size={20} />{t(language, "ai.addOwnQuestion")}
            </button>
          )}

          {answered.length > 0 && (
            <div className="pt-1">
              <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground font-bold uppercase tracking-wider mb-2 px-1">{t(language, "ai.alreadyAsked")}</p>
              {answered.map(q => (
                <div key={q.id} data-testid={`doctor_message-${q.id}`} className="bg-muted/40 rounded-xl border border-border p-3.5 mb-2 flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-taken flex items-center justify-center shrink-0 mt-0.5">
                    <Check size={11} className="text-white" strokeWidth={3} />
                  </div>
                  <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground line-through leading-relaxed flex-1">{questionText(q)}</p>
                  <button onClick={() => onDeleteQuestion(q.id)} aria-label={t(language, "common.delete")} className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-muted-foreground active:text-destructive active:bg-destructive/10 transition-all">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
