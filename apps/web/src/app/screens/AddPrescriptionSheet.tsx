import { useState, useRef } from "react";
import type { ReactNode, ChangeEvent } from "react";
import { X, Check, Plus, Pill, Camera, PenLine, Image as ImageIcon, Sparkles } from "lucide-react";
import type { Medication } from "../types";
import { MED_COLOURS, PRESET_TIMES, MEDICATION_CATALOG, COMMON_CONDITIONS, MED_PHOTOS } from "../data/medications";

interface AddPrescriptionSheetProps {
  onClose: () => void;
  onAdd: (med: Omit<Medication, "id" | "status">) => void;
  initialTab?: "scan" | "manual";
}

// A small type-ahead input: shows filtered suggestions as the user types.
function TypeAhead<T>({ value, onChange, onPick, items, filter, label, render, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  onPick: (item: T) => void;
  items: T[];
  filter: (item: T, q: string) => boolean;
  label: (item: T) => string;
  render?: (item: T) => ReactNode;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const q = value.trim().toLowerCase();
  const matches = q ? items.filter(i => filter(i, q)).slice(0, 6) : [];
  const showList = open && matches.length > 0 && !(matches.length === 1 && label(matches[0]).toLowerCase() === q);

  return (
    <div className="relative">
      <input
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
      />
      {showList && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-card border border-border rounded-xl shadow-lg overflow-hidden max-h-56 overflow-y-auto scrollbar-none">
          {matches.map((item, i) => (
            <button
              key={i}
              onMouseDown={e => { e.preventDefault(); onPick(item); setOpen(false); }}
              className="w-full text-left px-3.5 py-2.5 hover:bg-muted active:bg-muted border-b border-border/50 last:border-0 transition-colors"
            >
              {render ? render(item) : <span className="text-sm text-foreground">{label(item)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AddPrescriptionSheet({ onClose, onAdd, initialTab = "manual" }: AddPrescriptionSheetProps) {
  const [tab, setTab] = useState<"scan" | "manual">(initialTab);
  const [scannedPhoto, setScannedPhoto] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [fromScan, setFromScan] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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
      colour,
    });
    onClose();
  };

  const pickMedication = (m: { name: string; purpose: string; dose: string }) => {
    setName(m.name);
    if (!purpose.trim()) setPurpose(m.purpose);
    if (!dose.trim()) setDose(m.dose);
  };

  // Simulated label scan: reads a photo, then pre-fills the form for review.
  // (Mockup only — real OCR would replace runScan.)
  const runScan = (photoUrl: string, demo: { name: string; purpose: string; dose: string }) => {
    setScannedPhoto(photoUrl);
    setScanning(true);
    setTimeout(() => {
      setName(demo.name);
      setDose(demo.dose);
      setPurpose(demo.purpose);
      setRefillDays("30");
      setScanning(false);
      setFromScan(true);
      setTab("manual");
    }, 1300);
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    runScan(URL.createObjectURL(file), MEDICATION_CATALOG[0]);
  };

  const inputCls = "w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors";

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative bg-card rounded-t-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90%]">
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-3 pt-1 border-b border-border shrink-0">
          <div>
            <h2 className="font-['Fraunces'] text-lg font-semibold text-foreground">Add refill / prescription</h2>
            <p className="text-xs text-muted-foreground">Snap the label or type it in</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
            <X size={14} className="text-foreground" />
          </button>
        </div>

        {/* Mode toggle */}
        <div className="px-5 pt-3 shrink-0">
          <div className="flex gap-2 bg-muted rounded-xl p-1">
            <button
              onClick={() => setTab("scan")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-semibold transition-colors ${tab === "scan" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              <Camera size={16} />Scan photo
            </button>
            <button
              onClick={() => setTab("manual")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-semibold transition-colors ${tab === "manual" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              <PenLine size={16} />Enter manually
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto scrollbar-none px-5 py-4 space-y-4">
          {tab === "scan" ? (
            <div className="space-y-3">
              <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFile} />
              {scanning ? (
                <div className="border-2 border-primary/30 bg-primary/5 rounded-2xl p-6 flex flex-col items-center text-center gap-3">
                  {scannedPhoto && <img src={scannedPhoto} alt="scan" className="w-24 h-24 rounded-xl object-cover" />}
                  <div className="flex items-center gap-2 text-primary">
                    <Sparkles size={16} className="animate-pulse" />
                    <span className="text-sm font-semibold">Reading the label…</span>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="w-full border-2 border-dashed border-border rounded-2xl p-6 flex flex-col items-center text-center gap-2 active:bg-muted/50 transition-colors"
                  >
                    <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                      <Camera size={26} className="text-primary" />
                    </div>
                    <p className="text-[15px] font-semibold text-foreground">Take a photo</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">Snap the medicine box or the prescription label — we'll fill in the details for you to check.</p>
                  </button>
                  <button
                    onClick={() => runScan(MED_PHOTOS["Metformin"], MEDICATION_CATALOG[0])}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-muted text-sm font-semibold text-foreground active:bg-muted/70"
                  >
                    <ImageIcon size={15} />Try with a sample photo
                  </button>
                  <p className="text-center text-[11px] text-muted-foreground">Prefer to type it?{" "}
                    <button onClick={() => setTab("manual")} className="text-primary font-semibold underline">Enter manually</button>
                  </p>
                </>
              )}
            </div>
          ) : (
            <>
              {fromScan && (
                <div className="bg-primary/5 border border-primary/20 rounded-xl px-3 py-2.5 flex items-center gap-2">
                  <Sparkles size={14} className="text-primary shrink-0" />
                  <p className="text-xs text-foreground">Filled in from your photo — please check it's correct.</p>
                </div>
              )}

              {/* Medication name — type-ahead */}
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">Medication name <span className="text-destructive">*</span></label>
                <TypeAhead
                  value={name}
                  onChange={setName}
                  onPick={pickMedication}
                  items={MEDICATION_CATALOG}
                  filter={(m, q) => m.name.toLowerCase().includes(q)}
                  label={m => m.name}
                  placeholder="Start typing, e.g. Metf…"
                  render={m => (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">{m.name}</span>
                      <span className="text-[11px] text-muted-foreground">{m.purpose} · {m.dose}</span>
                    </div>
                  )}
                />
              </div>

              {/* Dose */}
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">Dose <span className="text-destructive">*</span></label>
                <input value={dose} onChange={e => setDose(e.target.value)} placeholder="e.g. 500mg, 2 tablets, 1 drop each eye" className={inputCls} />
              </div>

              {/* Purpose / condition — type-ahead */}
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">Purpose / Condition <span className="text-destructive">*</span></label>
                <TypeAhead
                  value={purpose}
                  onChange={setPurpose}
                  onPick={c => setPurpose(c)}
                  items={COMMON_CONDITIONS}
                  filter={(c, q) => c.toLowerCase().includes(q)}
                  label={c => c}
                  placeholder="e.g. Diabetes, Blood Pressure"
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
                  <input value={customTime} onChange={e => setCustomTime(e.target.value)} placeholder="e.g. 10:30 AM" className={inputCls} />
                )}
              </div>

              {/* Refill supply */}
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">Current supply (days remaining)</label>
                <input type="number" value={refillDays} onChange={e => setRefillDays(e.target.value)} placeholder="e.g. 28" min={1} className={inputCls} />
                <p className="text-[11px] text-muted-foreground mt-1">You'll be alerted when this runs low.</p>
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
            </>
          )}
        </div>

        {/* Submit (manual only) */}
        {tab === "manual" && (
          <div className="px-5 py-4 border-t border-border shrink-0">
            <button
              onClick={handleAdd}
              disabled={!isValid}
              className="w-full bg-primary text-primary-foreground rounded-2xl py-3.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 transition-opacity"
            >
              <Plus size={16} /> Add {name || "medication"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
