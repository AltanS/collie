import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { COLLAPSE_MS } from "@/components/ui/collapse";
import { StripHost } from "@/components/ui/strip-host";
import { CrewProvider } from "@/components/crew-provider";
import * as api from "@/lib/api";
import type { ServerSummary } from "@/lib/types";
import { fixtureServers } from "@/test/handlers";
import { markNotPaired } from "@/lib/pairing";
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
// The saved-copy flag, mutable so a case can let the live answer clear it and re-render.
let liveStale = false;

function renderBanner(
  props: {
    bridge?: "connected" | "disconnected";
    host?: string;
    servers?: ServerSummary[];
    error?: boolean;
    authError?: boolean;
    lastSeenAt?: number;
    stale?: boolean;
  } = {},
) {
  liveStale = props.stale ?? false;
  function Harness() {
    const [, setN] = useState(0);
    rerenderBanner = () => setN((n) => n + 1);
    return (
      <ConnectionBanner
        bridge={props.bridge ?? "disconnected"}
        host={props.host}
        error={props.error ?? false}
        authError={props.authError ?? false}
        lastSeenAt={props.lastSeenAt}
        stale={liveStale}
      />
    );
  }
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <CrewProvider servers={props.servers ?? (props.host === undefined ? undefined : fixtureServers)}>
          <StripHost>
            <Harness />
          </StripHost>
        </CrewProvider>
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

  it("escalates to a red alert with Retry and a dismiss, no Reload, naming Herdr when the bridge answers", async () => {
    h.trouble = true;
    h.lost = true;
    cfg.reachable = true; // the config probe succeeds → the bridge is up, so Herdr is the outage
    renderBanner();
    await act(async () => {}); // flush the probe microtask
    expect(row()?.className).toMatch(/bg-status-blocked/); // red = failed
    expect(announced("alert")).toHaveTextContent("Herdr is down on the host");
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reload/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Hide this notice" })).toBeInTheDocument();
  });

  it("does not infer mux failure from a successful config probe after a failed snapshot", async () => {
    h.lost = true;
    renderBanner({ bridge: "connected", error: true });
    await act(async () => {});
    expect(announced("alert")).toHaveTextContent("Can't reach Collie");
  });

  it("does not reuse a cached disconnected mux as evidence during a snapshot failure", async () => {
    h.lost = true;
    renderBanner({ bridge: "disconnected", error: true });
    await act(async () => {});
    expect(announced("alert")).toHaveTextContent("Can't reach Collie");
  });

  it("does not attribute a member outage to the lead's disconnected mux", async () => {
    h.lost = true;
    renderBanner({ host: "workshop", bridge: "disconnected" });
    await act(async () => {});
    expect(announced("alert")).toHaveTextContent("Can't reach Collie");
  });

  it("keeps the lead's mux failure and updates the cause on host switches", async () => {
    h.lost = true;
    const props = { host: "bluefin", bridge: "disconnected" as const };
    renderBanner(props);
    await act(async () => {});
    expect(announced("alert")).toHaveTextContent("Herdr is down on the host");
    props.host = "workshop";
    act(() => rerenderBanner());
    expect(announced("alert")).toHaveTextContent("Can't reach Collie");
    props.host = "bluefin";
    act(() => rerenderBanner());
    expect(announced("alert")).toHaveTextContent("Herdr is down on the host");
  });

  // THE PROBE STAYS UNSCOPED. `/api/config?host=` is answered by the lead from its cache, so a scoped
  // probe would pass for a member that is down and prove nothing; the unscoped one tests the lead.
  it("probes the lead with no host argument, on a member view too", async () => {
    h.lost = true;
    renderBanner({ host: "workshop", bridge: "disconnected" });
    await act(async () => {});
    expect(api.fetchConfig).toHaveBeenCalled();
    expect(vi.mocked(api.fetchConfig).mock.calls.every((call) => call.length === 0)).toBe(true);
  });

  // The lead answers and a member is the fault: the banner names it with the sentences the pane
  // notice and a refused write already use, and only when the lead's own roster says it is down.
  describe("a member the lead reports down", () => {
    const down = (id: string): ServerSummary[] =>
      fixtureServers.map((s) => (s.id === id ? Object.assign({}, s, { reachable: false }) : s));

    it("names an unreachable member, with its own last seen and no second one", async () => {
      h.lost = true;
      renderBanner({ host: "workshop", servers: down("workshop"), bridge: "connected", error: true, lastSeenAt: 5_000 });
      await act(async () => {});
      expect(announced("alert")).toHaveTextContent(/^workshop is unreachable · /);
      expect(announced("alert")).not.toHaveTextContent("Can't reach Collie");
      expect(announced("alert")).not.toHaveTextContent("Herdr is down");
      expect(announced("alert")).not.toHaveTextContent(/last seen \d/);
    });

    it("names an incompatible member, with the lead's protocol detail", async () => {
      h.lost = true;
      renderBanner({ host: "attic", bridge: "connected", error: true });
      await act(async () => {});
      expect(announced("alert")).toHaveTextContent("attic is running an incompatible Collie");
      expect(announced("alert")).toHaveTextContent("crew protocol 2");
    });

    it("keeps the plain copy for a member the lead reports healthy", async () => {
      h.lost = true;
      renderBanner({ host: "workshop", bridge: "connected", error: true });
      await act(async () => {});
      expect(announced("alert")).toHaveTextContent("Can't reach Collie");
      expect(announced("alert")).not.toHaveTextContent("is unreachable");
    });

    it("says nothing about a member when the lead itself does not answer", async () => {
      h.lost = true;
      cfg.reachable = false;
      renderBanner({ host: "workshop", servers: down("workshop"), bridge: "connected", error: true });
      await act(async () => {});
      expect(announced("alert")).toHaveTextContent("Can't reach Collie");
      expect(announced("alert")).not.toHaveTextContent("workshop");
    });

    it("never applies to the lead: a down mux there is still the mux", async () => {
      h.lost = true;
      renderBanner({ host: "bluefin", servers: down("workshop"), bridge: "disconnected" });
      await act(async () => {});
      expect(announced("alert")).toHaveTextContent("Herdr is down on the host");
    });

    it("never applies to a solo install", async () => {
      h.lost = true;
      renderBanner({ bridge: "connected", error: true });
      await act(async () => {});
      expect(announced("alert")).toHaveTextContent("Can't reach Collie");
    });
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

  it("reserves no safe-area inset — the band sits under the header, which owns it", () => {
    // The reported iOS bug, at one of its three sources. This row set the inset for itself, as did
    // the update ribbon and as did the header, each written when it might have been the first thing
    // on the screen — so any two of them together paid for the notch twice. The band paints under
    // the header since 2026-10-07, so the header is the one owner and nothing in the band reserves.
    h.trouble = true;
    const { container } = renderBanner();
    expect(row()).not.toBeNull();
    expect(row()?.className).not.toMatch(/safe-area/);
    expect(container.querySelectorAll("[class*='safe-area-inset-top']")).toHaveLength(0);
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

// ── M46 spec 10: three offline states, told apart in this one banner ─────────────
describe("ConnectionBanner — offline states", () => {
  const SAVED_AT = new Date(2026, 0, 2, 14, 32).getTime();

  it("offline states: the phone is offline, says so at once with the saved time, no escalation wait", () => {
    setOnline(false);
    renderBanner({ error: true, stale: true, lastSeenAt: SAVED_AT });
    expect(row()).toHaveTextContent(/^You are offline\. Showing what was saved at .+\./);
    expect(row()).toHaveTextContent(/14.32|2:32/);
    // Quiet: a saved copy is not an error, so it is announced politely.
    expect(announced("alert")).toBeNull();
    expect(announced("status")).not.toBeNull();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  // M46 pass 3: a VPN keeps `navigator.onLine` true in airplane mode, so "online" is not a fact here.
  // One sentence that guesses no cause, and the places to look on a smaller second line.
  it("offline states: online but the bridge does not answer, says so without guessing a cause", () => {
    setOnline(true);
    renderBanner({ error: true, stale: true, lastSeenAt: SAVED_AT });
    expect(row()).toHaveTextContent(/^No connection to the bridge\. Showing what was saved at .+\./);
    expect(row()).not.toHaveTextContent(/Is Tailscale connected/);
    const hint = row()?.querySelector('[data-slot="connection-hint"]');
    expect(hint).toHaveTextContent("Check your connection or Tailscale.");
    // Smaller and quieter than the sentence above it: advice, not the state.
    expect(hint).toHaveClass("text-[11px]", "text-muted-foreground", "block");
  });

  it("offline states: the phone's own offline sentence carries no hint line", () => {
    setOnline(false);
    renderBanner({ error: true, stale: true, lastSeenAt: SAVED_AT });
    expect(row()?.querySelector('[data-slot="connection-hint"]')).toBeNull();
  });

  // The band is an overlay since 2026-10-07 (`ui/strip-host.tsx`), so a sentence change moves
  // nothing below it and red no longer reserves a height. It is as tall as its words, and Retry
  // still never wraps.
  it.each([
    ["offline, saved", { online: false, stale: true, lastSeenAt: SAVED_AT }],
    ["no bridge, saved", { online: true, stale: true, lastSeenAt: SAVED_AT }],
    ["no bridge, nothing saved", { online: true, stale: false, lastSeenAt: undefined }],
  ])("offline states: no red variant reserves a height (%s)", async (_name, state) => {
    h.lost = true;
    cfg.reachable = false;
    setOnline(state.online);
    renderBanner({ error: true, stale: state.stale, lastSeenAt: state.lastSeenAt });
    await act(async () => {});
    expect(row()).not.toHaveClass("min-h-[72px]");
    expect(row()?.className).not.toMatch(/min-h-\[(?!33px\])/);
    expect(screen.getByRole("button", { name: /retry/i })).toHaveClass("whitespace-nowrap");
  });

  it("offline states: amber keeps the thin strip", () => {
    h.trouble = true;
    renderBanner();
    expect(row()).not.toHaveClass("min-h-[72px]");
  });

  it.each([
    [false, "You are offline. Showing what was saved at"],
    [true, "No connection to the bridge. Showing what was saved at"],
  ])("offline states: the saved-copy sentence reads whole, wrapping instead of truncating (online %s)", (online, lead) => {
    setOnline(online);
    renderBanner({ error: true, stale: true, lastSeenAt: SAVED_AT });
    const sentence = screen.getByText((text) => text.startsWith(lead));
    expect(sentence.textContent).toMatch(/at .+\.$/);
    expect(sentence).not.toHaveClass("truncate");
    // Retry stays beside it, as the compact action at the right.
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("offline states: a device refused for want of pairing shows no connection strip and no saved copy", () => {
    markNotPaired();
    renderBanner({ error: true, stale: true, lastSeenAt: SAVED_AT });
    expect(row()).toBeNull();
    expect(screen.queryByText(/Showing what was saved/)).toBeNull();
  });

  it("offline states: a probe that finds the bridge answering falls back to the named cause", async () => {
    h.lost = true;
    cfg.reachable = true;
    renderBanner({ error: true, stale: true, lastSeenAt: SAVED_AT });
    await act(async () => {});
    expect(row()).not.toHaveTextContent(/No connection to the bridge/);
    expect(row()).toHaveTextContent(/Can't reach Collie — last seen/);
  });

  it("the stale marks clear when the bridge answers: a green flash, then nothing", () => {
    renderBanner({ error: true, stale: true, lastSeenAt: SAVED_AT });
    expect(row()).toHaveTextContent(/Showing what was saved/);
    liveStale = false;
    act(() => rerenderBanner());
    expect(announced("status")).toHaveTextContent("Connected");
    act(() => vi.advanceTimersByTime(GREEN_MS));
    act(() => vi.advanceTimersByTime(COLLAPSE_MS + 16));
    expect(row()).toBeNull();
  });
});

// ── The red strip is dismissable, and has one action ──────────────────────────────
// Phone in airplane mode: two buttons and no way to hide the strip. The strip now carries Retry and a
// ✕, the ✕ hides it for the rest of THIS outage, and the mark's badge (collie-home.tsx) keeps the
// state visible after that.
describe("ConnectionBanner — dismissing the red strip", () => {
  const SAVED_AT = new Date(2026, 0, 2, 14, 32).getTime();
  const dismiss = () => screen.getByRole("button", { name: "Hide this notice" });

  it("has exactly two buttons in red, Retry and the dismiss, and no Reload", async () => {
    h.lost = true;
    renderBanner();
    await act(async () => {});
    const buttons = Array.from(row()?.querySelectorAll("button") ?? []).map(
      (b) => b.getAttribute("aria-label") ?? b.textContent?.trim(),
    );
    expect(buttons).toEqual(["Retry", "Hide this notice"]);
  });

  it("gives amber no dismiss and no action: it is ambient", () => {
    h.trouble = true;
    renderBanner();
    expect(row()?.querySelectorAll("button")).toHaveLength(0);
  });

  it("keeps the auth strip's Sign in and Reload untouched", () => {
    renderBanner({ authError: true });
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide this notice" })).toBeNull();
  });

  it("hides the strip on dismiss, and the band closes over it", async () => {
    h.lost = true;
    renderBanner();
    await act(async () => {});
    expect(row()).not.toBeNull();
    act(() => void fireEvent.click(dismiss()));
    act(() => vi.advanceTimersByTime(COLLAPSE_MS + 16));
    expect(row()).toBeNull();
  });

  it("stays hidden for the rest of the outage, across re-renders and a change of sentence", async () => {
    h.lost = true;
    renderBanner({ error: true, stale: true, lastSeenAt: SAVED_AT });
    await act(async () => {});
    act(() => void fireEvent.click(dismiss()));
    act(() => vi.advanceTimersByTime(COLLAPSE_MS + 16));
    act(() => rerenderBanner());
    cfg.reachable = false;
    act(() => rerenderBanner());
    act(() => vi.advanceTimersByTime(60_000));
    expect(row()).toBeNull();
  });

  it("recovers quietly after a dismiss: no green Connected flash", async () => {
    h.lost = true;
    renderBanner({ error: true, stale: true, lastSeenAt: SAVED_AT });
    await act(async () => {});
    act(() => void fireEvent.click(dismiss()));
    act(() => vi.advanceTimersByTime(COLLAPSE_MS + 16));

    h.lost = false;
    liveStale = false;
    act(() => rerenderBanner());
    expect(screen.queryByText("Connected")).toBeNull();
    act(() => vi.advanceTimersByTime(GREEN_MS + COLLAPSE_MS + 16));
    expect(screen.queryByText("Connected")).toBeNull();
    expect(row()).toBeNull();
  });

  it("shows the strip again on a new outage", async () => {
    h.lost = true;
    renderBanner({ error: true, stale: true, lastSeenAt: SAVED_AT });
    await act(async () => {});
    act(() => void fireEvent.click(dismiss()));
    act(() => vi.advanceTimersByTime(COLLAPSE_MS + 16));

    h.lost = false;
    liveStale = false;
    act(() => rerenderBanner());
    act(() => vi.advanceTimersByTime(GREEN_MS + COLLAPSE_MS + 16));
    expect(row()).toBeNull();

    h.lost = true;
    liveStale = true;
    act(() => rerenderBanner());
    await act(async () => {});
    expect(row()).not.toBeNull();
    expect(announced("alert") ?? row()).toHaveTextContent(/saved|Can't reach|Offline/i);
    expect(dismiss()).toBeInTheDocument();
  });

  it("still flashes green after a recovery that was never dismissed", async () => {
    h.lost = true;
    renderBanner();
    await act(async () => {});
    h.lost = false;
    act(() => rerenderBanner());
    expect(announced("status")).toHaveTextContent("Connected");
  });
});
