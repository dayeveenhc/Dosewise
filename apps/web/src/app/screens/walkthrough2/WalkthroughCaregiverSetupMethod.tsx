import { useState } from "react";
import { ArrowLeft, ClipboardList, Lock, ChevronRight, FileUp, QrCode } from "lucide-react";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";
import { WalkthroughCaregiverOnboardingScan } from "./WalkthroughCaregiverOnboardingScan";

// Scripted duplicate of screens/setup/SetupMethodScreen — same four cards and
// copy, but only "Scan a loved one's QR code" is wired (the path this
// scenario demonstrates); Upload records / Guided setup are inert here, same
// as other out-of-scope controls elsewhere in the walkthroughs (e.g. the
// caregiver Settings tab). Opens WalkthroughCaregiverOnboardingScan instead of
// the real ScanLovedOneSheet, since that one calls supabase.auth.signUp.
export function WalkthroughCaregiverSetupMethod({ onBack, onScanConfirmed }: { onBack: () => void; onScanConfirmed: () => void }) {
  const { language } = useLanguage();
  const [showScan, setShowScan] = useState(false);

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
        {/* HealthHub — placeholder, not yet available (matches the real screen) */}
        <div className="w-full text-left rounded-2xl bg-card border border-border p-5 flex items-start gap-4 opacity-50 cursor-not-allowed" aria-disabled="true">
          <div className="w-11 h-11 rounded-xl bg-muted flex items-center justify-center shrink-0 mt-0.5">
            <Lock size={20} className="text-muted-foreground" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-foreground text-[15px] leading-snug mb-1">{t(language, "common.healthHub")}</p>
            <p className="text-sm text-muted-foreground leading-relaxed">{t(language, "common.healthHubComingSoon")}</p>
          </div>
        </div>

        {/* Upload records — not part of this demo */}
        <button className="w-full text-left rounded-2xl bg-card shadow-sm p-5 flex items-start gap-4 active:scale-[0.98] transition-transform">
          <div className="w-11 h-11 rounded-xl bg-accent flex items-center justify-center shrink-0 mt-0.5">
            <FileUp size={20} className="text-accent-foreground" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-foreground text-[15px] leading-snug">{t(language, "setup.uploadRecords")}</p>
            <p className="text-sm text-muted-foreground leading-relaxed">{t(language, "setup.uploadRecordsDesc")}</p>
          </div>
        </button>

        {/* Guided questions — not part of this demo */}
        <button className="w-full text-left rounded-2xl bg-card shadow-sm p-5 flex items-start gap-4 active:scale-[0.98] transition-transform">
          <div className="w-11 h-11 rounded-xl bg-primary flex items-center justify-center shrink-0 mt-0.5">
            <ClipboardList size={20} className="text-primary-foreground" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-foreground text-[15px] leading-snug">{t(language, "common.guidedSetup")}</p>
          </div>
          <ChevronRight size={18} className="text-muted-foreground mt-1 shrink-0" />
        </button>

        {/* Scan a loved one's QR code — the path this scenario walks through */}
        <button
          onClick={() => setShowScan(true)}
          className="w-full text-left rounded-2xl bg-card shadow-sm p-5 flex items-start gap-4 active:scale-[0.98] transition-transform"
        >
          <div className="w-11 h-11 rounded-xl bg-accent flex items-center justify-center shrink-0 mt-0.5">
            <QrCode size={20} className="text-accent-foreground" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-foreground text-[15px] leading-snug">Scan a loved one's QR code</p>
            <p className="text-sm text-muted-foreground leading-relaxed">Already have their code? Link to their existing profile instead.</p>
          </div>
          <ChevronRight size={18} className="text-muted-foreground mt-1 shrink-0" />
        </button>
      </div>

      <p className="text-center text-[11px] text-muted-foreground leading-relaxed px-6 pb-10">
        {t(language, "common.setupMinutes")}
      </p>

      {showScan && <WalkthroughCaregiverOnboardingScan onClose={() => setShowScan(false)} onConfirm={onScanConfirmed} />}
    </div>
  );
}
