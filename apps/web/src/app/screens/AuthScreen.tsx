import { useState } from "react";
import { ArrowLeft, Droplets, Pill } from "lucide-react";
import { supabase } from "../lib/supabase";

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return "Something went wrong";
}

export function AuthScreen({ role, onBack, onAuthed }: {
  role: "elder" | "caregiver";
  onBack: () => void;
  onAuthed: (userId: string) => void;
}) {
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isValid = email.trim() && password.length >= 6 && (mode === "signin" || fullName.trim());

  const handleSubmit = async () => {
    if (!isValid || loading) return;
    setError(null);
    setLoading(true);
    try {
      if (mode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({ email: email.trim(), password });
        if (signUpError) throw signUpError;
        const userId = data.user?.id;
        if (!userId) {
          throw new Error("Check your inbox to confirm your email, then sign in — email confirmation is on for this Supabase project.");
        }
        const { error: profileError } = await supabase
          .from("profiles")
          .insert({ id: userId, role, full_name: fullName.trim() });
        if (profileError) throw profileError;
        onAuthed(userId);
      } else {
        const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (signInError) throw signInError;
        onAuthed(data.user.id);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-background">
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

      <div className="px-4 pt-2 pb-1 shrink-0">
        <button onClick={onBack} className="w-8 h-8 bg-card border border-border rounded-xl flex items-center justify-center">
          <ArrowLeft size={14} className="text-foreground" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-none px-6 pt-4">
        <div className="w-11 h-11 rounded-xl bg-primary flex items-center justify-center mb-4">
          <Pill size={20} className="text-primary-foreground" />
        </div>
        <h1 className="font-['Fraunces'] text-2xl font-semibold text-foreground leading-snug mb-1">
          {mode === "signup" ? "Create your account" : "Welcome back"}
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed mb-6">
          {role === "caregiver" ? "Setting up as a caregiver." : "Setting up for yourself."}
        </p>

        <div className="space-y-4">
          {mode === "signup" && (
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1.5">Full name</label>
              <input
                value={fullName}
                onChange={e => setFullName(e.target.value)}
                placeholder="e.g. Tan Wei Ming"
                className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

          {error && (
            <p className="text-xs text-destructive leading-relaxed">{error}</p>
          )}

          <button
            onClick={handleSubmit}
            disabled={!isValid || loading}
            className="w-full h-12 rounded-2xl bg-primary text-primary-foreground text-sm font-bold disabled:opacity-40 active:scale-[0.98] transition-transform"
          >
            {loading ? "Please wait..." : mode === "signup" ? "Create account" : "Sign in"}
          </button>

          <button
            onClick={() => { setMode(m => m === "signup" ? "signin" : "signup"); setError(null); }}
            className="w-full text-center text-xs text-muted-foreground"
          >
            {mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
          </button>
        </div>
      </div>
    </div>
  );
}
