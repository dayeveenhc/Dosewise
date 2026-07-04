import { X } from "lucide-react";
import type { Patient } from "../types";
import { AIScreen } from "./AIScreen";

export function WeeklySummarySheet({ patient, onClose }: { patient: Patient; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative bg-card rounded-t-3xl shadow-2xl overflow-hidden flex flex-col max-h-[88%]">
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>
        <button
          onClick={onClose}
          className="absolute top-3 right-4 w-8 h-8 rounded-full bg-muted flex items-center justify-center z-10"
        >
          <X size={15} className="text-foreground" />
        </button>
        <div className="flex-1 overflow-y-auto scrollbar-none pb-4">
          <AIScreen patient={patient} />
        </div>
      </div>
    </div>
  );
}
