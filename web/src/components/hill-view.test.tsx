import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";

import { HILL_IDLE } from "@/hooks/use-hill-answer";
import { ARM_DWELL_MS, ARM_MS } from "@/lib/arm";
import { sortOpenDecisions, type HillDecision } from "@/lib/hill/wire";
import { withHeaderHost } from "@/test/header-host";
import { HILL_T0, hillDecision, trickDecision } from "@/test/hill-fixtures";

import { PRESENCE_MS, PRESENCE_REDUCED_MS } from "@/components/ui/presence";

import { DecisionCard } from "./decision-card";
import { HillHeader, HillView } from "./hill-view";

// The Hill's header, body and the Dashboard's way in (M96): the count line, the cards grouped by
// priority and most urgent first, the empty hill, the Answered fold with the state glyphs, the state
// words and the receipt line, and the row in the singular and the plural.

const NO_KEPT: ReadonlyMap<string, string> = new Map();

function renderView(open: HillDecision[], closed: HillDecision[] = [], kept: ReadonlyMap<string, string> = NO_KEPT) {
  return render(
    <HillView
      open={sortOpenDecisions(open)}
      closed={closed}
      kept={kept}
      renderCard={(decision) => <DecisionCard key={decision.id} decision={decision} answer={HILL_IDLE} onSend={() => {}} />}
    />,
  );
}

const titles = (root: HTMLElement) => [...root.querySelectorAll('[data-slot="decision-title"]')].map((el) => el.textContent);

describe("the Hill", () => {
  it("lists the cards by priority, then oldest first", () => {
    const { container } = renderView([
      hillDecision({ title: "later", priority: "later", at: HILL_T0 - 1000 }),
      hillDecision({ title: "today, new", priority: "today", at: HILL_T0 }),
      hillDecision({ title: "now", priority: "now", at: HILL_T0 }),
      hillDecision({ title: "today, old", priority: "today", at: HILL_T0 - 5000 }),
    ]);
    expect(titles(container)).toEqual(["now", "today, old", "today, new", "later"]);
  });

  it("groups the cards under Now, Today and Later, each heading with its peaks and its count", () => {
    const { container } = renderView([
      hillDecision({ title: "a", priority: "today" }),
      hillDecision({ title: "b", priority: "now" }),
      hillDecision({ title: "c", priority: "today" }),
    ]);
    const groups = [...container.querySelectorAll<HTMLElement>('[data-slot="hill-group"]')];
    expect(groups.map((g) => g.dataset.priority)).toEqual(["now", "today"]);
    expect(groups.map((g) => g.querySelector("h2")?.textContent)).toEqual(["Now1", "Today2"]);
    expect(groups.map((g) => g.querySelector('h2 [data-slot="peak-glyph"]')?.getAttribute("data-filled"))).toEqual(["3", "2"]);
    // The heading names its section; the glyph beside the word is decorative there.
    expect(groups[0]!.querySelector('h2 [data-slot="peak-glyph"]')).toHaveAttribute("aria-hidden", "true");
    expect(groups[0]).toHaveAttribute("aria-labelledby", groups[0]!.querySelector("h2")!.id);
    expect(titles(groups[1]!)).toEqual(["a", "c"]);
  });

  it("draws the clear hill when no Decision is open", () => {
    const { container } = renderView([]);
    const empty = container.querySelector('[data-slot="hill-empty"]');
    expect(empty).toHaveTextContent("The hill is clear.");
    expect(empty).toHaveTextContent("Nothing waits on you.");
    expect(empty?.querySelector("[data-mark]")).not.toBeNull();
    expect(container.querySelector('[data-slot="hill-answered"]')).toBeNull();
  });

  it("says how many were answered on the clear hill, and opens the fold there", () => {
    const answer = { rid: "r1", intent: "yes", label: "Yes", text: null, by: "phone", at: HILL_T0, delivery: "typed" as const, trick: "none" as const };
    const { container } = renderView([], [hillDecision({ state: "answered", answer }), hillDecision({ state: "answered", answer }), hillDecision({ state: "expired" })]);
    expect(container.querySelector('[data-slot="hill-empty"]')).toHaveTextContent("2 answered. Nothing waits on you.");
    expect(container.querySelector('[data-slot="hill-answered"] button[aria-expanded]')).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the fold closed while Decisions are open", () => {
    const { container } = renderView([hillDecision()], [hillDecision({ state: "expired" })]);
    expect(container.querySelector('[data-slot="hill-answered"] button[aria-expanded]')).toHaveAttribute("aria-expanded", "false");
  });

  it("folds the closed ones under Answered, with the state in words and where an answer went", () => {
    const answered = hillDecision({
      title: "Ship it?",
      state: "answered",
      answer: { rid: "r1", intent: "yes", label: "Yes, Edge first", text: null, by: "phone", at: HILL_T0, delivery: "typed", trick: "none" },
    });
    const expired = hillDecision({ title: "Post before noon?", state: "expired" });
    const { container } = renderView([hillDecision()], [answered, expired]);
    const fold = container.querySelector<HTMLElement>('[data-slot="hill-answered"]')!;
    const toggle = fold.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(fold).toHaveTextContent("Answered");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const lines = [...fold.querySelectorAll('[data-slot="hill-closed-line"]')].map((el) => el.textContent);
    expect(lines).toEqual(["Answered · Yes, Edge first · typed to collie lead", "Expired"]);
  });

  it("puts a glyph for each closed state in front of its row, named by what it means", () => {
    const states = ["dismissed", "expired", "withdrawn", "superseded", "undeliverable"] as const;
    const { container } = renderView([], states.map((state) => hillDecision({ state })));
    const glyphs = [...container.querySelectorAll('[data-slot="hill-closed-row"] > [data-icon]')].map((el) => el.getAttribute("data-icon"));
    expect(glyphs).toEqual(["decision-dismissed", "time", "decision-withdrawn", "decision-superseded", "error"]);
  });

  it("says what the trick did on the row of an answer to a trick's decision", () => {
    const answer = { rid: "r1", intent: "yes", label: "Yes", text: null, by: "phone", at: HILL_T0 };
    const ran = trickDecision({ state: "answered", answer: { ...answer, delivery: "none", trick: "ran" } });
    const sentAndRan = trickDecision({
      state: "answered",
      target: { label: "m96-hill", host: "lodge", unattended: false },
      answer: { ...answer, delivery: "typed", trick: "ran" },
    });
    const failed = trickDecision({ state: "answered", answer: { ...answer, delivery: "none", trick: "failed" } });
    const { container } = renderView([], [ran, sentAndRan, failed]);
    const lines = [...container.querySelectorAll('[data-slot="hill-closed-line"]')].map((el) => el.textContent);
    expect(lines).toEqual([
      "Answered · Yes · recorded by Look",
      "Answered · Yes · typed to m96-hill · recorded by Look",
      "Answered · Yes · Look did not take it",
    ]);
  });

  it("keeps the words of an undeliverable answer on its row", () => {
    const gone = hillDecision({ state: "undeliverable", closedReason: "target session ended" });
    const { container } = renderView([], [gone], new Map([[gone.id, "Call it workshop-hc."]]));
    const row = container.querySelector('[data-slot="hill-closed-row"]')!;
    expect(row).toHaveTextContent("Could not be delivered");
    expect(row.querySelector('[data-slot="decision-kept"]')).toHaveTextContent("Call it workshop-hc.");
  });
});

describe("nothing arrives or leaves the Hill with a jump (2026-11-10)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const view = (open: HillDecision[], closed: HillDecision[] = []) => (
    <HillView open={sortOpenDecisions(open)} closed={closed} kept={NO_KEPT} renderCard={(d) => <DecisionCard key={d.id} decision={d} answer={HILL_IDLE} onSend={() => {}} />} />
  );
  const itemOf = (el: Element | null | undefined) => el?.closest('[data-slot="presence-item"]');

  it("keeps a card that left the list where it stood, collapsing and out of reach, then lets it go", () => {
    const a = hillDecision({ title: "First?", at: HILL_T0 });
    const b = hillDecision({ title: "Second?", at: HILL_T0 + 1 });
    const c = hillDecision({ title: "Third?", at: HILL_T0 + 2 });
    const { container, rerender } = render(view([a, b, c]));
    rerender(view([a, c]));
    expect(titles(container)).toEqual(["First?", "Second?", "Third?"]);
    const leaving = itemOf(container.querySelector(`[data-id="${b.id}"]`))!;
    expect(leaving).toHaveAttribute("data-state", "closed");
    expect(leaving).toHaveAttribute("inert");
    // Its 12px gap goes with it, so the card below lands where it stays.
    expect(leaving.getAttribute("style")).toContain("margin-bottom: -12px");
    act(() => vi.advanceTimersByTime(PRESENCE_MS));
    expect(titles(container)).toEqual(["First?", "Third?"]);
  });

  it("lets a priority group leave with its last card, heading and all, in one motion", () => {
    const now = hillDecision({ title: "Now?", priority: "now" });
    const today = hillDecision({ title: "Today?", priority: "today" });
    const { container, rerender } = render(view([now, today]));
    rerender(view([today]));
    const group = container.querySelector<HTMLElement>('[data-slot="hill-group"][data-priority="now"]')!;
    expect(group).toHaveTextContent("Now?");
    expect(itemOf(group)).toHaveAttribute("data-state", "closed");
    expect(itemOf(group)!.getAttribute("style")).toContain("margin-bottom: -28px");
    // The card inside rides with the group; it does not collapse on its own.
    expect(itemOf(group.querySelector('[data-slot="decision-card"]'))).toHaveAttribute("data-state", "open");
    act(() => vi.advanceTimersByTime(PRESENCE_MS));
    expect(container.querySelector('[data-slot="hill-group"][data-priority="now"]')).toBeNull();
  });

  it("trades the last card for the clear hill in one band", () => {
    const last = hillDecision({ title: "Last one?" });
    const { container, rerender } = render(view([last]));
    expect(container.querySelector('[data-slot="hill-empty"]')).toBeNull();
    rerender(view([], [{ ...last, state: "dismissed" }]));
    // Both in the band for the motion: the card collapsing, the ridge fading in where it stood.
    expect(titles(container)).toEqual(["Last one?"]);
    expect(container.querySelector('[data-slot="hill-empty"]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(PRESENCE_MS));
    expect(titles(container)).toEqual([]);
    expect(container.querySelector('[data-slot="hill-empty"]')).not.toBeNull();
  });

  it("brings Answered in as an item of the column the first time, and grows a new row in at its top", () => {
    const open = hillDecision({ title: "Open?" });
    const first = hillDecision({ title: "First closed", state: "expired" });
    const { container, rerender } = render(view([open]));
    expect(container.querySelector('[data-slot="hill-answered"]')).toBeNull();
    rerender(view([open], [first]));
    const answered = container.querySelector('[data-slot="hill-answered"]')!;
    expect(itemOf(answered)).toHaveAttribute("data-state", "closed");
    act(() => vi.advanceTimersByTime(64));
    expect(itemOf(answered)).toHaveAttribute("data-state", "open");
    fireEvent.click(answered.querySelector("button[aria-expanded]")!);
    act(() => vi.advanceTimersByTime(PRESENCE_MS + 64));
    const second = hillDecision({ title: "Second closed", state: "withdrawn" });
    rerender(view([open], [second, first]));
    const rows = [...container.querySelectorAll('[data-slot="hill-closed-row"]')];
    expect(rows.map((row) => row.querySelector(".font-content")?.textContent)).toEqual(["Second closed", "First closed"]);
    const arriving = itemOf(rows[0])!;
    expect(arriving.tagName).toBe("LI");
    expect(arriving).toHaveAttribute("data-state", "closed");
    act(() => vi.advanceTimersByTime(48));
    expect(arriving).toHaveAttribute("data-state", "open");
  });
});

describe("the Hill's header", () => {
  /** The header portals into the one header host, as on a route; read it from the document. */
  const header = (count: number, nowCount: number) => {
    const router = createMemoryRouter([{ path: "/hill", element: withHeaderHost(<HillHeader count={count} nowCount={nowCount} onBack={() => {}} />) }], {
      initialEntries: ["/hill"],
    });
    render(<RouterProvider router={router} />);
    return document;
  };
  const line = (count: number, nowCount: number) => header(count, nowCount).querySelector('[data-slot="hill-count"]')?.textContent;

  it("says how many are open, and how many of them are Now", () => {
    expect(line(12, 1)).toBe("12 open · 1 now");
  });

  it("leaves Now out of the line when none is Now", () => {
    expect(line(3, 0)).toBe("3 open");
  });

  it("keeps its line with nothing open, so the header does not move", () => {
    expect(line(0, 0)).toBe("All clear");
  });

  it("wears the Hill's mountain through its icon key", () => {
    expect(header(1, 0).querySelector('[data-slot="hill-mark"] [data-icon="hill"]')).not.toBeNull();
  });

  it("gives the mark the warm accent while a Decision is Now, and the plain ink otherwise (C1)", () => {
    expect(header(2, 1).querySelector('[data-slot="hill-mark"]')!.className).toMatch(/\bborder-status-working\/60\b.*\btext-status-working\b/u);
    cleanup();
    const calm = header(2, 0).querySelector('[data-slot="hill-mark"]')!;
    expect(calm.className).not.toContain("status-working");
    expect(calm.className).toMatch(/\bborder-border\b/u);
  });
});

// Clear on the Answered header: one quiet button, armed by the first tap, fired by the second, dropped
// by time and by a count that moved, and drawn only when the view is given the way to clear.
describe("the Clear button on the Answered group", () => {
  const closed = () => [hillDecision({ state: "answered", closedAt: HILL_T0 }), hillDecision({ state: "dismissed", closedAt: HILL_T0 - 1 })];
  const shown = (root: HTMLElement) => root.querySelector('[data-slot="hill-clear"] [data-active]')?.textContent;

  function renderClear(over: { closedTotal?: number; canWrite?: boolean; busy?: boolean; onClear?: () => void; rows?: HillDecision[] } = {}) {
    const props = (rows: HillDecision[]) => ({
      open: [],
      closed: rows,
      kept: NO_KEPT,
      closedTotal: over.closedTotal,
      clear: { canWrite: over.canWrite ?? true, busy: over.busy ?? false, onClear: over.onClear ?? (() => {}) },
      renderCard: () => null,
    });
    const view = render(<HillView {...props(over.rows ?? closed())} />);
    return { ...view, again: (rows: HillDecision[]) => view.rerender(<HillView {...props(rows)} />) };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is drawn only with a way to clear: a view without one has no button", () => {
    const { container } = render(<HillView open={[]} closed={closed()} kept={NO_KEPT} renderCard={() => null} />);
    expect(container.querySelector('[data-slot="hill-clear"]')).toBeNull();
  });

  it("sits beside the Answered fold button, not inside it, so a tap on it never folds the group", () => {
    const { container } = renderClear();
    const fold = container.querySelector('[data-slot="hill-answered"] button[aria-expanded]')!;
    const clear = container.querySelector('[data-slot="hill-clear"]')!;
    expect(fold.contains(clear)).toBe(false);
    fireEvent.click(clear);
    expect(fold).toHaveAttribute("aria-expanded", "true");
  });

  it("arms on the first tap, fires on the second after the dwell, and spends the arm", () => {
    const onClear = vi.fn();
    const { container } = renderClear({ onClear });
    const clear = () => container.querySelector<HTMLButtonElement>('[data-slot="hill-clear"]')!;
    fireEvent.click(clear());
    expect(shown(container)).toBe("Clear 2 entries?");
    // Inside the dwell: the same touch landing twice.
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS - 100));
    fireEvent.click(clear());
    expect(onClear).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    fireEvent.click(clear());
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(shown(container)).toBe("Clear");
  });

  it("lapses after the arm window, and a tap after that is a first tap again", () => {
    const onClear = vi.fn();
    const { container } = renderClear({ onClear });
    const clear = () => container.querySelector<HTMLButtonElement>('[data-slot="hill-clear"]')!;
    fireEvent.click(clear());
    act(() => vi.advanceTimersByTime(ARM_MS + 10));
    expect(shown(container)).toBe("Clear");
    fireEvent.click(clear());
    expect(onClear).not.toHaveBeenCalled();
    expect(shown(container)).toBe("Clear 2 entries?");
  });

  it("drops an arm when the count it asked about moves", () => {
    const { container, again } = renderClear();
    fireEvent.click(container.querySelector('[data-slot="hill-clear"]')!);
    expect(shown(container)).toBe("Clear 2 entries?");
    again([hillDecision({ state: "answered", closedAt: HILL_T0 })]);
    expect(shown(container)).toBe("Clear");
  });

  it("counts what the bridge holds when that is more than the rows served", () => {
    const { container } = renderClear({ closedTotal: 31 });
    fireEvent.click(container.querySelector('[data-slot="hill-clear"]')!);
    expect(shown(container)).toBe("Clear 31 entries?");
  });

  it("is disabled for a device that may not write and while a clear is in flight", () => {
    expect(renderClear({ canWrite: false }).container.querySelector('[data-slot="hill-clear"]')).toBeDisabled();
    cleanup();
    expect(renderClear({ busy: true }).container.querySelector('[data-slot="hill-clear"]')).toBeDisabled();
  });

  describe("and the motion of a Clear", () => {
    const itemOf = (el: Element | null | undefined) => el?.closest('[data-slot="presence-item"]');
    const rowsOf = (root: HTMLElement) => [...root.querySelectorAll('[data-slot="hill-closed-row"]')];
    const group = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-slot="hill-answered"]');

    it("folds the whole Answered group away as one motion: header, Clear button and rows together, then lets it go", () => {
      const { container, again } = renderClear();
      again([]);
      const leaving = group(container)!;
      expect(leaving).not.toBeNull();
      // One item leaves, the group, and it draws what it drew last: the header still says 2, the rows are all there.
      const item = itemOf(leaving)!;
      expect(item).toHaveAttribute("data-state", "closed");
      expect(item).toHaveAttribute("inert");
      expect(item.getAttribute("style")).toContain("margin-bottom: -28px");
      expect(leaving.querySelector('[data-slot="hill-clear"]')).not.toBeNull();
      expect(leaving).toHaveTextContent("Answered(2)");
      expect(rowsOf(container)).toHaveLength(2);
      // The rows ride with the group: none of them collapses on its own, so nothing moves out of step.
      for (const row of rowsOf(container)) expect(itemOf(row)).toHaveAttribute("data-state", "open");
      act(() => vi.advanceTimersByTime(PRESENCE_MS));
      expect(group(container)).toBeNull();
      expect(container.querySelector('[data-slot="hill-clear"]')).toBeNull();
      expect(rowsOf(container)).toHaveLength(0);
      // The empty hill stands where the group was, as after the last open card.
      expect(container.querySelector('[data-slot="hill-empty"]')).toHaveTextContent("Nothing waits on you.");
    });

    it("grows the rows back when the clear failed, before or after the fold is over", () => {
      const rows = closed();
      const { container, again } = renderClear({ rows });
      again([]);
      act(() => vi.advanceTimersByTime(PRESENCE_MS / 2));
      // Back while it was still folding: the same group opens again, rows and header and all.
      again(rows);
      act(() => vi.advanceTimersByTime(PRESENCE_MS));
      expect(itemOf(group(container))).toHaveAttribute("data-state", "open");
      expect(itemOf(group(container))).not.toHaveAttribute("inert");
      expect(rowsOf(container)).toHaveLength(2);
      // And after it had gone: the group arrives by growing from nothing.
      again([]);
      act(() => vi.advanceTimersByTime(PRESENCE_MS));
      expect(group(container)).toBeNull();
      again(rows);
      const arriving = itemOf(group(container))!;
      expect(arriving).toHaveAttribute("data-state", "closed");
      act(() => vi.advanceTimersByTime(64));
      expect(arriving).toHaveAttribute("data-state", "open");
      expect(rowsOf(container)).toHaveLength(2);
    });

    it("keeps the armed words in the Clear button's own slot, so arming moves nothing beside it", () => {
      const { container } = renderClear();
      const slot = container.querySelector('[data-slot="hill-clear"] [data-active]')!.parentElement!;
      const layers = () => [...slot.children].map((el) => el.textContent);
      // Both words are in the DOM at rest, one shown: the slot is as wide as the wider.
      expect(layers()).toEqual(["Clear", "Clear 2 entries?"]);
      fireEvent.click(container.querySelector('[data-slot="hill-clear"]')!);
      expect(layers()).toEqual(["Clear", "Clear 2 entries?"]);
    });

    it("only fades under reduced motion: no collapsed height, no margin pulled in", () => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
      try {
        const { container, again } = renderClear();
        again([]);
        const item = itemOf(group(container))!;
        expect(item).toHaveAttribute("data-state", "closed");
        expect(item.className).toContain("grid-rows-[1fr]");
        expect(item.className).toContain("opacity-0");
        expect(item.getAttribute("style")).toBeNull();
        act(() => vi.advanceTimersByTime(PRESENCE_REDUCED_MS));
        expect(group(container)).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it("is a 44px target and keeps the muted ink at rest, the destructive tint when armed", () => {
    const { container } = renderClear();
    const clear = container.querySelector<HTMLButtonElement>('[data-slot="hill-clear"]')!;
    expect(clear.className).toContain("h-11");
    expect(clear.className).toContain("text-muted-foreground");
    fireEvent.click(clear);
    expect(clear.className).toContain("bg-destructive/10");
  });
});

// The second Clear (1.29.0): with open cards the person answered in their session, Clear opens a menu
// of two choices; the second withdraws and clears those cards. Without such cards, Clear is as before.
describe("the Clear menu with the second choice", () => {
  const closed = () => [hillDecision({ state: "answered", closedAt: HILL_T0 })];

  function renderMenu(rows: HillDecision[], spoken: number) {
    const onClear = vi.fn();
    const onClearSpoken = vi.fn();
    const view = render(<HillView open={[]} closed={rows} kept={NO_KEPT} renderCard={() => null} clear={{ canWrite: true, busy: false, onClear, spoken, onClearSpoken }} />);
    return { ...view, onClear, onClearSpoken };
  }

  it("offers both choices, and the second clears only the cards answered in the session", () => {
    const { container, getByRole, onClear, onClearSpoken } = renderMenu(closed(), 2);
    fireEvent.click(container.querySelector('[data-slot="hill-clear"]')!);
    expect(getByRole("button", { name: "Clear 1 entry" })).toBeEnabled();
    fireEvent.click(getByRole("button", { name: "Clear cards you answered in the session" }));
    expect(onClearSpoken).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
  });

  it("shows Clear with only cards answered in the session, and the first choice is then not offered as live", () => {
    const { container, getByRole } = renderMenu([], 1);
    fireEvent.click(container.querySelector('[data-slot="hill-clear"]')!);
    expect(getByRole("button", { name: "Clear 0 entries" })).toBeDisabled();
    expect(getByRole("button", { name: "Clear cards you answered in the session" })).toBeEnabled();
  });

  it("keeps the arm-and-tap Clear when no card was answered in its session", () => {
    const { container, queryByRole } = renderMenu(closed(), 0);
    expect(container.querySelector('[data-slot="hill-clear"]')).not.toHaveAttribute("data-menu");
    fireEvent.click(container.querySelector('[data-slot="hill-clear"]')!);
    expect(queryByRole("button", { name: "Clear cards you answered in the session" })).toBeNull();
  });
});
