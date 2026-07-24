import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { X, Check, QrCode, UserPlus, Loader2, AlertCircle, Send } from "lucide-react";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";
import { parseCareLinkPayload, createLinkRequest } from "../lib/careLinks";
import { emitWalkthroughEvent } from "../lib/walkthrough/bus";

const SCANNER_ID = "care-link-scanner";

type Phase = "scanning" | "confirm" | "sending" | "sent" | "error";

// Caregiver-side sheet: open the camera, scan an elder's Dosewise linking QR, and
// send them a pending link request. On success it reports the scanned name +
// relationship back so the caller can show a pending patient card.
export function ScanLinkSheet({ onClose, onLinked }: {
  onClose: () => void;
  onLinked: (name: string, relationship: string) => void;
}) {
  const { language } = useLanguage();
  const [phase, setPhase] = useState<Phase>("scanning");
  const [scanned, setScanned] = useState<{ elderId: string; name?: string } | null>(null);
  const [relationship, setRelationship] = useState("");
  const [message, setMessage] = useState("");

  const scannerRef = useRef<Html5Qrcode | null>(null);
  // Ref-guarded so the async decode callback can't fire twice past the first hit.
  const handledRef = useRef(false);

  // Camera lifecycle: run only while in the scanning phase.
  useEffect(() => {
    if (phase !== "scanning") return;
    handledRef.current = false;
    const scanner = new Html5Qrcode(SCANNER_ID, { verbose: false });
    scannerRef.current = scanner;
    let cancelled = false;

    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        decodedText => {
          if (handledRef.current) return;
          const parsed = parseCareLinkPayload(decodedText);
          if (!parsed) return; // keep scanning until a Dosewise code appears
          handledRef.current = true;
          setScanned(parsed);
          setPhase("confirm");
          // The walkthrough's completion signal here is a successful decode, not
          // the camera merely starting — this only fires once a real Dosewise
          // QR code was found.
          emitWalkthroughEvent("qr-code-decoded");
        },
        () => {}, // per-frame decode misses — ignore
      )
      .catch(() => {
        if (cancelled) return;
        setMessage(t(language, "link.cameraError"));
        setPhase("error");
      });

    return () => {
      cancelled = true;
      const s = scannerRef.current;
      scannerRef.current = null;
      if (s) {
        s.stop().then(() => s.clear()).catch(() => {});
      }
    };
  }, [phase, language]);

  const sendRequest = async () => {
    if (!scanned) return;
    setPhase("sending");
    const result = await createLinkRequest(scanned.elderId, relationship);
    const name = scanned.name?.trim() || t(language, "link.theElder");
    switch (result.status) {
      case "sent":
      case "already_pending":
        onLinked(name, relationship.trim());
        setMessage(t(language, "link.sentBody", { name }));
        setPhase("sent");
        // Gated on the real, resolved write — never the Send button's click,
        // which fires before createLinkRequest settles (and the "already_active"/
        // "self"/"error" branches below must NOT satisfy this).
        emitWalkthroughEvent("care-link-request-sent");
        break;
      case "already_active":
        setMessage(t(language, "link.alreadyLinked", { name }));
        setPhase("error");
        break;
      case "self":
        setMessage(t(language, "link.selfScan"));
        setPhase("error");
        break;
      case "not_signed_in":
        setMessage(t(language, "link.notSignedIn"));
        setPhase("error");
        break;
      default:
        setMessage(t(language, "link.genericError"));
        setPhase("error");
    }
  };

  const relationChips = [
    t(language, "link.relDaughter"),
    t(language, "link.relSon"),
    t(language, "link.relSpouse"),
    t(language, "link.relHelper"),
    t(language, "link.relNurse"),
  ];

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative bg-card rounded-t-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90%]">
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        <div className="flex items-center justify-between px-5 pb-3 pt-1 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <QrCode size={16} className="text-primary" />
            <h2 className="font-['Fraunces'] text-lg font-semibold text-foreground">{t(language, "link.scanTitle")}</h2>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
            <X size={14} className="text-foreground" />
          </button>
        </div>

        <div className="overflow-y-auto scrollbar-none px-5 py-4 space-y-4">
          {phase === "scanning" && (
            <>
              <p className="text-sm text-muted-foreground">{t(language, "link.scanHint")}</p>
              <div id={SCANNER_ID} className="w-full rounded-2xl overflow-hidden bg-black [&_video]:rounded-2xl" />
            </>
          )}

          {(phase === "confirm" || phase === "sending") && (
            <>
              <div className="bg-secondary rounded-2xl p-4 flex items-center gap-3">
                <div className="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center">
                  <UserPlus size={18} className="text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{scanned?.name || t(language, "link.theElder")}</p>
                  <p className="text-xs text-muted-foreground">{t(language, "link.confirmSub")}</p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-foreground mb-2">{t(language, "link.relationLabel")}</label>
                <div className="flex flex-wrap gap-2 mb-2" data-walk="scanlink-relationship-chips">
                  {relationChips.map(c => (
                    <button
                      key={c}
                      onClick={() => setRelationship(c)}
                      className={`text-xs rounded-full border px-3 py-1.5 transition-colors ${relationship === c ? "bg-primary/10 border-primary text-foreground" : "bg-muted/50 border-border text-foreground"}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <input
                  value={relationship}
                  onChange={e => setRelationship(e.target.value)}
                  placeholder={t(language, "link.relationPlaceholder")}
                  className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
                />
              </div>

              <button
                onClick={sendRequest}
                disabled={phase === "sending"}
                data-walk="scanlink-send-button"
                className="w-full bg-primary text-primary-foreground rounded-2xl py-3.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 transition-opacity"
              >
                {phase === "sending" ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                {t(language, "link.sendRequest")}
              </button>
            </>
          )}

          {phase === "sent" && (
            <div className="flex flex-col items-center justify-center gap-3 py-8">
              <div className="w-16 h-16 rounded-full bg-emerald-500 flex items-center justify-center animate-in zoom-in duration-300">
                <Check size={30} className="text-white" strokeWidth={3} />
              </div>
              <p className="font-['Fraunces'] text-lg font-semibold text-foreground">{t(language, "link.sentTitle")}</p>
              <p className="text-sm text-muted-foreground text-center">{message}</p>
              <button onClick={onClose} className="mt-2 w-full bg-primary text-primary-foreground rounded-2xl py-3 text-sm font-semibold">
                {t(language, "link.done")}
              </button>
            </div>
          )}

          {phase === "error" && (
            <div className="flex flex-col items-center justify-center gap-3 py-8">
              <div className="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center">
                <AlertCircle size={26} className="text-amber-600" />
              </div>
              <p className="text-sm text-muted-foreground text-center max-w-[260px]">{message}</p>
              <button onClick={onClose} className="mt-1 w-full bg-muted text-foreground rounded-2xl py-3 text-sm font-semibold">
                {t(language, "link.close")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
