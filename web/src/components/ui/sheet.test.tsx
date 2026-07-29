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

  it("exposes a single accessible Close (✕); the backdrop is aria-hidden but still dismisses on a real tap (down+up on it)", () => {
    const onClose = vi.fn();
    const { container } = render(
      <SideSheet open onClose={onClose} title="Navigate">
        body
      </SideSheet>,
    );
    // Only the header ✕ is in the a11y tree now — no giant duplicate "Close" from the backdrop.
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    // ...but the backdrop still closes on a genuine press-and-release on it.
    const backdrop = container.querySelector('button[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    fireEvent.pointerDown(backdrop!);
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

// The on-device bug: a long-press that opens the sheet leaves the finger down at mount time: the
// browser's release `click` lands wherever the finger now is, which is the backdrop — and closing on
// ANY backdrop click meant the sheet closed in the same instant it opened. The fix arms the dismiss
// only when the pointer went DOWN on the backdrop too (press AND release on it), so a click whose
// pointerdown started elsewhere (the pill, in the real gesture) is ignored.
describe("BottomSheet — backdrop dismiss requires press AND release on the backdrop", () => {
  it("stays open when pointerdown happened elsewhere (not the backdrop) and only the click lands on it", () => {
    const onClose = vi.fn();
    const { container } = render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    // Simulate the pointerdown landing on something other than the backdrop (e.g. the pane pill that
    // triggered the long-press), then the release click landing on the backdrop.
    fireEvent.pointerDown(document.body);
    const backdrop = container.querySelector('button[aria-hidden="true"]')!;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes when both pointerdown and click land on the backdrop (a genuine backdrop tap)", () => {
    const onClose = vi.fn();
    const { container } = render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    const backdrop = container.querySelector('button[aria-hidden="true"]')!;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the ✕ button still closes regardless of the backdrop arm state", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape still closes regardless of the backdrop arm state", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("re-arms per open: a stale arm from a previous open doesn't leak into the next one", () => {
    const onClose = vi.fn();
    const { container, rerender } = render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    const backdrop = () => container.querySelector('button[aria-hidden="true"]')!;
    fireEvent.pointerDown(backdrop());
    // Close via Escape instead of the (now-armed) backdrop click, leaving the arm flag set to true.
    fireEvent.keyDown(window, { key: "Escape" });
    rerender(
      <BottomSheet open={false} onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    rerender(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    onClose.mockClear();
    // A click with no pointerdown in this new open should NOT close, even though a stale arm from the
    // previous open was left set to true.
    fireEvent.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();
  });
});

// `aria-modal="true"` tells assistive tech that everything behind the panel is inert. Before the
// trap that was a lie: on the real "Switch pane" sheet, Tab #28 walked out of the dialog and landed
// on the page header underneath — controls a screen reader was insisting weren't there.
describe("sheet — focus containment (the aria-modal contract)", () => {
  function Fixture({ Sheet }: { Sheet: typeof BottomSheet | typeof SideSheet }) {
    return (
      <>
        <button type="button">behind the sheet</button>
        <Sheet open onClose={vi.fn()} title="Panes">
          <button type="button">first row</button>
          <button type="button">last row</button>
        </Sheet>
      </>
    );
  }

  for (const [name, Sheet] of [
    ["BottomSheet", BottomSheet],
    ["SideSheet", SideSheet],
  ] as const) {
    it(`${name}: Tab past the last control wraps to the first, never out of the dialog`, () => {
      render(<Fixture Sheet={Sheet} />);
      const dialog = screen.getByRole("dialog");
      screen.getByRole("button", { name: "last row" }).focus();
      fireEvent.keyDown(window, { key: "Tab" });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    });

    it(`${name}: Shift+Tab off the front wraps to the last control`, () => {
      render(<Fixture Sheet={Sheet} />);
      screen.getByRole("button", { name: "Close" }).focus();
      fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "last row" }));
    });

    it(`${name}: Shift+Tab from the panel itself wraps inward rather than escaping backwards`, () => {
      // The panel is where focus LANDS on open (tabIndex -1), so it's a boundary, not an item.
      render(<Fixture Sheet={Sheet} />);
      fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "last row" }));
    });

    it(`${name}: a stray focus outside is pulled back in on the next Tab`, () => {
      render(<Fixture Sheet={Sheet} />);
      screen.getByRole("button", { name: "behind the sheet" }).focus();
      fireEvent.keyDown(window, { key: "Tab" });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    });
  }

  it("opens on the row a panel nominates with data-autofocus, not at the top", () => {
    render(
      <BottomSheet open onClose={vi.fn()} title="Panes">
        <button type="button">first row</button>
        <button type="button" data-autofocus>
          you are here
        </button>
      </BottomSheet>,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "you are here" }));
  });

  it("keys other than Tab are left alone", () => {
    render(<Fixture Sheet={BottomSheet} />);
    const last = screen.getByRole("button", { name: "last row" });
    last.focus();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(document.activeElement).toBe(last);
  });
});
