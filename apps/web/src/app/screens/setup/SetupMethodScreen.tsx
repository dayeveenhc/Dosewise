import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { ArrowLeft, ClipboardList, Lock, ChevronRight, FileUp, Loader2 } from "lucide-react";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";
import { extractProfile, fileToBase64 } from "../../lib/hermes";
import { buildWizardPrefill, type WizardPrefill } from "../../lib/profile";
import { PhotoSourceSheet } from "../../components/PhotoSourceSheet";

export function SetupMethodScreen({
  onBack,
  onGuided,
  onExtracted,
}: {
  onBack: () => void;
  onGuided: () => void;
  onExtracted: (prefill: WizardPrefill) => void;
}) {
  const { language } = useLanguage();
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const [showPhotoSource, setShowPhotoSource] = useState(false);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const hasAnything = (p: WizardPrefill) =>
    !!p.fullName || Object.keys(p.details).length > 0 || p.currentMeds.length > 0 || p.pastMeds.length > 0;

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setLoading(true);
    setNote(null);
    try {
      const b64 = await fileToBase64(file);
      const isPdf = file.type === "application/pdf";
      const { fields, note: serverNote } = await extractProfile(
        isPdf ? undefined : b64,
        isPdf ? b64 : undefined
      );
      const prefill = buildWizardPrefill(fields);
      if (hasAnything(prefill)) {
        onExtracted(prefill);
      } else {
        setNote(serverNote ?? t(language, "setup.uploadNothing"));
      }
    } catch {
      setNote(t(language, "setup.uploadFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="px-4 pt-4 pb-2">
        <button onClick={onBack} className="w-9 h-9 rounded-full bg-card border border-border flex items-center justify-center active:bg-muted transition-colors">
          <ArrowLeft size={16} className="text-foreground" />
        </button>
      </div>

      <div className="px-6 pt-4 pb-6">
        <h1 className="font-['Fraunces'] text-2xl font-semibold text-foreground leading-snug mb-2">
          {t(language, "common.howSetUp")}
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t(language, "common.setUpHint")}
        </p>
      </div>

      <div className="flex flex-col gap-4 px-5 flex-1">
        {/* HealthHub — placeholder, not yet available */}
        <div
          className="w-full text-left rounded-2xl bg-card border border-border p-5 flex items-start gap-4 opacity-50 cursor-not-allowed"
          aria-disabled="true"
        >
          <div className="w-11 h-11 rounded-xl bg-muted flex items-center justify-center shrink-0 mt-0.5">
            <Lock size={20} className="text-muted-foreground" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-foreground text-[15px] leading-snug mb-1">{t(language, "common.healthHub")}</p>
            <p className="text-sm text-muted-foreground leading-relaxed">{t(language, "common.healthHubComingSoon")}</p>
          </div>
        </div>

        {/* Upload records — auto-fill the guided questions from a PDF/image */}
        <button
          onClick={() => !loading && setShowPhotoSource(true)}
          disabled={loading}
          className="w-full text-left rounded-2xl bg-card shadow-sm p-5 flex items-start gap-4 active:scale-[0.98] transition-transform disabled:opacity-70"
        >
          <div className="w-11 h-11 rounded-xl bg-accent flex items-center justify-center shrink-0 mt-0.5">
            {loading ? (
              <Loader2 size={20} className="text-accent-foreground animate-spin" />
            ) : (
              <FileUp size={20} className="text-accent-foreground" />
            )}
          </div>
          <div className="flex-1">
            <p className="font-semibold text-foreground text-[15px] leading-snug">
              {loading ? t(language, "setup.reading") : t(language, "setup.uploadRecords")}
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">{t(language, "setup.uploadRecordsDesc")}</p>
          </div>
        </button>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onFile} />
        <input ref={libraryRef} type="file" accept="image/*,application/pdf" className="sr-only" onChange={onFile} />
        {showPhotoSource && (
          <PhotoSourceSheet
            onTakePhoto={() => { setShowPhotoSource(false); cameraRef.current?.click(); }}
            onChooseFile={() => { setShowPhotoSource(false); libraryRef.current?.click(); }}
            onClose={() => setShowPhotoSource(false)}
          />
        )}
        {note && <p className="text-xs text-muted-foreground px-1 -mt-2">{note}</p>}

        {/* Guided questions */}
        <button
          onClick={onGuided}
          data-walk="setup-method-guided"
          className="w-full text-left rounded-2xl bg-card shadow-sm p-5 flex items-start gap-4 active:scale-[0.98] transition-transform"
        >
          <div className="w-11 h-11 rounded-xl bg-primary flex items-center justify-center shrink-0 mt-0.5">
            <ClipboardList size={20} className="text-primary-foreground" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-foreground text-[15px] leading-snug">{t(language, "common.guidedSetup")}</p>
          </div>
          <ChevronRight size={18} className="text-muted-foreground mt-1 shrink-0" />
        </button>
      </div>

      <p className="text-center text-[11px] text-muted-foreground leading-relaxed px-6 pb-10">
        {t(language, "common.setupMinutes")}
      </p>
    </div>
  );
}
