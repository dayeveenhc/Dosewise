import { useEffect, useRef, useState } from "react";
import { Camera, X, RotateCcw, Check, ImageIcon } from "lucide-react";
import { MAX_EDGE_PX, JPEG_QUALITY } from "../lib/images";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

/**
 * A real in-app camera: live viewfinder, shutter, review, confirm.
 *
 * WHY THIS EXISTS. Every "Take photo" path used to click a hidden
 * `<input type="file" accept="image/*" capture="environment">`. That is correct
 * markup, and it does open the camera on a phone — but `capture` is simply
 * IGNORED by desktop browsers, which show the same file dialog as "Choose from
 * library". So the two options in PhotoSourceSheet were indistinguishable on a
 * laptop, which is where this app is demoed. getUserMedia behaves the same
 * everywhere: webcam on desktop, rear camera on a phone.
 *
 * The capture inputs are NOT removed — they are the fallback (`onFallback`),
 * reached whenever getUserMedia is unavailable (no `mediaDevices` at all on a
 * non-secure origin), there is no camera, or permission is refused.
 *
 * Once we are in the blocked phase we STAY there and offer the library instead
 * of retrying the camera. MEMORY.md's ScanLinkSheet entry documents the loop
 * this avoids: a denied permission makes `start()` reject again immediately, so
 * "try again" bounces straight back to the error.
 */
export function CameraSheet({ facing, onCapture, onClose, onFallback }: {
  /** Rear for labels and documents, front for a profile photo. */
  facing: "environment" | "user";
  /** A downscaled JPEG plus its data: URL, ready for the caller's existing path. */
  onCapture: (file: File, dataUrl: string) => void;
  onClose: () => void;
  /** No camera available — hand back to the hidden capture/library input. */
  onFallback: () => void;
}) {
  const { language } = useLanguage();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<"starting" | "live" | "review" | "blocked">("starting");
  const [shot, setShot] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const stop = () => {
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    };

    (async () => {
      // Absent entirely on an insecure origin, which is a legitimate way to
      // reach this and must not throw a TypeError at the person.
      if (!navigator.mediaDevices?.getUserMedia) {
        if (!cancelled) setPhase("blocked");
        return;
      }
      try {
        // `ideal`, not `exact`: a laptop has one camera and no environment-
        // facing mode, and an exact constraint makes it reject outright.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 } },
          audio: false,
        });
        // The component can unmount while the permission prompt is still open;
        // without this the stream is orphaned and the camera light stays on.
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setPhase("live");
      } catch (err) {
        console.warn("[dosewise] camera unavailable", err);
        if (!cancelled) setPhase("blocked");
      }
    })();

    return () => { cancelled = true; stop(); };
  }, [facing]);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    // Same downscale rule as a picked file (lib/images.ts), applied here so the
    // photo is already the right size rather than depending on whichever path
    // the caller happens to send it down.
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, width, height);
    setShot(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    setPhase("review");
  };

  const use = () => {
    if (!shot) return;
    const base64 = shot.split(",", 2)[1] ?? "";
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    onCapture(new File([bytes], "photo.jpg", { type: "image/jpeg" }), shot);
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between px-4 py-3 shrink-0">
        <p className="text-[calc(15px*var(--dw-text,1))] font-bold text-white">{t(language, "camera.title")}</p>
        <button
          onClick={onClose}
          aria-label={t(language, "link.close")}
          className="w-10 h-10 rounded-full bg-white/15 flex items-center justify-center"
        >
          <X size={18} className="text-white" />
        </button>
      </div>

      <div className="flex-1 min-h-0 relative flex items-center justify-center overflow-hidden">
        {/* Kept mounted through every phase: the ref must exist when the stream
            resolves, and hiding beats unmounting so the feed isn't torn down
            just to review a shot. Mirrored for the front camera, which is what
            people expect of a selfie view. */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`w-full h-full object-contain ${phase === "review" ? "hidden" : ""} ${facing === "user" ? "-scale-x-100" : ""}`}
        />
        {phase === "review" && shot && <img src={shot} alt="" className="w-full h-full object-contain" />}
        {phase === "starting" && (
          <p className="absolute text-[calc(14px*var(--dw-text,1))] text-white/80">{t(language, "camera.starting")}</p>
        )}
        {phase === "blocked" && (
          <p className="absolute px-8 text-center text-[calc(15px*var(--dw-text,1))] text-white/90 leading-relaxed">
            {t(language, "camera.blocked")}
          </p>
        )}
      </div>

      <div className="shrink-0 px-5 py-5 pb-8 flex flex-col items-center gap-3">
        {phase === "review" ? (
          <div className="w-full flex gap-2">
            <button
              onClick={() => { setShot(null); setPhase("live"); }}
              className="flex-1 h-12 rounded-2xl border border-white/30 text-white text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-2"
            >
              <RotateCcw size={17} />{t(language, "camera.retake")}
            </button>
            <button
              onClick={use}
              className="flex-1 h-12 rounded-2xl bg-primary text-primary-foreground text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-2 dw-press"
            >
              <Check size={17} />{t(language, "camera.usePhoto")}
            </button>
          </div>
        ) : phase === "blocked" ? (
          <button
            onClick={onFallback}
            className="w-full h-12 rounded-2xl bg-primary text-primary-foreground text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-2 dw-press"
          >
            <ImageIcon size={17} />{t(language, "camera.useLibrary")}
          </button>
        ) : (
          <button
            onClick={capture}
            disabled={phase !== "live"}
            aria-label={t(language, "camera.shutter")}
            className="w-20 h-20 rounded-full bg-white border-[6px] border-white/40 flex items-center justify-center disabled:opacity-40"
          >
            <Camera size={26} className="text-black" />
          </button>
        )}
      </div>
    </div>
  );
}
