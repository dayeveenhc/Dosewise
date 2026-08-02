import { useState } from "react";
import { X, Check } from "lucide-react";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

interface CaregiverAccount { name: string | null; email: string | null }

interface EditCaregiverAccountSheetProps {
  account: CaregiverAccount;
  onClose: () => void;
  onSave: (updated: CaregiverAccount) => void;
}

// Mirrors EditProfileSheet's chrome (handle, header, single Save button) —
// the caregiver's own account is a much smaller record than the elder's
// (name + email only), so it doesn't need that sheet's tab strip.
export function EditCaregiverAccountSheet({ account, onClose, onSave }: EditCaregiverAccountSheetProps) {
  const { language } = useLanguage();
  const [name, setName] = useState(account.name ?? "");
  const [email, setEmail] = useState(account.email ?? "");

  const fieldCls = "w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors";

  const handleSave = () => {
    onSave({ name: name.trim() || null, email: email.trim() || null });
    onClose();
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative bg-card rounded-t-3xl shadow-2xl overflow-hidden flex flex-col max-h-[70%]">
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        <div className="flex items-center justify-between px-5 pb-3 pt-1 border-b border-border shrink-0">
          <h2 className="font-['Fraunces'] text-lg font-semibold text-foreground">{t(language, "settings.editAccount")}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
            <X size={14} className="text-foreground" />
          </button>
        </div>

        <div className="overflow-y-auto scrollbar-none px-5 py-4 space-y-4 flex-1">
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "common.fullName")}</label>
            <input value={name} onChange={e => setName(e.target.value)} className={fieldCls} placeholder={t(language, "common.fullName")} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "common.email")}</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={fieldCls} placeholder={t(language, "common.email")} />
          </div>
        </div>

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
