import { fireEvent, render } from "@testing-library/react";
import { vi } from "vitest";

import { HILL_IDLE } from "@/hooks/use-hill-answer";
import { sortOpenDecisions, type HillDecision } from "@/lib/hill/wire";
import { HILL_T0, hillDecision } from "@/test/hill-fixtures";

import { DecisionCard } from "./decision-card";
import { HillEntryRow, HillView } from "./hill-view";

// The Hill's body and the Dashboard's way in (M96): the cards most urgent first, the empty state, the
// Answered fold with the state words and the receipt line, and the row in the singular and the plural.

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

  it("says nothing needs you when no Decision is open", () => {
    const { container } = renderView([]);
    const empty = container.querySelector('[data-slot="hill-empty"]');
    expect(empty).toHaveTextContent("Nothing needs you.");
    expect(empty).toHaveTextContent("A Decision an agent posts shows here.");
    expect(container.querySelector('[data-slot="hill-answered"]')).toBeNull();
  });

  it("folds the closed ones under Answered, with the state in words and where an answer went", () => {
    const answered = hillDecision({
      title: "Ship it?",
      state: "answered",
      answer: { rid: "r1", intent: "yes", label: "Yes, Edge first", text: null, by: "phone", at: HILL_T0, delivery: "typed" },
    });
    const expired = hillDecision({ title: "Post before noon?", state: "expired" });
    const { container } = renderView([], [answered, expired]);
    const fold = container.querySelector<HTMLElement>('[data-slot="hill-answered"]')!;
    const toggle = fold.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(fold).toHaveTextContent("Answered");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const lines = [...fold.querySelectorAll('[data-slot="hill-closed-line"]')].map((el) => el.textContent);
    expect(lines).toEqual(["Answered · Yes, Edge first · typed to collie lead", "Expired"]);
  });

  it("keeps the words of an undeliverable answer on its row", () => {
    const gone = hillDecision({ state: "undeliverable", closedReason: "target session ended" });
    const { container } = renderView([], [gone], new Map([[gone.id, "Call it minibuch-hc."]]));
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-slot="hill-answered"] button[aria-expanded]')!);
    const row = container.querySelector('[data-slot="hill-closed-row"]')!;
    expect(row).toHaveTextContent("Could not be delivered");
    expect(row.querySelector('[data-slot="decision-kept"]')).toHaveTextContent("Call it minibuch-hc.");
  });
});

describe("the Dashboard's row", () => {
  it("says one Decision in the singular and several in the plural, with the title", () => {
    const one = render(<HillEntryRow count={1} title="Ship the zoom fix?" onOpen={() => {}} />);
    expect(one.container.querySelector('[data-slot="hill-entry-count"]')).toHaveTextContent("1 Decision needs you");
    expect(one.container.querySelector('[data-slot="hill-entry-title"]')).toHaveTextContent("Ship the zoom fix?");
    one.unmount();
    const three = render(<HillEntryRow count={3} title="Ship the zoom fix?" onOpen={() => {}} />);
    expect(three.container.querySelector('[data-slot="hill-entry-count"]')).toHaveTextContent("3 Decisions need you");
  });

  it("opens the Hill on a tap", () => {
    const onOpen = vi.fn();
    const { container } = render(<HillEntryRow count={2} title="t" onOpen={onOpen} />);
    fireEvent.click(container.querySelector('[data-slot="hill-entry"]')!);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
