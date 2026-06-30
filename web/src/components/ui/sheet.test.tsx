import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BottomSheet, SideSheet } from "./sheet";

// The header opts into a view transition group via `view-transition-name`, which promotes it to its
// own composited layer that can flicker above an open sheet's backdrop on a poll repaint. While any
// sheet is open we mark <html data-sheet-open> so the CSS can drop the name. These tests lock in that
// marker (set while open, ref-counted across overlapping sheets, cleared when all close).
describe("sheet — data-sheet-open marker", () => {
  afterEach(() => {
    delete document.documentElement.dataset.sheetOpen;
  });

  it("is absent when no sheet is open", () => {
    render(<SideSheet open={false} onClose={vi.fn()} title="Navigate">body</SideSheet>);
    expect(document.documentElement.dataset.sheetOpen).toBeUndefined();
  });

  it("is set while a sheet is open and cleared when it closes", () => {
    const { rerender } = render(
      <SideSheet open onClose={vi.fn()} title="Navigate">
        body
      </SideSheet>,
    );
    expect(document.documentElement.dataset.sheetOpen).toBe("");

    rerender(
      <SideSheet open={false} onClose={vi.fn()} title="Navigate">
        body
      </SideSheet>,
    );
    expect(document.documentElement.dataset.sheetOpen).toBeUndefined();
  });

  it("stays set until the last of two overlapping sheets closes (ref-counted)", () => {
    const { rerender } = render(
      <>
        <SideSheet open onClose={vi.fn()} title="Navigate">
          a
        </SideSheet>
        <BottomSheet open onClose={vi.fn()} title="Switch pane">
          b
        </BottomSheet>
      </>,
    );
    expect(document.documentElement.dataset.sheetOpen).toBe("");

    // Close one — still marked because the other is open.
    rerender(
      <>
        <SideSheet open={false} onClose={vi.fn()} title="Navigate">
          a
        </SideSheet>
        <BottomSheet open onClose={vi.fn()} title="Switch pane">
          b
        </BottomSheet>
      </>,
    );
    expect(document.documentElement.dataset.sheetOpen).toBe("");

    // Close the last — now cleared.
    rerender(
      <>
        <SideSheet open={false} onClose={vi.fn()} title="Navigate">
          a
        </SideSheet>
        <BottomSheet open={false} onClose={vi.fn()} title="Switch pane">
          b
        </BottomSheet>
      </>,
    );
    expect(document.documentElement.dataset.sheetOpen).toBeUndefined();
  });

  it("still closes on backdrop tap (marker behaviour doesn't break dismissal)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SideSheet open onClose={onClose} title="Navigate">
        body
      </SideSheet>,
    );
    // Two "Close" affordances (the ✕ and the backdrop) — tapping either calls onClose.
    await user.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    expect(onClose).toHaveBeenCalled();
  });
});
