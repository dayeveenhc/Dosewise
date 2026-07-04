import { useState } from "react";
import { Shield, ChevronDown, Eye, Phone, RefreshCw } from "lucide-react";
import { useAccessibility } from "../../accessibility.tsx";
import type { Patient } from "../../types";
import { MED_SHAPES, MED_PHOTOS } from "../../data/medications";

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className={`w-12 h-6 rounded-full transition-colors relative shrink-0 ${on ? "bg-primary" : "bg-muted"}`}>
      <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${on ? "translate-x-6" : "translate-x-0.5"}`} />
    </button>
  );
}

export function ElderlySettingsScreen({ patient, onBack }: { patient: Patient; onBack: () => void }) {
  const { fontSize, setFontSize, highContrast, setHighContrast, colourBlind, setColourBlind } = useAccessibility();
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [language, setLanguage] = useState("English");
  const [notifications, setNotifications] = useState(true);
  const [showShapes, setShowShapes] = useState(false);
  const primary = patient.contacts.find(c => c.isPrimary);

  return (
    <div className="flex-1 overflow-y-auto scrollbar-none">
      <div className="px-4 pt-2 pb-28 space-y-4">
        <div className="bg-card rounded-2xl border border-border p-4">
          <div className="flex items-center gap-3 mb-3">
            <img src={patient.photo} alt={patient.nickname} className="w-14 h-14 rounded-full object-cover bg-muted border-2 border-primary/20" />
            <div>
              <p className="font-bold text-foreground text-lg">{patient.nickname}</p>
              <p className="text-sm text-muted-foreground">{patient.name} · {patient.age} yrs</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {patient.conditions.map(c => <span key={c} className="text-xs bg-secondary text-secondary-foreground rounded-full px-2.5 py-1">{c}</span>)}
          </div>
        </div>

        {/* Accessibility */}
        <div className="bg-card rounded-2xl border border-border divide-y divide-border">
          <div className="px-4 py-3 flex items-center gap-2">
            <Shield size={15} className="text-primary" />
            <p className="font-semibold text-foreground">Accessibility</p>
          </div>

          {/* Font size */}
          <div className="px-4 py-4">
            <p className="text-[15px] font-medium text-foreground mb-0.5">Text Size</p>
            <p className="text-xs text-muted-foreground mb-3">Larger text is easier to read</p>
            <div className="flex gap-2">
              {(["normal", "large", "xlarge"] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setFontSize(s)}
                  className={`flex-1 py-2 rounded-xl border text-sm font-semibold transition-colors ${
                    fontSize === s ? "bg-primary text-primary-foreground border-primary" : "bg-muted/50 text-foreground border-border"
                  }`}
                >
                  {s === "normal" ? "A" : s === "large" ? "A+" : "A++"}
                </button>
              ))}
            </div>
          </div>

          {/* High contrast */}
          <div className="px-4 py-4 flex items-center justify-between gap-3">
            <div className="flex-1">
              <p className="text-[15px] font-medium text-foreground">High Contrast</p>
              <p className="text-xs text-muted-foreground">Bolder colours and stronger outlines for easier reading</p>
            </div>
            <Toggle on={highContrast} onToggle={() => setHighContrast(!highContrast)} />
          </div>

          {/* Colour blind mode */}
          <div className="px-4 py-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex-1">
                <p className="text-[15px] font-medium text-foreground">Colour Blind Mode</p>
                <p className="text-xs text-muted-foreground">Uses pill shape, markings, and text — not colour — to identify each medicine</p>
              </div>
              <Toggle on={colourBlind} onToggle={() => setColourBlind(!colourBlind)} />
            </div>

            {colourBlind && (
              <div className="bg-muted/40 rounded-xl p-3 space-y-1.5">
                <button
                  onClick={() => setShowShapes(v => !v)}
                  className="w-full flex items-center justify-between text-sm font-semibold text-foreground"
                >
                  <span className="flex items-center gap-1.5"><Eye size={13} className="text-primary" />Your medicine descriptions</span>
                  <ChevronDown size={13} className={`text-muted-foreground transition-transform ${showShapes ? "rotate-180" : ""}`} />
                </button>
                {showShapes && (
                  <div className="mt-2 space-y-2 pt-2 border-t border-border/40">
                    {patient.medications.map(m => {
                      const shape = MED_SHAPES[m.name];
                      if (!shape) return null;
                      return (
                        <div key={m.id} className="flex items-start gap-3 py-1">
                          <div className="w-9 h-9 rounded-lg overflow-hidden shrink-0 bg-muted">
                            <img src={MED_PHOTOS[m.name] ?? ""} alt={m.name} className="w-full h-full object-cover grayscale" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-foreground">{m.name}</p>
                            <p className="text-xs text-muted-foreground">{shape.shape}</p>
                            <p className="text-xs text-muted-foreground">{shape.marking}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="bg-card rounded-2xl border border-border divide-y divide-border">
          <div className="px-4 py-3"><p className="font-semibold text-foreground">Voice & Language</p></div>
          <div className="px-4 py-4 flex items-center justify-between gap-3">
            <div className="flex-1">
              <p className="text-[15px] font-medium text-foreground">Read Aloud</p>
              <p className="text-xs text-muted-foreground">Mei reads her replies out loud</p>
            </div>
            <Toggle on={voiceEnabled} onToggle={() => setVoiceEnabled(v => !v)} />
          </div>
          <div className="px-4 py-4 flex items-center justify-between">
            <div>
              <p className="text-[15px] font-medium text-foreground">Language</p>
              <p className="text-xs text-muted-foreground">Mei responds in this language</p>
            </div>
            <select value={language} onChange={e => setLanguage(e.target.value)} className="bg-muted rounded-xl px-3 py-2 text-sm font-medium text-foreground outline-none">
              <option>English</option>
              <option>华语 (Mandarin)</option>
              <option>闽南话 (Hokkien)</option>
              <option>粤语 (Cantonese)</option>
              <option>தமிழ் (Tamil)</option>
              <option>Melayu</option>
            </select>
          </div>
        </div>

        <div className="bg-card rounded-2xl border border-border divide-y divide-border">
          <div className="px-4 py-3"><p className="font-semibold text-foreground">Reminders</p></div>
          <div className="px-4 py-4 flex items-center justify-between gap-3">
            <div className="flex-1">
              <p className="text-[15px] font-medium text-foreground">Medicine Reminders</p>
              <p className="text-xs text-muted-foreground">Alert when it's time to take medicine</p>
            </div>
            <Toggle on={notifications} onToggle={() => setNotifications(v => !v)} />
          </div>
        </div>

        {primary && (
          <div className="bg-card rounded-2xl border border-border divide-y divide-border">
            <div className="px-4 py-3"><p className="font-semibold text-foreground">Emergency Contact</p></div>
            <div className="px-4 py-4 flex items-center justify-between">
              <div>
                <p className="text-[15px] font-medium text-foreground">{primary.name}</p>
                <p className="text-sm text-muted-foreground">{primary.role}</p>
                <p className="text-sm text-muted-foreground">{primary.phone}</p>
              </div>
              <a href={`tel:${primary.phone}`} className="w-12 h-12 bg-emerald-100 text-emerald-700 rounded-xl flex items-center justify-center active:scale-95 transition-transform">
                <Phone size={18} />
              </a>
            </div>
          </div>
        )}

        <button onClick={onBack} className="w-full h-12 rounded-2xl border border-border text-muted-foreground text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
          <RefreshCw size={14} />Switch to Caregiver Mode
        </button>
      </div>
    </div>
  );
}
