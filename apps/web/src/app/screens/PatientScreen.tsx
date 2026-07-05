import { Activity, AlertTriangle, Info, Star, User, Phone, Plus, Trash2 } from "lucide-react";
import type { Patient } from "../types";
import { Card, SectionHeader } from "../components/shared";
import { MED_PHOTOS, MED_FREQUENCY } from "../data/medications";
import type { Medication } from "../types";

interface PatientScreenProps {
  patient: Patient;
  onEditProfile: () => void;
  onAddPrescription: () => void;
  onDeleteMedication: (medicationId: string) => void;
}

interface GroupedMedication {
  medicationId: string;
  name: string;
  dose: string;
  purpose: string;
  colour: string;
  times: string[];
  refillDaysLeft?: number;
}

function groupMedications(medications: Medication[]): GroupedMedication[] {
  const groups = new Map<string, GroupedMedication>();
  for (const m of medications) {
    const existing = groups.get(m.medicationId);
    if (existing) {
      existing.times.push(m.time);
      if (m.refillDaysLeft && (!existing.refillDaysLeft || m.refillDaysLeft < existing.refillDaysLeft)) {
        existing.refillDaysLeft = m.refillDaysLeft;
      }
    } else {
      groups.set(m.medicationId, {
        medicationId: m.medicationId,
        name: m.name,
        dose: m.dose,
        purpose: m.purpose,
        colour: m.colour,
        times: [m.time],
        refillDaysLeft: m.refillDaysLeft,
      });
    }
  }
  return Array.from(groups.values());
}

export function PatientScreen({ patient, onEditProfile, onAddPrescription, onDeleteMedication }: PatientScreenProps) {
  const groupedMedications = groupMedications(patient.medications);
  return (
    <div className="px-4 py-5 space-y-5">
      {/* Header card */}
      <Card className="overflow-hidden">
        <div className="h-20 bg-gradient-to-br from-primary to-sky-800" />
        <div className="px-4 pb-4 -mt-10">
          <img src={patient.photo} alt={patient.name} className="w-20 h-20 rounded-2xl object-cover border-4 border-white shadow-md bg-muted" />
          <h2 className="font-['Fraunces'] text-xl font-semibold text-foreground mt-2">{patient.name}</h2>
          <p className="text-sm text-muted-foreground">{patient.relation} · Age {patient.age}</p>
          <div className="flex gap-2 mt-3 flex-wrap">
            <span className="text-[11px] bg-secondary text-primary border border-primary/20 rounded-full px-2.5 py-1 font-medium">Blood Type {patient.bloodType}</span>
            <span className="text-[11px] bg-muted text-muted-foreground border border-border rounded-full px-2.5 py-1 font-medium">{patient.conditions.length} Conditions</span>
            <span className="text-[11px] bg-muted text-muted-foreground border border-border rounded-full px-2.5 py-1 font-medium">{patient.medications.length} Medications</span>
          </div>
        </div>
      </Card>

      {/* Conditions */}
      <div>
        <SectionHeader title="Medical Conditions" action="Edit" onAction={onEditProfile} />
        <Card className="divide-y divide-border">
          {patient.conditions.length > 0 ? patient.conditions.map((c, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Activity size={15} className="text-primary shrink-0" />
              <span className="text-sm text-foreground font-medium">{c}</span>
            </div>
          )) : (
            <div className="px-4 py-4 text-sm text-muted-foreground">No conditions recorded. <button onClick={onEditProfile} className="text-primary underline">Add one</button></div>
          )}
        </Card>
      </div>

      {/* Allergies */}
      <div>
        <SectionHeader title="Known Allergies" action="Edit" onAction={onEditProfile} />
        {patient.allergies.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {patient.allergies.map((a, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 bg-red-50 text-red-800 border border-red-200 rounded-xl px-3 py-1.5 text-sm font-semibold">
                <AlertTriangle size={13} className="text-red-600" /> {a}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No allergies recorded. <button onClick={onEditProfile} className="text-primary underline">Add one</button></p>
        )}
      </div>

      {/* Current medications */}
      <div>
        <SectionHeader title="Current Medications" action="+ Add" onAction={onAddPrescription} />
        <Card className="divide-y divide-border">
          {groupedMedications.map((m) => (
            <div key={m.name} className="px-4 py-3 flex items-center gap-3">
              <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 bg-muted">
                <img
                  src={MED_PHOTOS[m.name] ?? "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=120&h=120&fit=crop&auto=format"}
                  alt={m.name}
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">{m.name} <span className="text-xs font-normal text-muted-foreground">{m.dose}</span></p>
                <p className="text-[11px] text-muted-foreground">{m.purpose} · {m.times.join(" & ")}</p>
                {MED_FREQUENCY[m.name] && (
                  <p className="text-[11px] text-muted-foreground">{MED_FREQUENCY[m.name]}</p>
                )}
                {m.refillDaysLeft && m.refillDaysLeft <= 7 && (
                  <p className="text-[11px] text-amber-700 font-medium mt-0.5">{m.refillDaysLeft} days of supply left</p>
                )}
              </div>
              <button
                onClick={() => onDeleteMedication(m.medicationId)}
                className="w-7 h-7 rounded-full bg-red-50 border border-red-200 flex items-center justify-center shrink-0 hover:bg-red-100 transition-colors"
                title="Remove medication"
              >
                <Trash2 size={12} className="text-red-600" />
              </button>
            </div>
          ))}
          <button
            onClick={onAddPrescription}
            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted transition-colors"
          >
            <div className="w-8 h-8 rounded-full bg-secondary border border-primary/20 flex items-center justify-center shrink-0">
              <Plus size={14} className="text-primary" />
            </div>
            <span className="text-sm text-primary font-semibold">Add prescription</span>
          </button>
        </Card>
      </div>

      {/* Emergency contacts */}
      <div>
        <SectionHeader title="Emergency Contacts" action="Edit" onAction={onEditProfile} />
        <Card className="divide-y divide-border">
          {patient.contacts.map((c, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${c.isPrimary ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                {c.isPrimary ? <Star size={13} /> : <User size={13} className="text-muted-foreground" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">{c.name}</p>
                <p className="text-[11px] text-muted-foreground">{c.role}</p>
              </div>
              <a href={`tel:${c.phone}`} className="w-8 h-8 bg-emerald-50 border border-emerald-200 rounded-full flex items-center justify-center">
                <Phone size={13} className="text-emerald-700" />
              </a>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
