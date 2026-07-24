import { useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { performAct } from "./actor";

// Proves the crux of Guided Auto-Navigation's actor: driving a React-controlled
// input the naive way (el.value = x) does NOT update React state — the value is
// swallowed by React's own value tracker — whereas performAct's native-prototype
// setter + dispatched input event does. If this ever regresses, autonomous
// "fill" steps would silently type into the DOM while React (and the eventual
// write) sees an empty field.

afterEach(cleanup);

const noCancel = { shouldCancel: () => false };

function ControlledInput() {
  const [value, setValue] = useState("");
  return (
    <div>
      <input data-testid="field" value={value} onChange={e => setValue(e.target.value)} />
      <span data-testid="echo">{value}</span>
    </div>
  );
}

function ControlledSelect() {
  const [value, setValue] = useState("morning");
  return (
    <div>
      <select data-testid="sel" value={value} onChange={e => setValue(e.target.value)}>
        <option value="morning">Morning</option>
        <option value="noon">Noon</option>
      </select>
      <span data-testid="selecho">{value}</span>
    </div>
  );
}

describe("performAct", () => {
  it("fill drives a controlled input so React state actually updates", async () => {
    const { getByTestId } = render(<ControlledInput />);
    await act(async () => {
      await performAct(
        { kind: "fill", selector: '[data-testid="field"]', value: "Metformin", paceMs: 1 },
        noCancel,
      );
    });
    expect((getByTestId("field") as HTMLInputElement).value).toBe("Metformin");
    // The echo reflects React state — proof onChange fired, not just the DOM node.
    expect(getByTestId("echo").textContent).toBe("Metformin");
  });

  it("a naive el.value assignment does NOT update React (fix is load-bearing)", async () => {
    const { getByTestId } = render(<ControlledInput />);
    const input = getByTestId("field") as HTMLInputElement;
    act(() => {
      input.value = "NaiveSet";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // React's tracker was updated by its own patched setter, so onChange never
    // fires — state (and the echo) stay empty.
    expect(getByTestId("echo").textContent).toBe("");
  });

  it("click fires the target's onClick", async () => {
    let clicked = false;
    render(
      <button data-testid="btn" onClick={() => { clicked = true; }}>
        Go
      </button>,
    );
    await act(async () => {
      await performAct({ kind: "click", selector: '[data-testid="btn"]' }, noCancel);
    });
    expect(clicked).toBe(true);
  });

  it("select updates a controlled <select>", async () => {
    const { getByTestId } = render(<ControlledSelect />);
    await act(async () => {
      await performAct({ kind: "select", selector: '[data-testid="sel"]', value: "noon" }, noCancel);
    });
    expect(getByTestId("selecho").textContent).toBe("noon");
  });

  it("bails without throwing when the target selector matches nothing", async () => {
    await act(async () => {
      await performAct({ kind: "click", selector: '[data-testid="does-not-exist"]' }, noCancel);
    });
    // No assertion beyond "did not throw" — a bad step must fail soft, never wedge the run.
  });
});
