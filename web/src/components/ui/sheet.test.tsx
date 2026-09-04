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

  // THE PANEL IS A RAISED SURFACE, and the ground says so. It used to be `bg-background` — the same
  // token as the page it floats over — with a `--border` hairline for an edge. In dark that is the
  // app's worst case: the page is oklch(0.145), the scrim behind only darkens it, and 1.26:1 of
  // border was the whole separation. The operator's report was that the drawer was hard to make out.
  // `--card` (oklch 0.205 dark, white in light) is a real step up, and `--rule` is the token for a
  // cut between REGIONS rather than a component's own outline (DESIGN.md §4). Both halves are pinned:
  // a colour with no width paints nothing (§7 trap 1), and a ground restored to the page's own token
  // would put the panel back in the hole it came out of.
  it("stands on the raised surface, edged with the region rule", () => {
    const { container } = render(
      <BottomSheet open onClose={vi.fn()} title="Actions">
        body
      </BottomSheet>,
    );
    const panel = container.querySelector('div[tabindex="-1"]')!;
    expect(panel.className).toMatch(/(?:^|\s)bg-card(?=\s|$)/);
    expect(panel.className).not.toMatch(/(?:^|\s)bg-background(?=\s|$)/);
    expect(panel.className).toMatch(/(?:^|\s)border-t border-rule(?=\s|$)/);
    // The sticky title row rides the same surface — a header in the page's colour would cut the
    // panel in two at the top.
    const header = container.querySelector('[data-slot="sheet-title-row"]')!.parentElement!;
    expect(header.className).toContain("bg-card/95");
  });
});

// The native-feel drag reveal (use-sheet-pull.ts): while `!open && pull > 0` the sheet peeks up
// under the finger, mounted but not yet a modal, and when `open` follows right after, the
// entrance continues the transform rather than restarting the slide-in keyframe from 100%.
describe("BottomSheet: pull-driven peek", () => {
  it("renders a peeking panel, following the pull, hidden from assistive tech", () => {
    const { container } = render(
      <BottomSheet open={false} onClose={vi.fn()} title="Switch pane" pull={80}>
        body
      </BottomSheet>,
    );
    // Nothing has opened, so there is no dialog in the a11y tree yet.
    expect(screen.queryByRole("dialog")).toBeNull();
    const root = container.firstElementChild!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    const panel = container.querySelector<HTMLElement>('div[style*="translateY"]')!;
    expect(panel.style.transform).toBe("translateY(max(0px, calc(100% - 80px)))");
  });

  it("starts the peek's top edge at the handle's anchor, not the screen's bottom edge", () => {
    // pullFrom is the handle's own distance from the viewport bottom (useSheetPull's onAnchor);
    // the transform is pullFrom + pull, so a peek that started 100px above the bottom edge and has
    // been dragged 40px further reports 140px total.
    const { container } = render(
      <BottomSheet open={false} onClose={vi.fn()} title="Switch pane" pull={40} pullFrom={100}>
        body
      </BottomSheet>,
    );
    const panel = container.querySelector<HTMLElement>('div[style*="translateY"]')!;
    expect(panel.style.transform).toContain("140px");
    expect(panel.style.transform).toBe("translateY(max(0px, calc(100% - 140px)))");
  });

  it("renders nothing when closed and not being pulled", () => {
    const { container } = render(
      <BottomSheet open={false} onClose={vi.fn()} title="Switch pane" pull={0}>
        body
      </BottomSheet>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("skips the slide-in entrance when open follows a peek, continuing the transform instead", () => {
    const { container, rerender } = render(
      <BottomSheet open={false} onClose={vi.fn()} title="Switch pane" pull={150}>
        body
      </BottomSheet>,
    );
    rerender(
      <BottomSheet open onClose={vi.fn()} title="Switch pane" pull={0}>
        body
      </BottomSheet>,
    );
    const panel = container.querySelector<HTMLElement>('div[style*="translateY"]')!;
    expect(panel.className).not.toMatch(/animate-in/);
    expect(panel.className).not.toMatch(/slide-in-from-bottom/);
    expect(panel.style.transform).toBe("translateY(0)");
  });

  it("plays the ordinary slide-in entrance on a fresh open with no preceding peek", () => {
    const { container } = render(
      <BottomSheet open onClose={vi.fn()} title="Switch pane">
        body
      </BottomSheet>,
    );
    const panel = container.querySelector<HTMLElement>('div[tabindex="-1"]')!;
    expect(panel.className).toMatch(/animate-in/);
    expect(panel.className).toMatch(/slide-in-from-bottom/);
  });

  it("caps the panel at the content column while the backdrop stays the whole screen", () => {
    // The sheet is the app's only floating layer and it holds ordinary rows, so it stops at the same
    // 640px every route body uses; ui/toast-viewport.tsx already caps its layer there. Uncapped, the
    // panel spanned the whole viewport — 1366px on a landscape 13-inch iPad — for rows that were
    // drawn for a phone. The dim is the exception and must not be capped with it.
    const { container } = render(
      <BottomSheet open onClose={vi.fn()} title="Switch pane">
        body
      </BottomSheet>,
    );
    const panel = container.querySelector<HTMLElement>('div[tabindex="-1"]')!;
    expect(panel.className).toMatch(/\bmx-auto\b/);
    expect(panel.className).toMatch(/\bmax-w-screen-sm\b/);
    const backdrop = container.querySelector<HTMLElement>('button[aria-hidden="true"]');
    expect(backdrop?.className).toMatch(/\babsolute inset-0\b/);
  });
});
