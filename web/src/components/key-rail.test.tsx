import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { KeyRail } from "./key-rail";
import type { PinSide } from "@/hooks/use-pin-side";

// The rail is the one key surface that is ALWAYS on screen, so what it must never get wrong is the
// wire token behind each cap: a phone has no other route to Esc, Tab, ⇧Tab, the arrows or ^C, and a
// mislabelled cap sends the wrong key into a live terminal. These pin the token, the refusal, the
// pad's toggle contract and the edge the pin docks to.
function renderRail(overrides: Partial<React.ComponentProps<typeof KeyRail>> = {}) {
  const props: React.ComponentProps<typeof KeyRail> = {
    onSend: vi.fn(async () => true),
    unsupportedKeys: [],
    directActive: false,
    onOpenPad: vi.fn(),
    padOpen: false,
    ...overrides,
  };
  render(<KeyRail {...props} />);
  return props;
}
// `usePinSide` reads the store on mount (it is per-hook state, not a shared module store), so the
// edge is set by writing the key before render — the same thing a reload does.
function pinTo(side: PinSide) {
  localStorage.setItem("collie:pin-side:v1", JSON.stringify({ side }));
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("KeyRail", () => {
  it("sends each cap's exact Herdr key token", async () => {
    const user = userEvent.setup();
    const props = renderRail();

    // Esc and Tab read as their own labels; the arrows are glyphs, so the wire name is the
    // accessible name (that is the contract the aria-label exists for).
    for (const [name, token] of [
      ["Esc", "Escape"],
      ["Tab", "Tab"],
      ["Up", "Up"],
      ["Down", "Down"],
      ["Left", "Left"],
      ["Right", "Right"],
    ] as const) {
      await user.click(screen.getByRole("button", { name }));
      expect(props.onSend).toHaveBeenCalledWith([token]);
    }
  });

  it("puts interrupt immediately after Escape, before the scrollable tail", () => {
    renderRail();
    const buttons = screen.getAllByRole("button");
    const escapeIndex = buttons.indexOf(screen.getByRole("button", { name: "Esc" }));
    expect(buttons[escapeIndex + 1]).toHaveAccessibleName("⌃C");
  });

  it("sends ⇧Tab and ^C as +-joined chords, never tmux spelling", async () => {
    const user = userEvent.setup();
    const props = renderRail();

    // Herdr's grammar is "+"-joined (HERDR_API.md): `ctrl+c`, never `C-c`.
    await user.click(screen.getByRole("button", { name: "⇧Tab" }));
    expect(props.onSend).toHaveBeenCalledWith(["shift+Tab"]);

    await user.click(screen.getByRole("button", { name: "⌃C" }));
    expect(props.onSend).toHaveBeenCalledWith(["ctrl+c"]);
  });

  it("greys a key this multiplexer refuses instead of sending it", async () => {
    const user = userEvent.setup();
    // `keysSendable` refuses by BASE key (mux-capability.ts), so a refused "Tab" takes the bare
    // Tab and the ⇧Tab chord with it — and leaves every other cap alone.
    const props = renderRail({ unsupportedKeys: ["Tab"] });

    // Greyed in place, not removed: the rail order is fixed muscle memory, so pulling a key out
    // would move every key after it.
    const refused = screen.getByRole("button", { name: "Tab" });
    expect(refused).toBeDisabled();
    expect(screen.getByRole("button", { name: "⇧Tab" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Esc" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "⌃C" })).toBeEnabled();

    await user.click(refused);
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("keeps Backspace off the rail until direct typing is armed", () => {
    renderRail();
    // In Reply mode it would sit one row above a textarea where it means delete-draft.
    expect(screen.queryByRole("button", { name: "Backspace" })).not.toBeInTheDocument();

    cleanup();
    renderRail({ directActive: true });
    expect(screen.getByRole("button", { name: "Backspace" })).toBeInTheDocument();
  });

  it("the pad is the Keys dock's toggle, and says so to a reader", async () => {
    const user = userEvent.setup();
    const props = renderRail();

    const pad = screen.getByRole("button", { name: "Keys" });
    expect(pad).toHaveAttribute("aria-expanded", "false");
    expect(pad).toHaveAttribute("aria-controls", "dock-keys");

    await user.click(pad);
    expect(props.onOpenPad).toHaveBeenCalled();

    cleanup();
    renderRail({ padOpen: true });
    expect(screen.getByRole("button", { name: "Keys" })).toHaveAttribute("aria-expanded", "true");
  });

  it("docks the pad on the configured edge", () => {
    // Position, not decoration: the pin is the thumb's target, so which end it sits at is the
    // whole point of the setting. Asserted through DOM order rather than class names.
    pinTo("right");
    renderRail();
    const railRight = document.querySelector('[data-slot="key-rail"]')!;
    expect(railRight.lastElementChild).toBe(screen.getByRole("button", { name: "Keys" }));

    cleanup();
    pinTo("left");
    renderRail();
    const railLeft = document.querySelector('[data-slot="key-rail"]')!;
    expect(railLeft.firstElementChild).toBe(screen.getByRole("button", { name: "Keys" }));
  });

  it("locks every key when the composer is locked", () => {
    renderRail({ disabled: true });
    for (const name of ["Esc", "Tab", "Up", "Keys"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });
});
