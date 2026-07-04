import { useState } from "react";
import { CheckCircle2, AlertTriangle, Circle, X, ChevronDown, Plus } from "lucide-react";
import type { MedStatus, Patient } from "../types";

export function StatusPill({ status, small = false }: { status: MedStatus; small?: boolean }) {
  const map: Record<MedStatus, { label: string; icon: React.ReactNode; cls: string }> = {
    taken: { label: "Taken", icon: <CheckCircle2 size={small ? 11 : 13} />, cls: "bg-emerald-50 text-emerald-700 border border-emerald-200" },
    missed: { label: "Missed", icon: <AlertTriangle size={small ? 11 : 13} />, cls: "bg-orange-50 text-orange-700 border border-orange-200" },
    upcoming: { label: "Upcoming", icon: <Circle size={small ? 11 : 13} />, cls: "bg-sky-50 text-sky-700 border border-sky-200" },
    skipped: { label: "Skipped", icon: <X size={small ? 11 : 13} />, cls: "bg-stone-100 text-stone-500 border border-stone-200" },
  };
  const { label, icon, cls } = map[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-medium ${small ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"} ${cls}`}>
      {icon} {label}
    </span>
  );
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-sm font-semibold text-foreground/70 uppercase tracking-widest">{title}</h3>
      {action && <button onClick={onAction} className="text-xs text-primary font-medium">{action}</button>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-card rounded-2xl shadow-sm border border-border ${className}`}>{children}</div>;
}

export function QuickAction({ icon, label, colour, onClick }: { icon: React.ReactNode; label: string; colour: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1.5 flex-1">
      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${colour}`}>
        {icon}
      </div>
      <span className="text-[10px] font-medium text-muted-foreground text-center leading-tight">{label}</span>
    </button>
  );
}

export function PatientSwitcher({ patients, selected, onSelect }: { patients: Patient[]; selected: number; onSelect: (i: number) => void }) {
  const [open, setOpen] = useState(false);
  const patient = patients[selected];

  return (
    <div className="relative z-[200]">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 bg-white/70 backdrop-blur-sm border border-border rounded-2xl px-3 py-2 w-full"
      >
        <img src={patient.photo} alt={patient.name} className="w-8 h-8 rounded-full object-cover bg-muted" />
        <div className="flex-1 text-left">
          <div className="text-xs font-semibold text-foreground leading-tight">{patient.nickname} · {patient.relation}</div>
          <div className="text-[10px] text-muted-foreground">Checked {patient.lastChecked}</div>
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
                <div className="text-[10px] text-muted-foreground">{p.relation} · Age {p.age}</div>
              </div>
              {i === selected && <CheckCircle2 size={14} className="ml-auto text-primary" />}
            </button>
          ))}
          <button className="flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-muted border-t border-border">
            <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
              <Plus size={14} className="text-muted-foreground" />
            </div>
            <span className="text-xs text-muted-foreground font-medium">Add care recipient</span>
          </button>
        </div>
      )}
    </div>
  );
}
