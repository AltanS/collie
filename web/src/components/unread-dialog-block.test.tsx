import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { buildBlocks } from "@/lib/harness";
import { UnreadDialogBlock } from "./unread-dialog-block";

// The unread-dialog card (.adr/0053). Driven off a real capture through the real pipeline, so what
// it renders is exactly what the post-pass produces.

const SCREEN = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "panes", "claude-lab--menu-status-screen--w82.txt"),
  "utf8",
);

function cardBlock() {
  const block = buildBlocks(splitLines(parseAnsi(SCREEN)), { agent: "claude" }).find(
    (b) => b.kind === "unread-dialog",
  );
  if (!block || block.kind !== "unread-dialog") throw new Error("the fixture produced no card");
  return block;
}

function renderCard(onAction = vi.fn(), disabled = false) {
  const block = cardBlock();
  const { container } = render(
    <UnreadDialogBlock
      cancel={block.cancel}
      lines={block.lines}
      onAction={onAction}
      disabled={disabled}
    />,
  );
  return { onAction, container, block };
}

describe("UnreadDialogBlock", () => {
  it("renders the caption and exactly two controls: the declared key and Put away", () => {
    renderCard();
    expect(screen.getByText("Collie cannot read this dialog")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    // The key, named the way the Keys keypad names it — and NEVER a verb: on Muse this key steps
    // back rather than dismisses, so a label promising "cancel" would be a lie on a real harness.
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    // ADR 0056, counsel fix: this card shows its mirror by default, so the control's job is
    // putting the key control away, never a claimed swap — "Put away" / its aria-label.
    expect(
      screen.getByRole("button", { name: "Hide this card's buttons, keep the terminal" }),
    ).toBeInTheDocument();
  });

  it("mirrors the whole screen under the control by default, so nothing is hidden", () => {
    const { container, block } = renderCard();
    const pre = container.querySelector("pre")!;
    for (const line of block.lines.slice(0, 5)) {
      const text = line.segments.map((s) => s.text).join("").trim();
      if (text !== "") expect(pre.textContent).toContain(text);
    }
  });

  // ADR 0056, counsel fix: the control puts the key control away for a decluttered, mirror-only
  // view, and "Show the buttons" restores it. The rows themselves stay on screen throughout (same
  // `lines`, same RawMirror) — this card never claims a swap.
  it("declutters to the mirror alone when Put away is tapped, and restores on Show the buttons", async () => {
    const user = userEvent.setup();
    const { container, block } = renderCard();

    await user.click(
      screen.getByRole("button", { name: "Hide this card's buttons, keep the terminal" }),
    );

    expect(screen.queryByRole("button", { name: "Esc" })).toBeNull();
    const pre = container.querySelector("pre")!;
    for (const line of block.lines.slice(0, 5)) {
      const text = line.segments.map((s) => s.text).join("").trim();
      if (text !== "") expect(pre.textContent).toContain(text);
    }
    expect(screen.getByRole("button", { name: "Show the buttons" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show the buttons" }));
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();
  });

  it("fires the declared key on a tap", async () => {
    const user = userEvent.setup();
    const { onAction } = renderCard();
    await user.click(screen.getByRole("button", { name: "Esc" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("Escape");
  });

  it("presses nothing while disabled", async () => {
    const user = userEvent.setup();
    const { onAction } = renderCard(vi.fn(), true);
    await user.click(screen.getByRole("button", { name: "Esc" }));
    expect(onAction).not.toHaveBeenCalled();
  });

  // DESIGN.md §2: a state may repaint, it may not re-lay-out. The in-flight state recolours the
  // button and nothing else — same text, same children, same reserved border — so the card the
  // operator is reading does not shift under the tap.
  it("does not move content when the tap goes in flight", async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => (release = resolve));
    const { container } = renderCard(vi.fn().mockReturnValue(pending));
    const button = screen.getByRole("button", { name: "Esc" });

    const before = {
      text: container.textContent,
      children: button.childNodes.length,
      classes: button.className.split(" ").filter((c) => c.startsWith("min-h") || c === "border")
        .length,
    };

    await user.click(button);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(container.textContent).toBe(before.text);
    expect(button.childNodes.length).toBe(before.children);
    // The tap floor and the reserved edge survive the state (DESIGN.md §6 and §2).
    expect(
      button.className.split(" ").filter((c) => c.startsWith("min-h") || c === "border").length,
    ).toBe(before.classes);

    release();
  });
});
