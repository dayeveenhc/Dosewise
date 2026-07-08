import { ArrowLeft, ClipboardList, Lock, ChevronRight } from "lucide-react";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";

export function SetupMethodScreen({ onBack, onGuided }: { onBack: () => void; onGuided: () => void }) {
  const { language } = useLanguage();
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

        {/* Guided questions */}
        <button
          onClick={onGuided}
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
