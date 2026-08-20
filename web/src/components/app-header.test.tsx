import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, useLocation } from "react-router";
import type { ReactElement } from "react";

import { server } from "@/test/setup";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { AppHeader, SettingsGear } from "./app-header";
import { StatusBadge } from "./status-badge";
import { CONNECTION_LOST_MS, TROUBLE_MS } from "@/hooks/use-connection-lost";
import { __resetConnectionHealth, isLostLatched } from "@/lib/connection-health";
import { PackProvider } from "./pack-provider";
import type { ServerSummary } from "@/lib/types";

// AppHeader mounts CollieHome (a button) and, via SettingsGear, useNavigate — so it needs a router.
function renderHeader(ui: ReactElement) {
  return render(ui, { wrapper: MemoryRouter });
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

describe("AppHeader — the one shared header shell", () => {
  beforeEach(() => __resetConnectionHealth());

  it("is calm in the PANE variant while live — breadcrumb + status badge, no pill, no wordmark", () => {
    // Connection copy lives in the top ConnectionBanner now; the header carries none. A healthy pane
    // header shows its own bits and a resting (static) Collie mark.
    const { container } = renderHeader(
      <AppHeader
        bridge="connected"
        error={false}
        onHome={() => {}}
        rightLead={<StatusBadge status="working" />}
      >
        <span>webapp › main</span>
      </AppHeader>,
    );
    expect(screen.queryByRole("status")).toBeNull(); // no connection pill of any kind
    expect(container.querySelector(".dog-gallop")).toBeNull(); // mark at rest (static icon)
    expect(screen.getByText("webapp › main")).toBeInTheDocument(); // the breadcrumb slot
    expect(screen.getByText("working")).toBeInTheDocument(); // the agent status badge
    expect(screen.queryByText("Collie")).toBeNull(); // no wordmark in a pane
  });

  it("is calm in the DASHBOARD variant while live — wordmark + settings gear, resting mark", () => {
    const { container } = renderHeader(
      <AppHeader bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
    );
    expect(screen.getByText("Collie")).toBeInTheDocument(); // wordmark
    expect(container.querySelector(".dog-gallop")).toBeNull(); // mark at rest while live
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("returns to the dashboard via onHome when the Collie mark is tapped", async () => {
    const onHome = vi.fn();
    renderHeader(<AppHeader bridge="connected" error={false} onHome={onHome} wordmark />);
    await userEvent.click(screen.getByRole("button", { name: "Collie home" }));
    expect(onHome).toHaveBeenCalledOnce();
  });

  it("navigates to a session-scoped /settings via the shared gear", async () => {
    render(
      <MemoryRouter initialEntries={["/?s=collie-demo"]}>
        <AppHeader
          bridge="connected"
          error={false}
          rightTrail={<SettingsGear scope={{ session: "collie-demo" }} />}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("loc").textContent).toBe("/settings?s=collie-demo");
  });

  it("the find-bar override takes over the whole row (mark and breadcrumb yield)", () => {
    // `error` → not live, so the mark would react — proving the override replaces the row entirely.
    renderHeader(
      <AppHeader
        bridge="connected"
        error
        onHome={() => {}}
        rightLead={<StatusBadge status="working" />}
        override={<div>FINDBAR</div>}
      >
        <span>webapp › main</span>
      </AppHeader>,
    );
    // The override owns the row while searching — the normal content is replaced, not stacked.
    expect(screen.getByText("FINDBAR")).toBeInTheDocument();
    expect(screen.queryByText("webapp › main")).toBeNull();
    expect(screen.queryByRole("button", { name: "Collie home" })).toBeNull();
  });
});

// The header dog agrees with the ConnectionBanner by construction — it reads the SAME shared-clock
// signals: it gallops only once trouble is sustained (≥4s, the flicker fix), and rests muted once lost
// (≥15s). Fake timers drive the wall-clock hooks (Vitest advances Date.now with them).
describe("AppHeader — the dog keys on trouble/lost, not the first not-live frame", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetConnectionHealth(); // anchor == frozen clock, so the thresholds land exactly
  });
  afterEach(() => vi.useRealTimers());

  it("stays a static icon during a brief not-live spell, gallops at 4s, rests muted at 15s", () => {
    const { container } = renderHeader(<AppHeader bridge="connected" error onHome={() => {}} />);
    // A single not-live frame is NOT trouble yet: the mark stays the static, full-color icon.
    expect(container.querySelector(".dog-gallop")).toBeNull();
    expect(container.querySelector("img")).toHaveAttribute("src", "/favicon.svg");
    expect(container.querySelector("img")?.className ?? "").not.toMatch(/grayscale/);

    // Sustained trouble (4s) → the dog gallops (agreeing with the amber bar).
    act(() => vi.advanceTimersByTime(TROUBLE_MS));
    expect(container.querySelector(".dog-gallop")).toHaveClass("dog-gallop--running");

    // Escalated to lost (15s) → the gallop stops and the mark rests on the muted static icon.
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - TROUBLE_MS));
    expect(container.querySelector(".dog-gallop")).toBeNull();
    expect(container.querySelector("img")?.className ?? "").toMatch(/grayscale/);
  });
});

// The header dog and the ConnectionBanner read ONE anchor (lib/connection-health.ts), which is why
// they can never disagree — and why a pack member going quiet must not reach it. The dog is asserted
// alongside the banner deliberately: they escalate together, so a mistake here would be wrong twice.
describe("AppHeader — a quiet pack member is not the phone's connection", () => {
  beforeEach(() => __resetConnectionHealth());

  it("stays at rest with an unreachable peer in the roster and a healthy lead", () => {
    const roster: ServerSummary[] = [
      { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 100_000 },
      { id: "workshop", name: "workshop", isLead: false, reachable: false, protocol: "ok", lastSeenAt: 1_000 },
    ];
    const { container } = renderHeader(
      <PackProvider servers={roster} ts={100_000} pollMs={1500}>
        <AppHeader bridge="connected" error={false} wordmark />
      </PackProvider>,
    );
    // Nothing about a peer feeds `isConnecting`, so: no gallop, no pill, no escalation.
    expect(container.querySelector(".dog-gallop")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(isLostLatched()).toBe(false);
  });
});

// "Collie on <mux>" — the header says what this collie drives, and the name arrives as DATA on the
// one /api/config read. The fabricated name below is not any real multiplexer's, deliberately: it is
// the standing proof that the line is PRINTED rather than recognised. A component that had learned a
// name — a lookup table, a branch, a per-mux glyph — could not render this one at all.
describe("AppHeader — the multiplexer line", () => {
  beforeEach(() => {
    __resetConnectionHealth();
    __resetOperatorCommands(); // the store caches one read for the life of a page; each case is a page
  });
  afterEach(() => __resetOperatorCommands());

  it("names whatever the bridge published, beside the wordmark", async () => {
    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          push: false,
          vapidPublicKey: "",
          mux: { name: "reference", capabilities: {}, unsupportedKeys: [], notes: {} },
        }),
      ),
    );
    renderHeader(<AppHeader bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />);
    await waitFor(() => expect(screen.getByText("on reference")).toBeInTheDocument());
    expect(screen.getByText("Collie")).toBeInTheDocument(); // the wordmark it completes, still there
  });

  it("says nothing extra when the bridge published no mux block", async () => {
    // The default handler is that bridge — older than the field, or a cached page. The header is
    // exactly the one it has always been: no line, and no "on unknown" placeholder standing in.
    renderHeader(<AppHeader bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />);
    await waitFor(() => expect(screen.getByText("Collie")).toBeInTheDocument());
    expect(screen.queryByText(/^on /)).toBeNull();
  });

  it("keeps the line out of the pane header, where the breadcrumb owns the width", async () => {
    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          push: false,
          vapidPublicKey: "",
          mux: { name: "reference", capabilities: {}, unsupportedKeys: [], notes: {} },
        }),
      ),
    );
    renderHeader(
      <AppHeader bridge="connected" error={false} onHome={() => {}}>
        <span>webapp › main</span>
      </AppHeader>,
    );
    await waitFor(() => expect(screen.getByText("webapp › main")).toBeInTheDocument());
    expect(screen.queryByText("on reference")).toBeNull();
  });
});
