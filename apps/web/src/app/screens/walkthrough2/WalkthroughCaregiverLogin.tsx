import { useState } from "react";
import { Pill, Heart, Shield, ArrowLeft } from "lucide-react";

// Mocked login for walkthrough 2's "I already have an account" path —
// visually mirrors the real LoginScreen, but doesn't call supabase.auth:
// this whole scenario stays offline/scripted, same as every other
// walkthrough screen.
export function WalkthroughCaregiverLogin({ onLoggedIn, onBack }: { onLoggedIn: () => void; onBack?: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const fieldCls = "w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors";

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex items-center justify-between px-6 pt-4 pb-1">
        <span className="text-xs font-semibold text-foreground font-mono">8:40 AM</span>
      </div>

      {onBack && (
        <div className="px-4 pt-2">
          <button onClick={onBack} className="w-9 h-9 rounded-full bg-card border border-border flex items-center justify-center active:bg-muted transition-colors">
            <ArrowLeft size={16} className="text-foreground" />
          </button>
        </div>
      )}

      <div className="flex flex-col items-center pt-8 pb-6 px-6">
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
        <h1 className="font-['Fraunces'] text-2xl font-semibold text-foreground text-center leading-snug mb-2">Welcome back</h1>
        <p className="text-sm text-muted-foreground text-center leading-relaxed">Sign in to continue as Wei Liang</p>
      </div>

      <div className="flex flex-col gap-3 px-6 flex-1">
        <div>
          <label className="block text-xs font-semibold text-foreground mb-1.5">Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="wei.liang@example.com" className={fieldCls} autoComplete="email" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-foreground mb-1.5">Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" className={fieldCls} autoComplete="current-password" />
        </div>

        <button
          onClick={onLoggedIn}
          className="w-full h-12 mt-1 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
        >
          Log In
        </button>
      </div>
    </div>
  );
}
