import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BottomSheet } from "./sheet";

// THE KEYS OF A MENU BESIDE ITS BUTTON. A sheet drawn as a menu (the pane menu on a wide window) takes the
// arrow keys between its rows, and a menu a key opened puts the focus on its first row; Esc closes it and the
// focus goes back to its button. The wide window and the laid-out button are stood in for: jsdom lays nothing out.

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      // SAFETY: a stand-in for the browser's MediaQueryList with every member the app reads.
      ({
        matches: /min-width/u.test(query),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
});

afterEach(() => vi.unstubAllGlobals());

function Harness({ focusFirstRow = false }: { focusFirstRow?: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={button} type="button" onClick={() => setOpen(true)}>
        dots
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Pane" anchor={button} focusFirstRow={focusFirstRow}>
        <button type="button">First</button>
        <button type="button" disabled>
          Skipped
        </button>
        <button type="button">Second</button>
        <button type="button">Third</button>
      </BottomSheet>
    </>
  );
}

/** The panel: the element with the focus and the key handler, inside the dialog frame. */
const panel = () => {
  const found = screen.getByRole("dialog").querySelector<HTMLElement>("[data-presentation]");
  if (found === null) throw new Error("no panel");
  return found;
};

function openMenu() {
  const view = render(<Harness focusFirstRow />);
  const dots = screen.getByRole("button", { name: "dots" });
  dots.getBoundingClientRect = () => ({ left: 100, top: 10, right: 144, bottom: 54, width: 44, height: 44, x: 100, y: 10, toJSON: () => ({}) });
  act(() => dots.click());
  return { dots, view };
}

describe("a menu beside its button", () => {
  it("draws as a menu, and a key-opened one puts the focus on its first row", () => {
    openMenu();
    expect(panel()).toHaveAttribute("data-presentation", "menu");
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

  it("moves the focus with Down and Up between the enabled rows, and wraps", () => {
    openMenu();
    const dialog = panel();
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "Second" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "Third" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    expect(screen.getByRole("button", { name: "Third" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Home" });
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "End" });
    expect(screen.getByRole("button", { name: "Third" })).toHaveFocus();
  });

  it("leaves a key with a modifier, and every other key, to the page", () => {
    openMenu();
    const dialog = panel();
    expect(fireEvent.keyDown(dialog, { key: "ArrowDown", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(dialog, { key: "a" })).toBe(true);
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

  it("closes on Escape and gives the focus back to its button", () => {
    const { dots } = openMenu();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dots).toHaveFocus();
  });

  it("opened by a tap, leaves the focus on the panel, and Down takes the first row", () => {
    render(<Harness />);
    const dots = screen.getByRole("button", { name: "dots" });
    dots.getBoundingClientRect = () => ({ left: 100, top: 10, right: 144, bottom: 54, width: 44, height: 44, x: 100, y: 10, toJSON: () => ({}) });
    act(() => dots.click());
    const dialog = panel();
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });
});
