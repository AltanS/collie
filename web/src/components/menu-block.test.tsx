import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { claudeBuildBlocks } from "@/lib/harness/claude";
import { MenuBlock } from "./menu-block";

// The generic menu renderer. Driven off the real `/model` capture through the real pipeline, so what
// it renders is exactly what the adapter lifts.

const PANES = join(import.meta.dirname, "..", "fixtures", "panes");
const PICKER = readFileSync(join(PANES, "claude--menu-model-picker.txt"), "utf8");
// The /effort slider at 132 columns: the one capture that prints its whole scale, so the card shows
// one chip per level instead of the arrows (.adr/0054).
const SLIDER = readFileSync(join(PANES, "claude--menu-effort-slider--w132.txt"), "utf8");

function menuBlock(capture = PICKER) {
  const block = claudeBuildBlocks(splitLines(parseAnsi(capture))).find((b) => b.kind === "menu");
  if (!block || block.kind !== "menu") throw new Error("the fixture lifted no menu block");
  return block;
}

function renderMenu(onAction = vi.fn(), capture = PICKER) {
  const block = menuBlock(capture);
  render(<MenuBlock menu={block.menu} lines={block.lines} onAction={onAction} />);
  return onAction;
}

describe("MenuBlock", () => {
  it("renders the footer's actions, the cancel, and the nav the screen advertised", () => {
    renderMenu();
    expect(screen.getByRole("button", { name: "Set as default" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use this session only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move up" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move down" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /right — adjust/i })).toBeInTheDocument();
  });

  // The arrows are unreadable on their own — the cluster has to say WHAT it adjusts, both visibly and
  // in the accessible names, and that text is the row's live value.
  it("labels the ←/→ cluster with the value it adjusts", () => {
    renderMenu();
    expect(
      screen.getByRole("button", { name: "Left — adjust (◐ Medium effort)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Right — adjust (◐ Medium effort)" }),
    ).toBeInTheDocument();
    // …and visibly, between them.
    expect(screen.getAllByText("◐ Medium effort").length).toBeGreaterThan(0);
  });

  // The region stays visible because the grammar parsed the FOOTER, not the body: the options and
  // their descriptions exist only as terminal text, and the buttons are meaningless without them.
  it("keeps the terminal region readable above the controls", () => {
    renderMenu();
    expect(screen.getByText(/Most capable for your hardest/)).toBeInTheDocument();
  });

  // .adr/0009 at the UI edge: a digit tap here would confirm AND persist the user's default model.
  it("offers no digit buttons", () => {
    renderMenu();
    for (const button of screen.getAllByRole("button")) {
      expect(/^\d+$/.test(button.textContent ?? ""), button.textContent ?? "").toBe(false);
    }
  });

  it("sends a footer key as a committing action and an arrow as nav", async () => {
    const user = userEvent.setup();
    const onAction = renderMenu();

    await user.click(screen.getByRole("button", { name: "Use this session only" }));
    expect(onAction).toHaveBeenCalledWith({ keys: ["s"], nav: false });

    await user.click(screen.getByRole("button", { name: "Move down" }));
    expect(onAction).toHaveBeenCalledWith({ keys: ["Down"], nav: true });
  });

  it("renders but refuses taps when disabled", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const block = menuBlock();
    render(<MenuBlock menu={block.menu} lines={block.lines} onAction={onAction} disabled />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onAction).not.toHaveBeenCalled();
  });
});

// The printed scale (.adr/0054). The /effort slider names every level on one row, so the card drops
// the two arrows and offers the levels themselves; a tap is the delta in presses of the arrow the
// footer advertised, never a key the screen did not name.
describe("MenuBlock — a printed scale", () => {
  it("renders one chip per level and no arrow row", () => {
    renderMenu(vi.fn(), SLIDER);
    for (const level of ["low", "high", "xhigh", "max", "ultracode"]) {
      expect(screen.getByRole("button", { name: `adjust to ${level}` })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "medium, current" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^left — adjust/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^right — adjust/i })).not.toBeInTheDocument();
  });

  it("marks the current level and refuses a tap on it", () => {
    renderMenu(vi.fn(), SLIDER);
    const current = screen.getByRole("button", { name: "medium, current" });
    expect(current).toHaveAttribute("aria-current", "true");
    expect(current).toBeDisabled();
  });

  it("sends the delta as repeated presses of the arrow the footer named", async () => {
    const user = userEvent.setup();
    const onAction = renderMenu(vi.fn(), SLIDER);

    // medium (index 1) → xhigh (index 3): two Rights.
    await user.click(screen.getByRole("button", { name: "adjust to xhigh" }));
    expect(onAction).toHaveBeenCalledWith({ keys: ["Right", "Right"], nav: true });

    // medium (index 1) → low (index 0): one Left.
    await user.click(screen.getByRole("button", { name: "adjust to low" }));
    expect(onAction).toHaveBeenCalledWith({ keys: ["Left"], nav: true });
  });

  it("emits no key the screen did not name", async () => {
    const user = userEvent.setup();
    const onAction = renderMenu(vi.fn(), SLIDER);
    await user.click(screen.getByRole("button", { name: "adjust to ultracode" }));
    // SAFETY: `onAction` is the component's own `MenuBlockAction` handler, so the first argument of
    // the first call is a MenuBlockAction and carries `keys`. The mock is untyped, nothing else.
    const sent = onAction.mock.calls[0]![0] as { keys: string[] };
    expect(new Set(sent.keys)).toEqual(new Set(["Right"]));
  });

  // The `/model` picker prints the current value alone, so nothing changes there.
  it("keeps the plain arrows when the screen printed no scale", () => {
    renderMenu();
    expect(screen.getByRole("button", { name: /^left — adjust/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^right — adjust/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /, current$/ })).not.toBeInTheDocument();
  });
});
