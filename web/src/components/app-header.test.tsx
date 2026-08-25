import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import type { ReactElement } from "react";

import { server } from "@/test/setup";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { AppHeader, SettingsGear } from "./app-header";
import { StatusBadge } from "./status-badge";
import { CONNECTION_LOST_MS, TROUBLE_MS } from "@/hooks/use-connection-lost";
import { __resetConnectionHealth, isLostLatched } from "@/lib/connection-health";
import { PackProvider } from "./pack-provider";
import type { MuxTopologyLatency, ServerSummary } from "@/lib/types";

// AppHeader mounts CollieHome (a button) and, via SettingsGear, useNavigate — so it needs a router.
// It ALSO reads the root snapshot's `ts` for the freshness line, which is a DATA router hook, so the
// shell is a `createMemoryRouter` with the real root route id. No loader by default: a route without
// one initialises synchronously (so every case below keeps its synchronous assertions) and hands the
// header `undefined` data, which is exactly the state a header mounts in before the first snapshot.
function renderHeader(ui: ReactElement) {
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", element: ui }], {
    initialEntries: ["/"],
  });
  return render(<RouterProvider router={router} />);
}

/** The same shell, with a root snapshot stamped `ts` — the freshness line's only source of a number. */
function renderHeaderWithSnapshot(ui: ReactElement, ts: number) {
  const router = createMemoryRouter(
    [{ id: ROOT_ROUTE_ID, path: "/", loader: () => ({ ts }), element: ui }],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
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
    const router = createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          element: (
            <AppHeader
              bridge="connected"
              error={false}
              rightTrail={<SettingsGear scope={{ session: "collie-demo" }} />}
            />
          ),
        },
        // The gear's destination, so the navigation resolves to a route that reports where it landed.
        { path: "/settings", element: <LocationProbe /> },
      ],
      { initialEntries: ["/?s=collie-demo"] },
    );
    render(<RouterProvider router={router} />);
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

  // The mark beside the name comes from the bridge as a URL and is PRINTED into a `src` — the same
  // property the fabricated name above proves for the word. A component that picked a picture per
  // multiplexer could not render this one, and would render nothing for the next adapter.
  it("shows the published mark before the name, decorative to a screen reader", async () => {
    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          push: false,
          vapidPublicKey: "",
          mux: {
            name: "reference",
            capabilities: {},
            unsupportedKeys: [],
            notes: {},
            logoUrl: "/api/mux/logo.svg",
          },
        }),
      ),
    );
    const { container } = renderHeader(
      <AppHeader bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
    );
    await waitFor(() => expect(screen.getByText("on reference")).toBeInTheDocument());
    const logo = container.querySelector('img[src="/api/mux/logo.svg"]');
    expect(logo).not.toBeNull();
    // alt="" — the name is right there in the same sentence; announcing the picture too would say
    // the multiplexer twice.
    expect(logo?.getAttribute("alt")).toBe("");
  });

  it("renders no image when the bridge published a name but no mark", async () => {
    // An adapter with no logo, or a bridge older than the field. The line is exactly the text it
    // has always been — never a house glyph standing in for a mark nobody supplied.
    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          push: false,
          vapidPublicKey: "",
          mux: { name: "reference", capabilities: {}, unsupportedKeys: [], notes: {} },
        }),
      ),
    );
    const { container } = renderHeader(
      <AppHeader bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
    );
    await waitFor(() => expect(screen.getByText("on reference")).toBeInTheDocument());
    expect(container.querySelector('img[src*="logo"]')).toBeNull();
  });

  it("keeps the mux line out of the pane header, where the breadcrumb owns the width", async () => {
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

// THE CHROME IS ONE HEIGHT. The freshness line used to be a row the DASHBOARD rendered under the
// header while a space rendered its own, different-height row there — so every home ⇄ space
// navigation jumped the page. It lives in the header now, and these cases pin the two properties
// that make that stick: it is INSIDE the header element (no route can put it anywhere else), and the
// header's height-bearing structure is byte-identical whether it prints or not.
describe("AppHeader — the freshness line is chrome, and never changes the chrome's height", () => {
  beforeEach(() => {
    __resetConnectionHealth();
    __resetOperatorCommands();
  });
  afterEach(() => __resetOperatorCommands());

  function declaresLatency(latency: MuxTopologyLatency): void {
    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          push: false,
          vapidPublicKey: "",
          mux: {
            name: "reference",
            capabilities: {},
            unsupportedKeys: [],
            notes: {},
            topologyLatency: latency,
          },
        }),
      ),
    );
  }

  /** The header's height-bearing structure: the bar's own classes and its row's, plus the row count. */
  function headerGeometry(container: HTMLElement): string {
    const header = container.querySelector("header")!;
    const rows = [...header.children].map((el) => el.className);
    return `${header.className}||${rows.join("|")}`;
  }

  it("prints the age INSIDE the header under a bounded declaration", async () => {
    declaresLatency({ kind: "bounded", ms: 12_000 });
    const { container } = renderHeaderWithSnapshot(
      <AppHeader bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
      Date.now() - 4000,
    );
    const age = await screen.findByText(/synced 4s ago/i);
    // Not "somewhere on the page" — in the bar itself, which is the whole point of the move.
    expect(age.closest("header")).toBe(container.querySelector("header"));
  });

  it("keeps the same header geometry whether the line prints or renders nothing", async () => {
    declaresLatency({ kind: "bounded", ms: 12_000 });
    const bounded = renderHeaderWithSnapshot(
      <AppHeader bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
      Date.now() - 4000,
    );
    await screen.findByText(/synced/i);
    const withStamp = headerGeometry(bounded.container);
    bounded.unmount();

    __resetOperatorCommands();
    declaresLatency({ kind: "push" });
    const pushing = renderHeaderWithSnapshot(
      <AppHeader bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
      Date.now() - 4000,
    );
    await screen.findByText("Collie");
    await waitFor(() => expect(screen.queryByText(/synced/i)).toBeNull());
    // Same bar, same single row, same classes — the line rides inside that row or not at all, so
    // nothing about the geometry can differ between a bounded multiplexer and a pushing one.
    expect(headerGeometry(pushing.container)).toBe(withStamp);
  });

  it("carries the line on every route, because the header does — a pane header shows it too", async () => {
    declaresLatency({ kind: "bounded", ms: 12_000 });
    const { container } = renderHeaderWithSnapshot(
      <AppHeader bridge="connected" error={false} onHome={() => {}}>
        <span>webapp › main</span>
      </AppHeader>,
      Date.now() - 9000,
    );
    const age = await screen.findByText(/synced 9s ago/i);
    expect(age.closest("header")).toBe(container.querySelector("header"));
  });

  it("says nothing at all with no snapshot yet — the header is the one it has always been", async () => {
    declaresLatency({ kind: "bounded", ms: 12_000 });
    renderHeader(<AppHeader bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />);
    await screen.findByText("Collie");
    await waitFor(() => expect(screen.queryByText(/synced/i)).toBeNull());
  });
});
