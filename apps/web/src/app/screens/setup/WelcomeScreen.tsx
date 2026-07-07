import { Droplets, Pill, Heart, Shield, LogIn, Sparkles } from "lucide-react";

export function WelcomeScreen({ onSignIn, onGetStarted }: { onSignIn: () => void; onGetStarted: () => void }) {
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
          <Sparkles size={18} />Get started
        </button>
        <button
          onClick={onSignIn}
          className="w-full bg-card border border-border rounded-2xl py-4 flex items-center justify-center gap-2 text-[16px] font-semibold text-foreground active:scale-[0.98] transition-transform"
        >
          <LogIn size={18} className="text-muted-foreground" />I already have an account
        </button>
      </div>
    </div>
  );
}
