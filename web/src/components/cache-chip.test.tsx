import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CacheChip } from "./cache-chip";
import { CrewProvider } from "./crew-provider";
import { resetCacheClockForTests } from "@/lib/cache-clock";
import { HOST_TEXT_CLASSES, hostSlot } from "@/lib/hosts";
import { fixtureServers } from "@/test/handlers";
import type { PaneCache, ServerSummary } from "@/lib/types";

// The chip on a card and in a header. The two claims worth a test are both about ABSENCE and about
// which element it is: nothing renders before a reading exists, and the chip is a control on the pane
// screen only — on a card the row is already one button, and a button inside a button is a mis-tap.

const solo: ServerSummary[] = [fixtureServers[0]!];

const crew = ({ children }: { children: React.ReactNode }) => (
  <CrewProvider servers={fixtureServers}>{children}</CrewProvider>
);
const one = ({ children }: { children: React.ReactNode }) => (
  <CrewProvider servers={solo}>{children}</CrewProvider>
);

const cache = (over: Partial<PaneCache> = {}): PaneCache => ({
  state: "warm",
  expiresAt: Date.now() + 12 * 60_000,
  ttlSeconds: 3600,
  ruleId: "claude.subscription",
  confidence: "documented",
  lastRequestAt: Date.now() - 48 * 60_000,
  ...over,
});

const chip = () => document.querySelector('[data-slot="cache-chip"]');

afterEach(() => {
  resetCacheClockForTests();
});

describe("nothing is shown before it is measured", () => {
  it("renders nothing with no reading at all", () => {
    render(<CacheChip cache={undefined} />, { wrapper: one });
    expect(chip()).toBeNull();
  });

  it("renders nothing for the unknown state — no placeholder, no waiting word", () => {
    render(<CacheChip cache={cache({ state: "unknown" })} />, { wrapper: one });
    expect(chip()).toBeNull();
    expect(screen.queryByText(/measuring|waiting|unknown/i)).toBeNull();
  });
});

describe("what it says", () => {
  it("counts the minutes left", () => {
    render(<CacheChip cache={cache()} />, { wrapper: one });
    expect(chip()?.textContent).toContain("12m");
  });

  it("says the cold word, not a number", () => {
    render(<CacheChip cache={cache({ state: "cold" })} />, { wrapper: one });
    expect(chip()?.textContent).toContain("cold");
  });

  it("gives a screen reader the meaning of the number on a card", () => {
    render(<CacheChip cache={cache()} />, { wrapper: one });
    expect(screen.getByText("Prompt cache warm")).toBeInTheDocument();
  });

  it("says expiring to a screen reader when the bridge says expiring", () => {
    render(<CacheChip cache={cache({ state: "expiring", expiresAt: Date.now() + 8 * 60_000 })} />, {
      wrapper: one,
    });
    expect(screen.getByText("Prompt cache expiring")).toBeInTheDocument();
  });
});

describe("the overridden mark", () => {
  it("is absent on a shipped number", () => {
    render(<CacheChip cache={cache()} />, { wrapper: one });
    expect(document.querySelector("[data-overridden]")).toBeNull();
  });

  it("is a dot PLUS a word, because a dot alone is shape and colour", () => {
    render(<CacheChip cache={cache({ overridden: true })} />, { wrapper: one });
    expect(document.querySelector('[data-overridden="true"]')).not.toBeNull();
    expect(screen.getByText("TTL set in cache-rules.toml")).toBeInTheDocument();
  });
});

describe("which element it is", () => {
  it("is NOT a control on a card — the row is already one button", () => {
    render(<CacheChip cache={cache()} />, { wrapper: one });
    expect(screen.queryByRole("button")).toBeNull();
    expect(chip()?.tagName).toBe("SPAN");
  });

  it("is a button on the pane screen, and opening it calls back", async () => {
    const onOpen = vi.fn();
    render(<CacheChip cache={cache()} variant="button" onOpen={onOpen} />, { wrapper: one });
    const button = screen.getByRole("button");
    await userEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-label")).toContain("12m");
  });
});

describe("one quiet ink per state, on the glyph alone", () => {
  const glyphClass = () => chip()?.querySelector("svg")?.getAttribute("class") ?? "";

  it("paints warm green, expiring red and cold blue, three states and no shades between", () => {
    // Cold is blue, not red; expiring is the alarm, so it alone runs at full strength. Warm and
    // cold are dimmed because the chip is a footnote until the window is nearly out.
    const inks = [
      ["warm", "text-status-done/60"],
      ["expiring", "text-status-blocked"],
      ["cold", "text-status-info/70"],
    ] as const;
    for (const [state, ink] of inks) {
      const view = render(<CacheChip cache={cache({ state })} />, { wrapper: one });
      expect(glyphClass()).toContain(ink);
      // The word never takes the state's ink: DESIGN.md's tint lands on the glyph only.
      expect(chip()?.className).toContain("text-muted-foreground");
      expect(chip()?.className).not.toMatch(/text-status-/);
      view.unmount();
    }
  });

  it("leaves a peer's number in the same ink — the host tint is not a status", () => {
    // Until 2026-09-14 the whole chip wore the machine's identity tint, which Altan read as a loud
    // pink in a line of muted type. DESIGN.md: a host tint may never be mistaken for a status, and
    // this chip is a status. The `HostChip` beside it still says whose machine it is.
    const host = fixtureServers[1]?.id;
    expect(host).toBeDefined();
    const slot = hostSlot(fixtureServers, host);
    expect(slot).not.toBeNull();
    render(<CacheChip cache={cache()} host={host} />, { wrapper: crew });
    if (slot !== null) {
      expect(chip()?.className).not.toContain(HOST_TEXT_CLASSES[slot]);
      expect(glyphClass()).not.toContain(HOST_TEXT_CLASSES[slot]);
    }
    expect(glyphClass()).toContain("text-status-done/60");
    // `crew-formation.tsx:454`: a second coloured mark beside a HostChip says one fact twice.
    expect(document.querySelector("[data-overridden]")).toBeNull();
  });
});

describe("one mark, in every state", () => {
  it("is an hourglass, and the same hourglass whether the window is warm, expiring or cold", () => {
    // The glyph asserts no temperature: the ink alone carries warm/expiring/cold, and a second
    // encoding of the same fact is what a thermometer was. So the SHAPE may not change with the
    // state, only the colour it is drawn in.
    const marks = (["warm", "expiring", "cold"] as const).map((state) => {
      const view = render(<CacheChip cache={cache({ state })} />, { wrapper: one });
      const glyph = chip()?.querySelector("svg")?.getAttribute("class") ?? "";
      view.unmount();
      return glyph.replace(/text-status-\S+/, "");
    });
    expect(marks[0]).toContain("lucide-hourglass");
    expect(new Set(marks).size).toBe(1);
  });
});

describe("the number stands on the glyph's bottom edge", () => {
  it("aligns on the baseline, not on the centre, in every variant", () => {
    // An SVG has no baseline of its own, so CSS synthesises one from its bottom border edge: with
    // `items-baseline` the hourglass's foot and the number's baseline are the same line. Centring put
    // the number about 2.4px above that foot at 12px, which is the gap Altan saw. `leading-none`
    // keeps the chip no taller than the glyph plus the font's descent, so neither the header's 12px
    // line nor the dashboard's 16px slot is asked for more room.
    const row = render(<CacheChip cache={cache()} />, { wrapper: one });
    expect(chip()?.className).toMatch(/(?:^|\s)items-baseline(?=\s|$)/);
    expect(chip()?.className).toMatch(/(?:^|\s)leading-none(?=\s|$)/);
    expect(chip()?.className).not.toMatch(/items-center/);
    row.unmount();

    render(<CacheChip cache={cache()} variant="button" onOpen={() => {}} />, { wrapper: one });
    expect(chip()?.className).toMatch(/(?:^|\s)items-baseline(?=\s|$)/);
  });
});
