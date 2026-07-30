// A tiny event bus for "app-event" WaitFor conditions (lib/walkthrough/types.ts)
// — the handful of user actions a generic DOM listener can't detect on its own:
// a custom stepper with no DOM signal for "value truly changed" (TimesPicker,
// TimeField), an async write's real success rather than the click that started
// it (TravelModeSheet's save, ScanLinkSheet's send, the caregiver's accept), a
// camera decode, or a chat turn's committed action. Instrumented app code calls
// emitWalkthroughEvent when (and only when) the real thing actually happened;
// the Walkthrough overlay listens only while a step declares that exact event.
//
// A plain EventTarget, not a custom pub/sub — native, no dependency, and
// CustomEvent's `detail` carries whatever payload a listener needs.
const bus = new EventTarget();

// Pace-controller telemetry (lib/walkthrough/pace.ts): emitted on every phase
// start / min-reached / end with { phase, canAdvance }, so the overlay UI can
// render Next-button state and the "checking…" label without prop drilling.
export const WALK_PHASE_EVENT = "walk-phase";

export function emitWalkthroughEvent(event: string, detail?: unknown): void {
  bus.dispatchEvent(new CustomEvent(event, { detail }));
}

export function onWalkthroughEvent(event: string, handler: (detail: unknown) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent).detail);
  bus.addEventListener(event, listener);
  return () => bus.removeEventListener(event, listener);
}
