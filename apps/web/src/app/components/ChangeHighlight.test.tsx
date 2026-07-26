import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { AgentAction } from "../lib/hermes";
import { ChangeHighlight } from "./ChangeHighlight";

// jsdom implements none of these (layout APIs); they're irrelevant to what
// these tests assert (class application / cleanup / caption text), so stub them.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollSpy;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  // HighlightCaption's frame hit-test; null → it falls back to viewport bounds.
  document.elementFromPoint = () => null;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// The exact bulk shape the backend emits for resolve_missed_doses: entities[]
// with no top-level entity_type/entity_id; each entity_id is the MEDICATION id,
// resolved to the `medication-{uuid}` card via the suffix fallback.
function bulkChange(ids: string[]): AgentAction {
  return {
    tool: "resolve_missed_doses",
    summary: `${ids.length} missed doses marked taken`,
    entities: ids.map((id, i) => ({
      entity_type: "dose",
      entity_id: id,
      changed_fields: { status: { before: null, after: "taken" } },
      dose_id: `dose-row-${i}`,
      slot: "08:00",
      name: `Med ${i + 1}`,
    })),
  };
}

function addCard(medId: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-testid", `medication-${medId}`);
  document.body.appendChild(el);
  return el;
}

describe("ChangeHighlight — bulk actions ring every element simultaneously", () => {
  it("rings all found elements at once, navigates once, scrolls only the first", async () => {
    const cards = ["uuid-a", "uuid-b", "uuid-c"].map(addCard);
    const onNavigate = vi.fn();
    const onDone = vi.fn();

    render(
      <ChangeHighlight
        change={bulkChange(["uuid-a", "uuid-b", "uuid-c"])}
        mode="elderly"
        onNavigate={onNavigate}
        onDone={onDone}
      />,
    );

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("home"); // ENTITY_TARGETS.dose.elderly
    for (const card of cards) {
      expect(card.classList.contains("change-highlight")).toBe(true);
    }
    expect(scrollSpy).toHaveBeenCalledTimes(1); // only the anchor scrolls

    // ONE batch caption, anchored to the first element, with the backend summary.
    await waitFor(() => {
      const caption = document.querySelector('[data-testid="change-highlight-caption"]');
      expect(caption).not.toBeNull();
      expect(caption!.textContent).toBe("Taken: 3 missed doses marked taken");
    });
    expect(document.querySelectorAll('[data-testid="change-highlight-caption"]')).toHaveLength(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a superseding null change removes the ring from EVERY element", () => {
    const cards = ["uuid-a", "uuid-b", "uuid-c"].map(addCard);
    const { rerender } = render(
      <ChangeHighlight
        change={bulkChange(["uuid-a", "uuid-b", "uuid-c"])}
        mode="elderly"
        onNavigate={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    for (const card of cards) expect(card.classList.contains("change-highlight")).toBe(true);

    rerender(
      <ChangeHighlight change={null} mode="elderly" onNavigate={vi.fn()} onDone={vi.fn()} />,
    );
    for (const card of cards) expect(card.classList.contains("change-highlight")).toBe(false);
  });

  it("unmount removes the ring from EVERY element", () => {
    const cards = ["uuid-a", "uuid-b"].map(addCard);
    const { unmount } = render(
      <ChangeHighlight
        change={bulkChange(["uuid-a", "uuid-b"])}
        mode="elderly"
        onNavigate={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    for (const card of cards) expect(card.classList.contains("change-highlight")).toBe(true);
    unmount();
    for (const card of cards) expect(card.classList.contains("change-highlight")).toBe(false);
  });

  it("rings the elements it finds, then console.errors the ones it never found", () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Only 2 of the 3 batched doses have a card on screen.
    const cards = ["uuid-a", "uuid-b"].map(addCard);
    const onDone = vi.fn();

    render(
      <ChangeHighlight
        change={bulkChange(["uuid-a", "uuid-b", "uuid-missing"])}
        mode="elderly"
        onNavigate={vi.fn()}
        onDone={onDone}
      />,
    );

    // The two resolvable cards ring immediately; nothing has been reported yet.
    for (const card of cards) expect(card.classList.contains("change-highlight")).toBe(true);
    expect(errSpy).not.toHaveBeenCalled();

    // Rings stay up while the poller keeps looking for the straggler.
    act(() => { vi.advanceTimersByTime(3000); });
    for (const card of cards) expect(card.classList.contains("change-highlight")).toBe(true);
    expect(errSpy).not.toHaveBeenCalled();

    // When the highlight ends, the missing entity is reported loudly — never
    // silently — and every ring is cleaned up.
    act(() => { vi.advanceTimersByTime(2500); });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain('data-testid="dose-uuid-missing"');
    expect(onDone).toHaveBeenCalledTimes(1);
    for (const card of cards) expect(card.classList.contains("change-highlight")).toBe(false);
  });

  it("finds nothing → reports and finishes without showing", () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onDone = vi.fn();

    render(
      <ChangeHighlight
        change={bulkChange(["uuid-none"])}
        mode="elderly"
        onNavigate={vi.fn()}
        onDone={onDone}
      />,
    );

    act(() => { vi.advanceTimersByTime(6000); });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="change-highlight-caption"]')).toBeNull();
  });

  it("single-action shape still rings exactly one element with the field-diff caption", async () => {
    const card = addCard("uuid-solo");
    const other = addCard("uuid-untouched");
    const single: AgentAction = {
      tool: "set_medication_reminder",
      summary: "Metformin at 20:00",
      entity_type: "schedule_entry",
      entity_id: "uuid-solo",
      changed_fields: { times: { before: ["18:00"], after: ["20:00"] } },
    };

    render(
      <ChangeHighlight change={single} mode="elderly" onNavigate={vi.fn()} onDone={vi.fn()} />,
    );

    expect(card.classList.contains("change-highlight")).toBe(true);
    expect(other.classList.contains("change-highlight")).toBe(false);
    await waitFor(() => {
      const caption = document.querySelector('[data-testid="change-highlight-caption"]');
      expect(caption).not.toBeNull();
      expect(caption!.textContent).toBe("Updated: dose time 6:00 PM → 8:00 PM");
    });
  });
});
