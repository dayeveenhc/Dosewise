import { useState } from "react";
import { X, Check, Plus, Pill } from "lucide-react";
import type { Medication } from "../types";
import { MED_COLOURS, PRESET_TIMES } from "../data/medications";

interface AddPrescriptionSheetProps {
  onClose: () => void;
  onAdd: (med: Omit<Medication, "id" | "medicationId" | "status" | "colour">) => void;
}

export function AddPrescriptionSheet({ onClose, onAdd }: AddPrescriptionSheetProps) {
  const [name, setName] = useState("");
  const [dose, setDose] = useState("");
  const [purpose, setPurpose] = useState("");
  const [time, setTime] = useState("8:00 AM");
  const [customTime, setCustomTime] = useState("");
  const [useCustomTime, setUseCustomTime] = useState(false);
  const [refillDays, setRefillDays] = useState("");
  const [colour, setColour] = useState(MED_COLOURS[0].hex);

  const isValid = name.trim() && dose.trim() && purpose.trim();

  const handleAdd = () => {
    if (!isValid) return;
    onAdd({
      name: name.trim(),
      dose: dose.trim(),
      purpose: purpose.trim(),
      time: useCustomTime ? customTime || time : time,
      refillDaysLeft: refillDays ? parseInt(refillDays) : undefined,
    });
    onClose();
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative bg-card rounded-t-3xl shadow-2xl overflow-hidden flex flex-col max-h-[88%]">
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-3 pt-1 border-b border-border shrink-0">
          <div>
            <h2 className="font-['Fraunces'] text-lg font-semibold text-foreground">Add Prescription</h2>
            <p className="text-xs text-muted-foreground">Caregiver-entered — patient sees this automatically</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
            <X size={14} className="text-foreground" />
          </button>
        </div>

        {/* Form */}
        <div className="overflow-y-auto scrollbar-none px-5 py-4 space-y-4">
          {/* Medication name */}
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">Medication name <span className="text-destructive">*</span></label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Metformin"
              className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

          {/* Dose */}
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">Dose <span className="text-destructive">*</span></label>
            <input
              value={dose}
              onChange={e => setDose(e.target.value)}
              placeholder="e.g. 500mg, 2 tablets, 1 drop each eye"
              className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

          {/* Purpose */}
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">Purpose / Condition <span className="text-destructive">*</span></label>
            <input
              value={purpose}
              onChange={e => setPurpose(e.target.value)}
              placeholder="e.g. Diabetes, Blood Pressure"
              className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

          {/* Time */}
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">Scheduled time</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {PRESET_TIMES.map(t => (
                <button
                  key={t}
                  onClick={() => { setTime(t); setUseCustomTime(false); }}
                  className={`text-xs font-medium rounded-xl px-3 py-1.5 border transition-colors ${!useCustomTime && time === t ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-border"}`}
                >
                  {t}
                </button>
              ))}
              <button
                onClick={() => setUseCustomTime(true)}
                className={`text-xs font-medium rounded-xl px-3 py-1.5 border transition-colors ${useCustomTime ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-border"}`}
              >
                Custom
              </button>
            </div>
            {useCustomTime && (
              <input
                value={customTime}
                onChange={e => setCustomTime(e.target.value)}
                placeholder="e.g. 10:30 AM"
                className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
              />
            )}
          </div>

          {/* Refill supply */}
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">Current supply (days remaining)</label>
            <input
              type="number"
              value={refillDays}
              onChange={e => setRefillDays(e.target.value)}
              placeholder="e.g. 28"
              min={1}
              className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
            />
            <p className="text-[11px] text-muted-foreground mt-1">You will be alerted when this drops below your threshold.</p>
          </div>

          {/* Colour */}
          <div>
            <label className="block text-xs font-semibold text-foreground mb-2">Colour label</label>
            <div className="flex gap-3">
              {MED_COLOURS.map(c => (
                <button
                  key={c.hex}
                  onClick={() => setColour(c.hex)}
                  className="w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all"
                  style={{ backgroundColor: c.hex, borderColor: colour === c.hex ? c.hex : "transparent", boxShadow: colour === c.hex ? `0 0 0 2px white, 0 0 0 4px ${c.hex}` : "none" }}
                  title={c.label}
                >
                  {colour === c.hex && <Check size={14} className="text-white" />}
                </button>
              ))}
            </div>
          </div>

          {/* Preview */}
          {isValid && (
            <div className="bg-secondary border border-primary/20 rounded-xl p-3 flex items-center gap-3">
              <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: `${colour}20` }}>
                <Pill size={16} style={{ color: colour }} />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{name} <span className="text-xs font-normal text-muted-foreground">{dose}</span></p>
                <p className="text-[11px] text-muted-foreground">{purpose} · {useCustomTime ? customTime || time : time}</p>
              </div>
            </div>
          )}
        </div>

        {/* Submit */}
        <div className="px-5 py-4 border-t border-border shrink-0">
          <button
            onClick={handleAdd}
            disabled={!isValid}
            className="w-full bg-primary text-primary-foreground rounded-2xl py-3.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 transition-opacity"
          >
            <Plus size={16} /> Add to {name || "medication"} schedule
          </button>
        </div>
      </div>
    </div>
  );
}
