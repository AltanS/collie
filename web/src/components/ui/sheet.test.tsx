import { fireEvent, render, screen } from "@testing-library/react";

import { act } from "react";

import { cn } from "@/lib/utils";

import { BottomSheet, SHEET_BODY_STICKY, TALL_SHEET_CLEARANCE, useAnySheetOpen } from "./sheet";

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
      <BottomSheet open onClose={onClose} title="Navigate">
        body
      </BottomSheet>,
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
    expect(header.className).toMatch(/(?:^|\s)bg-card(?=\s|$)/);
    // Solid: the rows under it animate, and a blur over an animation redraws every frame (issue 748).
    expect(header.className).not.toContain("backdrop-blur");
  });
});

// THE TITLE ROW'S ACTION SLOT: one generic control at the trailing end, directly before the close
// button, and nothing at all when a caller passes none.
describe("BottomSheet: the title row's action slot", () => {
  it("draws the action directly before the close button, in the title row", () => {
    const { container } = render(
      <BottomSheet open onClose={vi.fn()} title="Switch pane" action={<button type="button">Create</button>}>
        body
      </BottomSheet>,
    );
    const row = container.querySelector('[data-slot="sheet-title-row"]')!;
    const slot = row.querySelector('[data-slot="sheet-action"]')!;
    expect(slot).toContainElement(screen.getByRole("button", { name: "Create" }));
    expect(slot.nextElementSibling).toBe(screen.getByRole("button", { name: "Close" }));
    // The close button stays a direct child of the row, where the hit-area census finds it.
    expect(screen.getByRole("button", { name: "Close" }).parentElement).toBe(row);
    // 12px clear of the close button, so a mis-tap on the action never reaches it, pressed or not.
    expect(slot).toHaveClass("mr-3");
  });

  it("leaves the row exactly as it was without one", () => {
    const { container } = render(
      <BottomSheet open onClose={vi.fn()} title="Switch pane">
        body
      </BottomSheet>,
    );
    expect(container.querySelector('[data-slot="sheet-action"]')).toBeNull();
    expect(container.querySelector('[data-slot="sheet-title-row"]')!.children).toHaveLength(2);
  });
});

// DRAG-TO-DISMISS SURVIVES A RE-RENDER OF ITS CALLER. The switcher passes `onClose` as an inline
// arrow, so every poll handed the sheet a new function; with that function in the drag effect's
// deps, the effect re-ran and `setDragY(0)` snapped a held sheet back to the top on each poll, the
// flicker a slow drag showed on the phone (2026-11-06). The drag must hold its offset across it.
describe("BottomSheet: drag-to-dismiss", () => {
  const at = (y: number) => ({ clientX: 100, clientY: y, identifier: 1 });

  it("keeps the dragged offset when the caller re-renders with a new onClose mid-drag", () => {
    const { container, rerender } = render(
      <BottomSheet open onClose={() => {}} title="Switch pane">
        body
      </BottomSheet>,
    );
    const panel = container.querySelector<HTMLElement>('div[tabindex="-1"]')!;
    fireEvent.touchStart(panel, { touches: [at(100)] });
    fireEvent.touchMove(panel, { touches: [at(140)] });
    expect(panel.style.transform).toBe("translateY(40px)");

    // A poll: the caller renders again and hands over a fresh arrow.
    rerender(
      <BottomSheet open onClose={() => {}} title="Switch pane">
        body
      </BottomSheet>,
    );
    expect(panel.style.transform).toBe("translateY(40px)");
  });

  it("closes through the onClose of the latest render when released past the threshold", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { container, rerender } = render(
      <BottomSheet open onClose={first} title="Switch pane">
        body
      </BottomSheet>,
    );
    const panel = container.querySelector<HTMLElement>('div[tabindex="-1"]')!;
    fireEvent.touchStart(panel, { touches: [at(100)] });
    fireEvent.touchMove(panel, { touches: [at(150)] });
    rerender(
      <BottomSheet open onClose={latest} title="Switch pane">
        body
      </BottomSheet>,
    );
    fireEvent.touchMove(panel, { touches: [at(220)] });
    fireEvent.touchEnd(panel, { touches: [] });
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  // A part inside the sheet that owns the fingers (a zoomed picture, ui/zoom-picture.tsx) claims its
  // moves with preventDefault before they bubble up; a second finger is a pinch. Neither is a pull.
  it("lets go of the pull on a move a child claimed, and on a second finger, and stays open", () => {
    const onClose = vi.fn();
    const { container } = render(
      <BottomSheet open onClose={onClose} title="Picture">
        <div data-testid="owner" />
      </BottomSheet>,
    );
    const panel = container.querySelector<HTMLElement>('div[tabindex="-1"]')!;
    const owner = container.querySelector<HTMLElement>("[data-testid='owner']")!;
    const claim = (e: Event) => e.preventDefault();
    owner.addEventListener("touchmove", claim, { passive: false });
    fireEvent.touchStart(owner, { touches: [at(100)] });
    fireEvent.touchMove(owner, { touches: [at(250)], cancelable: true });
    expect(panel.style.transform).toBe("");
    fireEvent.touchEnd(owner, { touches: [] });
    owner.removeEventListener("touchmove", claim);

    fireEvent.touchStart(panel, { touches: [at(100)] });
    fireEvent.touchMove(panel, { touches: [at(150)] });
    expect(panel.style.transform).toBe("translateY(50px)");
    fireEvent.touchStart(panel, { touches: [at(150), { ...at(150), identifier: 2, clientX: 200 }] });
    expect(panel.style.transform).toBe("");
    fireEvent.touchMove(panel, { touches: [at(300)] });
    fireEvent.touchEnd(panel, { touches: [] });
    expect(panel.style.transform).toBe("");
    expect(onClose).not.toHaveBeenCalled();
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

  it("keeps the entrance skipped on every render after a peek-driven open, not just the first", () => {
    // A poll, a keyboard resize or any parent state change re-renders the open sheet. The slide-in
    // class must not appear on that render: adding `animate-in` to an already-shown panel starts
    // the keyframe from translateY(100%), so the sheet drops out of view and slides back in.
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
    rerender(
      <BottomSheet open onClose={vi.fn()} title="Switch pane" pull={0}>
        body again
      </BottomSheet>,
    );
    const panel = container.querySelector<HTMLElement>('div[tabindex="-1"]')!;
    expect(panel.className).not.toMatch(/animate-in/);
    expect(panel.className).not.toMatch(/slide-in-from-bottom/);
    const backdrop = container.querySelector<HTMLElement>('button[aria-hidden="true"]')!;
    expect(backdrop.className).not.toMatch(/animate-in/);
  });

  it("plays the slide-in again on a tap-open after a drag-opened sheet has closed", () => {
    // The drag's skip is held for one open only; a later open with no peek before it is a fresh
    // open and gets the ordinary entrance.
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
    rerender(
      <BottomSheet open={false} onClose={vi.fn()} title="Switch pane" pull={0}>
        body
      </BottomSheet>,
    );
    rerender(
      <BottomSheet open onClose={vi.fn()} title="Switch pane" pull={0}>
        body
      </BottomSheet>,
    );
    const panel = container.querySelector<HTMLElement>('div[tabindex="-1"]')!;
    expect(panel.className).toMatch(/slide-in-from-bottom/);
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
  // M48 spec 03. A bare focus() scrolls the focused element into view, and the panel is focused while
  // its slide-in still holds it below the screen, so the content BEHIND the sheet jumped. jsdom runs
  // no layout and cannot show the scroll, so the test pins the call that prevents it.
  it("never scrolls the page to focus the panel, on open or on restore", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const calls: Array<{ el: Element; options: FocusOptions | undefined }> = [];
    const real = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
      calls.push({ el: this, options });
      real.call(this, options);
    };
    try {
      const { rerender } = render(
        <BottomSheet open onClose={vi.fn()} title="Keys">
          body
        </BottomSheet>,
      );
      const panel = screen.getByRole("dialog").querySelector("div[tabindex='-1']");
      expect(calls.find((c) => c.el === panel)?.options).toEqual({ preventScroll: true });

      rerender(
        <BottomSheet open={false} onClose={vi.fn()} title="Keys">
          body
        </BottomSheet>,
      );
      expect(calls.find((c) => c.el === opener)?.options).toEqual({ preventScroll: true });
    } finally {
      HTMLElement.prototype.focus = real;
      opener.remove();
    }
  });
});

// The count behind the dashboard's floating New button, which steps aside while any sheet is open.
describe("useAnySheetOpen", () => {
  function Probe() {
    return <output>{useAnySheetOpen() ? "open" : "none"}</output>;
  }

  it("follows the number of open BottomSheets, and ignores a closed one", () => {
    const { rerender } = render(
      <>
        <Probe />
        <BottomSheet open={false} onClose={vi.fn()} title="A">a</BottomSheet>
      </>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("none");
    rerender(
      <>
        <Probe />
        <BottomSheet open onClose={vi.fn()} title="A">a</BottomSheet>
        <BottomSheet open onClose={vi.fn()} title="B">b</BottomSheet>
      </>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("open");
    rerender(
      <>
        <Probe />
        <BottomSheet open={false} onClose={vi.fn()} title="A">a</BottomSheet>
        <BottomSheet open onClose={vi.fn()} title="B">b</BottomSheet>
      </>,
    );
    // One of the two closed; one is still up.
    expect(screen.getByRole("status")).toHaveTextContent("open");
    act(() => {
      rerender(
        <>
          <Probe />
          <BottomSheet open={false} onClose={vi.fn()} title="A">a</BottomSheet>
          <BottomSheet open={false} onClose={vi.fn()} title="B">b</BottomSheet>
        </>,
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent("none");
  });

  it("drops the count when an open sheet unmounts", () => {
    const { rerender } = render(
      <>
        <Probe />
        <BottomSheet open onClose={vi.fn()} title="A">a</BottomSheet>
      </>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("open");
    rerender(<Probe />);
    expect(screen.getByRole("status")).toHaveTextContent("none");
  });
});

// SHEET_BODY_STICKY states the head's height as a sum of the head's own fixed boxes. jsdom lays out
// nothing, so this reads the boxes the sum was made from off the rendered head (DESIGN.md §9).
describe("SHEET_BODY_STICKY", () => {
  it("is the sum of the head's stated boxes, and takes back the body's own gutter", () => {
    render(
      <BottomSheet open onClose={() => {}} title="Switch pane">
        <p>body</p>
      </BottomSheet>,
    );
    const head = document.querySelector<HTMLElement>(".sticky.top-0")!;
    const grab = head.children[0];
    const titleRow = head.children[1];
    const classes = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/u);
    expect(classes(head)).toContain("border-b");
    expect(classes(grab)).toEqual(expect.arrayContaining(["pt-2", "pb-1"]));
    expect(classes(grab?.firstElementChild)).toContain("h-1");
    expect(classes(titleRow)).toContain("pb-3");
    expect(classes(titleRow?.querySelector("button"))).toContain("size-8");
    // 0.5 + 0.25 + 0.25 (the grab row) + 2 + 0.75 (the title row) = 3.75rem, plus the 1px rule.
    expect(SHEET_BODY_STICKY).toContain("top-[calc(3.75rem+1px)]");
    expect(classes(head.nextElementSibling)).toContain("px-4");
    expect(SHEET_BODY_STICKY).toContain("-mx-4 px-4");
  });
});

// ON A WIDE WINDOW THE SHEET IS A CENTRED DIALOG (ADR 0167, addendum 2026-11-20). The width class is read
// from the window's media queries (hooks/use-width-class.ts), the fold from the viewport segments
// (hooks/use-fold-posture.ts); this stub answers both from a width, a height and a posture.
describe("BottomSheet: the presentation by width class", () => {
  let width = 1440;
  let height = 900;
  let posture: "flat" | "book" | "tabletop" = "flat";
  function answer(query: string): boolean {
    if (query.includes("vertical-viewport-segments")) return posture === "tabletop";
    if (query.includes("horizontal-viewport-segments")) return posture === "book";
    const minW = /min-width:\s*(\d+)px/.exec(query);
    const minH = /min-height:\s*(\d+)px/.exec(query);
    return minW !== null && width >= Number(minW[1]) && (minH === null || height >= Number(minH[1]));
  }
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        // SAFETY: a stand-in for the browser's MediaQueryList with every member the app reads.
        ({
          matches: answer(query),
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
  afterEach(() => {
    width = 1440;
    height = 900;
    posture = "flat";
    vi.unstubAllGlobals();
  });
  const panelOf = (container: HTMLElement) => container.querySelector<HTMLElement>('div[tabindex="-1"]')!;
  const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/u);
  const at = (y: number) => ({ clientX: 100, clientY: y, identifier: 1 });

  it("draws a centred dialog in the modal's look on expanded: four round corners, a uniform edge, no handle", () => {
    const { container } = render(
      <BottomSheet open onClose={vi.fn()} title="Actions" action={<button type="button">Go</button>}>
        body
      </BottomSheet>,
    );
    const panel = panelOf(container);
    expect(panel.dataset.presentation).toBe("dialog");
    expect(classes(panel)).toEqual(expect.arrayContaining(["rounded-md", "border", "border-border", "bg-card", "shadow-2xl", "zoom-in-95", "motion-reduce:animate-none"]));
    expect(classes(panel)).not.toContain("rounded-t-md");
    expect(classes(panel)).not.toContain("border-t");
    expect(classes(panel)).not.toContain("slide-in-from-bottom");
    expect(classes(panel)).toEqual(expect.arrayContaining(["w-full", "max-w-screen-sm"]));
    // Centred in the window: the frame is the modal's centre frame, not the bottom-aligned column.
    const frame = screen.getByRole("dialog", { name: "Actions" });
    expect(classes(frame)).toEqual(expect.arrayContaining(["items-center", "justify-center"]));
    expect(classes(frame)).not.toContain("justify-end");
    expect(frame.style.getPropertyValue("--modal-room")).not.toBe("");
    // No grab handle; the title row, its action and the close button stay.
    expect(container.querySelector('[data-slot="sheet-handle"]')).toBeNull();
    expect(container.querySelector('[data-slot="sheet-action"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("keeps the head at the height SHEET_BODY_STICKY states, the handle's row given to the title row", () => {
    render(
      <BottomSheet open onClose={() => {}} title="Switch pane">
        <p>body</p>
      </BottomSheet>,
    );
    const head = document.querySelector<HTMLElement>(".sticky.top-0")!;
    expect(head.children).toHaveLength(1);
    const titleRow = head.children[0]!;
    // 0.875 + 2 (the close button) + 0.875 = 3.75rem, the bottom sheet's 1rem handle row plus its 2.75rem title row.
    expect(classes(titleRow)).toContain("py-3.5");
    expect(classes(titleRow.querySelector("button")!)).toContain("size-8");
    expect(classes(head)).toContain("border-b");
    expect(SHEET_BODY_STICKY).toContain("top-[calc(3.75rem+1px)]");
  });

  it("caps the dialog's height inline and lets a bottom sheet's clearance, square top and taller cap give way", () => {
    const { container } = render(
      <BottomSheet open onClose={vi.fn()} title="Tour" className={cn("h-(--app-h) max-h-[92dvh] rounded-t-none", TALL_SHEET_CLEARANCE)}>
        body
      </BottomSheet>,
    );
    const panel = panelOf(container);
    expect(panel.style.maxHeight).toContain("82dvh");
    expect(panel.style.maxHeight).toContain("--modal-room");
    expect(classes(panel)).toEqual(expect.arrayContaining(["rounded-md", "pb-1"]));
    expect(classes(panel)).not.toContain("rounded-t-none");
    expect(classes(panel)).not.toContain(TALL_SHEET_CLEARANCE);
    // The caller's `max-h-[92dvh]` may stay in the list: an inline max-height outranks every class.
    expect(panel.style.getPropertyValue("--sheet-body-room")).toContain("82dvh");
    expect(panel.style.getPropertyValue("--sheet-body-width")).toBe("");
  });

  it("takes no pull: a touch drag on the panel writes no transform and never closes", () => {
    const onClose = vi.fn();
    const { container } = render(
      <BottomSheet open onClose={onClose} title="Switch pane">
        body
      </BottomSheet>,
    );
    const panel = panelOf(container);
    fireEvent.touchStart(panel, { touches: [at(100)] });
    fireEvent.touchMove(panel, { touches: [at(300)], cancelable: true });
    fireEvent.touchEnd(panel, { touches: [] });
    expect(panel.style.transform).toBe("");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("draws no peek: a pull before the open renders nothing, and the open that follows plays its entrance", () => {
    const { container, rerender } = render(
      <BottomSheet open={false} onClose={vi.fn()} title="Switch pane" pull={120} pullFrom={40}>
        body
      </BottomSheet>,
    );
    // Only the room probe, which draws nothing: no panel, no scrim, no dialog.
    expect(container.querySelector("[data-presentation]")).toBeNull();
    expect(container.querySelector('button[aria-hidden="true"]')).toBeNull();
    expect(container.firstElementChild?.getAttribute("data-slot")).toBe("sheet-room");
    rerender(
      <BottomSheet open onClose={vi.fn()} title="Switch pane" pull={120} pullFrom={40}>
        body
      </BottomSheet>,
    );
    const panel = panelOf(container);
    expect(panel.style.transform).toBe("");
    expect(classes(panel)).toContain("animate-in");
  });

  it("closes by Escape, the close button and a press and release on the scrim, and not by a release alone", () => {
    const onClose = vi.fn();
    const { container } = render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    const scrim = container.querySelector<HTMLElement>('button[aria-hidden="true"]')!;
    fireEvent.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("moves the focus in and gives it back, and counts as an open sheet", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    function Probe() {
      return <output>{useAnySheetOpen() ? "open" : "none"}</output>;
    }
    const { rerender } = render(
      <>
        <Probe />
        <BottomSheet open onClose={vi.fn()} title="Keys">
          body
        </BottomSheet>
      </>,
    );
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("open");
    rerender(
      <>
        <Probe />
        <BottomSheet open={false} onClose={vi.fn()} title="Keys">
          body
        </BottomSheet>
      </>,
    );
    expect(document.activeElement).toBe(opener);
    expect(screen.getByRole("status")).toHaveTextContent("none");
    opener.remove();
  });

  it("opens a viewer as wide as its picture, up to min(92vw, 1200px), never narrower than the column", () => {
    const { container } = render(
      <BottomSheet open onClose={vi.fn()} title="Attachment" size="viewer">
        <img alt="" />
      </BottomSheet>,
    );
    const panel = panelOf(container);
    expect(classes(panel)).toEqual(expect.arrayContaining(["w-fit", "min-w-[min(40rem,100%)]", "max-w-[min(92vw,1200px)]"]));
    expect(classes(panel)).not.toContain("max-w-screen-sm");
    // The widest body width, for a content that pages (PagerSheet); a column dialog publishes none.
    expect(panel.style.getPropertyValue("--sheet-body-width")).toContain("1200px");
  });

  // The website and the design reference draw the app in phone frames in the page: the stage carries a
  // transform, so the sheet's fixed layer is laid out in a 390px box while the window is 1440px wide.
  // jsdom lays nothing out, so the probe's box is given here, as the browser would measure it.
  function roomOf(size: { width: number; height: number }) {
    const real = Element.prototype.getBoundingClientRect;
    return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.getAttribute("data-slot") !== "sheet-room") return real.call(this);
      return DOMRect.fromRect({ x: 0, y: 0, ...size });
    });
  }

  it("draws the bottom sheet with its handle in a 390px transformed box, though the window is expanded", () => {
    const spy = roomOf({ width: 390, height: 844 });
    try {
      const { container } = render(
        <div style={{ transform: "translate(0)", width: 390, height: 844 }}>
          <BottomSheet open onClose={vi.fn()} title="Pins">
            body
          </BottomSheet>
        </div>,
      );
      const panel = panelOf(container);
      expect(panel.dataset.presentation).toBe("sheet");
      expect(container.querySelector('[data-slot="sheet-handle"]')).not.toBeNull();
      expect(classes(panel)).toEqual(expect.arrayContaining(["rounded-t-md", "slide-in-from-bottom"]));
    } finally {
      spy.mockRestore();
    }
  });

  it("still peeks under a pull in a phone frame, where the layer is a bottom sheet", () => {
    const spy = roomOf({ width: 390, height: 844 });
    try {
      const { container } = render(
        <BottomSheet open={false} onClose={vi.fn()} title="Switch pane" pull={80}>
          body
        </BottomSheet>,
      );
      const panel = container.querySelector<HTMLElement>('div[style*="translateY"]');
      expect(panel?.style.transform).toBe("translateY(max(0px, calc(100% - 80px)))");
    } finally {
      spy.mockRestore();
    }
  });

  it("draws the dialog when the layer's room is expanded too, and the sheet when it is only short", () => {
    const wide = roomOf({ width: 1440, height: 900 });
    const first = render(
      <BottomSheet open onClose={vi.fn()} title="Pins">
        body
      </BottomSheet>,
    );
    expect(panelOf(first.container).dataset.presentation).toBe("dialog");
    first.unmount();
    wide.mockRestore();
    const short = roomOf({ width: 1440, height: 400 });
    try {
      const { container } = render(
        <BottomSheet open onClose={vi.fn()} title="Pins">
          body
        </BottomSheet>,
      );
      expect(panelOf(container).dataset.presentation).toBe("sheet");
    } finally {
      short.mockRestore();
    }
  });

  it("keeps a full-screen sheet a bottom sheet on expanded when it asks for one (the tour)", () => {
    const { container } = render(
      <BottomSheet open onClose={vi.fn()} title="Tour" presentation="sheet" className="h-(--app-h) max-h-(--app-h) rounded-t-none">
        body
      </BottomSheet>,
    );
    const panel = panelOf(container);
    expect(panel.dataset.presentation).toBe("sheet");
    expect(classes(panel)).toEqual(expect.arrayContaining(["h-(--app-h)", "max-h-(--app-h)", "rounded-t-none"]));
    expect(container.querySelector('[data-slot="sheet-handle"]')).not.toBeNull();
  });

  it("drops a bottom sheet's fixed height in a dialog, so it is as tall as its content", () => {
    const { container } = render(
      <BottomSheet open onClose={vi.fn()} title="Pins" className={cn("h-[85dvh] max-h-[85dvh]", TALL_SHEET_CLEARANCE)}>
        body
      </BottomSheet>,
    );
    const panel = panelOf(container);
    expect(classes(panel)).toContain("h-auto");
    expect(classes(panel)).not.toContain("h-[85dvh]");
    width = 390;
    const phone = render(
      <BottomSheet open onClose={vi.fn()} title="Pins" className={cn("h-[85dvh] max-h-[85dvh]", TALL_SHEET_CLEARANCE)}>
        body
      </BottomSheet>,
    );
    expect(classes(panelOf(phone.container))).toEqual(expect.arrayContaining(["h-[85dvh]", "max-h-[85dvh]"]));
  });

  // A MENU BESIDE ITS BUTTON: a dialog opened by a tap on a button in view draws beside it, with no scrim
  // and no heading. jsdom lays nothing out, so the button's box is given.
  function trigger(rect = { x: 900, y: 20, width: 44, height: 44 }, attach = true) {
    const button = document.createElement("button");
    button.textContent = "menu";
    if (attach) document.body.appendChild(button);
    button.getBoundingClientRect = () => DOMRect.fromRect(rect);
    return { current: button };
  }

  it("draws a menu beside an anchor in view: below it, no dimming, no title row, the title as its name", () => {
    const anchor = trigger();
    const { container } = render(
      <BottomSheet open onClose={vi.fn()} title="Pane actions" anchor={anchor}>
        <button type="button">Rename</button>
      </BottomSheet>,
    );
    const panel = panelOf(container);
    expect(panel.dataset.presentation).toBe("menu");
    expect(panel.style.top).toBe("68px");
    expect(classes(panel)).toEqual(expect.arrayContaining(["w-80", "rounded-md", "border", "border-border", "shadow-2xl"]));
    expect(classes(panel)).not.toContain("animate-in");
    const layer = container.querySelector<HTMLElement>('button[aria-hidden="true"]')!;
    expect(layer.className).not.toMatch(/bg-black/);
    expect(container.querySelector('[data-slot="sheet-title-row"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Pane actions" })).toBeInTheDocument();
    anchor.current.remove();
  });

  it("closes a menu on an outside press and release, and Escape gives the focus back to its button", () => {
    const anchor = trigger();
    const onClose = vi.fn();
    const { container, rerender } = render(
      <BottomSheet open onClose={onClose} title="Pane actions" anchor={anchor}>
        body
      </BottomSheet>,
    );
    const layer = container.querySelector<HTMLElement>('button[aria-hidden="true"]')!;
    fireEvent.click(layer);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(layer);
    fireEvent.click(layer);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    rerender(
      <BottomSheet open={false} onClose={onClose} title="Pane actions" anchor={anchor}>
        body
      </BottomSheet>,
    );
    expect(document.activeElement).toBe(anchor.current);
    anchor.current.remove();
  });

  it("keeps the title row of a menu that carries an action", () => {
    const anchor = trigger();
    const { container } = render(
      <BottomSheet open onClose={vi.fn()} title="Tab" anchor={anchor} action={<button type="button">Go</button>}>
        body
      </BottomSheet>,
    );
    expect(panelOf(container).dataset.presentation).toBe("menu");
    expect(container.querySelector('[data-slot="sheet-title-row"]')).not.toBeNull();
    anchor.current.remove();
  });

  it("draws the centred dialog with no anchor, an anchor out of the document, or one scrolled out of view", () => {
    const cases = [undefined, trigger(undefined, false), trigger({ x: 900, y: -200, width: 44, height: 44 })];
    for (const anchor of cases) {
      const { container, unmount } = render(
        <BottomSheet open onClose={vi.fn()} title="Pane actions" anchor={anchor}>
          body
        </BottomSheet>,
      );
      expect(panelOf(container).dataset.presentation).toBe("dialog");
      unmount();
      anchor?.current.remove();
    }
  });

  it("keeps the bottom sheet with an anchor on compact", () => {
    width = 390;
    const anchor = trigger({ x: 340, y: 20, width: 44, height: 44 });
    const { container } = render(
      <BottomSheet open onClose={vi.fn()} title="Pane actions" anchor={anchor}>
        body
      </BottomSheet>,
    );
    expect(panelOf(container).dataset.presentation).toBe("sheet");
    expect(container.querySelector('[data-slot="sheet-handle"]')).not.toBeNull();
    anchor.current.remove();
  });

  it("stays a bottom sheet on medium and compact, and the viewer size changes nothing there", () => {
    for (const w of [390, 820]) {
      width = w;
      const { container, unmount } = render(
        <BottomSheet open onClose={vi.fn()} title="Attachment" size="viewer">
          body
        </BottomSheet>,
      );
      const panel = panelOf(container);
      expect(panel.dataset.presentation).toBe("sheet");
      expect(classes(panel)).toEqual(expect.arrayContaining(["rounded-t-md", "border-t", "max-w-screen-sm", "slide-in-from-bottom"]));
      expect(container.querySelector('[data-slot="sheet-handle"]')).not.toBeNull();
      expect(panel.style.getPropertyValue("--sheet-body-room")).toBe("");
      unmount();
    }
  });

  it("stays a bottom sheet on a wide window under 480px tall, and on a foldable folded as a book or held as a tabletop", () => {
    const cases: Array<[number, typeof posture]> = [
      [400, "flat"],
      [900, "book"],
      [900, "tabletop"],
    ];
    for (const [h, p] of cases) {
      height = h;
      posture = p;
      const { container, unmount } = render(
        <BottomSheet open onClose={vi.fn()} title="Actions">
          body
        </BottomSheet>,
      );
      expect(panelOf(container).dataset.presentation).toBe("sheet");
      unmount();
    }
  });
});

// The bottom sheet's panel, pinned whole: the dialog work must leave a phone's sheet exactly as it was.
describe("BottomSheet: the compact panel is unchanged", () => {
  it("draws the same class list as before the dialog", () => {
    const { container } = render(
      <BottomSheet open onClose={vi.fn()} title="Actions">
        body
      </BottomSheet>,
    );
    const panel = container.querySelector<HTMLElement>('div[tabindex="-1"]')!;
    expect(panel.getAttribute("class")).toBe(
      "relative z-10 mx-auto max-h-[82dvh] w-full max-w-screen-sm overflow-y-auto overscroll-contain rounded-t-md border-t border-rule bg-card shadow-2xl duration-200 animate-in slide-in-from-bottom pb-[calc(env(safe-area-inset-bottom)_+_1rem)]",
    );
    expect(container.firstElementChild?.getAttribute("class")).toBe("fixed inset-x-0 top-0 z-50 flex h-(--app-h) flex-col justify-end");
  });
});
