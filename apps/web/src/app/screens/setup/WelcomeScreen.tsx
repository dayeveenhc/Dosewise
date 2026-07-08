import { Pill, Heart, Shield, LogIn, Sparkles } from "lucide-react";
import { LiveStatusBar } from "../../components/shared";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";

export function WelcomeScreen({ onSignIn, onGetStarted }: { onSignIn: () => void; onGetStarted: () => void }) {
  const { language } = useLanguage();
  return (
    <div className="flex flex-col h-full bg-background">
      {/* Status bar */}
      <LiveStatusBar />

      {/* Hero area */}
      <div className="flex flex-col items-center pt-12 pb-6 px-6 flex-1 justify-center">
        <p className="text-[10px] text-muted-foreground uppercase tracking-[0.25em] font-medium mb-1">DOSEWISE</p>
        <div className="relative w-20 h-20 mb-6 mt-2">
          <div className="absolute inset-0 rounded-full bg-primary/10 flex items-center justify-center">
            <div className="w-14 h-14 rounded-full bg-primary/20 flex items-center justify-center">
              <Pill size={28} className="text-primary" />
            </div>
          </div>
          <div className="absolute -top-1 -right-1 w-7 h-7 rounded-full bg-amber-100 border-2 border-background flex items-center justify-center">
            <Heart size={13} className="text-amber-500" />
          </div>
          <div className="absolute -bottom-1 -left-1 w-7 h-7 rounded-full bg-teal-100 border-2 border-background flex items-center justify-center">
            <Shield size={13} className="text-primary" />
          </div>
        </div>
        <h1 className="font-['Fraunces'] text-2xl font-semibold text-foreground text-center leading-snug mb-2">
          Your smart<br />prescription tracker
        </h1>
        <p className="text-sm text-muted-foreground text-center leading-relaxed max-w-[280px]">
          Keep track of medications, get gentle reminders, and stay connected with the people who care for you.
        </p>
      </div>

      {/* Choice cards */}
      <div className="flex flex-col gap-3 px-5 pb-10">
        <button
          onClick={onGetStarted}
          className="w-full bg-primary text-primary-foreground rounded-2xl py-4 flex items-center justify-center gap-2 text-[16px] font-semibold active:scale-[0.98] transition-transform shadow-sm"
        >
          <Sparkles size={18} />{t(language, "common.getStarted")}
        </button>
        <button
          onClick={onSignIn}
          className="w-full bg-card border border-border rounded-2xl py-4 flex items-center justify-center gap-2 text-[16px] font-semibold text-foreground active:scale-[0.98] transition-transform"
        >
          <LogIn size={18} className="text-muted-foreground" />{t(language, "common.alreadyHaveAccount")}
        </button>
      </div>
    </div>
  );
}
