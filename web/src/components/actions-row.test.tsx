import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Keyboard, Terminal } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetHarnessBar, setHarnessBarEnabled } from "@/lib/harness-bar-pref";
import { ActionsRow, type GeneralAction } from "./actions-row";

afterEach(() => __resetHarnessBar());

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
    expect(spacer.getAttribute("style")).toBe("width: 117px;");
    // The masked wrapper one level out never carries a right-hand gradient stop — `edges="left"`
    // took effect.
    const masked = scroller.parentElement!;
    expect(masked.className).not.toContain("black_calc");
  });

  it("stands the belt's scroller at py-1 (40px), with no vertical scroll under a thumb", () => {
    // Option 6 of the belt-shade deck (playground, removed 2026-09-14 once it had served) first
    // dropped STRIP_SCROLLER's own `py-1.5` to `py-0`, the pill's own 32px. The phone read that as
    // too thin, so it came back up to `py-1` — 40px, 4px above and below the 32px pills — and
    // `overflow-y-hidden` stays paired with it so STRIP_TAP_TARGET's 46px `::before` reach, still
    // wider than the 4px of padding on each side, cannot force a vertical scrollbar the way it did
    // in the playground.
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} />);
    const scroller = document.querySelector<HTMLElement>(".overflow-x-auto")!;
    expect(scroller.className).toMatch(/(?:^|\s)py-1(?=\s|$)/);
    expect(scroller.className).toMatch(/(?:^|\s)overflow-y-hidden(?=\s|$)/);
  });

  it("narrows the Switch button to 32px, the operator's pick", () => {
    render(
      <ActionsRow
        general={[general()]}
        agent="claude"
        onRun={took}
        handle={{ ref: vi.fn(), onClick: vi.fn(), label: "Switch pane" }}
      />,
    );
    const grip = screen.getByRole("button", { name: "Switch pane" });
    expect(grip.className).toMatch(/(?:^|\s)w-8(?=\s|$)/);
    expect(grip.className).toMatch(/(?:^|\s)min-w-8(?=\s|$)/);
  });

  it("gives the scroller symmetric px-3 padding, no trailing spacer, and OverflowEdges its default edges when there is no handle", () => {
    render(<ActionsRow general={[general()]} agent="claude" onRun={took} />);
    const scroller = document.querySelector<HTMLElement>(".overflow-x-auto")!;
    expect(scroller.style.paddingRight).toBe("");
    expect(scroller.className).toMatch(/(?:^|\s)pr-3(?=\s|$)/);
    expect(scroller.lastElementChild?.getAttribute("aria-hidden")).not.toBe("true");
  });
});
