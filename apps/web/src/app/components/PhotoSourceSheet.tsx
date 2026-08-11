import { Camera, Image as ImageIcon, PenLine } from "lucide-react";
import { BottomSheet } from "./BottomSheet";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

// Explicit "Take Photo" vs "Choose from Library" chooser. A single hidden
// file input's on-tap behaviour (camera vs. gallery) is up to the OS/browser
// and isn't reliably a real choice on every device — this sheet backs each
// option with its own input (one `capture="environment"`, one without) so
// both paths are always reachable regardless of native-picker quirks.
// onTypeMyself (optional) adds a third, non-photo path — for flows like
// "Update profile" where a camera must never be the ONLY way in.
export function PhotoSourceSheet({ onTakePhoto, onChooseFile, onTypeMyself, onClose }: {
  onTakePhoto: () => void;
  onChooseFile: () => void;
  onTypeMyself?: () => void;
  onClose: () => void;
}) {
  const { language } = useLanguage();
  return (
    <BottomSheet onClose={onClose}>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onTakePhoto}
            className="h-[88px] flex flex-col items-center justify-center gap-1.5 bg-muted rounded-2xl active:bg-muted/70 transition-colors"
          >
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <Camera size={18} className="text-primary" />
            </div>
            <span className="text-[calc(12px*var(--dw-text,1))] font-bold text-foreground leading-tight">{t(language, "photoSource.takePhoto")}</span>
          </button>
          <button
            onClick={onChooseFile}
            className="h-[88px] flex flex-col items-center justify-center gap-1.5 bg-muted rounded-2xl active:bg-muted/70 transition-colors"
          >
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <ImageIcon size={18} className="text-primary" />
            </div>
            <span className="text-[calc(12px*var(--dw-text,1))] font-bold text-foreground leading-tight">{t(language, "photoSource.chooseFromLibrary")}</span>
          </button>
        </div>
        {onTypeMyself && (
          <button
            onClick={onTypeMyself}
            className="mt-2 w-full min-h-[56px] flex items-center justify-center gap-2 bg-muted rounded-2xl active:bg-muted/70 transition-colors"
          >
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <PenLine size={18} className="text-primary" />
            </div>
            <span className="text-[calc(12px*var(--dw-text,1))] font-bold text-foreground leading-tight">{t(language, "photoSource.typeItIn")}</span>
          </button>
        )}
    </BottomSheet>
  );
}
