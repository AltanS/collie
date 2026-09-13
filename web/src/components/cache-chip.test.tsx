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

describe("a peer's number wears that machine's ink", () => {
  it("takes the host's identity tint on a crew, and adds no second dot", () => {
    const host = fixtureServers[1]?.id;
    expect(host).toBeDefined();
    render(<CacheChip cache={cache()} host={host} />, { wrapper: crew });
    const slot = hostSlot(fixtureServers, host);
    expect(slot).not.toBeNull();
    if (slot !== null) expect(chip()?.className).toContain(HOST_TEXT_CLASSES[slot]);
    // `crew-formation.tsx:454`: a second coloured mark beside a HostChip says one fact twice.
    expect(document.querySelector("[data-overridden]")).toBeNull();
  });

  it("keeps the plain tone on a solo install, where there is nothing to tell apart", () => {
    render(<CacheChip cache={cache()} host="bluefin" />, { wrapper: one });
    expect(chip()?.className).toContain("text-muted-foreground");
  });
});

describe("one mark, in every state", () => {
  it("is an hourglass, and the same hourglass whether the window is warm, expiring or cold", () => {
    // The glyph asserts no temperature: the tint alone carries warm/expiring/cold, and a second
    // encoding of the same fact is what a thermometer was. So the mark may not change with the state.
    const marks = (["warm", "expiring", "cold"] as const).map((state) => {
      const view = render(<CacheChip cache={cache({ state })} />, { wrapper: one });
      const glyph = chip()?.querySelector("svg")?.getAttribute("class") ?? "";
      view.unmount();
      return glyph;
    });
    expect(marks[0]).toContain("lucide-hourglass");
    expect(new Set(marks).size).toBe(1);
  });
});
