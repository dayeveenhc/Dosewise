import type { Screen } from "../types";
import { NAV_ITEMS } from "../nav";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

// Caregiver bottom navigation. Lives in its own component (a child of
// LanguageProvider) so labels re-render live when the language toggles — App
// itself owns the provider and would not re-render on a language change.
export function BottomNav({ activeTab, onSelect }: { activeTab: string; onSelect: (s: Screen) => void }) {
  const { language } = useLanguage();
  // Icon-only, matching the elder shell. aria-label carries what the removed
  // visible text used to say — an icon-only tab bar is otherwise silent to a
  // screen reader.
  return (
    <div className="shrink-0 bg-card/85 backdrop-blur-xl border-t border-border/60 px-3 pt-4 pb-6">
      {/* items-END so every control shares one baseline — see ElderlyApp's nav. */}
      <div className="flex items-end">
        {NAV_ITEMS.map(item => {
          const isActive = activeTab === item.id;
          const label = t(language, item.labelKey);
          if (item.fab) {
            return (
              <div key={item.id} className="flex-1 flex justify-center">
                <button
                  onClick={() => onSelect(item.id)}
                  data-tour={`nav-${item.id}`}
                  aria-label={label}
                  aria-current={isActive ? "page" : undefined}
                  className={`w-16 h-16 rounded-full flex items-center justify-center -mt-6 shadow-lg active:scale-95 transition-transform bg-primary ${isActive ? "ring-4 ring-accent/40" : ""}`}
                >
                  <item.icon size={30} className="text-primary-foreground" />
                </button>
              </div>
            );
          }
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              data-tour={`nav-${item.id}`}
              aria-label={label}
              aria-current={isActive ? "page" : undefined}
              className="flex-1 min-w-0 flex justify-center relative"
            >
              {/* Coloured icon + dot rather than a filled pill — see ElderlyApp's nav. */}
              <div className="w-16 h-12 flex flex-col items-center justify-end gap-1.5">
                <item.icon size={26} className={`transition-colors ${isActive ? "text-primary" : "text-muted-foreground/70"}`} />
                <span className={`h-1.5 w-1.5 rounded-full transition-colors ${isActive ? "bg-primary" : "bg-transparent"}`} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
