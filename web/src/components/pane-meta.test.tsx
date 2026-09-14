import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PaneMeta } from "./pane-meta";
import { CrewProvider } from "./crew-provider";
import { resetCacheClockForTests } from "@/lib/cache-clock";
import { fixtureServers } from "@/test/handlers";
import type { PaneCache, ServerSummary } from "@/lib/types";

// A pane's address and its cache reading, drawn once for the two screens that carry them: the
// dashboard row's name line (`agent-card.tsx`) and the pane header's workspace line
// (`agent-chat.tsx`). `PaneMeta` had two layouts until 2026-09-14 — a column of two fixed corners
// for the dashboard, a single inline row for the header — and the column read as an extra row on a
// phone (Altan's phone feedback), so it is gone; every caller now gets the one row below. The claims
// worth a test are the ones the copy kept breaking: the row keeps its height when both chips
// self-hide, the pair is always the same pair, and the reading is a control only where the surface
// offers the rule behind it.

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

const row = () => document.querySelector<HTMLElement>('[data-slot="pane-meta"]')!;

afterEach(() => {
  resetCacheClockForTests();
});

describe("the row's shape", () => {
  it("is ONE box of the line's own height, whatever either chip has to say", () => {
    // DESIGN.md §2. A reading that arrives on the next poll cannot grow the line the row sits at
    // the end of.
    const full = render(<PaneMeta host="workshop" cache={reading()} />, { wrapper: crew });
    expect(row().className).toMatch(/(?:^|\s)h-3(?=\s|$)/);
    full.unmount();

    // Solo, no reading: both chips render nothing at all and the box still stands.
    render(<PaneMeta host={undefined} cache={undefined} />, { wrapper: one });
    expect(row().className).toMatch(/(?:^|\s)h-3(?=\s|$)/);
    expect(document.querySelector('[data-slot="cache-chip"]')).toBeNull();
    expect(screen.queryByLabelText(/^host: /i)).toBeNull();
  });

  it("borrows the host's borderless run and leaves the reading's word at the meta colour", () => {
    // The two decisions that make a line of chrome out of what was a corner: the machine is the
    // `bare` HostChip — no pill, the surrounding line's own mono — and the reading tints its GLYPH
    // alone, so the only coloured thing on the row is the hourglass (DESIGN.md's tint-on-glyph rule).
    const withHost = render(<PaneMeta host="workshop" cache={reading()} />, { wrapper: crew });
    const host = screen.getByLabelText(/^host: workshop/i);
    expect(host.className).toMatch(/font-mono/);
    expect(host.className).not.toMatch(/border/);
    withHost.unmount();

    // A window the bridge calls expiring: the state's ink is the app's red, the alarm, and it may
    // reach the hourglass and nothing else. A PEER's reading is drawn in the very same ink — the
    // identity tint left this chip on 2026-09-14, because a host tint may never be mistaken for a
    // status.
    render(<PaneMeta host="workshop" cache={reading({ state: "expiring" })} />, { wrapper: crew });
    const chip = document.querySelector<HTMLElement>('[data-slot="cache-chip"]')!;
    expect(chip.className).toMatch(/text-muted-foreground/);
    expect(chip.className).not.toMatch(/text-status-blocked/);
    expect(chip.className).not.toMatch(/text-host-/);
    expect(chip.querySelector("svg")?.getAttribute("class")).toMatch(/text-status-blocked/);
  });

  it("stands the reading on the hourglass's foot", () => {
    render(<PaneMeta host="workshop" cache={reading()} />, { wrapper: crew });
    const chip = document.querySelector<HTMLElement>('[data-slot="cache-chip"]')!;
    expect(chip.className).toMatch(/(?:^|\s)items-baseline(?=\s|$)/);
    expect(chip.querySelector("svg")?.getAttribute("class")).toMatch(/text-status-done\/60/);
  });

  it("stands the WHOLE row on one baseline — both glyphs' feet, both words", () => {
    // The 2026-09-14 fix aligned the cache chip's own glyph to its own number and the row still
    // read wrong, because a flex container centres its CHILDREN as boxes: a 12px host run beside a
    // 15px cache chip put the two glyphs' feet on two different lines. Every box on this row is
    // baseline-aligned — the row, the bare host chip and the separator span that carries the dot —
    // so the container synthesises one line for all of them.
    render(<PaneMeta host="workshop" cache={reading()} />, { wrapper: crew });
    const baseline = /(?:^|\s)items-baseline(?=\s|$)/;
    expect(row().className).toMatch(baseline);
    expect(row().className).not.toMatch(/(?:^|\s)items-center(?=\s|$)/);
    expect(screen.getByLabelText(/^host: workshop/i).className).toMatch(baseline);
    const dotted = document.querySelector<HTMLElement>("span[class*=\"before:content-\"]")!;
    expect(dotted.className).toMatch(baseline);
    // The row still measures the header's own 12px box, so the line it ends cannot grow.
    expect(row().className).toMatch(/(?:^|\s)h-3(?=\s|$)/);
  });

  it("reaches a 44px tap box without drawing one, when the surface opens the rule", async () => {
    const user = userEvent.setup();
    const onOpenCache = vi.fn();
    render(<PaneMeta host={undefined} cache={reading()} onOpenCache={onOpenCache} />, {
      wrapper: one,
    });
    const chip = document.querySelector<HTMLElement>('[data-slot="cache-chip"]')!;
    expect(chip.tagName).toBe("BUTTON");
    // 12px of line plus 16px above and below is 44px. Drawn, the box would be nearly four times the
    // line and would set the surrounding row's height on its own.
    expect(chip.className).toMatch(/before:-inset-y-4/);
    await user.click(chip);
    expect(onOpenCache).toHaveBeenCalledTimes(1);
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
    await user.click(chip);
    expect(onOpenCache).toHaveBeenCalledTimes(1);
  });

  it("is a plain span with no callback — the dashboard card is already one button", () => {
    render(<PaneMeta host={undefined} cache={reading()} />, { wrapper: one });
    const chip = document.querySelector<HTMLElement>('[data-slot="cache-chip"]')!;
    expect(chip.tagName).toBe("SPAN");
  });
});
