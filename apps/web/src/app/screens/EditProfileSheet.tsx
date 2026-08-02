import { useState } from "react";
import { X, AlertTriangle, Trash2, Star, Check, Plus } from "lucide-react";
import type { Patient, Contact } from "../types";
import { COMMON_ALLERGIES, COMMON_DRUG_ALLERGIES, localizeCatalogValue } from "../data/medications";
import { withCatalogLabels } from "./setup/GuidedSetupWizard";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

interface EditProfileSheetProps {
  patient: Patient;
  onClose: () => void;
  onSave: (updated: Patient) => void;
}

function AllergyTypeAhead({ value, onChange, onSelect }: { value: string; onChange: (v: string) => void; onSelect: (v: string) => void }) {
  const { language } = useLanguage();
  const suggestions = [...withCatalogLabels(COMMON_ALLERGIES, language), ...withCatalogLabels(COMMON_DRUG_ALLERGIES, language)];
  const q = value.trim().toLowerCase();
  const matches = q ? suggestions.filter(item => item.label.toLowerCase().includes(q)).slice(0, 8) : suggestions.slice(0, 8);
  return (
    <div className="relative">
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={t(language, "editProfile.addAllergy")} className={"w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"} />
      {matches.length > 0 && value.trim().length > 0 && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-card border border-border rounded-xl shadow-lg overflow-hidden max-h-40 overflow-y-auto">
          {matches.map(item => (
            <button key={item.value} onMouseDown={e => { e.preventDefault(); onSelect(item.value); }} className="w-full text-left px-3.5 py-2 text-sm text-foreground hover:bg-muted transition-colors">
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function EditProfileSheet({ patient, onClose, onSave }: EditProfileSheetProps) {
  const { language } = useLanguage();
  const [name, setName] = useState(patient.name);
  const [nickname, setNickname] = useState(patient.nickname);
  const [age, setAge] = useState(String(patient.age));
  const [relation, setRelation] = useState(patient.relation);
  const [bloodType, setBloodType] = useState(patient.bloodType);
  const [conditions, setConditions] = useState<string[]>(patient.conditions);
  const [newCondition, setNewCondition] = useState("");
  const [allergies, setAllergies] = useState<string[]>(patient.allergies);
  const [newAllergy, setNewAllergy] = useState("");
  const [contacts, setContacts] = useState<Contact[]>(patient.contacts);
  const [newContactName, setNewContactName] = useState("");
  const [newContactRole, setNewContactRole] = useState("");
  const [newContactPhone, setNewContactPhone] = useState("");
  const [tab, setTab] = useState<"profile" | "health" | "contacts">("profile");

  const addCondition = () => {
    if (newCondition.trim()) { setConditions(prev => [...prev, newCondition.trim()]); setNewCondition(""); }
  };
  const addAllergy = () => {
    if (newAllergy.trim()) { setAllergies(prev => [...prev, newAllergy.trim()]); setNewAllergy(""); }
  };
  const addContact = () => {
    if (newContactName.trim() && newContactPhone.trim()) {
      setContacts(prev => [...prev, { name: newContactName.trim(), role: newContactRole.trim() || t(language, "editProfile.defaultContactRole"), phone: newContactPhone.trim() }]);
      setNewContactName(""); setNewContactRole(""); setNewContactPhone("");
    }
  };

  const handleSave = () => {
    onSave({ ...patient, name: name.trim(), nickname: nickname.trim(), age: parseInt(age) || patient.age, relation: relation.trim(), bloodType, conditions, allergies, contacts });
    onClose();
  };

  const fieldCls = "w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors";
  const BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative bg-card rounded-t-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92%]">
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-3 pt-1 border-b border-border shrink-0">
          <div>
            <h2 className="font-['Fraunces'] text-lg font-semibold text-foreground">{t(language, "editProfile.title")}</h2>
            <p className="text-xs text-muted-foreground">{t(language, "editProfile.caregiverManaged", { nickname: patient.nickname })}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
            <X size={14} className="text-foreground" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-border shrink-0">
          {(["profile", "health", "contacts"] as const).map(tab_ => (
            <button
              key={tab_}
              onClick={() => setTab(tab_)}
              className={`flex-1 py-2.5 text-xs font-semibold capitalize transition-colors ${tab === tab_ ? "text-primary border-b-2 border-primary" : "text-muted-foreground"}`}
            >
              {tab_ === "profile" ? t(language, "editProfile.tabBasicInfo") : tab_ === "health" ? t(language, "editProfile.tabHealth") : t(language, "editProfile.tabContacts")}
            </button>
          ))}
        </div>

        {/* Form body */}
        <div className="overflow-y-auto scrollbar-none px-5 py-4 space-y-4 flex-1">

          {tab === "profile" && (
            <>
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "editProfile.fullName")}</label>
                <input value={name} onChange={e => setName(e.target.value)} className={fieldCls} placeholder={t(language, "editProfile.fullName")} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "editProfile.nickname")}</label>
                <input value={nickname} onChange={e => setNickname(e.target.value)} className={fieldCls} placeholder={t(language, "editProfile.nicknamePlaceholder")} />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "settings.age")}</label>
                  <input type="number" value={age} onChange={e => setAge(e.target.value)} min={1} max={130} className={fieldCls} />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "editProfile.yourRelation")}</label>
                  <input value={relation} onChange={e => setRelation(e.target.value)} className={fieldCls} placeholder={t(language, "editProfile.relationPlaceholder")} />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "editProfile.bloodType")}</label>
                <div className="flex flex-wrap gap-2">
                  {BLOOD_TYPES.map(bt => (
                    <button
                      key={bt}
                      onClick={() => setBloodType(bt)}
                      className={`text-xs font-semibold rounded-xl px-3 py-1.5 border transition-colors ${bloodType === bt ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-border"}`}
                    >
                      {bt}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {tab === "health" && (
            <>
              <div>
                <label className="block text-xs font-semibold text-foreground mb-2">{t(language, "settings.medicalConditions")}</label>
                <div className="flex flex-wrap gap-2 mb-3">
                  {conditions.map((c, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 bg-secondary border border-primary/20 text-primary rounded-xl px-2.5 py-1 text-xs font-medium">
                      {localizeCatalogValue(c, k => t(language, k))}
                      <button onClick={() => setConditions(prev => prev.filter((_, j) => j !== i))} className="text-primary/60 hover:text-destructive transition-colors">
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    value={newCondition}
                    onChange={e => setNewCondition(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && addCondition()}
                    placeholder={t(language, "editProfile.addCondition")}
                    className={`${fieldCls} flex-1`}
                  />
                  <button onClick={addCondition} disabled={!newCondition.trim()} className="w-10 h-10 bg-primary rounded-xl flex items-center justify-center disabled:opacity-40">
                    <Plus size={16} className="text-white" />
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-foreground mb-2">{t(language, "editProfile.knownAllergies")}</label>
                <div className="flex flex-wrap gap-2 mb-3">
                  {allergies.map((a, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 bg-red-50 border border-red-200 text-red-800 rounded-xl px-2.5 py-1 text-xs font-semibold">
                      <AlertTriangle size={10} className="text-red-600" /> {a}
                      <button onClick={() => setAllergies(prev => prev.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-700 transition-colors ml-0.5">
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <AllergyTypeAhead
                      value={newAllergy}
                      onChange={setNewAllergy}
                      onSelect={value => { setNewAllergy(value); setTimeout(() => addAllergy(), 0); }}
                    />
                  </div>
                  <button onClick={addAllergy} disabled={!newAllergy.trim()} className="w-10 h-10 bg-destructive rounded-xl flex items-center justify-center disabled:opacity-40">
                    <Plus size={16} className="text-white" />
                  </button>
                </div>
                <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground mt-1.5">{t(language, "editProfile.allergiesShownProminently")}</p>
              </div>
            </>
          )}

          {tab === "contacts" && (
            <div>
              <div className="space-y-2 mb-4">
                {contacts.map((c, i) => (
                  <div key={i} className="flex items-center gap-3 bg-muted rounded-xl px-3 py-2.5">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-[calc(11px*var(--dw-text,1))] font-bold ${c.isPrimary ? "bg-primary text-primary-foreground" : "bg-secondary text-primary"}`}>
                      {c.name.split(" ").map(w => w[0]).join("").slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-foreground truncate">{c.name}</p>
                      <p className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground truncate">{c.role} · {c.phone}</p>
                    </div>
                    {!c.isPrimary && (
                      <button onClick={() => setContacts(prev => prev.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive transition-colors shrink-0">
                        <Trash2 size={13} />
                      </button>
                    )}
                    {c.isPrimary && <Star size={12} className="text-primary shrink-0" />}
                  </div>
                ))}
              </div>

              <p className="text-xs font-semibold text-foreground mb-2">{t(language, "editProfile.addNewContact")}</p>
              <div className="space-y-2">
                <input value={newContactName} onChange={e => setNewContactName(e.target.value)} placeholder={t(language, "editProfile.fullName")} className={fieldCls} />
                <input value={newContactRole} onChange={e => setNewContactRole(e.target.value)} placeholder={t(language, "editProfile.contactRolePlaceholder")} className={fieldCls} />
                <input value={newContactPhone} onChange={e => setNewContactPhone(e.target.value)} placeholder={t(language, "editProfile.contactPhonePlaceholder")} className={fieldCls} type="tel" />
                <button
                  onClick={addContact}
                  disabled={!newContactName.trim() || !newContactPhone.trim()}
                  className="w-full bg-muted border border-border rounded-xl py-2.5 text-xs font-semibold text-foreground flex items-center justify-center gap-2 disabled:opacity-40"
                >
                  <Plus size={13} /> {t(language, "editProfile.addContact")}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Save */}
        <div className="px-5 py-4 border-t border-border shrink-0">
          <button
            onClick={handleSave}
            className="w-full bg-primary text-primary-foreground rounded-2xl py-3.5 text-sm font-semibold flex items-center justify-center gap-2"
          >
            <Check size={16} /> {t(language, "editProfile.saveProfile")}
          </button>
        </div>
      </div>
    </div>
  );
}
