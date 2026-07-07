import { Droplets, Pill, Heart, Shield, Users, ChevronRight, User } from "lucide-react";

export function OnboardingScreen({ onSelect }: { onSelect: (mode: "caregiver" | "elderly") => void }) {
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

      {/* Hero area */}
      <div className="flex flex-col items-center pt-10 pb-6 px-6">
        {/* Wordmark */}
        <p className="text-[10px] text-muted-foreground uppercase tracking-[0.25em] font-medium mb-1">DOSEWISE</p>
        {/* Pill icon cluster */}
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
          Who are you using<br />Dosewise for today?
        </h1>
        <p className="text-sm text-muted-foreground text-center leading-relaxed">
          We'll tailor your experience based<br />on how you'd like to use the app.
        </p>
      </div>

      {/* Choice cards */}
      <div className="flex flex-col gap-4 px-5 flex-1">
        {/* For A Loved One */}
        <button
          onClick={() => onSelect("caregiver")}
          className="w-full text-left rounded-2xl bg-card shadow-sm p-5 flex items-start gap-4 active:scale-[0.98] transition-transform"
        >
          <div className="w-11 h-11 rounded-xl bg-primary flex items-center justify-center shrink-0 mt-0.5">
            <Users size={20} className="text-primary-foreground" />
          </div>
          <div>
            <p className="font-semibold text-foreground text-[15px] leading-snug mb-1">For a Loved One</p>
            <p className="text-sm text-muted-foreground leading-relaxed">Manage schedules, prescriptions, and monitor progress</p>
          </div>
          <ChevronRight size={18} className="text-muted-foreground mt-1.5 ml-auto shrink-0" />
        </button>

        {/* For Myself */}
        <button
          onClick={() => onSelect("elderly")}
          className="w-full text-left rounded-2xl bg-card shadow-sm p-5 flex items-start gap-4 active:scale-[0.98] transition-transform"
        >
          <div className="w-11 h-11 rounded-xl bg-amber-100 flex items-center justify-center shrink-0 mt-0.5">
            <User size={20} className="text-amber-600" />
          </div>
          <div>
            <p className="font-semibold text-foreground text-[15px] leading-snug mb-1">For Myself</p>
            <p className="text-sm text-muted-foreground leading-relaxed">Manage my daily medications and ask for help</p>
          </div>
          <ChevronRight size={18} className="text-muted-foreground mt-1.5 ml-auto shrink-0" />
        </button>
      </div>

      {/* Footer */}
      <div className="px-6 pb-10 pt-6">
        <p className="text-center text-[11px] text-muted-foreground leading-relaxed">
          You can switch modes anytime in Settings.
        </p>
      </div>
    </div>
  );
}
