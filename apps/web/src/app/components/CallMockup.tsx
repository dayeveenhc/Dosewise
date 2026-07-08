import { useEffect, useState } from "react";
import { PhoneOff } from "lucide-react";

// A mockup calling screen — tel: links go nowhere useful in a desktop browser,
// so this gives visible feedback that the call button actually did something.
export function CallMockup({ name, role, onEnd }: { name: string; role?: string; onEnd: () => void }) {
  const [connected, setConnected] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const initials = name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();

  useEffect(() => {
    const connectTimer = setTimeout(() => setConnected(true), 2200);
    return () => clearTimeout(connectTimer);
  }, []);

  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [connected]);

  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <div className="absolute inset-0 z-[250] bg-gradient-to-b from-emerald-900 via-emerald-950 to-black flex flex-col items-center justify-between py-16 px-6 text-white">
      <div className="flex flex-col items-center gap-2 mt-10">
        <p className="text-sm text-emerald-200 uppercase tracking-widest font-medium">{connected ? "Connected" : "Calling…"}</p>
        <div className={`w-24 h-24 rounded-full bg-white/10 flex items-center justify-center text-3xl font-bold mt-4 ${connected ? "" : "animate-pulse"}`}>
          {initials}
        </div>
        <p className="text-xl font-semibold mt-4">{name}</p>
        {role && <p className="text-sm text-emerald-200">{role}</p>}
        {connected && <p className="text-sm text-emerald-300 font-mono mt-1">{mm}:{ss}</p>}
      </div>
      <button
        onClick={onEnd}
        className="w-16 h-16 rounded-full bg-red-600 flex items-center justify-center shadow-xl active:scale-95 transition-transform"
      >
        <PhoneOff size={26} className="text-white" />
      </button>
    </div>
  );
}
