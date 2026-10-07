import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Keyboard, Terminal } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetHarnessBar, setHarnessBarEnabled } from "@/lib/harness-bar-pref";
import { ActionsRow, switchPillInset, type ActionsRowProps, type GeneralAction } from "./actions-row";

afterEach(() => {
  __resetHarnessBar();
  localStorage.clear();
});

const took = async () => true;

function general(over: Partial<GeneralAction> = {}): GeneralAction {
  return { id: "keys", icon: Keyboard, label: "Keys", onSelect: vi.fn(), ...over };
}

/** Every button in the row, in paint order, by its accessible name. */
const names = () => screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));

describe("ActionsRow", () => {
  it("puts Collie's own actions first and the harness's own after them", () => {
    render(
      <ActionsRow
        general={[general(), general({ id: "type", icon: Terminal, label: "Type into terminal" })]}
        agent="claude"
        onRun={took}
      />,
    );
    // The left edge is the same control on every pane there is, which is the whole reason for this
    // order: the harness half is absent on a shell, on grok, and with the switch off.
    expect(names()).toEqual(["Keys", "Type into terminal", "Model", "Effort", "Compact", "Resume"]);
  });

  it("names both groups, so a reader knows which half it has walked into", () => {
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} />);
    expect(screen.getByRole("group", { name: "Controls" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Harness shortcuts" })).toBeInTheDocument();
  });

  it("hides the harness segment alone when the switch is off — never the general actions", () => {
    setHarnessBarEnabled(false);
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} />);
    expect(names()).toEqual(["Keys"]);
    expect(screen.queryByRole("group", { name: "Harness shortcuts" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Controls" })).toBeInTheDocument();
  });

  it("draws the general actions on a pane whose harness has no bar at all", () => {
    render(<ActionsRow general={[general()]} agent="grok" onRun={took} />);
    expect(names()).toEqual(["Keys"]);
  });

  it("costs no height when there is neither a general action nor a harness bar", () => {
    // With nothing to carry, the row must not render an empty scroller — that would spend 12px on
    // nothing.
    const { container } = render(<ActionsRow general={[]} agent="grok" onRun={took} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("draws the harness segment alone when there are no general actions", () => {
    render(<ActionsRow general={[]} agent="pi" onRun={took} />);
    expect(names()).toEqual(["Model", "Compact", "Tree", "Resume"]);
    expect(screen.queryByRole("group", { name: "Controls" })).not.toBeInTheDocument();
  });

  it("carries each general action's own state: expanded, pressed, disabled, and the tap", async () => {
    const onSelect = vi.fn();
    render(
      <ActionsRow
        general={[
          general({ id: "keys", expanded: true, on: true, onSelect }),
          general({ id: "type", icon: Terminal, label: "Type into terminal", pressed: true }),
          general({ id: "quick", icon: Keyboard, label: "Quick", disabled: true }),
        ]}
        agent="grok"
        onRun={took}
      />,
    );
    expect(screen.getByRole("button", { name: "Keys" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Type into terminal" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Quick" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Keys" }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("tints the harness section in the harness's own colour, and never with a rule down its side", () => {
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} />);
    const section = document.querySelector<HTMLElement>('[data-slot="harness-bar"]')!;
    // Claude's #D97757, at 14% of whatever ground is behind it. jsdom normalises the hex to rgb().
    expect(section.style.backgroundColor).toBe("color-mix(in srgb, rgb(217, 119, 87) 14%, transparent)");
    // A tint that reads (1.12:1 light, 1.22:1 dark against the belt) needs no edge, and an edge here
    // would be the divider the belt exists to do without.
    expect(section.className).not.toMatch(/border-l/);
  });

  it("falls back to the app's own ground for a brand whose colour is black, and edges THAT one", () => {
    // Codex and pi are officially monochrome. A near-black icon is invisible in the dark theme, so
    // absent is a real answer and the section takes the muted ground instead of a wrong colour.
    // On the belt that ground measures 1.02:1 in dark — nothing — so this section, and only this
    // one, colours the left edge BELT_SECTION already reserves.
    render(<ActionsRow general={[general()]} agent="codex" onRun={took} />);
    const section = document.querySelector<HTMLElement>('[data-slot="harness-bar"]')!;
    expect(section.style.backgroundColor).toBe("");
    expect(section.className).toMatch(/(?:^|\s)bg-muted(?=\s|$)/);
    expect(section.className).toMatch(/(?:^|\s)border-l-border(?=\s|$)/);
  });

  it("draws the belt itself: one full-bleed band, hairlines on both edges, no rounded ends", () => {
    // The ground and the rules belong to the element carrying the `-mx-3`, or they stop 12px short
    // of both screen edges and the band reads as a wide capsule again.
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} />);
    const belt = document.querySelector<HTMLElement>('[data-slot="composer-actions"]')!;
    expect(belt.className).toMatch(/(?:^|\s)-mx-3(?=\s|$)/);
    // `border-b` and NOT `border-y`: the belt is flush under the mirror and the chrome block's own
    // top rule is the boundary up there, so a rule here would be the second of two.
    expect(belt.className).toMatch(/(?:^|\s)border-b(?=\s|$)/);
    expect(belt.className).not.toMatch(/(?:^|\s)(?:border-y|border-t|mt-)/);
    expect(belt.className).toMatch(/(?:^|\s)bg-foreground\/6(?=\s|$)/);
    expect(belt.className).not.toMatch(/rounded/);
    // Collie's own controls stand on that ground with no box of their own.
    const controls = document.querySelector<HTMLElement>('[data-slot="composer-controls"]')!;
    expect(controls.className).not.toMatch(/rounded|border|bg-/);
  });

  it("pins the switcher's bare mark at its right end when one is handed down, and nothing when none is", async () => {
    // The grip used to be a 30px band of its own above the composer, then a chevron on this belt's
    // rule — which stood over whichever pill was in the middle of the band. It stands at the belt's
    // right end now, above Send. The pane decides whether there is one (agent-chat.tsx).
    const onClick = vi.fn();
    const ref = vi.fn();
    const { unmount } = render(
      <ActionsRow
        general={[general()]}
        agent="claude"
        onRun={took}
        handle={{ ref, onClick, label: "Switch pane" }}
      />,
    );
    const grip = screen.getByRole("button", { name: "Switch pane" });
    // IT DRAWS NO WORD AT ALL. It wore one — "Switch", beside the mark, inside an accent pill — and
    // Altan's verdict was that it "is taking up too much room for my taste, I'd argue we can just
    // have the icon". So the accessible name is the only name it has, which is what a case may
    // address and what a reader hears; nothing on screen says it.
    expect(grip.textContent).toBe("");
    // It is INSIDE the belt and NOT inside the scroller's masked wrapper: a mask applies to its
    // whole subtree, so a pinned pill in there would fade out wherever the belt overflows.
    const belt = document.querySelector<HTMLElement>('[data-slot="composer-actions"]')!;
    expect(belt.contains(grip)).toBe(true);
    expect(belt.querySelector(".overflow-x-auto")!.contains(grip)).toBe(false);
    // THE DRAG REF LANDS ON THE BELT, NOT ON THE PILL. A drag up from anywhere on the band opens
    // the switcher; the pill only says where it comes from and takes the tap. Asserted as
    // "the node the ref got CONTAINS the pill", which is the shape that fails the moment somebody
    // puts the ref back on the button.
    const dragged = ref.mock.calls.map(([node]) => node).findLast((node) => node !== null);
    expect(dragged).toBe(belt);
    expect(dragged).not.toBe(grip);
    // …and the belt yields the sideways pan to the scroller, so the pills still scroll under a
    // horizontal drag (use-sheet-pull.ts arbitrates the rest).
    expect(belt.className).toMatch(/(?:^|\s)touch-pan-x(?=\s|$)/);
    // …and the belt's own pills are untouched: the grip is an addition, never a replacement.
    expect(names()).toContain("Keys");
    expect(screen.getByRole("group", { name: "Harness shortcuts" })).toBeInTheDocument();
    await userEvent.click(grip);
    expect(onClick).toHaveBeenCalledTimes(1);

    unmount();
    // Without the prop there is no such button anywhere, and that is the whole of the old behaviour.
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} />);
    expect(screen.queryByRole("button", { name: "Switch pane" })).not.toBeInTheDocument();
  });

  it("reserves room for the pinned Switch block with a trailing spacer, not padding, and draws no right fade of its own", () => {
    // jsdom has no ResizeObserver (lib/env.ts's hasResizeObserver), so the scroller falls back to
    // SWITCH_PILL_INSET's first-paint value — the same number a real browser reports for today's
    // box before its first observation callback lands. A spacer, not `paddingRight`: measured over
    // CDP on a Claude pane, `paddingRight` on this scroller did not reliably reach the scrollable
    // overflow in Chrome — the last pill still sat ~5px under the Switch block's fade at
    // `scrollLeft` max — because the scroller is a `flex` row and the harness section is itself a
    // nested `flex` row, so the overflowing pill is two levels down from the padded element. A real
    // flex child always counts toward `scrollWidth`, at any nesting depth. `OverflowEdges` is told
    // `edges="left"` so it never paints a second, scroll-dependent fade over the block's own.
    render(
      <ActionsRow
        general={[general()]}
        agent="claude"
        onRun={took}
        handle={{ ref: vi.fn(), onClick: vi.fn(), label: "Switch pane" }}
      />,
    );
    const scroller = document.querySelector<HTMLElement>(".overflow-x-auto")!;
    expect(scroller.style.paddingRight).toBe("");
    expect(scroller.className).not.toMatch(/(?:^|\s)pr-3(?=\s|$)/);
    const spacer = scroller.lastElementChild!;
    expect(spacer.getAttribute("aria-hidden")).toBe("true");
    // 122 (the block's first-frame fallback at the default 1.15 scale: 85 + the 37px mark) + 16
    // (BELT_END_AIR, the operator's wider right margin).
    expect(spacer.getAttribute("style")).toBe("width: 138px;");
    // The masked wrapper one level out never carries a right-hand gradient stop — `edges="left"`
    // took effect.
    const masked = scroller.parentElement!;
    expect(masked.className).not.toContain("black_calc");
  });

  // EXPERIMENT (operator, 2026-09-23): the Changes entry rides the pinned block, left of the mark.
  it("draws the Changes pill immediately left of the Switch mark, same 32px box, and widens the fallback", async () => {
    const onChanges = vi.fn();
    render(
      <ActionsRow
        general={[general()]}
        agent="claude"
        onRun={took}
        handle={{ ref: vi.fn(), onClick: vi.fn(), label: "Switch pane" }}
        changes={{ onClick: onChanges, label: "Changes" }}
      />,
    );
    const pill = screen.getByRole("button", { name: "Changes" });
    const grip = screen.getByRole("button", { name: "Switch pane" });
    expect(pill.nextElementSibling).toBe(grip);
    expect(pill.className).toMatch(/(?:^|\s)w-\(--belt-pill\)(?=\s|$)/);
    expect(pill.className).toMatch(/(?:^|\s)min-w-\(--belt-pill\)(?=\s|$)/);
    expect(pill).not.toHaveAttribute("aria-haspopup");
    await userEvent.click(pill);
    expect(onChanges).toHaveBeenCalledTimes(1);
    // 165 (122 + the 37px pill + its 6px gap, at the default 1.15 scale) + 16 of end air.
    const scroller = document.querySelector<HTMLElement>(".overflow-x-auto")!;
    expect(scroller.lastElementChild!.getAttribute("style")).toBe("width: 181px;");
  });

  it("has no Changes pill without the prop", () => {
    render(
      <ActionsRow general={[general()]} agent="claude" onRun={took} handle={{ ref: vi.fn(), onClick: vi.fn(), label: "Switch pane" }} />,
    );
    expect(screen.queryByRole("button", { name: "Changes" })).not.toBeInTheDocument();
  });

  // Operator, phone: "can we get a focus hover animation/color change on both icons? so I know
  // I've clicked" — the Changes pill and the Switch mark share PINNED_PILL, so the tap feedback is
  // asserted once per class and expected identical on both.
  it("gives the Changes pill and the Switch mark identical, fast tap feedback", () => {
    render(
      <ActionsRow
        general={[general()]}
        agent="claude"
        onRun={took}
        handle={{ ref: vi.fn(), onClick: vi.fn(), label: "Switch pane" }}
        changes={{ onClick: vi.fn(), label: "Changes" }}
      />,
    );
    const changesPill = screen.getByRole("button", { name: "Changes" });
    const switchPill = screen.getByRole("button", { name: "Switch pane" });
    for (const pill of [changesPill, switchPill]) {
      expect(pill.className).toMatch(/(?:^|\s)hover:bg-foreground\/8(?=\s|$)/);
      expect(pill.className).toMatch(/(?:^|\s)active:bg-foreground\/15(?=\s|$)/);
      expect(pill.className).toMatch(/(?:^|\s)active:scale-\[0\.92\](?=\s|$)/);
      expect(pill.className).toMatch(/(?:^|\s)motion-reduce:active:scale-100(?=\s|$)/);
      expect(pill.className).toMatch(/(?:^|\s)duration-\[120ms\](?=\s|$)/);
    }
    // No layout shift: the drawn box stays borderless and padding-free in every state — only the
    // background, the transform and the outline (focus-visible, from ui/button.tsx) move.
    expect(changesPill.className).toMatch(/(?:^|\s)border-0(?=\s|$)/);
    expect(changesPill.className).toMatch(/(?:^|\s)px-0(?=\s|$)/);
  });

  it("stands the belt's scroller on the scaled padding, with no vertical scroll under a thumb", () => {
    // Option 6 of the belt-shade deck (playground, removed 2026-09-14 once it had served) first
    // dropped STRIP_SCROLLER's own `py-1.5` to `py-0`, the pill's own 32px. The phone read that as
    // too thin, so it came back up to `py-1` — 40px, 4px above and below the 32px pills — and
    // `overflow-y-hidden` stays paired with it so STRIP_TAP_TARGET's 46px `::before` reach, still
    // wider than the 4px of padding on each side, cannot force a vertical scrollbar the way it did
    // in the playground.
    // Since 2026-09-23 the 4px is `--belt-pad`, derived from the belt's one `--belt-scale`.
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} />);
    const scroller = document.querySelector<HTMLElement>(".overflow-x-auto")!;
    expect(scroller.className).toMatch(/(?:^|\s)py-\(--belt-pad\)(?=\s|$)/);
    expect(scroller.className).toMatch(/(?:^|\s)overflow-y-hidden(?=\s|$)/);
  });

  it("narrows the Switch button to the pill's own scaled height, square, the operator's pick", () => {
    render(
      <ActionsRow
        general={[general()]}
        agent="claude"
        onRun={took}
        handle={{ ref: vi.fn(), onClick: vi.fn(), label: "Switch pane" }}
      />,
    );
    const grip = screen.getByRole("button", { name: "Switch pane" });
    expect(grip.className).toMatch(/(?:^|\s)w-\(--belt-pill\)(?=\s|$)/);
    expect(grip.className).toMatch(/(?:^|\s)min-w-\(--belt-pill\)(?=\s|$)/);
  });

  // ONE SCALE FOR THE WHOLE BELT (operator, 2026-09-23): the root carries `--belt-scale` from the
  // dash pref, 1.15 by default, and the first-frame fallback follows it.
  it("sets --belt-scale from the dash pref, 1.15 by default", () => {
    const { unmount } = render(<ActionsRow general={[general()]} agent="claude" onRun={took} />);
    const belt = () => document.querySelector<HTMLElement>('[data-slot="composer-actions"]')!;
    expect(belt().style.getPropertyValue("--belt-scale")).toBe("1.15");
    unmount();
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ beltScale: 1.5 }));
    render(
      <ActionsRow
        general={[general()]}
        agent="claude"
        onRun={took}
        handle={{ ref: vi.fn(), onClick: vi.fn(), label: "Switch pane" }}
      />,
    );
    expect(belt().style.getPropertyValue("--belt-scale")).toBe("1.5");
    // 85 + the 48px mark + 16 of end air.
    const scroller = document.querySelector<HTMLElement>(".overflow-x-auto")!;
    expect(scroller.lastElementChild!.getAttribute("style")).toBe("width: 149px;");
  });

  it("gives the scroller symmetric px-3 padding, no trailing spacer, and OverflowEdges its default edges when there is no handle", () => {
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} />);
    const scroller = document.querySelector<HTMLElement>(".overflow-x-auto")!;
    expect(scroller.style.paddingRight).toBe("");
    expect(scroller.className).toMatch(/(?:^|\s)pr-3(?=\s|$)/);
    expect(scroller.lastElementChild?.getAttribute("aria-hidden")).not.toBe("true");
  });
});

// ANOTHER PANE NEEDS YOU: the switcher mark wears a red dot, and its name says why. Red only, so the
// caller passes `alert` only for a blocked pane elsewhere (agent-chat.tsx).
describe("ActionsRow — the switcher mark's alert", () => {
  const dotOf = (el: HTMLElement) => el.querySelector(".bg-status-blocked");

  it("draws the red dot only when alerted", () => {
    const { rerender } = render(
      <ActionsRow general={[general()]} agent="claude" onRun={took} handle={{ ref: vi.fn(), onClick: vi.fn(), label: "Switch pane" }} />,
    );
    expect(dotOf(screen.getByRole("button", { name: "Switch pane" }))).toBeNull();
    rerender(
      <ActionsRow
        general={[general()]}
        agent="claude"
        onRun={took}
        handle={{ ref: vi.fn(), onClick: vi.fn(), label: "Switch pane, another pane needs you", alert: true }}
      />,
    );
    expect(dotOf(screen.getByRole("button", { name: "Switch pane, another pane needs you" }))).not.toBeNull();
  });
});


// THE COMPOSER'S CLEAR SLOT (M40 spec 04, issue #291; Altan, 2026-09-26/27): an icon-only X on the
// pinned block, directly left of the Changes pill, left of the Switch mark without one, alone when
// neither shows. The composer decides WHEN (a draft in the box, or the Undo window after a tap);
// this file decides WHERE and how it is drawn.
describe("ActionsRow — the composer's clear slot", () => {
  const handle = () => ({ ref: vi.fn(), onClick: vi.fn(), label: "Switch pane" });
  const changes = () => ({ onClick: vi.fn(), label: "Changes" });
  const clearX = (over: Partial<NonNullable<ActionsRowProps["clear"]>> = {}) => ({
    mode: "clear" as const,
    onClick: vi.fn(),
    label: "Clear message",
    ...over,
  });
  /** The trailing spacer's inline width, the first-frame fallback plus BELT_END_AIR's 16. */
  const spacerStyle = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(".overflow-x-auto")!.lastElementChild!.getAttribute("style");

  it("draws no X without the prop: the belt at rest is unchanged", () => {
    const { container } = render(
      <ActionsRow general={[general()]} agent="claude" onRun={took} handle={handle()} changes={changes()} />,
    );
    expect(screen.queryByRole("button", { name: "Clear message" })).not.toBeInTheDocument();
    // Two pills pinned, 165 + 16: exactly the number the Changes case above pins.
    expect(spacerStyle(container)).toBe("width: 181px;");
  });

  it("stands directly left of the Changes pill, on the pinned block and outside the scroller", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <ActionsRow
        general={[general()]}
        agent="claude"
        onRun={took}
        handle={handle()}
        changes={changes()}
        clear={clearX({ onClick })}
      />,
    );
    const x = screen.getByRole("button", { name: "Clear message" });
    const changesPill = screen.getByRole("button", { name: "Changes" });
    const grip = screen.getByRole("button", { name: "Switch pane" });
    expect(x.nextElementSibling).toBe(changesPill);
    expect(changesPill.nextElementSibling).toBe(grip);
    // Icon-only: the accessible name is the only name it has.
    expect(x.textContent).toBe("");
    // The pinned block, never the masked scroller: a pill in there would fade with the scroll.
    const belt = container.querySelector<HTMLElement>('[data-slot="composer-actions"]')!;
    expect(belt.contains(x)).toBe(true);
    expect(belt.querySelector(".overflow-x-auto")!.contains(x)).toBe(false);
    // The scrolling pills are still all there, in their order: the X adds, it replaces nothing.
    expect(names().slice(0, 5)).toEqual(["Keys", "Model", "Effort", "Compact", "Resume"]);
    await userEvent.click(x);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("stands directly left of the Switch mark when the pane has no Changes pill", () => {
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} handle={handle()} clear={clearX()} />);
    const x = screen.getByRole("button", { name: "Clear message" });
    expect(x.nextElementSibling).toBe(screen.getByRole("button", { name: "Switch pane" }));
  });

  it("stands alone when neither shows, and still pins a block to stand on", () => {
    const { container } = render(<ActionsRow general={[general()]} agent="claude" onRun={took} clear={clearX()} />);
    const x = screen.getByRole("button", { name: "Clear message" });
    expect(x.nextElementSibling).toBeNull();
    // A pinned block needs its spacer, and the scroller drops its own `pr-3` for it: one pill, 122 + 16.
    expect(spacerStyle(container)).toBe("width: 138px;");
    const scroller = container.querySelector<HTMLElement>(".overflow-x-auto")!;
    expect(scroller.className).not.toMatch(/(?:^|\s)pr-3(?=\s|$)/);
  });

  it("widens the first-frame fallback for the third pill: 85 + 3 × 37 + 2 × 6 = 208 at the default scale", () => {
    const { container } = render(
      <ActionsRow
        general={[general()]}
        agent="claude"
        onRun={took}
        handle={handle()}
        changes={changes()}
        clear={clearX()}
      />,
    );
    expect(spacerStyle(container)).toBe("width: 224px;");
  });

  it("keeps the inset arithmetic one formula for one, two and three pinned pills", () => {
    // The scale-1 constants, as documented at SWITCH_PILL_INSET: 117, 155, 193.
    expect([1, 2, 3].map((n) => switchPillInset(1, n))).toEqual([117, 155, 193]);
    // The three belt sizes: only the pills grow, the fixed 85 and the 6px gaps do not.
    expect([1, 2, 3].map((n) => switchPillInset(1.15, n))).toEqual([122, 165, 208]);
    expect([1, 2, 3].map((n) => switchPillInset(1.3, n))).toEqual([127, 175, 223]);
    expect([1, 2, 3].map((n) => switchPillInset(1.5, n))).toEqual([133, 187, 241]);
  });

  it("swaps the X for Undo in the same slot: same element, same box, the belt does not move", () => {
    const { container, rerender } = render(
      <ActionsRow
        general={[general()]}
        agent="claude"
        onRun={took}
        handle={handle()}
        changes={changes()}
        clear={clearX()}
      />,
    );
    const x = screen.getByRole("button", { name: "Clear message" });
    const before = {
      className: x.className,
      children: x.childElementCount,
      text: x.textContent,
      icon: x.querySelector("svg")!.getAttribute("class"),
      spacer: spacerStyle(container),
    };
    rerender(
      <ActionsRow
        general={[general()]}
        agent="claude"
        onRun={took}
        handle={handle()}
        changes={changes()}
        clear={clearX({ mode: "undo", label: "Undo clear" })}
      />,
    );
    const undo = screen.getByRole("button", { name: "Undo clear" });
    // The same DOM node: a reader's focus stays on it and hears the new name.
    expect(undo).toBe(x);
    // Only the glyph changed. Box, children and the block's reserved width are identical.
    expect(undo.className).toBe(before.className);
    expect(undo.childElementCount).toBe(before.children);
    expect(undo.textContent).toBe(before.text);
    expect(spacerStyle(container)).toBe(before.spacer);
    expect(undo.querySelector("svg")!.getAttribute("class")).not.toBe(before.icon);
    expect(undo.nextElementSibling).toBe(screen.getByRole("button", { name: "Changes" }));
  });

  it("wears the Changes pill's shape and tap feedback", () => {
    render(
      <ActionsRow general={[general()]} agent="claude" onRun={took} handle={handle()} changes={changes()} clear={clearX()} />,
    );
    const x = screen.getByRole("button", { name: "Clear message" });
    for (const cls of [
      /(?:^|\s)w-\(--belt-pill\)(?=\s|$)/,
      /(?:^|\s)min-w-\(--belt-pill\)(?=\s|$)/,
      /(?:^|\s)border-0(?=\s|$)/,
      /(?:^|\s)px-0(?=\s|$)/,
      /(?:^|\s)hover:bg-foreground\/8(?=\s|$)/,
      /(?:^|\s)active:bg-foreground\/15(?=\s|$)/,
      /(?:^|\s)active:scale-\[0\.92\](?=\s|$)/,
      /(?:^|\s)duration-\[120ms\](?=\s|$)/,
    ]) {
      expect(x.className).toMatch(cls);
    }
  });

  it("gives each pinned pill a hit box by its place: 7px out at the block's ends, 3px toward a neighbour", () => {
    render(
      <ActionsRow general={[general()]} agent="claude" onRun={took} handle={handle()} changes={changes()} clear={clearX()} />,
    );
    const reach = (name: string) => {
      const cls = screen.getByRole("button", { name }).className;
      return [cls.match(/before:-left-\[(\d+)px\]/)?.[1], cls.match(/before:-right-\[(\d+)px\]/)?.[1]];
    };
    expect(reach("Clear message")).toEqual(["7", "3"]);
    expect(reach("Changes")).toEqual(["3", "3"]);
    expect(reach("Switch pane")).toEqual(["3", "7"]);
  });

  it("refuses its own mousedown, so the field under the thumb keeps focus and the keyboard stays up", () => {
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} handle={handle()} clear={clearX()} />);
    const x = screen.getByRole("button", { name: "Clear message" });
    // `fireEvent` answers false when a listener called preventDefault.
    expect(fireEvent.mouseDown(x)).toBe(false);
    // …and NOT its pointerdown: WebKit on a phone drops the whole click after a cancelled one.
    expect(fireEvent.pointerDown(x)).toBe(true);
    // The Switch mark refuses neither: it opens a sheet, and the keyboard going down there is right.
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "Switch pane" }))).toBe(true);
  });

  it("an inert X is aria-disabled and dimmed, and ignores the tap", async () => {
    const onClick = vi.fn();
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} clear={clearX({ onClick, inert: true })} />);
    const x = screen.getByRole("button", { name: "Clear message" });
    expect(x).toHaveAttribute("aria-disabled", "true");
    // Not `disabled`: a disabled button takes no mousedown, and the tap would drop the keyboard.
    expect(x).not.toBeDisabled();
    expect(x.className).toMatch(/(?:^|\s)opacity-50(?=\s|$)/);
    await userEvent.click(x);
    expect(onClick).not.toHaveBeenCalled();
  });
});

// THE LEFT-HAND BELT (Settings -> Hand). The mirror is real CSS direction, not a transform: the DOM
// keeps the right-hand order (Keys first), and the left-hand look comes from `rtl` runs with `ltr`
// pills. jsdom has no layout, so these pin the classes and the order; the pixels were measured in
// Chromium at 412px.
describe("ActionsRow — hand", () => {
  const handle = () => ({ ref: vi.fn(), onClick: vi.fn(), label: "Switch pane" });
  const changes = () => ({ onClick: vi.fn(), label: "Changes" });
  const clearX = () => ({ mode: "clear" as const, label: "Clear message", onClick: vi.fn() });
  const rows = (hand?: "right" | "left") =>
    render(
      <ActionsRow
        general={[general(), general({ id: "type", icon: Terminal, label: "Type into terminal" })]}
        agent="claude"
        onRun={took}
        hand={hand}
        handle={handle()}
        changes={changes()}
        clear={clearX()}
      />,
    );
  const scroller = () => document.querySelector<HTMLElement>(".overflow-x-auto")!;
  const block = () => screen.getByRole("button", { name: "Switch pane" }).parentElement!.parentElement!;

  it("is the right hand by default: no direction class anywhere, pinned block at the right", () => {
    rows();
    expect(document.body.innerHTML).not.toMatch(/direction:(?:rtl|ltr)/);
    expect(block().className).toMatch(/(?:^|\s)right-0(?=\s|$)/);
    expect(block().className).not.toMatch(/(?:^|\s)left-0(?=\s|$)/);
    expect(block().className).toMatch(/(?:^|\s)pl-16(?=\s|$)/);
    expect(scroller().className).toMatch(/(?:^|\s)pl-3(?=\s|$)/);
    expect(scroller().className).not.toMatch(/(?:^|\s)pr-3(?=\s|$)/);
  });

  it("keeps the DOM, and so the tab and reading order, the same for both hands", () => {
    const { unmount } = rows("right");
    const right = names();
    unmount();
    rows("left");
    expect(names()).toEqual(right);
    expect(names().slice(0, 2)).toEqual(["Keys", "Type into terminal"]);
  });

  it("runs the scroller, the controls and the harness section right to left, and each pill back to left to right", () => {
    rows("left");
    expect(scroller().className).toContain("[direction:rtl]");
    expect(screen.getByRole("group", { name: "Controls" }).className).toContain("[direction:rtl]");
    expect(screen.getByRole("group", { name: "Harness shortcuts" }).className).toContain("[direction:rtl]");
    // Words are not mirrored: every pill reads icon then word, left to right.
    for (const name of ["Keys", "Type into terminal", "Model", "Effort", "Compact", "Resume"]) {
      expect(screen.getByRole("button", { name }).className).toContain("[direction:ltr]");
    }
  });

  it("pins the block at the LEFT end, fades it toward the right, and mirrors its hairline and order", () => {
    rows("left");
    expect(block().className).toMatch(/(?:^|\s)left-0(?=\s|$)/);
    expect(block().className).toMatch(/(?:^|\s)pr-16(?=\s|$)/);
    expect(block().className).toMatch(/(?:^|\s)pl-3(?=\s|$)/);
    expect(block().className).not.toMatch(/(?:^|\s)right-0(?=\s|$)/);
    // The block's own fade runs to the left, so its solid side stands against the belt's edge.
    expect(block().firstElementChild!.className).toContain("to_left");
    // The block runs mirrored: Switch on the belt's edge, the hairline on the scroller's side.
    const inner = screen.getByRole("button", { name: "Switch pane" }).parentElement!;
    expect(inner.className).toMatch(/(?:^|\s)flex-row-reverse(?=\s|$)/);
    expect(inner.firstElementChild!.className).toMatch(/(?:^|\s)ml-0\.5(?=\s|$)/);
  });

  it("keeps the trailing spacer last (the LEFT end of a right-to-left row) and gutters the right edge", () => {
    rows("left");
    expect(scroller().lastElementChild!.getAttribute("aria-hidden")).toBe("true");
    expect(scroller().className).toMatch(/(?:^|\s)pr-3(?=\s|$)/);
    expect(scroller().className).not.toMatch(/(?:^|\s)pl-3(?=\s|$)/);
  });

  it("mirrors the pinned pills' hit-box reach: 7px out at the block's ends, 3px toward a neighbour", () => {
    rows("left");
    const reach = (name: string) => {
      const cls = screen.getByRole("button", { name }).className;
      return [cls.match(/before:-left-\[(\d+)px\]/)?.[1], cls.match(/before:-right-\[(\d+)px\]/)?.[1]];
    };
    // Right to left on screen: Switch (outer, left edge), Changes, then the X on the inner side.
    expect(reach("Switch pane")).toEqual(["7", "3"]);
    expect(reach("Changes")).toEqual(["3", "3"]);
    expect(reach("Clear message")).toEqual(["3", "7"]);
  });

  it("moves the muted harness section's hairline to the edge its mark stands on", () => {
    render(<ActionsRow general={[general()]} agent="codex" onRun={took} hand="left" />);
    const section = document.querySelector<HTMLElement>('[data-slot="harness-bar"]')!;
    expect(section.className).toMatch(/(?:^|\s)border-r-border(?=\s|$)/);
    expect(section.className).not.toMatch(/(?:^|\s)border-l-border(?=\s|$)/);
  });

  it("with nothing pinned keeps both gutters on a left-hand scroller", () => {
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} hand="left" />);
    expect(scroller().className).toMatch(/(?:^|\s)pl-3(?=\s|$)/);
    expect(scroller().className).toMatch(/(?:^|\s)pr-3(?=\s|$)/);
  });
});
