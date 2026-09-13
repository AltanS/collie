import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PaneMeta } from "./pane-meta";
import { CrewProvider } from "./crew-provider";
import { resetCacheClockForTests } from "@/lib/cache-clock";
import { fixtureServers } from "@/test/handlers";
import type { PaneCache, ServerSummary } from "@/lib/types";

// The two corners a pane carries, drawn once for the dashboard row and the pane header. The claims
// worth a test are the ones the copy kept breaking: the column is the SAME shape on both screens, it
// keeps its height when both chips self-hide, and the reading is a control on exactly one of them.

const solo: ServerSummary[] = [fixtureServers[0]!];

const crew = ({ children }: { children: React.ReactNode }) => (
  <CrewProvider servers={fixtureServers}>{children}</CrewProvider>
);
const one = ({ children }: { children: React.ReactNode }) => (
  <CrewProvider servers={solo}>{children}</CrewProvider>
);

const reading = (over: Partial<PaneCache> = {}): PaneCache => ({
  state: "warm",
  expiresAt: Date.now() + 12 * 60_000,
  ttlSeconds: 3600,
  ruleId: "claude.subscription",
  confidence: "documented",
  lastRequestAt: Date.now() - 48 * 60_000,
  ...over,
});

const column = () => document.querySelector<HTMLElement>('[data-slot="pane-meta"]')!;

afterEach(() => {
  resetCacheClockForTests();
});

describe("the column's shape", () => {
  it("is two slots of fixed height, whatever either slot has to say", () => {
    // DESIGN.md §2. An empty slot is an invisible box, never a missing one: a pane whose agent has
    // not taken a turn yet carries no reading, and the corner below the address may not collapse and
    // take the row's height with it.
    const heights = () =>
      // SAFETY: every child of the column is a plain <div> written in pane-meta.tsx, never an SVG or
      // other non-HTMLElement, so each one carries a string className.
      [...column().children].map((box) => /h-(?:4|\[21px\])/.exec((box as HTMLElement).className)?.[0]);

    const full = render(<PaneMeta host="workshop" cache={reading()} />, { wrapper: crew });
    expect(heights()).toEqual(["h-[21px]", "h-4"]);
    full.unmount();

    // Solo, no reading: both chips render nothing at all and the boxes stand.
    render(<PaneMeta host={undefined} cache={undefined} />, { wrapper: one });
    expect(heights()).toEqual(["h-[21px]", "h-4"]);
    expect(document.querySelector('[data-slot="cache-chip"]')).toBeNull();
    expect(screen.queryByLabelText(/^host: /i)).toBeNull();
  });

  it("aligns both slots on one right edge", () => {
    // The fault this closes, in Altan's words from his phone: "the alignment is off". The header put
    // its ⋮ in the top slot beside the host tag, so the tag's bordered box ended 28px left of the
    // cache reading below it. Nothing but the address is in these slots now, and `items-end` is then
    // the whole of the alignment.
    render(<PaneMeta host="workshop" cache={reading()} />, { wrapper: crew });
    expect(column().className).toMatch(/(?:^|\s)items-end(?=\s|$)/);
    expect(column().querySelector("button")).toBeNull();
  });
});

describe("the reading is a control on one screen only", () => {
  it("is a button, with a reachable 44px box, when the surface opens the rule behind it", async () => {
    const user = userEvent.setup();
    const onOpenCache = vi.fn();
    render(<PaneMeta host={undefined} cache={reading()} onOpenCache={onOpenCache} />, {
      wrapper: one,
    });
    const chip = document.querySelector<HTMLElement>('[data-slot="cache-chip"]')!;
    expect(chip.tagName).toBe("BUTTON");
    // Reached, not drawn: 16px of line plus 14px above and below is 44px. A drawn box would be more
    // than twice the slot and would set the header's height on its own.
    expect(chip.className).toMatch(/before:-inset-y-\[14px\]/);
    await user.click(chip);
    expect(onOpenCache).toHaveBeenCalledTimes(1);
  });

  it("is a plain span with no callback — the dashboard card is already one button", () => {
    render(<PaneMeta host={undefined} cache={reading()} />, { wrapper: one });
    const chip = document.querySelector<HTMLElement>('[data-slot="cache-chip"]')!;
    expect(chip.tagName).toBe("SPAN");
  });
});
