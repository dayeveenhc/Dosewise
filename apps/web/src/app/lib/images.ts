import { fileToBase64 } from "./hermes";

// How many photos may ride along on one chat turn. A ceiling, not a target:
// every attachment is a separate vision input on the Hermes side (one image
// block per entry, agent/loop.py), and Hermes caps the request at 6 of its own
// accord — staying under that here means the client never silently loses a
// photo the person watched itself attach.
export const MAX_ATTACHMENTS = 5;

// Longest edge, in CSS pixels, a staged photo is reduced to before it is either
// stored or sent. 1600 keeps a medicine box's small print legible to a vision
// model while cutting a typical 4-8MB phone JPEG to a few hundred KB — which is
// what makes BOTH sessionStorage persistence (a ~5MB origin budget for the whole
// chat record) and multi-image turns (Hermes's 25MB hermes_max_body_bytes)
// possible at all. Neither is workable with raw camera output.
// Exported so the in-app camera (components/CameraSheet.tsx) sizes its capture
// canvas by the same rule, rather than shooting at native sensor resolution and
// relying on a second downscale downstream.
export const MAX_EDGE_PX = 1600;
export const JPEG_QUALITY = 0.8;

/** A photo staged on the composer: what Hermes gets, and what the UI shows. */
export interface Attachment {
  // Raw base64, data-URL prefix stripped — the shape Hermes's image_base64 /
  // images_base64 fields expect (same contract as fileToBase64).
  base64: string;
  // A `data:` URL for <img src>. Deliberately NOT URL.createObjectURL: a blob:
  // URL dies with the page, so it can't be persisted and restored, which is the
  // whole point of staging a photo that outlives leaving the screen.
  dataUrl: string;
}

// Decode a file into an <img> we can draw. createImageBitmap would be tidier but
// isn't in jsdom (the unit-test environment) and gives no EXIF-orientation win
// worth the branch.
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode image"));
    img.src = url;
  });
}

/**
 * Drop any `blob:` object URL from a chat message before it is persisted.
 *
 * A blob: URL is only valid for the life of the page that minted it, so a saved
 * message pointing at one restores as a broken-image icon. Everything the
 * composer stages is a `data:` URL (prepareAttachment) and survives fine — this
 * exists so a caller that reaches for URL.createObjectURL cannot silently
 * reintroduce that. Sweeps BOTH fields; the message text is never touched.
 */
export function stripBlobImages<T extends { image?: string; images?: string[] }>(msg: T): T {
  const image = msg.image?.startsWith("blob:") ? undefined : msg.image;
  const images = msg.images?.filter(src => !src.startsWith("blob:"));
  if (image === msg.image && images?.length === msg.images?.length) return msg;
  return { ...msg, image, images: images?.length ? images : undefined };
}

/**
 * Read a picked image file into the pair the composer needs, downscaled.
 *
 * Falls back to the original bytes if anything in the canvas path fails (an
 * exotic format the browser can decode but not re-encode, a tainted canvas, a
 * headless environment with no real 2D context) — a slightly-too-large photo
 * that works beats a correctly-sized one that doesn't.
 *
 * Images only. The PDF path (clinic reports) must never come through here:
 * re-encoding a PDF as JPEG would destroy the text layer /profile/extract reads.
 */
export async function prepareAttachment(file: Blob): Promise<Attachment> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    // A JPEG has no alpha channel, so anything transparent would encode as
    // black without this — a white-background PNG label is a common upload.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    const base64 = dataUrl.split(",", 2)[1] ?? "";
    if (!base64) throw new Error("empty encode");
    return { base64, dataUrl };
  } catch (err) {
    console.warn("[dosewise] image downscale failed; sending the original", err);
    const base64 = await fileToBase64(file);
    return { base64, dataUrl: `data:${file.type || "image/jpeg"};base64,${base64}` };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
