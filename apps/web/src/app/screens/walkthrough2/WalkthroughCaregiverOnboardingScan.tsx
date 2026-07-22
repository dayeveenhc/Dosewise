import { useEffect, useState } from "react";
import { QrCode, ScanLine, ClipboardList, Bell, ShieldQuestion } from "lucide-react";

// Scripted duplicate of components/ScanLovedOneSheet — same "scanning" beat
// and visual language, but resolves to a *pending* request instead of an
// instant link: this scenario exists to show off the elder-side accept flow
// (WalkthroughNotificationsScreen), so scanning Margaret's QR sends a request
// rather than connecting immediately. No account-creation phase either — the
// scenario stays fully offline/scripted, same as every other walkthrough screen.
export function WalkthroughCaregiverOnboardingScan({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  const [phase, setPhase] = useState<"scanning" | "pending">("scanning");

  useEffect(() => {
    if (phase !== "scanning") return;
    const timer = window.setTimeout(() => setPhase("pending"), 1100);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={phase !== "scanning" ? onClose : undefined} />
      <div className="relative bg-card rounded-t-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90%]">
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        <div className="overflow-y-auto scrollbar-none px-6 pb-8 pt-2">
          {phase === "scanning" ? (
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
          ) : (
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="w-16 h-16 rounded-full bg-amber-500 flex items-center justify-center animate-in zoom-in duration-300">
                <ShieldQuestion size={28} className="text-white" strokeWidth={2.5} />
              </div>
              <div>
                <p className="font-['Fraunces'] text-xl font-semibold text-foreground">Request sent to Margaret</p>
                <p className="text-sm text-muted-foreground mt-1">She'll need to accept before you can see her medications</p>
              </div>
              <div className="w-full bg-muted/40 rounded-2xl divide-y divide-border/60 text-left">
                <div className="flex items-center gap-3 px-4 py-3">
                  <ClipboardList size={16} className="text-primary shrink-0" />
                  <p className="text-sm text-foreground">Once she accepts, you'll see her medication schedule and doses</p>
                </div>
                <div className="flex items-center gap-3 px-4 py-3">
                  <Bell size={16} className="text-primary shrink-0" />
                  <p className="text-sm text-foreground">You'll be alerted on missed doses and low refills</p>
                </div>
              </div>
              <button onClick={onConfirm} className="w-full bg-primary text-primary-foreground rounded-2xl py-3.5 text-sm font-semibold mt-2 active:scale-[0.98] transition-transform">
                Continue
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
