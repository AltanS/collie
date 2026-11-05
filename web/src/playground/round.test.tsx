import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Round, type RoundOption } from "./round";

let mounts = 0;

function Probe({ caseValue, n }: { caseValue: string; n: number }) {
  return <p data-testid={`probe-${n}`}>{`${n}:${caseValue}`}</p>;
}

function Counter() {
  mounts += 1;
  return null;
}

const OPTIONS: readonly RoundOption[] = [
  { n: 0, title: "Today", render: ({ caseValue }) => <Probe n={0} caseValue={caseValue} /> },
  { n: 1, title: "Lines", render: ({ caseValue }) => <Probe n={1} caseValue={caseValue} /> },
  { n: 2, title: "Counter", render: () => <Counter /> },
];

const CASES = [
  { value: "quiet", label: "Quiet" },
  { value: "busy", label: "Busy" },
];

function mount() {
  return render(<Round id="demo" cases={CASES} options={OPTIONS} frame={{ kind: "phone", height: 300 }} />);
}

describe("Round", () => {
  it("gives every option its handle and one number", () => {
    const { container } = mount();
    const handles = [...container.querySelectorAll(".pg-grid > *")].map((el) => el.getAttribute("data-state"));
    expect(handles).toEqual(["demo-option-0", "demo-option-1", "demo-option-2"]);
  });

  it("drives every option with one Case switch", () => {
    mount();
    expect(screen.getByTestId("probe-0")).toHaveTextContent("0:quiet");
    fireEvent.click(within(screen.getByRole("group", { name: "Case" })).getByRole("button", { name: "Busy" }));
    expect(screen.getByTestId("probe-0")).toHaveTextContent("0:busy");
    expect(screen.getByTestId("probe-1")).toHaveTextContent("1:busy");
  });

  it("remounts every option on Replay", () => {
    mounts = 0;
    mount();
    expect(mounts).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(mounts).toBe(2);
  });

  it("scales the frames from the top-left on Zoom", () => {
    const { container } = mount();
    fireEvent.click(within(screen.getByRole("group", { name: "Zoom" })).getByRole("button", { name: "2x" }));
    const scaled = container.querySelector<HTMLElement>('[style*="scale(2)"]');
    expect(scaled?.style.transformOrigin).toMatch(/^0(px)? 0(px)?$/);
  });

  it("shows one frame in Flip and swaps A and B on a tap", () => {
    const { container } = mount();
    fireEvent.click(within(screen.getByRole("group", { name: "Flip" })).getByRole("button", { name: "On" }));
    const cell = (n: number) => container.querySelector<HTMLElement>(`[data-state="demo-option-${n}"]`)!;
    // A is 0 and B is 1 by default: those two are mounted, the third is not.
    expect(container.querySelector('[data-state="demo-option-2"]')).toBeNull();
    expect(cell(0)).not.toHaveClass("invisible");
    expect(cell(1)).toHaveClass("invisible");
    fireEvent.click(cell(0));
    expect(cell(0)).toHaveClass("invisible");
    expect(cell(1)).not.toHaveClass("invisible");
    fireEvent.click(cell(1));
    expect(cell(0)).not.toHaveClass("invisible");
  });
});
