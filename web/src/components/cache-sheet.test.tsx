import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { CacheSheet, resetCacheCatalogForTests } from "./cache-sheet";
import { CrewProvider } from "./crew-provider";
import { fixtureCacheRules, fixtureServers } from "@/test/handlers";
import { server } from "@/test/setup";
import type { PaneCache, ServerSummary } from "@/lib/types";

// The sheet is a READING. It has no control in it, it cites a page by name and date, and on a peer's
// pane it says where the number was read rather than quoting a source that machine may never have seen.
//
// The catalog is fetched, which is what makes the last group here worth a test: a sheet that could not
// fetch must fall back to the short form rather than to a plausible-looking citation.

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

describe("this machine's pane", () => {
  it("shows the state, the TTL, the confidence and the rule id", async () => {
    render(<CacheSheet open onClose={() => {}} cache={cache()} />, { wrapper: one });
    expect(screen.getByText("Warm")).toBeInTheDocument();
    expect(screen.getByText("60 min")).toBeInTheDocument();
    expect(screen.getByText("documented")).toBeInTheDocument();
    expect(screen.getByText("claude.subscription")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("link", { name: fixtureCacheRules[0]!.sourceTitle })).toBeInTheDocument();
    });
  });

  it("cites the page by name, links it, and prints the date it was read", async () => {
    render(<CacheSheet open onClose={() => {}} cache={cache()} />, { wrapper: one });
    const link = await screen.findByRole("link", { name: fixtureCacheRules[0]!.sourceTitle });
    expect(link.getAttribute("href")).toBe(fixtureCacheRules[0]!.sourceUrl);
    expect(screen.getByText("2026-08-24")).toBeInTheDocument();
  });

  it("says MEASURED and how long ago, when the number came off a live transcript", async () => {
    const measured = cache({ confidence: "observed", measuredAt: Date.now() - 4 * 60_000 });
    render(<CacheSheet open onClose={() => {}} cache={measured} />, { wrapper: one });
    expect(screen.getByText("measured")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/last read 4m/)).toBeInTheDocument());
  });

  it("says so, and cites the OPERATOR's own date, when cache-rules.toml moved the number", async () => {
    const moved = cache({ ruleId: "claude.api", ttlSeconds: 3600, overridden: true });
    render(<CacheSheet open onClose={() => {}} cache={moved} />, { wrapper: one });
    await waitFor(() => expect(screen.getByText(/Moved by cache-rules\.toml/)).toBeInTheDocument());
    expect(screen.getByText(/2026-09-12/)).toBeInTheDocument();
  });

  it("has no control in it — it is a reading, not a setting", async () => {
    render(<CacheSheet open onClose={() => {}} cache={cache()} />, { wrapper: one });
    await waitFor(() => expect(screen.getByRole("link")).toBeInTheDocument());
    // The sheet primitive supplies its own dismiss (ui/sheet.tsx), so the claim is that this feature
    // added NO control of its own: one button, and it is that dismiss.
    const buttons = screen.queryAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Close");
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("renders nothing at all when the pane has no reading", () => {
    render(<CacheSheet open onClose={() => {}} cache={undefined} />, { wrapper: one });
    expect(screen.queryByText("Prompt cache")).toBeNull();
  });
});

// An action that dropped the prefix (issue #236): the chip is cold like any other cold, and the sheet
// names the action in ONE line, from the rule label that rode the wire.
describe("a cold reading with an action behind it", () => {
  const model = { ruleId: "claude.reset.model", label: "The model changed", at: Date.now() - 60_000 };

  it("names a pending action, and says the next turn rebuilds", async () => {
    render(<CacheSheet open onClose={() => {}} cache={cache({ state: "cold", coldReason: "reset", reset: model })} />, {
      wrapper: one,
    });
    expect(screen.getByText("Cold")).toBeInTheDocument();
    expect(
      screen.getByText("The model changed after the last turn, so the next turn rebuilds the cache."),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link")).toBeInTheDocument());
  });

  it("names the action that made the last turn miss", async () => {
    render(<CacheSheet open onClose={() => {}} cache={cache({ state: "cold", coldReason: "observed", reset: model })} />, {
      wrapper: one,
    });
    expect(
      screen.getByText("The model changed before the last turn, so that turn rebuilt the cache."),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link")).toBeInTheDocument());
  });

  it("says nothing extra for a cold with no action named, which is every older bridge", async () => {
    render(<CacheSheet open onClose={() => {}} cache={cache({ state: "cold", coldReason: "expired" })} />, { wrapper: one });
    render(<CacheSheet open onClose={() => {}} cache={cache({ state: "cold" })} />, { wrapper: one });
    expect(screen.queryByText(/turn rebuil/)).toBeNull();
    await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(2));
  });

  it("reads the label off the wire on a peer's pane, with no catalog behind it", async () => {
    const host = fixtureServers[1]?.id;
    render(
      <CacheSheet open onClose={() => {}} cache={cache({ state: "cold", coldReason: "reset", reset: model })} host={host} />,
      { wrapper: crew },
    );
    expect(screen.getByText(/^The model changed after the last turn/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("link")).toBeNull());
  });
});

describe("a peer's pane", () => {
  it("shows what rides the wire and says where the number was read", async () => {
    const host = fixtureServers[1]?.id;
    expect(host).toBeDefined();
    render(<CacheSheet open onClose={() => {}} cache={cache()} host={host} />, { wrapper: crew });
    expect(screen.getByText("Warm")).toBeInTheDocument();
    expect(screen.getByText("claude.subscription")).toBeInTheDocument();
    expect(screen.getByText(/Its rule catalog is not forwarded/)).toBeInTheDocument();
    // It must never quote the LEAD's catalog for a peer's number: the peer may hold its own override.
    await waitFor(() => expect(screen.queryByRole("link")).toBeNull());
  });
});

describe("no catalog", () => {
  it("falls back to the short form rather than to a guessed citation", async () => {
    // The catalog is cached for the life of the document on purpose, so the cache has to be cleared to
    // state what a boot with no answer looks like.
    resetCacheCatalogForTests();
    server.use(http.get("/api/cache-rules", () => new HttpResponse(null, { status: 503 })));
    render(<CacheSheet open onClose={() => {}} cache={cache()} />, { wrapper: one });
    expect(screen.getByText("Warm")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("link")).toBeNull());
  });
});
