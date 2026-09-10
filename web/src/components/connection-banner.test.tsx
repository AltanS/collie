import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { COLLAPSE_MS } from "@/components/ui/collapse";
import { StripHost } from "@/components/ui/strip-host";
import { ConnectionBanner, GREEN_MS } from "./connection-banner";

// THE BAR IS A STRIP, and this file mounts the band it appears in. `ConnectionBanner` registers a
// `StripSlot` and draws nothing where it sits, so a case that rendered it alone would be asserting
// against silence. Two things moved out of this component with the conversion and are therefore no
// longer asserted here: the enter/exit animation (`ui/collapse.tsx` and the host's ghost own it, on
// one duration shared with everything else in flow — hence COLLAPSE_MS below where EXIT_MS used to
// be), and the tint recipe (`ui/notice.tsx`'s one table). What is still this file's is the
// amber→red→green state machine, the probe, and the words.
//
// A ROW IS ADDRESSED BY `data-slot`, NEVER BY `role="status"`. The host keeps two permanent empty
// live regions mounted so a strip appearing is a change inside a region that already existed, and a
// role query matches one of those as readily as the row you meant — DESIGN.md §9.

// Drive the two shared-clock thresholds directly so the amber→red→green STATE MACHINE can be tested
// without burning real seconds; the 4s/15s wall-clock lockstep itself is proven in
// use-connection-lost.test.ts. The mocks ignore their arg and return the staged values.
const h = vi.hoisted(() => ({ trouble: false, lost: false }));
vi.mock("@/hooks/use-connection-lost", () => ({
  useConnectionTrouble: () => h.trouble,
  useConnectionLost: () => h.lost,
}));
vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

// The /api/config probe (red only) — controllable + counted, so we don't lean on MSW timing under fake
// timers. `reachable` false makes fetchConfig throw (bridge unreachable).
const cfg = vi.hoisted(() => ({ reachable: true, calls: 0 }));
vi.mock("@/lib/api", () => ({
  fetchConfig: vi.fn(async () => {
    cfg.calls += 1;
    if (!cfg.reachable) throw new Error("unreachable");
    return { push: false, vapidPublicKey: "" };
  }),
}));

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
}

// A harness whose own state forces the banner to re-render (creating a fresh element so the mocked
// hooks are re-read) — RouterProvider re-rendered with the same static route element would bail out.
let rerenderBanner: () => void = () => {};

function renderBanner(
  props: {
    bridge?: "connected" | "disconnected";
    error?: boolean;
    authError?: boolean;
    lastSeenAt?: number;
  } = {},
) {
  function Harness() {
    const [, setN] = useState(0);
    rerenderBanner = () => setN((n) => n + 1);
    return (
      <ConnectionBanner
        bridge={props.bridge ?? "disconnected"}
        error={props.error ?? false}
        authError={props.authError ?? false}
        lastSeenAt={props.lastSeenAt}
      />
    );
  }
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <StripHost>
          <Harness />
        </StripHost>
      ),
    },
  ]);
  return render(<RouterProvider router={router} />);
}

/** The strip the band is painting, or null when the band holds nothing. */
function row(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="collapse"] [data-slot="notice"]');
}

/** The strip's own live region — the body, where `ui/notice.tsx` puts the role. One attribute or
 *  none: there is no way to ask that component for a role AND an `aria-live`. */
function announced(role: "status" | "alert"): HTMLElement | null {
  return row()?.querySelector<HTMLElement>(`[role="${role}"]`) ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.trouble = false;
  h.lost = false;
  cfg.reachable = true;
  cfg.calls = 0;
  setOnline(true);
});
afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
});

describe("ConnectionBanner — the single connection surface", () => {
  it("shows the auth refusal with Reload and no connection treatment", () => {
    h.trouble = true;
    h.lost = true;
    renderBanner({ authError: true });

    expect(announced("alert")).toHaveTextContent(
      "Access refused. This is not a connection problem.",
    );
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.querySelector(".animate-spin")).toBeNull();
    expect(cfg.calls).toBe(0);
  });

  // The escape hatch for an installed PWA, which has no address bar: a real link to the one path the
  // service worker always passes to the network. It must stay an <a> with a real href — a button
  // with an onClick would be a same-document action the SW never sees as a navigation, which is the
  // whole bug (#31). If this assertion is ever "fixed" by swapping in a Button, the PWA is bricked
  // again behind a refused session and nothing else will fail.
  it("offers a real link to the reserved proxy path, not a click handler", () => {
    renderBanner({ authError: true });

    const signIn = screen.getByRole("link", { name: "Sign in" });
    expect(signIn).toHaveAttribute("href", "/auth/");
  });

  it("renders nothing while healthy — no bar at all", () => {
    renderBanner({ bridge: "connected" });
    expect(row()).toBeNull();
  });

  it("appears amber 'Reconnecting…' on sustained trouble — ambient, no Retry button", () => {
    h.trouble = true;
    renderBanner();
    expect(announced("status")).toHaveTextContent("Reconnecting…");
    expect(row()?.className).toMatch(/bg-status-working/); // amber = checking
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull(); // ambient → no actions
  });

  it("escalates to a red alert with Retry + Reload once lost, naming Herdr when the bridge answers", async () => {
    h.trouble = true;
    h.lost = true;
    cfg.reachable = true; // the config probe succeeds → the bridge is up, so Herdr is the outage
    renderBanner();
    await act(async () => {}); // flush the probe microtask
    expect(row()?.className).toMatch(/bg-status-blocked/); // red = failed
    expect(announced("alert")).toHaveTextContent("Herdr is down on the host");
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
  });

  it("says 'Offline' in red when the probe fails AND the browser reports offline", async () => {
    h.lost = true;
    cfg.reachable = false;
    setOnline(false);
    renderBanner();
    await act(async () => {});
    expect(screen.getByText("Offline — can't reach Collie")).toBeInTheDocument();
    expect(row()?.className).toMatch(/bg-status-blocked/); // offline is always red
  });

  it("says 'Can't reach Collie' when the probe fails but the browser still reports online", async () => {
    h.lost = true;
    cfg.reachable = false;
    setOnline(true);
    renderBanner();
    await act(async () => {});
    expect(screen.getByText("Can't reach Collie")).toBeInTheDocument();
  });

  // A cold boot with the tunnel down re-renders the whole herd from cache, which looks exactly like a
  // live one. The red row is where that gets named.
  it("dates the red row when the data on screen came from the cache", async () => {
    h.lost = true;
    cfg.reachable = false;
    setOnline(true);
    renderBanner({ error: true, lastSeenAt: new Date(2026, 0, 2, 14, 32).getTime() });
    await act(async () => {});
    expect(announced("alert")).toHaveTextContent(/Can't reach Collie — last seen \d/);
  });

  it("leaves the red row undated when nothing can date it", async () => {
    h.lost = true;
    cfg.reachable = false;
    renderBanner({ error: true });
    await act(async () => {});
    expect(announced("alert")).not.toHaveTextContent(/last seen/);
  });

  it("Retry re-probes the bridge", async () => {
    h.lost = true;
    renderBanner();
    await act(async () => {});
    expect(cfg.calls).toBe(1); // probed once when it appeared
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    });
    expect(cfg.calls).toBe(2); // Retry ran a fresh probe
  });

  it("is one crisp, non-wrapping row (text-xs, a single truncating flex-1 copy span)", async () => {
    h.lost = true;
    renderBanner();
    await act(async () => {});
    // The shape is `ui/notice.tsx`'s strip now, and the promise is the same one it always was: ONE
    // truncating, flex-1 span, so no string this component passes can turn the band into two lines.
    expect(row()?.className).toMatch(/text-xs/);
    expect(row()?.className).not.toMatch(/flex-wrap/);
    expect(row()?.querySelector("span.truncate.flex-1")).not.toBeNull();
  });

  it("reserves no safe-area inset of its own — the band above the header does", () => {
    // The reported iOS bug, at one of its three sources. This row set the inset for itself, as did
    // the update ribbon and as did the header, each written when it might have been the first thing
    // on the screen — so any two of them together paid for the notch twice. One owner now, and it is
    // the band, because clearing the notch is a fact about the row's position in the viewport.
    h.trouble = true;
    const { container } = renderBanner();
    expect(row()?.className).not.toMatch(/safe-area/);
    expect(container.querySelectorAll("[class*='safe-area-inset-top']")).toHaveLength(1);
  });

  it("flashes green 'Connected' only after a visible bar recovers, then the band closes over it", () => {
    h.trouble = true;
    renderBanner();
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();

    // Recover: the signals go healthy → because a bar WAS visible, a green confirmation appears.
    h.trouble = false;
    act(() => rerenderBanner());
    expect(announced("status")).toHaveTextContent("Connected");
    expect(row()?.className).toMatch(/bg-status-done/); // green = established

    // It lingers ~1.8s — that duration is still this component's, because how long a confirmation is
    // worth reading is a fact about what the operator is being told. What follows it is not: the
    // slot deregisters and the BAND keeps painting the strip while it closes, on the one collapse
    // duration the whole app moves in flow at.
    act(() => vi.advanceTimersByTime(GREEN_MS));
    expect(screen.getByText("Connected")).toBeInTheDocument(); // still there, collapsing
    act(() => vi.advanceTimersByTime(COLLAPSE_MS + 16));
    expect(screen.queryByText("Connected")).toBeNull();
    expect(row()).toBeNull();
  });

  it("shows nothing on a blip that never reached trouble — green needs a visible bar first", () => {
    renderBanner({ bridge: "connected" });
    // Never troubled → never showed a bar → a later 'recovery' re-render must not flash green.
    act(() => rerenderBanner());
    act(() => vi.advanceTimersByTime(GREEN_MS + COLLAPSE_MS + 16));
    expect(screen.queryByText("Connected")).toBeNull();
    expect(row()).toBeNull();
  });
});
