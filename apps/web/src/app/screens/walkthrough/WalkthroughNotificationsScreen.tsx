import { useEffect, useState } from "react";
import { MessageSquare, User, ShieldQuestion, Check, X, Loader2 } from "lucide-react";
import type { Message } from "../../types";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";
import { fetchPendingLinkRequests, respondToLinkRequest, type PendingLinkRequest } from "../../lib/careLinks";

// Scripted stand-in id — never sent to Supabase (see respond() below), so a
// scenario can hand this screen a one-off pending request (e.g. walkthrough
// 2's "caregiver scans, elder accepts" flow) without touching the real
// care_links fetch/respond path used elsewhere.
const SCRIPTED_REQUEST_ID = "scripted-pending-request";

export function WalkthroughNotificationsScreen({ careMessages, elderId, pendingLinkRequest, onRespondLinkRequest }: {
  careMessages: Message[];
  elderId?: string;
  pendingLinkRequest?: { caregiverName: string; relationship: string } | null;
  onRespondLinkRequest?: (accept: boolean) => void;
}) {
  const { language } = useLanguage();
  const [requests, setRequests] = useState<PendingLinkRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!elderId) return;
    void fetchPendingLinkRequests(elderId).then(setRequests);
  }, [elderId]);

  const scriptedRequest: PendingLinkRequest | null = pendingLinkRequest
    ? { id: SCRIPTED_REQUEST_ID, caregiverName: pendingLinkRequest.caregiverName, relationship: pendingLinkRequest.relationship, requestedAt: "" }
    : null;
  const allRequests = scriptedRequest ? [scriptedRequest, ...requests] : requests;

  const respond = async (id: string, accept: boolean) => {
    if (id === SCRIPTED_REQUEST_ID) { onRespondLinkRequest?.(accept); return; }
    setBusy(id);
    const ok = await respondToLinkRequest(id, accept);
    setBusy(null);
    if (ok) setRequests(prev => prev.filter(r => r.id !== id));
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex-1 overflow-y-auto scrollbar-none px-4 pb-28 pt-3 space-y-3">
        {/* Incoming caregiver link requests — accept to let them help manage meds. */}
        {allRequests.map(req => (
          <div key={req.id} className="bg-card rounded-2xl border border-primary/30 p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <ShieldQuestion size={16} className="text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{req.caregiverName}</p>
                <p className="text-xs text-muted-foreground">{req.relationship || t(language, "link.reqDefaultRelation")}</p>
              </div>
            </div>
            <p className="text-[15px] text-foreground leading-relaxed mb-3">
              {t(language, "link.reqBody", { name: req.caregiverName })}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => respond(req.id, true)}
                disabled={busy === req.id}
                className="flex-1 bg-primary text-primary-foreground rounded-xl py-2.5 text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40"
              >
                {busy === req.id ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                {t(language, "link.accept")}
              </button>
              <button
                onClick={() => respond(req.id, false)}
                disabled={busy === req.id}
                className="flex-1 bg-muted text-foreground rounded-xl py-2.5 text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40"
              >
                <X size={15} />{t(language, "link.decline")}
              </button>
            </div>
          </div>
        ))}

        <p className="text-sm text-muted-foreground">{t(language, "notifications.header")}</p>
        {careMessages.length === 0 && allRequests.length === 0 ? (
          <div className="bg-card rounded-2xl border border-border p-6 text-center">
            <MessageSquare size={28} className="text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">{t(language, "notifications.empty")}</p>
          </div>
        ) : careMessages.map(msg => (
          <div key={msg.id} className="bg-card rounded-2xl border border-border p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                <User size={14} className="text-primary" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-foreground">{msg.author}</p>
                <p className="text-xs text-muted-foreground">{msg.role}</p>
              </div>
              <p className="text-xs text-muted-foreground">{msg.time}</p>
            </div>
            <p className="text-[15px] text-foreground leading-relaxed">{msg.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
