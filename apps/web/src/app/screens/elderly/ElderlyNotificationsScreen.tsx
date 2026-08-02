import { useEffect, useState } from "react";
import { MessageSquare, User, ShieldQuestion, Check, X, Loader2, Plus, Trash2, Circle, Brain, AlertTriangle, CornerUpLeft, Send, Stethoscope, RefreshCw } from "lucide-react";
import type { Message } from "../../types";
import type { DoctorQ } from "./types";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";
import { fetchPendingLinkRequests, respondToLinkRequest, type PendingLinkRequest } from "../../lib/careLinks";
import { emitWalkthroughEvent } from "../../lib/walkthrough/bus";

export function ElderlyNotificationsScreen({ careMessages, elderId, doctorQuestions, onAddDoctorQ, onMarkAnswered, onDeleteQuestion, onDismissMessage, onReplyMessage, openQuestionsSignal, walkthroughResetSignal }: {
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
}) {
  const { language } = useLanguage();
  const [requests, setRequests] = useState<PendingLinkRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [showQInput, setShowQInput] = useState(false);
  const [newQ, setNewQ] = useState("");
  const [replyingTo, setReplyingTo] = useState<number | null>(null);
  const [replyText, setReplyText] = useState("");
  const [tab, setTab] = useState<"messages" | "questions">("messages");
  // Demo low-stock alert (no live push infra) — dismissible locally. Carries
  // the notifications_tour's stable anchors (notif-refill-row / notif-ack-btn).
  const [refillMockDismissed, setRefillMockDismissed] = useState(false);

  useEffect(() => {
    if (openQuestionsSignal) setTab("questions");
  }, [openQuestionsSignal]);

  useEffect(() => {
    if (!walkthroughResetSignal) return;
    // Restore the demo alert (notifications_tour's own step 3 dismisses it, so
    // replaying the tour used to dead-end on its previous run) and close the
    // question composer (add_doctor_question_auto opens it itself, and its step
    // targets the Add button, which only exists while it is closed).
    //
    // Deliberately does NOT touch `tab`: a ChangeHighlight can navigate here and
    // open the Questions tab (openQuestionsSignal) in the same beat a
    // walkthrough starts, and forcing Messages back would unmount the very card
    // the highlight is trying to ring. The tour's own anchors don't need it —
    // the demo alert sits ABOVE the tab strip, and the doctor-question flow
    // clicks its tab itself.
    setRefillMockDismissed(false);
    setShowQInput(false);
  }, [walkthroughResetSignal]);

  useEffect(() => {
    if (!elderId) return;
    void fetchPendingLinkRequests(elderId).then(setRequests);
  }, [elderId]);

  const respond = async (id: string, accept: boolean) => {
    setBusy(id);
    const ok = await respondToLinkRequest(id, accept);
    setBusy(null);
    if (ok) {
      setRequests(prev => prev.filter(r => r.id !== id));
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

        {/* Mock low-stock/refill alert — mirrors the caregiver demo toast; the
            notifications_tour spotlights this row and its Got it button. Sits
            above the tabs so the tour's anchors are on screen from the start. */}
        {!refillMockDismissed && (
          <div data-walk="notif-refill-row" className="rounded-2xl border border-warn-border bg-warn-bg p-4">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="w-9 h-9 rounded-full bg-card flex items-center justify-center shrink-0">
                <RefreshCw size={15} className="text-warn-fg" />
              </div>
              <p className="text-[calc(15px*var(--dw-text,1))] font-bold text-warn-fg flex-1">{t(language, "notifications.lowStockTitle", { med: "Metformin" })}</p>
            </div>
            <p className="text-[calc(15px*var(--dw-text,1))] text-warn-fg/90 leading-relaxed mb-3">
              {t(language, "notifications.lowStockBody", { med: "Metformin 500mg", days: 4 })}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setRefillMockDismissed(true)}
                data-walk="notif-ack-btn"
                className="flex-1 bg-card border border-warn-border text-warn-fg rounded-xl py-2.5 text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform"
              >
                <Check size={16} />{t(language, "notifications.dismiss")}
              </button>
              <button
                onClick={() => {
                  onAddDoctorQ(t(language, "ai.refillRequestMsg", { name: "Metformin" }));
                  setRefillMockDismissed(true);
                  setTab("questions");
                }}
                data-walk="notif-request-refill-btn"
                className="flex-1 bg-warn-fg text-white rounded-xl py-2.5 text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform"
              >
                <RefreshCw size={16} />{t(language, "prescription.requestRefill")}
              </button>
            </div>
          </div>
        )}

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

          {manual.map(q => (
            <div key={q.id} data-testid={`doctor_message-${q.id}`} className="dw-surface p-4">
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
