import { useEffect, useState } from "react";
import { QrCode, ScanLine, Check, Pill, Bell, TrendingUp, Eye, EyeOff, Loader2 } from "lucide-react";
import { supabase } from "../lib/supabase";
import { saveProfile } from "../lib/profile";
import { cls } from "../screens/setup/GuidedSetupWizard";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

// Caregiver onboarding — a mocked "scan a loved one's QR code" step. Unlike
// ScanLinkSheet (the real in-app version, backed by a live camera + a real
// care_links insert), the scan itself is demo-only: no camera, no backend
// write, just a scripted animation into a fixed confirmation for Margaret.
// The account-creation step after it is real, though — same
// supabase.auth.signUp + saveProfile path as GuidedSetupWizard's own
// "account" step, so a caregiver linking this way still ends up with a real,
// signed-in account rather than a session-less preview.
export function ScanLovedOneSheet({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  const { language } = useLanguage();
  const [phase, setPhase] = useState<"scanning" | "confirm" | "account">("scanning");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountInfo, setAccountInfo] = useState<string | null>(null);

  useEffect(() => {
    if (phase !== "scanning") return;
    const timer = window.setTimeout(() => setPhase("confirm"), 1100);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

  const createAccount = async () => {
    if (!email.trim() || !password.trim()) return;
    setAccountLoading(true);
    setAccountError(null);
    setAccountInfo(null);
    const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
    setAccountLoading(false);
    if (error) { setAccountError(error.message); return; }
    if (!data.session || !data.user) {
      setAccountInfo(t(language, "wizard.checkEmail"));
      return;
    }
    await saveProfile(data.user.id, "caregiver", fullName.trim(), {});
    onConfirm();
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={phase !== "scanning" ? onClose : undefined} />
      <div className="relative bg-card rounded-t-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90%]">
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        <div className="overflow-y-auto scrollbar-none px-6 pb-8 pt-2">
          {phase === "scanning" && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="relative w-40 h-40 rounded-2xl border-2 border-primary/30 bg-primary/5 flex items-center justify-center overflow-hidden">
                <QrCode size={64} className="text-primary/40" />
                <div className="absolute inset-x-0 h-0.5 bg-primary shadow-[0_0_8px_2px] shadow-primary/50 animate-scanline" />
              </div>
              <div className="flex items-center gap-2 text-primary">
                <ScanLine size={16} className="animate-pulse" />
                <span className="text-sm font-semibold">Scanning QR code…</span>
              </div>
            </div>
          )}

          {phase === "confirm" && (
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="w-16 h-16 rounded-full bg-emerald-500 flex items-center justify-center animate-in zoom-in duration-300">
                <Check size={30} className="text-white" strokeWidth={3} />
              </div>
              <div>
                <p className="font-['Fraunces'] text-xl font-semibold text-foreground">Margaret Tan added as a loved one</p>
                <p className="text-sm text-muted-foreground mt-1">You're now connected — here's what you can do</p>
              </div>
              <div className="w-full bg-muted/40 rounded-2xl divide-y divide-border/60 text-left">
                <div className="flex items-center gap-3 px-4 py-3">
                  <Pill size={16} className="text-primary shrink-0" />
                  <p className="text-sm text-foreground">View her medication schedule and doses</p>
                </div>
                <div className="flex items-center gap-3 px-4 py-3">
                  <TrendingUp size={16} className="text-primary shrink-0" />
                  <p className="text-sm text-foreground">Track her daily and weekly adherence</p>
                </div>
                <div className="flex items-center gap-3 px-4 py-3">
                  <Bell size={16} className="text-primary shrink-0" />
                  <p className="text-sm text-foreground">Get alerted on missed doses and low refills</p>
                </div>
              </div>
              <button onClick={() => setPhase("account")} className="w-full bg-primary text-primary-foreground rounded-2xl py-3.5 text-sm font-semibold mt-2 active:scale-[0.98] transition-transform">
                Continue
              </button>
            </div>
          )}

          {phase === "account" && (
            <div className="flex flex-col gap-4">
              <div>
                <p className="font-['Fraunces'] text-xl font-semibold text-foreground">{t(language, "wizard.accountTitleNew")}</p>
                <p className="text-sm text-muted-foreground mt-1">Create your account to finish linking with Margaret.</p>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "wizard.preferredName")}</label>
                  <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder={t(language, "wizard.preferredNamePlaceholder")} className={cls(fullName.trim().length > 0)} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "wizard.email")}</label>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={t(language, "wizard.emailPlaceholder")} className={cls(isEmail(email))} autoComplete="email" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "wizard.password")}</label>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && createAccount()}
                      placeholder={t(language, "wizard.passwordPlaceholder")}
                      className={`${cls(password.length >= 6)} pr-11`}
                      autoComplete="new-password"
                    />
                    <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-label={t(language, showPassword ? "wizard.hidePassword" : "wizard.showPassword")}>
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
                {accountError && <p className="text-xs text-destructive font-medium">{accountError}</p>}
                {accountInfo && <p className="text-xs text-primary font-medium">{accountInfo}</p>}
              </div>
              <button
                onClick={createAccount}
                disabled={!email.trim() || !password.trim() || accountLoading}
                className="w-full bg-primary text-primary-foreground rounded-2xl py-3.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98] transition-transform"
              >
                {accountLoading && <Loader2 size={16} className="animate-spin" />}
                {t(language, "wizard.createAccount")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
