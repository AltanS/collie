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

const PICKER = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "panes", "claude--menu-model-picker.txt"),
  "utf8",
);

function menuBlock() {
  const block = claudeBuildBlocks(splitLines(parseAnsi(PICKER))).find((b) => b.kind === "menu");
  if (!block || block.kind !== "menu") throw new Error("the picker fixture lifted no menu block");
  return block;
}

function renderMenu(onAction = vi.fn()) {
  const block = menuBlock();
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
