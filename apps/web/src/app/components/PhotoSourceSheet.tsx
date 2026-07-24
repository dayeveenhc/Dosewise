import { Camera, Image as ImageIcon } from "lucide-react";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

// Explicit "Take Photo" vs "Choose from Library" chooser. A single hidden
// file input's on-tap behaviour (camera vs. gallery) is up to the OS/browser
// and isn't reliably a real choice on every device — this sheet backs each
// option with its own input (one `capture="environment"`, one without) so
// both paths are always reachable regardless of native-picker quirks.
export function PhotoSourceSheet({ onTakePhoto, onChooseFile, onClose }: {
  onTakePhoto: () => void;
  onChooseFile: () => void;
  onClose: () => void;
}) {
  const { language } = useLanguage();
  return (
    <div className="absolute inset-0 z-[150] flex items-end p-3">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative w-full bg-card rounded-3xl border border-border shadow-2xl overflow-hidden animate-in slide-in-from-bottom duration-200 p-3">
        <div className="flex justify-center pb-2">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>
        <div className="grid grid-cols-2 gap-2 p-1">
          <button
            onClick={onTakePhoto}
            className="h-[88px] flex flex-col items-center justify-center gap-1.5 bg-muted rounded-2xl active:bg-muted/70 transition-colors"
          >
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <Camera size={18} className="text-primary" />
            </div>
            <span className="text-[12px] font-bold text-foreground leading-tight">{t(language, "photoSource.takePhoto")}</span>
          </button>
          <button
            onClick={onChooseFile}
            className="h-[88px] flex flex-col items-center justify-center gap-1.5 bg-muted rounded-2xl active:bg-muted/70 transition-colors"
          >
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <ImageIcon size={18} className="text-primary" />
            </div>
            <span className="text-[12px] font-bold text-foreground leading-tight">{t(language, "photoSource.chooseFromLibrary")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
