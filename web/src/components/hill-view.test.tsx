import { fireEvent, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { HILL_IDLE } from "@/hooks/use-hill-answer";
import { sortOpenDecisions, type HillDecision } from "@/lib/hill/wire";
import { withHeaderHost } from "@/test/header-host";
import { HILL_T0, hillDecision, trickDecision } from "@/test/hill-fixtures";

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
      target: { label: "m96-hill", host: "bluefin", unattended: false },
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
    const { container } = renderView([], [gone], new Map([[gone.id, "Call it minibuch-hc."]]));
    const row = container.querySelector('[data-slot="hill-closed-row"]')!;
    expect(row).toHaveTextContent("Could not be delivered");
    expect(row.querySelector('[data-slot="decision-kept"]')).toHaveTextContent("Call it minibuch-hc.");
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
});
