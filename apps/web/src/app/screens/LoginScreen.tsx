import { useState } from "react";
import { Pill, Heart, Shield, Loader2, ArrowLeft, Eye, EyeOff } from "lucide-react";
import { supabase } from "../lib/supabase";
import { LiveStatusBar } from "../components/shared";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

// Sign-in only — creating a new account happens through the guided setup wizard
// (screens/setup/), which needs a session in place before it can save profile
// details, medications, etc.
export function LoginScreen({ onBack, onGetStarted }: { onBack: () => void; onGetStarted: () => void }) {
  const { language } = useLanguage();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fieldCls = "w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors";

  const handleSubmit = async () => {
    if (!email.trim() || !password.trim()) return;
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) setError(error.message);
    setLoading(false);
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Status bar */}
      <LiveStatusBar />

      <div className="px-4 pt-2">
        <button onClick={onBack} className="w-9 h-9 rounded-full bg-card border border-border flex items-center justify-center active:bg-muted transition-colors">
          <ArrowLeft size={16} className="text-foreground" />
        </button>
      </div>

      {/* Hero area */}
      <div className="flex flex-col items-center pt-6 pb-6 px-6">
        <p className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground uppercase tracking-[0.25em] font-medium mb-1">DOSEWISE</p>
        <div className="relative w-20 h-20 mb-6 mt-2">
          <div className="absolute inset-0 rounded-full bg-primary/10 flex items-center justify-center">
            <div className="w-14 h-14 rounded-full bg-primary/20 flex items-center justify-center">
              <Pill size={28} className="text-primary" />
            </div>
          </div>
          <div className="absolute -top-1 -right-1 w-7 h-7 rounded-full bg-secondary border-2 border-background flex items-center justify-center">
            <Heart size={13} className="text-accent" />
          </div>
          <div className="absolute -bottom-1 -left-1 w-7 h-7 rounded-full bg-secondary border-2 border-background flex items-center justify-center">
            <Shield size={13} className="text-primary" />
          </div>
        </div>
        <h1 className="font-['Fraunces'] text-2xl font-semibold text-foreground text-center leading-snug mb-2">{t(language, "common.welcomeBack")}</h1>
        <p className="text-sm text-muted-foreground text-center leading-relaxed">{t(language, "common.signInToContinue")}</p>
      </div>

      {/* Form */}
      <div className="flex flex-col gap-3 px-6 flex-1">
        <div>
          <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "wizard.email")}</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSubmit()}
            placeholder={t(language, "wizard.emailPlaceholder")}
            className={fieldCls}
            autoComplete="email"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "wizard.password")}</label>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSubmit()}
              placeholder="••••••••"
              className={`${fieldCls} pr-11`}
              autoComplete="current-password"
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowPassword(v => !v)}
              aria-label={showPassword ? t(language, "common.hidePassword") : t(language, "common.showPassword")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            >
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
        </div>

        {error && <p className="text-xs text-destructive font-medium">{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={loading || !email.trim() || !password.trim()}
          className="w-full h-12 mt-1 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98] transition-transform"
        >
          {loading && <Loader2 size={15} className="animate-spin" />}
          {t(language, "common.signIn")}
        </button>

        <button onClick={onGetStarted} className="text-center text-xs text-muted-foreground font-medium mt-1">
          {t(language, "common.dontHaveAccount")}
        </button>
      </div>
    </div>
  );
}
