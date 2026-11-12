import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AgentCard } from "./agent-card";
import { resetPressMemory } from "@/lib/press-memory";
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
