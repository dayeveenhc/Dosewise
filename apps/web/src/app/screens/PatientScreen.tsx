import { Activity, AlertTriangle, Info, Star, User, Phone, Plus, Trash2, History, Check } from "lucide-react";
import { slugify } from "../lib/changeHighlight";
import type { Patient } from "../types";
import { Card, SectionHeader, MedAvatar, ProfileAvatar } from "../components/shared";
import { MED_FREQUENCY, localizeCatalogValue } from "../data/medications";
import { cadenceLabel, WEEKDAY_TOKENS } from "../lib/medications";
import type { Medication } from "../types";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

interface PatientScreenProps {
  patient: Patient;
  justAddedMed?: string | null;
  onEditProfile: () => void;
  onAddPrescription: () => void;
  onDeleteMedication: (id: number) => void;
}

interface GroupedMedication {
  ids: number[];
  medicationId?: string; // real medications.id (uuid) — the highlight anchor
  name: string;
  dose: string;
  purpose: string;
  colour: string;
  times: string[];
  refillDaysLeft?: number;
  days?: string[];
  intervalDays?: number;
}

function groupMedications(medications: Medication[]): GroupedMedication[] {
  const groups = new Map<string, GroupedMedication>();
  for (const m of medications) {
    const existing = groups.get(m.name);
    if (existing) {
      existing.ids.push(m.id);
      existing.times.push(m.time);
      if (m.refillDaysLeft && (!existing.refillDaysLeft || m.refillDaysLeft < existing.refillDaysLeft)) {
        existing.refillDaysLeft = m.refillDaysLeft;
      }
    } else {
      groups.set(m.name, {
        ids: [m.id],
        medicationId: m.medicationId,
        name: m.name,
        dose: m.dose,
        purpose: m.purpose,
        colour: m.colour,
        times: [m.time],
        refillDaysLeft: m.refillDaysLeft,
        days: m.days,
        intervalDays: m.intervalDays,
      });
    }
  }
  return Array.from(groups.values());
}

export function PatientScreen({ patient, justAddedMed, onEditProfile, onAddPrescription, onDeleteMedication }: PatientScreenProps) {
  const { language } = useLanguage();
  const groupedMedications = groupMedications(patient.medications);
  // The medicine's real cadence ("Mon, Thu" / "Every 2 days"); MED_FREQUENCY
  // below is the older hardcoded demo copy and only shows when there is none.
  const cadenceFor = (m: GroupedMedication) => cadenceLabel(
    m,
    Object.fromEntries(WEEKDAY_TOKENS.map(d => [d, t(language, `common.dayShort.${d}`)])),
    n => t(language, "prescription.everyNDays", { n }),
  );
  return (
    <div className="px-4 py-5 space-y-5">
      {/* Header card */}
      <Card className="overflow-hidden">
        <div className="h-20 bg-gradient-to-br from-primary to-accent" />
        <div className="px-4 pb-4 -mt-10">
          <ProfileAvatar photo={patient.photo} size={80} className="rounded-2xl border-4 border-card shadow-md" />
          <h2 className="dw-display text-[calc(20px*var(--dw-text,1))] font-semibold text-foreground mt-2">{patient.name}</h2>
          <p className="text-sm text-muted-foreground">{t(language, "common.relationAge", { relation: patient.relation, age: patient.age })}</p>
          <div className="flex gap-2 mt-3 flex-wrap">
            <span className="text-[calc(11px*var(--dw-text,1))] bg-secondary text-primary border border-primary/20 rounded-full px-2.5 py-1 font-medium">{t(language, "common.bloodType", { type: patient.bloodType })}</span>
            <span className="text-[calc(11px*var(--dw-text,1))] bg-muted text-muted-foreground border border-border rounded-full px-2.5 py-1 font-medium">{t(language, "common.conditionsCount", { count: patient.conditions.length })}</span>
            <span className="text-[calc(11px*var(--dw-text,1))] bg-muted text-muted-foreground border border-border rounded-full px-2.5 py-1 font-medium">{t(language, "common.medicationsCount", { count: patient.medications.length })}</span>
          </div>
        </div>
      </Card>

      {/* Conditions */}
      <div>
        <SectionHeader title={t(language, "common.medicalConditions")} action={t(language, "common.edit")} onAction={onEditProfile} />
        <Card className="divide-y divide-border">
          {patient.conditions.length > 0 ? patient.conditions.map((c, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Activity size={15} className="text-primary shrink-0" />
              <span className="text-sm text-foreground font-medium">{localizeCatalogValue(c, k => t(language, k))}</span>
            </div>
          )) : (
            <div className="px-4 py-4 text-sm text-muted-foreground">{t(language, "common.noConditionsRecorded")} <button onClick={onEditProfile} className="text-primary underline">{t(language, "common.addOne")}</button></div>
          )}
        </Card>
      </div>

      {/* Allergies */}
      <div>
        <SectionHeader title={t(language, "common.knownAllergies")} action={t(language, "common.edit")} onAction={onEditProfile} />
        {patient.allergies.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {patient.allergies.map((a, i) => (
              <span key={i} data-testid={`allergy-${slugify(a)}`} className="inline-flex items-center gap-1.5 bg-missed-bg text-missed-fg border border-missed-border rounded-xl px-3 py-1.5 text-sm font-semibold">
                <AlertTriangle size={13} className="text-missed-fg" /> {localizeCatalogValue(a, k => t(language, k))}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t(language, "common.noAllergiesRecorded")} <button onClick={onEditProfile} className="text-primary underline">{t(language, "common.addOne")}</button></p>
        )}
      </div>

      {/* Current medications */}
      <div>
        <SectionHeader title={t(language, "common.currentMedications")} action={t(language, "common.add")} onAction={onAddPrescription} />
        <Card className="divide-y divide-border" data-tour="cg-medlist">
          {groupedMedications.map((m) => {
            const justAdded = !!justAddedMed && m.name === justAddedMed;
            return (
            <div key={m.name} data-testid={m.medicationId ? `medication-${m.medicationId}` : undefined} className={`px-4 py-3 flex items-center gap-3 ${justAdded ? "bg-taken-bg/60 ring-2 ring-taken/40 rounded-xl" : ""}`}>
              <MedAvatar name={m.name} size={36} className="rounded-xl shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground flex items-center gap-1.5 flex-wrap">
                  <span>{m.name} <span className="text-xs font-normal text-muted-foreground">{m.dose}</span></span>
                  {justAdded && (
                    <span className="inline-flex items-center gap-1 bg-taken-bg text-taken-fg text-[calc(10px*var(--dw-text,1))] font-bold px-2 py-0.5 rounded-full">
                      <Check size={9} strokeWidth={3} />{t(language, "prescription.justAdded")}
                    </span>
                  )}
                </p>
                <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground">{localizeCatalogValue(m.purpose, k => t(language, k))} · {m.times.join(" & ")}</p>
                {(cadenceFor(m) ?? MED_FREQUENCY[m.name]) && (
                  <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground">{cadenceFor(m) ?? MED_FREQUENCY[m.name]}</p>
                )}
                {m.refillDaysLeft && m.refillDaysLeft <= 7 && (
                  <p className="text-[calc(11px*var(--dw-text,1))] text-warn-fg font-medium mt-0.5">{t(language, "common.daysOfSupplyLeft", { count: m.refillDaysLeft })}</p>
                )}
              </div>
              <button
                onClick={() => m.ids.forEach(onDeleteMedication)}
                className="w-8 h-8 rounded-full bg-missed-bg border border-missed-border flex items-center justify-center shrink-0 active:opacity-80 transition-opacity"
                title={t(language, "common.removeMedication")}
              >
                <Trash2 size={13} className="text-missed-fg" />
              </button>
            </div>
            );
          })}
          <button
            onClick={onAddPrescription}
            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted transition-colors"
          >
            <div className="w-8 h-8 rounded-full bg-secondary border border-primary/20 flex items-center justify-center shrink-0">
              <Plus size={14} className="text-primary" />
            </div>
            <span className="text-sm text-primary font-semibold">{t(language, "common.addPrescription")}</span>
          </button>
        </Card>
      </div>

      {/* Past medications */}
      {(patient.pastMedications?.length ?? 0) > 0 && (
        <div>
          <SectionHeader title={t(language, "common.pastMedications")} />
          <Card className="divide-y divide-border">
            {patient.pastMedications!.map(m => (
              <div key={m.id} data-testid={`medication-${m.id}`} className="px-4 py-3 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <History size={13} className="text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-muted-foreground">{m.name} <span className="text-xs font-normal">{m.dose}</span></p>
                  <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground/80">{localizeCatalogValue(m.purpose, k => t(language, k))}</p>
                </div>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* Emergency contacts */}
      <div>
        <SectionHeader title={t(language, "common.emergencyContacts")} action={t(language, "common.edit")} onAction={onEditProfile} />
        <Card className="divide-y divide-border">
          {patient.contacts.map((c, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${c.isPrimary ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                {c.isPrimary ? <Star size={13} /> : <User size={13} className="text-muted-foreground" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">{c.name}</p>
                <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground">{c.role}</p>
              </div>
              <a href={`tel:${c.phone}`} className="w-8 h-8 bg-taken-bg border border-taken-border rounded-full flex items-center justify-center">
                <Phone size={13} className="text-taken-fg" />
              </a>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
