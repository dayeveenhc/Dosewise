import { useState } from "react";
import { X, UserPlus } from "lucide-react";

const RELATIONS = ["Mother", "Father", "Grandmother", "Grandfather", "Spouse", "Client"];

interface AddCareRecipientSheetProps {
  onClose: () => void;
  onAdd: (fullName: string, relationship: string) => Promise<void>;
}

export function AddCareRecipientSheet({ onClose, onAdd }: AddCareRecipientSheetProps) {
  const [fullName, setFullName] = useState("");
  const [relationship, setRelationship] = useState(RELATIONS[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValid = fullName.trim().length > 0;

  const handleAdd = async () => {
    if (!isValid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd(fullName.trim(), relationship);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSaving(false);
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative bg-card rounded-t-3xl shadow-2xl overflow-hidden flex flex-col max-h-[88%]">
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        <div className="flex items-center justify-between px-5 pb-3 pt-1 border-b border-border shrink-0">
          <div>
            <h2 className="font-['Fraunces'] text-lg font-semibold text-foreground">Add Care Recipient</h2>
            <p className="text-xs text-muted-foreground">You'll manage their medications and schedule</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
            <X size={14} className="text-foreground" />
          </button>
        </div>

        <div className="overflow-y-auto scrollbar-none px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">Full name <span className="text-destructive">*</span></label>
            <input
              value={fullName}
              onChange={e => setFullName(e.target.value)}
              placeholder="e.g. Mdm Tan Bee Leng"
              className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">Your relationship to them</label>
            <div className="flex flex-wrap gap-2">
              {RELATIONS.map(r => (
                <button
                  key={r}
                  onClick={() => setRelationship(r)}
                  className={`text-xs font-medium rounded-xl px-3 py-1.5 border transition-colors ${relationship === r ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-border"}`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-xs text-destructive leading-relaxed">{error}</p>}
        </div>

        <div className="px-5 py-4 border-t border-border shrink-0">
          <button
            onClick={handleAdd}
            disabled={!isValid || saving}
            className="w-full bg-primary text-primary-foreground rounded-2xl py-3.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 transition-opacity"
          >
            <UserPlus size={16} /> {saving ? "Adding..." : "Add care recipient"}
          </button>
        </div>
      </div>
    </div>
  );
}
