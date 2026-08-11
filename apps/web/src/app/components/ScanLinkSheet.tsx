import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { X, Check, QrCode, UserPlus, Loader2, AlertCircle, Send, ImageUp } from "lucide-react";
import type { ChangeEvent } from "react";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";
import { parseCareLinkPayload, createLinkRequest } from "../lib/careLinks";
import { emitWalkthroughEvent } from "../lib/walkthrough/bus";

const SCANNER_ID = "care-link-scanner";
// A SECOND, always-mounted container, used only for decoding a picked image.
// html5-qrcode's constructor throws when its element is absent, and #SCANNER_ID
// only mounts during the scanning phase — so file decoding cannot share it.
const FILE_SCANNER_ID = "care-link-file-scanner";

type Phase = "scanning" | "decoding" | "confirm" | "sending" | "sent" | "error";

// Caregiver-side sheet: open the camera (or accept a photo of the code), scan an
// elder's Dosewise linking QR, and send them a pending link request. On success it
// reports the scanned name + relationship back so the caller can show a pending
// patient card.
//
// Two modes. Normally (`onLinked`) the sheet writes the care_links row itself.
// In DEFERRED mode (`onScanned`, used by caregiver onboarding) there is no session
// yet — RLS requires caregiver_id = auth.uid() — so the sheet only decodes and
// hands the payload up; the caller writes it once the account exists. Deferred mode
// must never reach the "sending"/"sent" phases: nothing has been sent, and showing
// "Request sent!" for a request that does not exist yet would be a lie.
export function ScanLinkSheet({ onClose, onLinked, onScanned }: {
  onClose: () => void;
  onLinked?: (name: string, relationship: string) => void;
  onScanned?: (elderId: string, name: string | undefined, relationship: string) => void;
}) {
  const { language } = useLanguage();
  const [phase, setPhase] = useState<Phase>("scanning");
  const [scanned, setScanned] = useState<{ elderId: string; name?: string } | null>(null);
  const [relationship, setRelationship] = useState("");
  const [message, setMessage] = useState("");
  const [uploadNote, setUploadNote] = useState<string | null>(null);

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const fileScannerRef = useRef<Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Where the upload was launched from, so a failed decode returns there. Always
  // returning to "scanning" would loop when the user reached upload BECAUSE the
  // camera was denied: start() rejects again and bounces straight back to "error".
  const uploadOriginRef = useRef<Phase>("scanning");
  // Ref-guarded so the async decode callback can't fire twice past the first hit.
  const handledRef = useRef(false);

  const deferred = !!onScanned;

  // Shared by both decode paths (live camera + picked image) so they can't drift.
  // Returns false for anything that isn't a Dosewise care-link code.
  const acceptDecoded = (decodedText: string): boolean => {
    if (handledRef.current) return false;
    const parsed = parseCareLinkPayload(decodedText);
    if (!parsed) return false;
    handledRef.current = true;
    setScanned(parsed);
    setUploadNote(null);
    setPhase("confirm");
    // The walkthrough's completion signal here is a successful decode, not the
    // camera merely starting — this only fires once a real Dosewise QR was found.
    emitWalkthroughEvent("qr-code-decoded");
    return true;
  };

  // Upload path: decode a QR out of a photo instead of the live camera. Entering
  // "decoding" tears the camera down via the effect's own `phase !== "scanning"`
  // guard, so the two never run at once.
  const onPickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const origin = uploadOriginRef.current;
    setUploadNote(null);
    setPhase("decoding");
    try {
      // One reused instance rather than one per pick, so repeated uploads don't
      // accumulate html5-qrcode instances on the same div.
      const fileScanner = fileScannerRef.current ?? new Html5Qrcode(FILE_SCANNER_ID, { verbose: false });
      fileScannerRef.current = fileScanner;
      // scanFile REJECTS when it finds no code — an uncaught rejection here is the
      // same blank-page class as the stop() crash guarded below (no error boundary).
      const decoded = await fileScanner.scanFile(file, false);
      if (acceptDecoded(decoded)) return;
      setUploadNote(t(language, "link.uploadNoCode"));
    } catch {
      setUploadNote(t(language, "link.uploadNoCode"));
    }
    setPhase(origin);
  };

  const openFilePicker = (origin: Phase) => {
    uploadOriginRef.current = origin;
    fileInputRef.current?.click();
  };

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
          acceptDecoded(decodedText); // ignores non-Dosewise codes, keeps scanning
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
        // stop() can throw SYNCHRONOUSLY (not just reject) when start() never
        // reached "running" — e.g. camera permission denied — which would
        // otherwise crash this cleanup with no error boundary in the tree.
        try {
          s.stop().then(() => s.clear()).catch(() => {});
        } catch {
          // Nothing was actually running; nothing to stop.
        }
      }
    };
  }, [phase, language]);

  // The file scanner never "runs" like the camera does, so it only needs clearing
  // once, on unmount. Same synchronous-throw caution as above.
  useEffect(() => () => {
    const fs = fileScannerRef.current;
    fileScannerRef.current = null;
    if (fs) {
      try { fs.clear(); } catch { /* never rendered anything to clear */ }
    }
  }, []);

  const sendRequest = async () => {
    if (!scanned) return;
    // Deferred mode: no session exists yet, so there is nothing to write. Hand the
    // payload up and stop here — never enter "sending"/"sent".
    if (onScanned) {
      onScanned(scanned.elderId, scanned.name?.trim() || undefined, relationship.trim());
      return;
    }
    setPhase("sending");
    const result = await createLinkRequest(scanned.elderId, relationship);
    const name = scanned.name?.trim() || t(language, "link.theElder");
    switch (result.status) {
      case "sent":
      case "already_pending":
        onLinked?.(name, relationship.trim());
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

        {/* Always mounted: html5-qrcode's constructor needs its element to exist,
            and #SCANNER_ID only mounts while scanning. */}
        <div id={FILE_SCANNER_ID} className="hidden" />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={onPickFile}
        />

        <div className="overflow-y-auto scrollbar-none px-5 py-4 space-y-4">
          {phase === "scanning" && (
            <>
              <p className="text-sm text-muted-foreground">{t(language, "link.scanHint")}</p>
              <div id={SCANNER_ID} className="w-full rounded-2xl overflow-hidden bg-black [&_video]:rounded-2xl" />
              {uploadNote && <p className="text-xs text-warn">{uploadNote}</p>}
              <button
                onClick={() => openFilePicker("scanning")}
                data-walk="scanlink-upload-qr"
                className="w-full flex items-center justify-center gap-2 rounded-2xl border border-border bg-muted/50 py-3 text-sm font-semibold text-foreground active:scale-[0.98] transition-transform"
              >
                <ImageUp size={16} className="text-primary" />
                {t(language, "link.uploadInstead")}
              </button>
            </>
          )}

          {phase === "decoding" && (
            <div className="flex flex-col items-center justify-center gap-3 py-10">
              <Loader2 size={26} className="animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">{t(language, "link.uploadReading")}</p>
            </div>
          )}

          {(phase === "confirm" || phase === "sending") && (
            <>
              <div className="bg-secondary rounded-2xl p-4 flex items-center gap-3">
                <div className="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center">
                  <UserPlus size={18} className="text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{scanned?.name || t(language, "link.theElder")}</p>
                  <p className="text-xs text-muted-foreground">{t(language, deferred ? "link.confirmSubDeferred" : "link.confirmSub")}</p>
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
                {t(language, deferred ? "link.continueToAccount" : "link.sendRequest")}
              </button>
            </>
          )}

          {phase === "sent" && (
            <div className="flex flex-col items-center justify-center gap-3 py-8">
              <div className="w-16 h-16 rounded-full bg-primary flex items-center justify-center animate-in zoom-in duration-300">
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
              <div className="w-14 h-14 rounded-full bg-warn-bg flex items-center justify-center">
                <AlertCircle size={26} className="text-warn" />
              </div>
              <p className="text-sm text-muted-foreground text-center max-w-[260px]">{message}</p>
              {uploadNote && <p className="text-xs text-warn text-center max-w-[260px]">{uploadNote}</p>}
              {/* The most likely way to land here is a denied camera — which is
                  precisely when uploading a photo of the code is the way through. */}
              <button
                onClick={() => openFilePicker("error")}
                data-walk="scanlink-upload-qr-error"
                className="mt-1 w-full bg-primary text-primary-foreground rounded-2xl py-3 text-sm font-semibold flex items-center justify-center gap-2"
              >
                <ImageUp size={16} />
                {t(language, "link.uploadInstead")}
              </button>
              <button onClick={onClose} className="w-full bg-muted text-foreground rounded-2xl py-3 text-sm font-semibold">
                {t(language, "link.close")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
