import { fireEvent, render, screen } from "@testing-library/react";

import { BottomSheet, SideSheet } from "./sheet";

// Focus + labelling: the sheets are role=dialog/aria-modal, so they should be named by their title,
// move focus inside on open, restore it on close, and expose exactly ONE accessible "Close" (the
// header ✕) — the full-screen backdrop stays tappable but is hidden from assistive tech.
describe("sheet — focus & labelling", () => {
  it("labels the dialog with its title (aria-labelledby)", () => {
    render(
      <BottomSheet open onClose={vi.fn()} title="Keys">
        body
      </BottomSheet>,
    );
    expect(screen.getByRole("dialog", { name: "Keys" })).toBeInTheDocument();
  });

  it("exposes a single accessible Close (✕); the backdrop is aria-hidden but still dismisses", () => {
    const onClose = vi.fn();
    const { container } = render(
      <SideSheet open onClose={onClose} title="Navigate">
        body
      </SideSheet>,
    );
    // Only the header ✕ is in the a11y tree now — no giant duplicate "Close" from the backdrop.
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    // ...but the backdrop still closes on a pointer tap.
    const backdrop = container.querySelector('button[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the panel on open and restores it to the opener on close", () => {
    const opener = document.createElement("button");
    opener.textContent = "open";
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(
      <BottomSheet open onClose={vi.fn()} title="Keys">
        body
      </BottomSheet>,
    );
    // Focus is now inside the dialog panel (not left on the opener behind the modal).
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);

    rerender(
      <BottomSheet open={false} onClose={vi.fn()} title="Keys">
        body
      </BottomSheet>,
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
