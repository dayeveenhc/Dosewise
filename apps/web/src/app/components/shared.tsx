import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, Circle, X, ChevronDown, Plus, Droplets, QrCode } from "lucide-react";
import type { MedStatus, Patient } from "../types";
import { MED_PHOTOS, MED_PHOTO_FALLBACKS } from "../data/medications";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

// Deterministic index per medication name, so a given medicine always draws the
// same fallback photo instead of jittering between renders.
function nameHash(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

// Every medicine shows a photo now — a bundled one where we have it, otherwise a
// deterministic generic medicine photo. Both are illustrative stock imagery
// rather than the real pill; MED_SHAPES is the accurate physical identifier.
export function medPhoto(name: string): string {
  return MED_PHOTOS[name] ?? MED_PHOTO_FALLBACKS[nameHash(name) % MED_PHOTO_FALLBACKS.length];
}

export function MedAvatar({ name, size, className = "" }: { name: string; size: number; className?: string }) {
  return (
    <img
      src={medPhoto(name)}
      alt=""
      style={{ width: size, height: size }}
      className={`object-cover bg-muted ${className}`}
    />
  );
}

export function LiveStatusBar({ className = "" }: { className?: string }) {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const intervalId = window.setInterval(() => setCurrentTime(new Date()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <div className={`flex items-center justify-between px-6 pt-3 pb-1 shrink-0 ${className}`}>
      <span className="text-xs font-semibold text-foreground font-mono">
        {currentTime.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit" })}
      </span>
      <div className="flex items-center gap-1.5">
        <div className="flex gap-0.5 items-end h-3">
          {[2, 3, 4, 4].map((height, i) => <div key={i} className="w-1 bg-foreground rounded-sm" style={{ height: `${height * 3}px` }} />)}
        </div>
        <Droplets size={11} className="text-foreground" />
        <span className="text-xs font-semibold text-foreground font-mono">100%</span>
      </div>
    </div>
  );
}

export function StatusPill({ status, small = false }: { status: MedStatus; small?: boolean }) {
  const { language } = useLanguage();
  // Status colours come from the shared tokens (styles/theme.css) so the
  // caregiver's chips track the elder's cards — including under the contrast
  // and colour-vision modes, which a hardcoded Tailwind palette would ignore.
  const map: Record<MedStatus, { label: string; icon: React.ReactNode; cls: string }> = {
    taken: { label: t(language, "common.taken"), icon: <CheckCircle2 size={small ? 11 : 13} />, cls: "bg-taken-bg text-taken-fg border border-taken-border" },
    missed: { label: t(language, "common.missed"), icon: <AlertTriangle size={small ? 11 : 13} />, cls: "bg-missed-bg text-missed-fg border border-missed-border" },
    upcoming: { label: t(language, "common.upcoming"), icon: <Circle size={small ? 11 : 13} />, cls: "bg-upcoming-bg text-upcoming-fg border border-upcoming-border" },
    skipped: { label: t(language, "common.skipped"), icon: <X size={small ? 11 : 13} />, cls: "bg-muted text-muted-foreground border border-border" },
  };
  const { label, icon, cls } = map[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-medium ${small ? "px-2 py-0.5 text-[calc(10px*var(--dw-text,1))]" : "px-2.5 py-1 text-xs"} ${cls}`}>
      {icon} {label}
    </span>
  );
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <h3 className="text-[calc(11px*var(--dw-text,1))] font-bold text-muted-foreground uppercase tracking-widest px-1">{title}</h3>
      {action && <button onClick={onAction} className="text-[calc(12px*var(--dw-text,1))] text-primary font-bold px-1">{action}</button>}
    </div>
  );
}

export function Card({ children, className = "", "data-tour": dataTour }: { children: React.ReactNode; className?: string; "data-tour"?: string }) {
  return <div className={`dw-surface ${className}`} data-tour={dataTour}>{children}</div>;
}

export function QuickAction({ icon, label, colour, onClick }: { icon: React.ReactNode; label: string; colour: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1.5 flex-1 dw-press">
      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${colour}`}>
        {icon}
      </div>
      <span className="text-[calc(11px*var(--dw-text,1))] font-semibold text-foreground text-center leading-tight">{label}</span>
    </button>
  );
}

export function PatientSwitcher({ patients, selected, onSelect, onAdd, onScan }: { patients: Patient[]; selected: number; onSelect: (i: number) => void; onAdd: (name: string, relation: string) => void; onScan?: () => void }) {
  const { language } = useLanguage();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRelation, setNewRelation] = useState("");
  const patient = patients[selected];

  const submitAdd = () => {
    if (!newName.trim()) return;
    onAdd(newName.trim(), newRelation.trim() || t(language, "patientSwitcher.careRecipientDefault"));
    setNewName(""); setNewRelation(""); setAdding(false); setOpen(false);
  };

  return (
    <div className="relative z-[200]">
      <button
        onClick={() => setOpen(!open)}
        data-tour="cg-patientswitcher"
        className="flex items-center gap-2.5 bg-card/70 backdrop-blur-sm border border-border rounded-2xl px-3 py-2 w-full active:bg-muted/60 transition-colors"
      >
        <img src={patient.photo} alt={patient.name} className="w-8 h-8 rounded-full object-cover bg-muted" />
        <div className="flex-1 text-left">
          <div className="text-xs font-semibold text-foreground leading-tight">{patient.nickname} · {patient.relation}</div>
          <div className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground">{t(language, "patientSwitcher.checked", { time: patient.lastChecked })}</div>
        </div>
        <ChevronDown size={14} className={`text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1.5 bg-card rounded-2xl shadow-xl border border-border z-[200] overflow-hidden">
          {patients.map((p, i) => (
            <button
              key={p.id}
              onClick={() => { onSelect(i); setOpen(false); }}
              className={`flex items-center gap-3 w-full px-3 py-2.5 text-left transition-colors ${i === selected ? "bg-secondary" : "hover:bg-muted"}`}
            >
              <img src={p.photo} alt={p.name} className="w-8 h-8 rounded-full object-cover bg-muted" />
              <div>
                <div className="text-xs font-semibold text-foreground">{p.name}</div>
                <div className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground">{t(language, "common.relationAge", { relation: p.relation, age: p.age })}</div>
              </div>
              {i === selected && <CheckCircle2 size={14} className="ml-auto text-primary" />}
            </button>
          ))}
          {adding ? (
            <div className="p-3 border-t border-border space-y-2">
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder={t(language, "common.fullName")}
                className="w-full bg-input-background border border-border rounded-xl px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
              />
              <input
                value={newRelation}
                onChange={e => setNewRelation(e.target.value)}
                placeholder={t(language, "patientSwitcher.relationPlaceholder")}
                className="w-full bg-input-background border border-border rounded-xl px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
              />
              <div className="flex gap-2">
                <button onClick={submitAdd} disabled={!newName.trim()} className="flex-1 bg-primary text-primary-foreground rounded-xl py-1.5 text-xs font-semibold disabled:opacity-40">
                  {t(language, "wizard.add")}
                </button>
                <button onClick={() => { setAdding(false); setNewName(""); setNewRelation(""); }} className="px-3 rounded-xl border border-border text-xs font-semibold text-muted-foreground">
                  {t(language, "common.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <>
              {onScan && (
                <button onClick={() => { setOpen(false); onScan(); }} data-walk="patientswitcher-scan-qr" className="flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-muted border-t border-border">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <QrCode size={14} className="text-primary" />
                  </div>
                  <span className="text-xs text-foreground font-medium">{t(language, "patientSwitcher.scanQr")}</span>
                </button>
              )}
              <button onClick={() => setAdding(true)} className="flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-muted border-t border-border">
                <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                  <Plus size={14} className="text-muted-foreground" />
                </div>
                <span className="text-xs text-muted-foreground font-medium">{t(language, "patientSwitcher.addCareRecipient")}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
