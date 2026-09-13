import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Keyboard, Terminal } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetHarnessBar, setHarnessBarEnabled } from "@/lib/harness-bar-pref";
import { fixtureServers } from "@/test/handlers";
import type { ServerSummary } from "@/lib/types";
import { ActionsRow, type GeneralAction } from "./actions-row";
import { CrewProvider } from "./crew-provider";

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
    expect(belt.className).toMatch(/(?:^|\s)border-y(?=\s|$)/);
    expect(belt.className).toMatch(/(?:^|\s)bg-foreground\/6(?=\s|$)/);
    expect(belt.className).not.toMatch(/rounded/);
    // Collie's own controls stand on that ground with no box of their own.
    const controls = document.querySelector<HTMLElement>('[data-slot="composer-controls"]')!;
    expect(controls.className).not.toMatch(/rounded|border|bg-/);
  });

  it("wears the switcher's grip on its top rule when one is handed down, and nothing when none is", async () => {
    // The grip used to be a 30px band of its own above the composer. It rides this belt's rule now,
    // absolutely positioned, so it takes no layout at all — and the belt draws it only because the
    // belt owns the rule. The pane decides whether there is one (agent-chat.tsx).
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
    // It is the belt's own first child and NOT inside the scroller's masked wrapper: a mask applies
    // to its whole subtree, so a grip in there would fade out wherever the belt overflows.
    const belt = document.querySelector<HTMLElement>('[data-slot="composer-actions"]')!;
    expect(grip.parentElement).toBe(belt);
    expect(belt.firstElementChild).toBe(grip);
    // THE DRAG REF LANDS ON THE BELT, NOT ON THE CHEVRON. A drag up from anywhere on the band opens
    // the switcher; the chevron only says where it comes from and takes the tap. Asserted as
    // "the node the ref got CONTAINS the chevron", which is the shape that fails the moment somebody
    // puts the ref back on the button.
    const dragged = ref.mock.calls.map(([node]) => node).findLast((node) => node !== null);
    expect(dragged).toBe(belt);
    expect(belt.contains(grip)).toBe(true);
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

  // THE MACHINE IS PINNED AT THE RIGHT END AND COSTS THE SCROLLER NOTHING. It opened the scroller
  // as its first child for half a day, and Altan's verdict was that the tag "is taking up too much
  // space" — 63px of a row that already overflows on a Claude pane. Pinned, the pills start on Keys
  // on a crew exactly as on a solo install, and the name never scrolls away.
  //
  // A real CrewProvider over two machines, because the chip's hide rule is "more than one machine"
  // and a solo provider would render nothing at all — which is the other half of what is asserted.
  describe("the pinned host tag", () => {
    const beltOf = () => document.querySelector<HTMLElement>('[data-slot="composer-actions"]')!;
    const scrollerOf = () => beltOf().querySelector<HTMLElement>(".overflow-x-auto")!;

    function renderBelt(servers?: ServerSummary[]) {
      render(
        <CrewProvider servers={servers}>
          <ActionsRow general={[general()]} agent="claude" writeHost="workshop" onRun={took} />
        </CrewProvider>,
      );
    }

    it("stands OUTSIDE the scroller, so the pills pan under it and start at the same x", () => {
      renderBelt(fixtureServers);
      const tag = screen.getByLabelText("Sends to host: workshop");
      expect(beltOf().contains(tag)).toBe(true);
      // Not in the scroller at all — not its first child, not anywhere in it. Inside, it would both
      // take width and fade out with the pills, because a mask applies to its whole subtree.
      expect(scrollerOf().contains(tag)).toBe(false);
      // …and the scroller's own first child is the controls group, on a crew as on a solo install.
      expect(scrollerOf().firstElementChild?.getAttribute("data-slot")).toBe("composer-controls");
    });

    it("is never wider than the send button, and says 'sends to' rather than 'host:'", () => {
      renderBelt(fixtureServers);
      const tag = screen.getByLabelText("Sends to host: workshop");
      // `max-w-11` is the send button's own `size-11`, 44px — Altan's rule, and the number that
      // costs this tag its glyph (actions-row.tsx holds the arithmetic).
      expect(tag.className).toMatch(/(?:^|\s)max-w-11(?=\s|$)/);
      expect(tag.className).not.toMatch(/max-w-\[8rem\]/);
    });

    it("draws nothing, and insets nothing, on a solo install", () => {
      renderBelt();
      expect(screen.queryByLabelText(/^Sends to host/)).toBeNull();
      // No pinned tag means no reason to hold the right end back, so the cue is on the edge again.
      expect(beltOf().querySelector("[style*='--edge-inset-right']")).toBeNull();
    });
  });
});
