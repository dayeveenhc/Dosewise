import { useState } from "react";
import { Droplets, Pill, Heart, Shield, Loader2, ArrowLeft } from "lucide-react";
import { supabase } from "../lib/supabase";

// Sign-in only — creating a new account happens through the guided setup wizard
// (screens/setup/), which needs a session in place before it can save profile
// details, medications, etc.
export function LoginScreen({ onBack, onGetStarted }: { onBack: () => void; onGetStarted: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      <div className="flex items-center justify-between px-6 pt-3 pb-1 shrink-0">
        <span className="text-xs font-semibold text-foreground font-mono">9:41</span>
        <div className="flex items-center gap-1.5">
          <div className="flex gap-0.5 items-end h-3">
            {[2, 3, 4, 4].map((h, i) => <div key={i} className="w-1 bg-foreground rounded-sm" style={{ height: `${h * 3}px` }} />)}
          </div>
          <Droplets size={11} className="text-foreground" />
          <span className="text-xs font-semibold text-foreground font-mono">100%</span>
        </div>
      </div>

      <div className="px-4 pt-2">
        <button onClick={onBack} className="w-9 h-9 rounded-full bg-card border border-border flex items-center justify-center active:bg-muted transition-colors">
          <ArrowLeft size={16} className="text-foreground" />
        </button>
      </div>

      {/* Hero area */}
      <div className="flex flex-col items-center pt-6 pb-6 px-6">
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
        <p className="text-sm text-muted-foreground text-center leading-relaxed">Sign in to continue to Dosewise.</p>
      </div>

      {/* Form */}
      <div className="flex flex-col gap-3 px-6 flex-1">
        <div>
          <label className="block text-xs font-semibold text-foreground mb-1.5">Email</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSubmit()}
            placeholder="you@example.com"
            className={fieldCls}
            autoComplete="email"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-foreground mb-1.5">Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSubmit()}
            placeholder="••••••••"
            className={fieldCls}
            autoComplete="current-password"
          />
        </div>

        {error && <p className="text-xs text-destructive font-medium">{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={loading || !email.trim() || !password.trim()}
          className="w-full h-12 mt-1 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98] transition-transform"
        >
          {loading && <Loader2 size={15} className="animate-spin" />}
          Sign in
        </button>

        <button onClick={onGetStarted} className="text-center text-xs text-muted-foreground font-medium mt-1">
          Don't have an account? Get started
        </button>
      </div>
    </div>
  );
}
