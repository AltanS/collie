import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Keyboard, Terminal } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetHarnessBar, setHarnessBarEnabled } from "@/lib/harness-bar-pref";
import { ActionsRow, type GeneralAction } from "./actions-row";

afterEach(() => __resetHarnessBar());

const took = async () => true;

function general(over: Partial<GeneralAction> = {}): GeneralAction {
  return { id: "keys", icon: Keyboard, label: "Keys", onSelect: vi.fn(), ...over };
}

/** Every button in the row, in paint order, by its accessible name. */
const names = () => screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));

describe("ActionsRow", () => {
  it("puts Collie's own actions first and the harness's own after them", () => {
    render(
      <ActionsRow
        general={[general(), general({ id: "type", icon: Terminal, label: "Type into terminal" })]}
        agent="claude"
        onRun={took}
      />,
    );
    // The left edge is the same control on every pane there is, which is the whole reason for this
    // order: the harness half is absent on a shell, on grok, and with the switch off.
    expect(names()).toEqual(["Keys", "Type into terminal", "Model", "Effort", "Compact", "Resume"]);
  });

  it("names both groups, so a reader knows which half it has walked into", () => {
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} />);
    expect(screen.getByRole("group", { name: "Controls" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Harness shortcuts" })).toBeInTheDocument();
  });

  it("hides the harness segment alone when the switch is off — never the general actions", () => {
    setHarnessBarEnabled(false);
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} />);
    expect(names()).toEqual(["Keys"]);
    expect(screen.queryByRole("group", { name: "Harness shortcuts" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Controls" })).toBeInTheDocument();
  });

  it("draws the general actions on a pane whose harness has no bar at all", () => {
    render(<ActionsRow general={[general()]} agent="grok" onRun={took} />);
    expect(names()).toEqual(["Keys"]);
  });

  it("costs no height when there is neither a general action nor a harness bar", () => {
    // With nothing to carry, the row must not render an empty scroller — that would spend 12px
    // on nothing.
    const { container } = render(<ActionsRow general={[]} agent="grok" onRun={took} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("draws the harness segment alone when there are no general actions", () => {
    render(<ActionsRow general={[]} agent="pi" onRun={took} />);
    expect(names()).toEqual(["Model", "Compact", "Tree", "Resume"]);
    expect(screen.queryByRole("group", { name: "Controls" })).not.toBeInTheDocument();
  });

  it("carries each general action's own state: expanded, pressed, disabled, and the tap", async () => {
    const onSelect = vi.fn();
    render(
      <ActionsRow
        general={[
          general({ id: "keys", expanded: true, on: true, onSelect }),
          general({ id: "type", icon: Terminal, label: "Type into terminal", pressed: true }),
          general({ id: "quick", icon: Keyboard, label: "Quick", disabled: true }),
        ]}
        agent="grok"
        onRun={took}
      />,
    );
    expect(screen.getByRole("button", { name: "Keys" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Type into terminal" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Quick" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Keys" }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("tints the harness segment in the harness's own colour, and never with a rule down its side", () => {
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} />);
    const segment = document.querySelector<HTMLElement>('[data-slot="harness-bar"]')!;
    // Claude's #D97757, at 14% of whatever ground is behind it. jsdom normalises the hex to rgb().
    expect(segment.style.backgroundColor).toBe("color-mix(in srgb, rgb(217, 119, 87) 14%, transparent)");
    expect(segment.className).not.toMatch(/border-l/);
  });

  it("falls back to the app's own ground for a brand whose colour is black", () => {
    // Codex and pi are officially monochrome. A near-black icon is invisible in the dark theme, so
    // absent is a real answer and the segment takes the muted ground instead of a wrong colour.
    render(<ActionsRow general={[general()]} agent="codex" onRun={took} />);
    const segment = document.querySelector<HTMLElement>('[data-slot="harness-bar"]')!;
    expect(segment.style.backgroundColor).toBe("");
    expect(segment.className).toMatch(/(?:^|\s)bg-muted(?=\s|$)/);
  });
});
