import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router";
import type { ComponentProps, ReactElement } from "react";

import { server } from "@/test/setup";
import { collieMark, markIsLive, markPaper } from "@/test/collie-mark";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { AppHeaderHost, RouteHeader, SettingsGear } from "./app-header";
import { StatusBadge } from "./status-badge";
import { CONNECTION_LOST_MS, TROUBLE_MS } from "@/hooks/use-connection-lost";
import { __resetConnectionHealth, isLostLatched } from "@/lib/connection-health";
import { PackProvider } from "./pack-provider";
import type { BridgeStatus, ServerSummary } from "@/lib/types";

// The header shell mounts CollieHome (a button) and, via SettingsGear, useNavigate — so it needs a router.
// A `createMemoryRouter` with the real root route id, no loader: the route initialises synchronously
// so every case below keeps its synchronous assertions.
function renderHeader(ui: ReactElement) {
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", element: ui }], {
    initialEntries: ["/"],
  });
  return render(<RouterProvider router={router} />);
}

// THE HEADER IS ONE SHELL ABOVE THE OUTLET NOW (app-header.tsx). A case therefore mounts the pair
// RootLayout mounts: the HOST, which owns the <header> element, the strip, the row's floor and the
// Collie mark, wrapped around the route's own contribution, which portals its items into it. Held
// together here so every case below reads as the single component it used to be — what changed is
// where the shell lives, not what the header is.
function Header({
  bridge,
  error,
  ...route
}: { bridge: BridgeStatus | undefined; error: boolean } & ComponentProps<typeof RouteHeader>) {
  return (
    <AppHeaderHost bridge={bridge} error={error}>
      <RouteHeader {...route} />
    </AppHeaderHost>
  );
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

describe("the header — the one shared shell", () => {
  beforeEach(() => __resetConnectionHealth());

  it("is calm in the PANE variant while live — breadcrumb + status badge, no pill, no wordmark", () => {
    // Connection copy lives in the top ConnectionBanner now; the header carries none. A healthy pane
    // header shows its own bits and a resting (static) Collie mark.
    const { container } = renderHeader(
      <Header
        bridge="connected"
        error={false}
        onHome={() => {}}
        rightLead={<StatusBadge status="working" />}
      >
        <span>webapp › main</span>
      </Header>,
    );
    expect(screen.queryByRole("status")).toBeNull(); // no connection pill of any kind
    expect(container.querySelector(".dog-gallop")).toBeNull(); // mark at rest (static icon)
    expect(screen.getByText("webapp › main")).toBeInTheDocument(); // the breadcrumb slot
    expect(screen.getByText("working")).toBeInTheDocument(); // the agent status badge
    expect(screen.queryByText("Collie")).toBeNull(); // no brand line in a pane
    // …and no identity block at all, not an empty one: the pane's width belongs to the breadcrumb.
    expect(container.querySelector('[data-slot="header-identity"]')).toBeNull();
  });

  it("is calm in the DASHBOARD variant while live — identity + settings gear, resting mark", () => {
    const { container } = renderHeader(
      <Header bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
    );
    expect(screen.getByText("Collie")).toBeInTheDocument(); // the identity's brand line
    expect(container.querySelector(".dog-gallop")).toBeNull(); // mark at rest while live
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("knocks the mark out in the SAME paper the header is filled with", () => {
    // THE COUPLING. The mark makes "in front" by cutting the head away behind a near-side bead and
    // filling the cut with the page colour — that fill is CollieHome's `paper` prop. It is not a
    // colour the mark picks; it is a claim about what the mark is sitting on. Change the header's
    // background and forget `paper` and every near-side bead gets a halo in the old ground, which
    // is a subtle enough failure to survive a screenshot review. So it is asserted mechanically:
    // read the background utility off the <header> element, read the custom property off the mark,
    // and require that they name the same token. Either edit alone fails this test.
    const { container } = renderHeader(
      <Header bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
    );
    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    const fill = /(?:^|\s)bg-([a-z][a-z-]*)(?:\/\d+)?(?=\s|$)/.exec(header?.className ?? "");
    // A bare token, no `/opacity`: chrome is the page colour outright, never a wash over content.
    expect(fill?.[0].trim()).toBe("bg-background");
    expect(markPaper(container)).toBe(`var(--${fill?.[1]})`);
  });

  it("states the row's own height instead of inheriting it from whatever a caller passed", () => {
    // THE SHIFT BUG. This row used to be `flex items-center … py-2` with no height of its own, so it
    // took the height of its tallest CHILD — and the children are props. On the dashboard the tallest
    // was the 44px SettingsGear (row 60px); inside a pane there is no gear, so the 40px Collie mark
    // won (row 56px), and every dashboard→pane navigation jumped the header 4px. A row whose height
    // is decided by its props cannot be stable, so the floor is stated on the row itself. Asserted
    // two ways: the floor is there, and the two variants produce the SAME row.
    const dash = renderHeader(
      <Header bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
    );
    const pane = renderHeader(
      <Header bridge="connected" error={false} onHome={() => {}}>
        <span>webapp › main</span>
      </Header>,
    );
    const rowOf = (c: HTMLElement) => c.querySelector('header [data-slot="header-row"]')?.className ?? "";
    // min-h, not h: a child taller than the floor must still grow the row rather than be clipped.
    expect(rowOf(dash.container)).toContain("min-h-15");
    expect(rowOf(dash.container)).not.toMatch(/(^|\s)h-\d/);
    // Same row, whatever the caller handed in — the geometry is the shell's, not the route's.
    expect(rowOf(pane.container)).toBe(rowOf(dash.container));
  });

  it("gives the Collie mark the same 44px tap box every other control in the row has", () => {
    // The mark is a BUTTON (it navigates home), so it owes the same tap floor as the gear beside it.
    // It was `size-10` — 40px, under the target, and the reason the pane header was the short one.
    // Coupled deliberately: read the size utility off both boxes and require one number, so shrinking
    // either one fails here rather than on a phone.
    const { container } = renderHeader(
      <Header bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
    );
    const size = (el: Element | null | undefined) =>
      /(?:^|\s)size-(\d+)(?=\s|$)/.exec(el?.className ?? "")?.[1];
    const markBox = container.querySelector('button[aria-label^="Collie"] > span');
    const gear = screen.getByRole("button", { name: "Settings" });
    expect(size(markBox)).toBe("11"); // 44px
    expect(size(markBox)).toBe(size(gear));
  });

  it("returns to the dashboard via onHome when the Collie mark is tapped", async () => {
    const onHome = vi.fn();
    renderHeader(<Header bridge="connected" error={false} onHome={onHome} wordmark />);
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
            <Header
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
      <Header
        bridge="connected"
        error
        onHome={() => {}}
        rightLead={<StatusBadge status="working" />}
        override={<div>FINDBAR</div>}
      >
        <span>webapp › main</span>
      </Header>,
    );
    // The override owns the row while searching — the normal content is replaced, not stacked.
    expect(screen.getByText("FINDBAR")).toBeInTheDocument();
    expect(screen.queryByText("webapp › main")).toBeNull();
    expect(screen.queryByRole("button", { name: "Collie home" })).toBeNull();
  });
});

// The header mark agrees with the ConnectionBanner by construction — it reads the SAME shared-clock
// signals: it gallops only once trouble is sustained (≥4s, the flicker fix), and rests muted once lost
// (≥15s). Fake timers drive the wall-clock hooks (Vitest advances Date.now with them).
describe("the header — the dog keys on trouble/lost, not the first not-live frame", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetConnectionHealth(); // anchor == frozen clock, so the thresholds land exactly
  });
  afterEach(() => vi.useRealTimers());

  it("rests during a brief not-live spell, blooms at 4s, rests muted at 15s", () => {
    const { container } = renderHeader(<Header bridge="connected" error onHome={() => {}} />);
    // A single not-live frame is NOT trouble yet: the orbit stays still, full colour.
    expect(markIsLive(container)).toBe(false);
    expect(collieMark(container)?.getAttribute("class") ?? "").not.toMatch(/grayscale/);

    // Sustained trouble (4s) → the mark blooms (agreeing with the amber bar).
    act(() => vi.advanceTimersByTime(TROUBLE_MS));
    expect(markIsLive(container)).toBe(true);

    // Escalated to lost (15s) → the bloom stops, the orbit stills again and the mark is muted.
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - TROUBLE_MS));
    expect(markIsLive(container)).toBe(false);
    expect(collieMark(container)?.getAttribute("class") ?? "").toMatch(/grayscale/);
  });
});

// The header dog and the ConnectionBanner read ONE anchor (lib/connection-health.ts), which is why
// they can never disagree — and why a pack member going quiet must not reach it. The dog is asserted
// alongside the banner deliberately: they escalate together, so a mistake here would be wrong twice.
describe("the header — a quiet pack member is not the phone's connection", () => {
  beforeEach(() => __resetConnectionHealth());

  it("stays at rest with an unreachable peer in the roster and a healthy lead", () => {
    const roster: ServerSummary[] = [
      { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 100_000 },
      { id: "workshop", name: "workshop", isLead: false, reachable: false, protocol: "ok", lastSeenAt: 1_000 },
    ];
    const { container } = renderHeader(
      <PackProvider servers={roster} ts={100_000} pollMs={1500}>
        <Header bridge="connected" error={false} wordmark />
      </PackProvider>,
    );
    // Nothing about a peer feeds `isConnecting`, so: no gallop, no pill, no escalation.
    expect(container.querySelector(".dog-gallop")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(isLostLatched()).toBe(false);
  });
});

// "Collie" over "on <mux>" — the header says what this collie drives, and the name arrives as DATA
// on the one /api/config read. The fabricated name below is not any real multiplexer's, deliberately:
// it is the standing proof that the line is PRINTED rather than recognised. A component that had
// learned a name — a lookup table, a branch, a per-mux glyph — could not render this one at all.
//
// The block is TWO STACKED LINES, not one 18px sentence: on a phone the single line ran out of room
// inside the multiplexer's own name. The structure cases below pin the shape that fixed it.
describe("the header — the stacked identity", () => {
  beforeEach(() => {
    __resetConnectionHealth();
    __resetOperatorCommands(); // the store caches one read for the life of a page; each case is a page
  });
  afterEach(() => __resetOperatorCommands());

  it("names whatever the bridge published, under the brand line", async () => {
    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          push: false,
          vapidPublicKey: "",
          mux: { name: "reference", capabilities: {}, unsupportedKeys: [], notes: {} },
        }),
      ),
    );
    renderHeader(<Header bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />);
    await waitFor(() => expect(screen.getByText("on reference")).toBeInTheDocument());
    expect(screen.getByText("Collie")).toBeInTheDocument(); // the brand line it completes, still there
  });

  it("says nothing extra when the bridge published no mux block", async () => {
    // The default handler is that bridge — older than the field, or a cached page. The header is
    // exactly the one it has always been: no line, and no "on unknown" placeholder standing in.
    renderHeader(<Header bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />);
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
      <Header bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
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
      <Header bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
    );
    await waitFor(() => expect(screen.getByText("on reference")).toBeInTheDocument());
    expect(container.querySelector('img[src*="logo"]')).toBeNull();
  });

  // THE SHAPE, AND THE BROWSER FACT UNDER IT. The two runs used to share one line, so the brand's
  // ~55px came out of the multiplexer name's budget and the name was what got the ellipsis — the
  // operator's screenshot had it down to a single letter. Stacked, they no longer compete: a flex
  // COLUMN's max-content width is its WIDEST child's, so the 11px brand line can neither raise nor
  // lower the width this block asks the row for. That measurement is the mux line's alone, and the
  // brand — the shorter run inside a box the longer run sized — is what clips first if anything
  // does. Pinned as classes because that is where the fact lives: `flex-col` is the inversion,
  // `min-w-0` is what lets the block shrink instead of pushing the gear off the row, and `truncate`
  // on BOTH lines is the promise that neither overflows it.
  it("stacks the brand over the multiplexer instead of racing it for one line's width", async () => {
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
      <Header bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
    );
    await waitFor(() => expect(screen.getByText("on reference")).toBeInTheDocument());
    const block = container.querySelector<HTMLElement>('[data-slot="header-identity"]');
    expect(block).not.toBeNull();
    expect(block?.className).toContain("flex-col");
    expect(block?.className).toContain("min-w-0");
    const [brand, muxLine] = Array.from(block?.children ?? []);
    expect(brand?.textContent).toBe("Collie"); // the brand is the TOP line
    expect(muxLine?.textContent).toBe("on reference");
    expect(brand?.className).toContain("truncate");
    expect(muxLine?.className).toContain("truncate");
  });

  // THE HEIGHT CONTRACT, which the stack had to fit inside rather than grow (DESIGN.md §2, §6).
  // The row is `min-h-15` — 60px — with `py-1`, so its content box is 52px and its tallest child is
  // the mark's 44px tap box. The brand line is an arbitrary 11px and therefore takes the inherited
  // 1.5 body leading: a 16.5px line box. The mux line is `text-base` — 16px on a 24px line box.
  // 16.5 + 24 = 40.5px, under the mark's 44px, so the block is NOT the tallest child and the row
  // still measures 60px on every route. jsdom lays nothing out, so what is asserted is the two
  // sizes that arithmetic is made of: raise either tier and this fails, which is the point — the
  // number has to be re-measured before the row is allowed to grow.
  it("spends the two lines inside the row's existing 60px floor", async () => {
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
      <Header bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
    );
    await waitFor(() => expect(screen.getByText("on reference")).toBeInTheDocument());
    const block = container.querySelector<HTMLElement>('[data-slot="header-identity"]');
    const [brand, muxLine] = Array.from(block?.children ?? []);
    expect(brand?.className).toContain("text-[11px]"); // 16.5px line box
    expect(muxLine?.className).toContain("text-base"); // 24px line box
    const row = container.querySelector('header [data-slot="header-row"]');
    expect(row?.className).toContain("min-h-15");
    expect(row?.className).not.toMatch(/(^|\s)h-\d/);
  });

  // A box with no line box inside it is 0px tall, so an absent name would let the brand line jump
  // 24px upward the moment /api/config landed — content moved by a state, which DESIGN.md §2 forbids
  // and which is exactly what `ui/one-of.tsx` reserves a slot for elsewhere. The mux line keeps its
  // slot while it has nothing to say.
  it("reserves the multiplexer's line before any name has arrived", async () => {
    // The default handler publishes no mux block — an old bridge, or a read still in flight.
    const { container } = renderHeader(
      <Header bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
    );
    await waitFor(() => expect(screen.getByText("Collie")).toBeInTheDocument());
    const block = container.querySelector<HTMLElement>('[data-slot="header-identity"]');
    const [, muxLine] = Array.from(block?.children ?? []);
    expect(muxLine?.textContent).toBe(""); // no "on unknown" placeholder
    expect(muxLine?.className).toContain("min-h-6"); // 24px, held open anyway
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
      <Header bridge="connected" error={false} onHome={() => {}}>
        <span>webapp › main</span>
      </Header>,
    );
    await waitFor(() => expect(screen.getByText("webapp › main")).toBeInTheDocument());
    expect(screen.queryByText("on reference")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE HOIST. The header used to be rendered by each of the six routes, which meant it lived inside
// `<Outlet/>` and therefore unmounted and remounted on every navigation — and the Collie mark is 37
// CSS animations on seven orbiting beads at durations from 17.8s to 48s, every one of which restarts
// at zero on a remount. Measured against the live bridge before this change: the orbit clock read
// 31598.7ms on the dashboard and 16.6ms one frame after opening a pane. It is one shell above the
// outlet now, so the assertions below are all about IDENTITY — the same DOM node, not an equal one.
// A per-route header passes every content assertion in this file and fails every one of these.
function HoistedRoute({ name, ...header }: { name: string } & ComponentProps<typeof RouteHeader>) {
  return (
    <>
      <RouteHeader {...header} />
      {/* The route's own body, so "above the outlet" can be asserted as document order rather than
          assumed from where the JSX sits. */}
      <div data-testid={`body-${name}`} />
    </>
  );
}

// THREE DISTINCT COMPONENT TYPES, and that detail is the whole test. React reconciles a subtree when
// the element TYPE is unchanged, so a harness that renders one shared route component at every path
// keeps the DOM alive across a navigation all by itself — and a per-route header would then pass
// every identity assertion below while the real app, whose six routes are six different components,
// remounts on every hop. Verified: with one shared type these cases pass even with the header put
// back inside the routes. With these three they do not.
const DashRoute = () => (
  <HoistedRoute name="dash" wordmark width="column" rightTrail={<SettingsGear />} />
);
const PaneRoute = () => (
  <HoistedRoute name="pane" onHome={() => {}}>
    <span>webapp › main</span>
  </HoistedRoute>
);
const SettingsLikeRoute = () => (
  <HoistedRoute name="settings" width="column" override={<button type="button">Back</button>} />
);

function renderHoisted(initialEntry = "/") {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        // RootLayout's exact shape: the host WRAPS the outlet, so a route cannot mount without it.
        element: (
          <AppHeaderHost bridge="connected" error={false}>
            <Outlet />
          </AppHeaderHost>
        ),
        children: [
          { index: true, element: <DashRoute /> },
          { path: "pane", element: <PaneRoute /> },
          { path: "settings", element: <SettingsLikeRoute /> },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  const utils = render(<RouterProvider router={router} />);
  const go = async (to: string) => {
    await act(async () => {
      await router.navigate(to);
    });
  };
  return { ...utils, router, go };
}

describe("the ONE header — hoisted above the outlet", () => {
  beforeEach(() => __resetConnectionHealth());

  it("mounts one header, above the outlet, and a navigation does not remount it", async () => {
    const { container, go } = renderHoisted();
    const header = container.querySelector("header");
    const mark = collieMark(container);
    expect(header).not.toBeNull();
    expect(mark).not.toBeNull();
    // Above the outlet, structurally: the route's body is a SIBLING that follows it, never a child.
    const body = screen.getByTestId("body-dash");
    expect(header?.contains(body)).toBe(false);
    expect(header?.compareDocumentPosition(body)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await go("/pane");
    expect(screen.getByTestId("body-pane")).toBeInTheDocument(); // we really did navigate
    // THE ASSERTION. Not "a header is present" — the SAME header element, and the same drawing
    // inside it. Identity is the only thing that carries a CSS animation's phase across a route
    // change, and it is the only thing a per-route header cannot produce.
    expect(container.querySelector("header")).toBe(header);
    expect(collieMark(container)).toBe(mark);

    await go("/"); // and back again — the round trip, which is the shape the operator navigates in
    expect(container.querySelector("header")).toBe(header);
    expect(collieMark(container)).toBe(mark);
  });

  // THE ONE PLACE THE PHASE STILL RESETS, stated rather than left to be discovered. A full-row
  // takeover is defined as "the route supplies the row INSTEAD of the mark" — Settings and Pack lead
  // with a back button where the mark stands, and the find bar hands the row to a search field. The
  // mark is not on screen at all there, so it is unmounted, and coming back out mounts a new one at
  // phase zero. That is a smaller thing than the bug this change fixes (the mark WAS on screen on
  // both sides of a dashboard↔pane navigation and still jumped), and the alternative — keeping the
  // mark mounted, `visibility: hidden`, out of flow, animating where nobody can see it — buys phase
  // continuity across two leaf screens with an invisible button and 37 unwatched animations. Not
  // taken. If it ever is, this test is the one that has to change, and its comment is the argument.
  it("still restarts the mark across a full-row takeover, because the mark is not on screen there", async () => {
    const { container, go } = renderHoisted();
    const header = container.querySelector("header");
    const mark = collieMark(container);
    await go("/settings");
    expect(container.querySelector("header")).toBe(header); // the SHELL is still the same one
    expect(collieMark(container)).toBeNull(); // …and the mark is genuinely gone, not hidden
    await go("/");
    expect(container.querySelector("header")).toBe(header);
    expect(collieMark(container)).not.toBe(mark); // a new drawing, at phase zero
  });

  it("mounts the prerelease strip exactly once, however many routes have been visited", async () => {
    // Six routes each mounting the shell meant six AlphaBars over an app's lifetime, one at a time.
    // vitest's define stamps BUILD.version as "0.0.0-test", so the strip is live in every case here.
    const { go } = renderHoisted();
    expect(screen.getAllByText(/TEST/)).toHaveLength(1);
    await go("/pane");
    await go("/settings");
    await go("/");
    expect(screen.getAllByText(/TEST/)).toHaveLength(1);
    expect(document.querySelectorAll("header")).toHaveLength(1);
  });

  it("keeps the row's height recipe byte-identical across a navigation", async () => {
    // jsdom lays nothing out, so "60px" is not measurable here — what IS measurable is that the row
    // is the same element carrying the same class string on every route, which is the property the
    // pixels follow from. (The pixels were measured in a browser: 79.75px of header, dashboard and
    // pane alike, before and after this change.) The floor itself is asserted above, in "states the
    // row's own height instead of inheriting it from whatever a caller passed".
    const { container, go } = renderHoisted();
    const row = container.querySelector<HTMLElement>('[data-slot="header-row"]');
    const recipe = row?.className ?? "";
    expect(recipe).toContain("min-h-15");
    expect(recipe).not.toMatch(/(^|\s)h-\d/);
    for (const to of ["/pane", "/settings", "/"]) {
      await go(to);
      expect(container.querySelector('[data-slot="header-row"]')).toBe(row);
      expect(row?.className).toBe(recipe);
    }
  });

  it("lets each route fill the one row, and hands it back when the route leaves", async () => {
    // The transition frame is what this is really about. React tears the leaving route down before
    // it runs the arriving route's layout effects, so the sequence is release → claim; the shell
    // ignores a release from a route that is no longer the owner, so the reverse order is harmless
    // too. Either way the row must show the ARRIVING route and never a blank or a stale one.
    const { container, go } = renderHoisted();
    // Dashboard: wordmark + gear, no breadcrumb.
    expect(screen.getByText("Collie")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByText("webapp › main")).toBeNull();

    // Pane: the breadcrumb takes the middle, the dashboard's items are gone, the mark stays.
    await go("/pane");
    expect(screen.getByText("webapp › main")).toBeInTheDocument();
    expect(screen.queryByText("Collie")).toBeNull(); // no wordmark inside a pane
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("button", { name: "Collie home" })).toBeInTheDocument();

    // Settings: `override` takes the WHOLE row — mark and breadcrumb both yield, exactly as they did
    // when the takeover was a prop on a per-route header.
    await go("/settings");
    const row = container.querySelector<HTMLElement>('[data-slot="header-row"]');
    expect(row?.contains(screen.getByRole("button", { name: "Back" }))).toBe(true);
    expect(screen.queryByRole("button", { name: "Collie home" })).toBeNull();
    expect(screen.queryByText("webapp › main")).toBeNull();

    // …and back. The row is handed over, not kept: nothing of Settings survives into the dashboard.
    await go("/");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Collie home" })).toBeInTheDocument();
    expect(screen.getByText("Collie")).toBeInTheDocument();
  });

  it("carries the route's own width claim, so a hoisted header is not silently full-bleed", async () => {
    // The header used to live INSIDE each route's content column and inherited its width for free:
    // 640px on the dashboard, Settings and Pack, edge-to-edge in a pane and in history. Measured in
    // a 1280px viewport before this change: `/` gave x=320 w=640, `/pane/…` gave x=0 w=1280. Hoisted,
    // that width has to be STATED or the dashboard's rule silently becomes the viewport's.
    const { container, go } = renderHoisted();
    const header = container.querySelector("header");
    expect(header?.className).toContain("max-w-screen-sm");
    await go("/pane");
    expect(header?.className).not.toContain("max-w-screen-sm");
    await go("/settings");
    expect(header?.className).toContain("max-w-screen-sm");
  });

  it("refuses to render a route header with no host above it", () => {
    // The forgot case, made loud. A route mounted with no header above it is a phone screen with no
    // way home, and a silent fallback would hide exactly the mistake the hoist exists to prevent.
    // (React logs the throw as well; the assertion is on the throw.)
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<RouteHeader wordmark />)).toThrow(/AppHeaderHost/);
    quiet.mockRestore();
  });
});
