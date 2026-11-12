import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AgentCard } from "./agent-card";
import { PRESS_MAX_MS, resetPressMemory } from "@/lib/press-memory";
import { fixtureAgents } from "@/test/handlers";
import type { AgentView } from "@/lib/types";

// THE PRESSED ROW OPENS (hitbox proposal 1). A list that slid between the finger landing and the click
// aims the click at a neighbour; the neighbour opens the row that was pressed.

const row = (paneId: string, sessionName: string): AgentView => ({ ...fixtureAgents[0]!, paneId, sessionName });

afterEach(() => {
  cleanup();
  resetPressMemory();
});

function twoRows(onA: () => void, onB: () => void, onHoldA?: () => void) {
  render(
    <div>
      <AgentCard agent={row("w9:p1", "alpha pane")} onClick={onA} onHold={onHoldA} />
      <AgentCard agent={row("w9:p2", "beta pane")} onClick={onB} />
    </div>,
  );
  const [a, b] = screen.getAllByRole("button");
  return { a: a!, b: b! };
}

describe("AgentCard: the pressed row opens", () => {
  it("a tap on the same row opens that row, as before", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const { a } = twoRows(onA, onB);
    fireEvent.pointerDown(a, { button: 0, pointerType: "touch" });
    fireEvent.pointerUp(a, { pointerType: "touch" });
    fireEvent.click(a, { detail: 1 });
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();
  });

  it("a press on A whose click lands on B opens A, not B", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const { a, b } = twoRows(onA, onB);
    fireEvent.pointerDown(a, { button: 0, pointerType: "touch" });
    fireEvent.pointerUp(a, { pointerType: "touch" });
    fireEvent.click(b, { detail: 1 });
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onA).toHaveBeenCalledWith(a);
    expect(onB).not.toHaveBeenCalled();
  });

  it("a keyboard click on B (no pointer, detail 0) opens B even with a press on A in memory", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const { a, b } = twoRows(onA, onB);
    fireEvent.pointerDown(a, { button: 0, pointerType: "touch" });
    fireEvent.click(b, { detail: 0 });
    expect(onB).toHaveBeenCalledTimes(1);
    expect(onA).not.toHaveBeenCalled();
  });

  it("a click on B with no press at all opens B", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const { b } = twoRows(onA, onB);
    fireEvent.click(b, { detail: 1 });
    expect(onB).toHaveBeenCalledTimes(1);
  });

  it("a scroll that cancels the touch leaves no press behind", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const { a, b } = twoRows(onA, onB);
    fireEvent.pointerDown(a, { button: 0, pointerType: "touch" });
    fireEvent.pointerCancel(a, { pointerType: "touch" });
    fireEvent.click(b, { detail: 1 });
    expect(onB).toHaveBeenCalledTimes(1);
    expect(onA).not.toHaveBeenCalled();
  });

  it("a right-click press is not remembered", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const { a, b } = twoRows(onA, onB);
    fireEvent.pointerDown(a, { button: 2, pointerType: "mouse" });
    fireEvent.click(b, { detail: 1 });
    expect(onB).toHaveBeenCalledTimes(1);
  });

  it("a mouse dragged off the row ends its press: the click that lands on B is B's own", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const { a, b } = twoRows(onA, onB);
    fireEvent.pointerDown(a, { button: 0, pointerType: "mouse" });
    fireEvent.pointerLeave(a, { pointerType: "mouse" });
    fireEvent.click(b, { detail: 1 });
    expect(onB).toHaveBeenCalledTimes(1);
    expect(onA).not.toHaveBeenCalled();
  });

  it("a touch's pointerleave, which follows its pointerup, does not end the press before the click", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const { a, b } = twoRows(onA, onB);
    fireEvent.pointerDown(a, { button: 0, pointerType: "touch" });
    fireEvent.pointerUp(a, { pointerType: "touch" });
    fireEvent.pointerLeave(a, { pointerType: "touch" });
    fireEvent.click(b, { detail: 1 });
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();
  });

  it("a row that unmounts under the finger takes its press with it", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const { a, b } = twoRows(onA, onB);
    fireEvent.pointerDown(a, { button: 0, pointerType: "mouse" });
    cleanup();
    twoRows(onA, onB);
    const [, b2] = screen.getAllByRole("button");
    expect(b).not.toBe(b2);
    fireEvent.click(b2!, { detail: 1 });
    expect(onB).toHaveBeenCalledTimes(1);
    expect(onA).not.toHaveBeenCalled();
  });

  it("a right or middle button clears a press that is in memory", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const { a, b } = twoRows(onA, onB);
    fireEvent.pointerDown(a, { button: 0, pointerType: "mouse" });
    fireEvent.pointerDown(b, { button: 1, pointerType: "mouse" });
    fireEvent.click(b, { detail: 1 });
    expect(onB).toHaveBeenCalledTimes(1);
    expect(onA).not.toHaveBeenCalled();
  });

  it("a press that outlives the ceiling is gone: the click on B is B's own", () => {
    vi.useFakeTimers();
    const onA = vi.fn();
    const onB = vi.fn();
    const { a, b } = twoRows(onA, onB);
    fireEvent.pointerDown(a, { button: 0, pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(PRESS_MAX_MS));
    fireEvent.click(b, { detail: 1 });
    expect(onB).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("a hold on A opens neither pane when the shifted list sends the click to B", () => {
    vi.useFakeTimers();
    const onA = vi.fn();
    const onB = vi.fn();
    const onHoldA = vi.fn();
    const { a, b } = twoRows(onA, onB, onHoldA);
    fireEvent.pointerDown(a, { button: 0, pointerType: "touch", clientX: 5, clientY: 5 });
    vi.advanceTimersByTime(600);
    expect(onHoldA).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(a, { pointerType: "touch" });
    fireEvent.click(b, { detail: 1 });
    expect(onA).not.toHaveBeenCalled();
    expect(onB).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// THE ROW THAT IS OPENING (hitbox proposal 4): a bar along its top, aria-busy on the button, no box change.
describe("AgentCard: a row that is opening", () => {
  it("draws the bar and says it is busy only once the open has taken longer than 120ms", async () => {
    const { beginOpening, resetOpenings, OPENING_SHOWN_MS } = await import("@/lib/pane-opening");
    vi.useFakeTimers();
    const key = "/pane/w9%3Ap1";
    render(<AgentCard agent={row("w9:p1", "alpha pane")} onClick={() => {}} glideKey={key} />);
    const button = screen.getByRole("button");
    expect(button).not.toHaveAttribute("aria-busy");
    act(() => {
      beginOpening(key, Symbol("screen"));
      vi.advanceTimersByTime(OPENING_SHOWN_MS - 1);
    });
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button.querySelector(".row-opening")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector(".row-opening")).not.toBeNull();
    // Over the row, never in its layout, and it takes no tap of its own.
    expect(button.querySelector(".row-opening")?.className).toMatch(/absolute/u);
    expect(button.querySelector(".row-opening")?.className).toMatch(/pointer-events-none/u);
    act(() => resetOpenings());
    expect(button).not.toHaveAttribute("aria-busy");
    vi.useRealTimers();
  });

  it("another row's open draws nothing here", async () => {
    const { beginOpening, resetOpenings, OPENING_SHOWN_MS } = await import("@/lib/pane-opening");
    vi.useFakeTimers();
    render(<AgentCard agent={row("w9:p1", "alpha pane")} onClick={() => {}} glideKey="/pane/w9%3Ap1" />);
    act(() => {
      beginOpening("/pane/w9%3Ap2", Symbol("screen"));
      vi.advanceTimersByTime(OPENING_SHOWN_MS);
    });
    expect(screen.getByRole("button")).not.toHaveAttribute("aria-busy");
    act(() => resetOpenings());
    vi.useRealTimers();
  });
});
