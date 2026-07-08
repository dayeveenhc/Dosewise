import type { Screen } from "../types";
import { NAV_ITEMS } from "../nav";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

// Caregiver bottom navigation. Lives in its own component (a child of
// LanguageProvider) so labels re-render live when the language toggles — App
// itself owns the provider and would not re-render on a language change.
export function BottomNav({ activeTab, onSelect }: { activeTab: string; onSelect: (s: Screen) => void }) {
  const { language } = useLanguage();
  return (
    <div className="shrink-0 bg-card/95 backdrop-blur-md border-t border-border px-2 pb-6 pt-2">
      <div className="flex items-end">
        {NAV_ITEMS.map(item => {
          const isActive = activeTab === item.id;
          const label = t(language, item.labelKey);
          if (item.fab) {
            return (
              <div key={item.id} className="flex-1 flex flex-col items-center">
                <button
                  onClick={() => onSelect(item.id)}
                  data-tour={`nav-${item.id}`}
                  className={`w-14 h-14 rounded-full flex items-center justify-center -mt-7 shadow-lg active:scale-95 transition-transform bg-primary ${isActive ? "ring-4 ring-primary/25" : ""}`}
                >
                  <item.icon size={24} className="text-primary-foreground" />
                </button>
                <span className={`text-[10px] font-medium mt-1 ${isActive ? "text-primary" : "text-muted-foreground"}`}>{label}</span>
              </div>
            );
          }
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              data-tour={`nav-${item.id}`}
              className="flex-1 flex flex-col items-center gap-1 py-1 relative"
            >
              <div className={`w-10 h-7 rounded-2xl flex items-center justify-center transition-colors ${isActive ? "bg-primary" : ""}`}>
                <item.icon size={18} className={isActive ? "text-primary-foreground" : "text-muted-foreground"} />
              </div>
              <span className={`text-[10px] font-medium transition-colors ${isActive ? "text-primary" : "text-muted-foreground"}`}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
