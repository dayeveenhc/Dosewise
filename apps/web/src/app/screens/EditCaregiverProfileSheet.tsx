import { useState } from "react";
import { X, Check } from "lucide-react";

interface CaregiverProfile { fullName: string; age?: number; gender?: string; email?: string }

interface EditCaregiverProfileSheetProps {
  profile: CaregiverProfile;
  onClose: () => void;
  onSave: (updated: CaregiverProfile) => void;
}

export function EditCaregiverProfileSheet({ profile, onClose, onSave }: EditCaregiverProfileSheetProps) {
  const [fullName, setFullName] = useState(profile.fullName);
  const [age, setAge] = useState(profile.age ? String(profile.age) : "");
  const [gender, setGender] = useState(profile.gender ?? "");

  const handleSave = () => {
    onSave({ ...profile, fullName: fullName.trim(), age: age ? Number(age) : undefined, gender: gender || undefined });
    onClose();
  };

  const fieldCls = "w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors";

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
            <h2 className="font-['Fraunces'] text-lg font-semibold text-foreground">Edit Profile</h2>
            <p className="text-xs text-muted-foreground">Your own account details</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
            <X size={14} className="text-foreground" />
          </button>
        </div>

        {/* Form body */}
        <div className="overflow-y-auto scrollbar-none px-5 py-4 space-y-4 flex-1">
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">Full name</label>
            <input value={fullName} onChange={e => setFullName(e.target.value)} className={fieldCls} placeholder="Full name" />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-semibold text-foreground mb-1.5">Age</label>
              <input type="number" value={age} onChange={e => setAge(e.target.value)} min={1} max={130} className={fieldCls} placeholder="e.g. 45" />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-semibold text-foreground mb-1.5">Gender</label>
              <div className="flex gap-2">
                {(["Female", "Male"] as const).map(g => (
                  <button
                    key={g}
                    onClick={() => setGender(g)}
                    className={`flex-1 py-2.5 rounded-xl border text-sm font-semibold transition-colors ${gender === g ? "bg-primary text-primary-foreground border-primary" : "bg-input-background text-foreground border-border"}`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {profile.email && (
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1.5">Email</label>
              <input value={profile.email} disabled className={`${fieldCls} opacity-60`} />
            </div>
          )}
        </div>

        {/* Save */}
        <div className="px-5 py-4 border-t border-border shrink-0">
          <button
            onClick={handleSave}
            className="w-full bg-primary text-primary-foreground rounded-2xl py-3.5 text-sm font-semibold flex items-center justify-center gap-2"
          >
            <Check size={16} /> Save profile
          </button>
        </div>
      </div>
    </div>
  );
}
