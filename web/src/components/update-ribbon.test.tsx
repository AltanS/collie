import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkForUpdate, type UpdateStage } from "@/lib/pwa";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetReloadGuard, holdReload } from "@/lib/reload-guard";
import { __resetSelfUpdate, __setReloadImpl, startSelfUpdate } from "@/lib/self-update";
import { __resetServerBuild, observeServerBuild } from "@/lib/server-build";
import { clearUpdateStarted, noteUpdateStarted } from "@/lib/update-ribbon";
import type { UpdateInfo, UpdatePeerLeg, UpdateRun, UpdateRunState } from "@/lib/types";
import { dismissUpdate } from "@/lib/api";
import { COLLAPSE_MS } from "@/components/ui/collapse";
import { StripHost } from "@/components/ui/strip-host";
import { UpdateRibbon } from "./update-ribbon";

// The ONE update band. The reading behind it is pinned in `lib/update-ribbon.test.ts`; this file is
// about the row that reaches the screen — its words, its tap, its dismiss, and what it does and does
// NOT own now that the band above the header owns the row it appears in.
//
// THE COMPONENT DRAWS NOTHING WHERE IT SITS. It registers a `StripSlot` and `ui/strip-host.tsx`
// paints the winner, so every case here mounts the real host — a ribbon rendered without one is
// silent by design, and asserting against that would be asserting against the wrong thing. What
// used to be pinned as "the band class, byte-identical in every state" is now two facts split
// between two files: the SHAPE is `ui/notice.tsx`'s strip floor (its own tests), and the POSITION,
// the safe-area inset included, is the host's (`ui/strip-host.test.tsx`). What is left here is that
// this feature adds neither.
//
// The bundle states are driven through the REAL self-updater, the way the real poll drives it: a
// build id that is not ours, observed twice (the hysteresis), with or without a reload hold.

// The update STAGE is part of this seam too (2026-09-12): the band reads `lib/pwa.ts`'s own store to
// know a new bundle is downloading. A box rather than a constant, so the one case about the download
// row can set it; `vi.hoisted` because a mock factory may not reach an ordinary module variable.

/**
 * The box the stub reads. Named, so the stage is the module's own type and not a widened string.
 *
 * It carries the real module's SUBSCRIPTION too, not just its value: the band drops the download
 * row on a close and raises it again for the next worker, and "the next worker" is nothing but the
 * stage leaving `installing` and coming back. A no-op subscribe could not express that.
 */
interface StageBox {
  current: UpdateStage;
  listeners: Set<() => void>;
  set: (next: UpdateStage) => void;
}
const pwaStage = vi.hoisted((): StageBox => {
  const listeners = new Set<() => void>();
  const box: StageBox = {
    current: "idle",
    listeners,
    set: (next: UpdateStage) => {
      box.current = next;
      for (const listener of listeners) listener();
    },
  };
  return box;
});
vi.mock("@/lib/pwa", () => ({
  checkForUpdate: vi.fn(),
  getUpdateStage: () => pwaStage.current,
  subscribeUpdateStage: (listener: () => void) => {
    pwaStage.listeners.add(listener);
    return () => pwaStage.listeners.delete(listener);
  },
}));
// The dismiss posts to the bridge (M17/08). What it SENDS is the assertion; the round trip itself is
// the bridge's own test.
vi.mock("@/lib/api", () => ({ dismissUpdate: vi.fn(async () => undefined) }));

// BUILD.id under vitest is "test" (vitest.config `define`). Any other id reads as stale.
const NEWER_BUILD = "1.5.0+new.1";

const run = (state: UpdateRunState, over: Partial<UpdateRun> = {}): UpdateRun => ({
  schema: 1,
  state,
  from: "1.4.1",
  to: "1.5.0",
  startedAt: Date.now() - 40_000,
  updatedAt: Date.now() - 2_000,
  pid: 99,
  attempt: 0,
  ...over,
});

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  current: "1.4.1",
  latest: "1.5.0",
  latestUrl: null,
  releaseAvailable: true,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: Date.now() - 60_000,
  ...over,
});

function homeData(update: UpdateInfo | undefined): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update,
    error: false,
    authError: false,
  };
}

/** The band under a router, plus a stand-in for `/settings/updates` so a navigation is observable. */
async function renderBand(update: UpdateInfo | undefined) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => homeData(update),
        // The real band, the way `routes/root.tsx` mounts it: the feature registers, the host paints.
        element: (
          <StripHost>
            <UpdateRibbon />
          </StripHost>
        ),
      },
      { path: "/settings/updates", element: <div>the updates page</div> },
    ],
    { initialEntries: ["/"] },
  );
  const result = render(<RouterProvider router={router} />);
  // A data router resolves its loader before the element mounts, so the first synchronous paint is
  // empty. Flush it, the way every other data-router test here reaches the rendered route.
  await act(async () => {});
  return result;
}

/** The band's collapsing row. Absent entirely until something has registered at least once. */
function collapse(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-slot="collapse"]');
}

/**
 * The strip on screen, or null when the band holds nothing.
 *
 * Scoped through the collapse and addressed by `data-slot`, NOT by `role="status"` any more: the
 * host keeps two permanent empty live regions (one polite, one assertive) so that a strip appearing
 * is a change inside a region that already existed, and `role="status"` therefore matches one of
 * those as readily as the notice you meant. DESIGN.md §9 states the trap; two workers lost time to
 * it before it was written down.
 */
function band(container: HTMLElement): HTMLElement | null {
  return collapse(container)?.querySelector<HTMLElement>('[data-slot="notice"]') ?? null;
}

/**
 * Let the band finish closing.
 *
 * "Gone" is a later moment than it used to be, and that is the point of the conversion rather than a
 * concession to it: the row's exit belongs to the band now, which keeps painting the last strip
 * while `ui/collapse.tsx` closes over it, so the words the operator just put down slide away instead
 * of blinking out. What happens ON THE TAP is that the band is told to close — asserted directly,
 * as `data-state`.
 */
async function settleBand(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, COLLAPSE_MS + 32));
  });
}

/** Drive the self-updater to CONFIRMED-stale. With a hold it shows a row; without one it reloads. */
function confirmStaleBundle(): void {
  observeServerBuild(NEWER_BUILD);
  observeServerBuild(NEWER_BUILD);
}

let stop: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  pwaStage.current = "idle";
  pwaStage.listeners.clear();
  sessionStorage.clear();
  __resetServerBuild();
  __resetReloadGuard();
  __resetSelfUpdate();
  __setReloadImpl(() => {}); // jsdom's location.reload throws; the real path is asserted separately
  clearUpdateStarted();
  stop = startSelfUpdate();
});
afterEach(() => {
  stop();
  clearUpdateStarted();
});

describe("update ribbon states — the row on screen", () => {
  it("renders nothing at all when there is nothing to say", async () => {
    const { container } = await renderBand(info({ releaseAvailable: false }));
    expect(band(container)).toBeNull();
  });

  it("(a) offers the release and names the version", async () => {
    await renderBand(info());
    expect(screen.getByText("Collie 1.5.0 available.")).toBeInTheDocument();
  });

  it("(b) counts through the three words of a run", async () => {
    await renderBand(info({ run: run("preflight") }));
    expect(screen.getByText("Updating to 1.5.0. Fetching")).toBeInTheDocument();
  });

  it("(b) says Building while staging", async () => {
    await renderBand(info({ run: run("staging") }));
    expect(screen.getByText("Updating to 1.5.0. Building")).toBeInTheDocument();
  });

  it("(c) names the new version once the bundle is behind and a hold is active", async () => {
    holdReload("an-open-composer-draft");
    confirmStaleBundle();
    await renderBand(info({ run: run("done") }));
    expect(screen.getByText("Updated to 1.5.0. Tap to reload.")).toBeInTheDocument();
  });

  it("(d) names a peer that rolled back, with its reason and a pointer to the page", async () => {
    const peers: UpdatePeerLeg[] = [
      { name: "minibuch", state: "rolled-back", reason: "health gate timed out" },
    ];
    await renderBand(info({ run: run("done", { peers }) }));
    expect(
      screen.getByText("Could not update minibuch: health gate timed out. See Updates."),
    ).toBeInTheDocument();
    // No retry on the band: the retry is the Updates page's single action.
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});

describe("starting update — the beat between the confirm and the first status", () => {
  it("shows on the client's own knowledge that it just posted", async () => {
    noteUpdateStarted();
    await renderBand(info());
    expect(screen.getByText("Starting update…")).toBeInTheDocument();
  });

  it("yields as soon as the status object speaks", async () => {
    noteUpdateStarted();
    await renderBand(info({ run: run("staging") }));
    expect(screen.queryByText("Starting update…")).toBeNull();
    expect(screen.getByText("Updating to 1.5.0. Building")).toBeInTheDocument();
  });
});

describe("update ribbon precedence — on screen", () => {
  it("a run in flight is shown instead of the offer that produced it", async () => {
    await renderBand(info({ run: run("restarting") }));
    expect(screen.getByText("Updating to 1.5.0. Restarting")).toBeInTheDocument();
    expect(screen.queryByText(/available/)).toBeNull();
  });
});

describe("available navigates, never runs", () => {
  // THE OFFER'S TAP IS A NAMED CONTROL, not the row. `ui/notice.tsx` forbids a whole-surface tap
  // beside a dismiss ✕ at the type level, because a <button> may not hold a second one and the
  // browsers that tolerate the nesting disagree about which of them a tap fires. The offer carries a
  // ✕, so it gives up the row-wide target; the states that carry none keep it (see the reload cases
  // below, which are still tapped on their copy).
  it("tapping the offer opens the Updates page", async () => {
    const user = userEvent.setup();
    await renderBand(info());
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByText("the updates page")).toBeInTheDocument();
  });

  it("the copy itself is not the target when there is a ✕ beside it", async () => {
    // The pair a button cannot hold, stated as the absence it now is: no ancestor of the copy is a
    // button, so there is no nesting for a browser to have an opinion about.
    await renderBand(info());
    expect(
      screen.getByText("Collie 1.5.0 available.").closest("button"),
    ).toBeNull();
  });

  it("tapping the offer never reloads the bundle and never posts an update", async () => {
    const user = userEvent.setup();
    const posts = vi.fn();
    globalThis.addEventListener("submit", posts);
    await renderBand(info());
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(posts).not.toHaveBeenCalled();
    globalThis.removeEventListener("submit", posts);
  });
});

describe("restarting gap is not an outage — on screen", () => {
  it("a run stuck at restarting keeps its progress words and grows no error tint", async () => {
    const { container } = await renderBand(info({ run: run("restarting") }));
    expect(screen.getByText("Updating to 1.5.0. Restarting")).toBeInTheDocument();
    expect(band(container)?.className).toContain("bg-status-working/15");
    expect(band(container)?.className).not.toContain("status-blocked");
  });
});

describe("a reload prompt does not look like an offer (M20/05)", () => {
  /** The band's leading icon, by the class lucide stamps on every one of its svgs. */
  function icon(container: HTMLElement): string | null {
    const svg = band(container)?.querySelector("svg");
    return svg === null || svg === undefined ? null : (svg.getAttribute("class")?.match(/lucide-[a-z-]+/)?.[0] ?? null);
  }

  it("an OFFER keeps the up-arrow: there is a new version, and a tap starts something", async () => {
    const { container } = await renderBand(info());
    expect(icon(container)).toBe("lucide-circle-arrow-up");
  });

  it("a stale BUNDLE asks for a reload, and wears the reload mark", async () => {
    holdReload("an-open-composer-draft");
    confirmStaleBundle();
    const { container } = await renderBand(info({ releaseAvailable: false }));
    expect(icon(container)).toBe("lucide-refresh-cw");
  });

  it("an UPDATED run asks for a reload too, and wears the same mark", async () => {
    // The 2026-09-07 reading: the up-arrow here says "another new version", so the operator taps
    // expecting an update to start and sees nothing start. The crew has already updated; what is
    // left is this screen.
    holdReload("an-open-composer-draft");
    confirmStaleBundle();
    const { container } = await renderBand(info({ run: run("done") }));
    expect(icon(container)).toBe("lucide-refresh-cw");
  });
});

describe("pwa path unchanged", () => {
  it("with no Collie update running, the band is the same PWA row it has always been", async () => {
    const user = userEvent.setup();
    holdReload("an-open-composer-draft");
    confirmStaleBundle();
    await renderBand(info({ releaseAvailable: false }));
    expect(
      screen.getByRole("button", { name: "New version — tap to update" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New version — tap to update" }));
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("says the new version is DOWNLOADING while a worker is on its way in (2026-09-12)", async () => {
    // The incident's missing word. The band offered "tap to update", the operator tapped, and for
    // the two minutes the download took the row went on saying the same thing — so the tap read as
    // ignored and the next one was a reload that landed on a shell about to be deleted.
    pwaStage.current = "installing";
    holdReload("an-open-composer-draft");
    confirmStaleBundle();
    await renderBand(info({ releaseAvailable: false }));
    expect(screen.getByText("Downloading the new version…")).toBeInTheDocument();
    expect(screen.queryByText("New version — tap to update")).not.toBeInTheDocument();
  });

  it("the download row carries a named close, and the close puts it down", async () => {
    // The counsel finding on the 2026-09-12 fix: a worker that never leaves `installing` — a dead
    // link — is waited on forever and on purpose, since reloading early is the incident. So the row
    // that says so must be closable, or the operator reads "Downloading" with no way out over an
    // app that is running perfectly well underneath.
    const user = userEvent.setup();
    pwaStage.current = "installing";
    holdReload("an-open-composer-draft");
    confirmStaleBundle();
    const { container } = await renderBand(info({ releaseAvailable: false }));
    await user.click(screen.getByRole("button", { name: "Hide this notice" }));
    await settleBand();
    expect(band(container)).toBeNull();
    // NOTHING WAS DECLINED, so nothing is posted: the install carries on and the controller swap
    // still reloads this page when it lands.
    expect(dismissUpdate).not.toHaveBeenCalled();
  });

  it("a LATER worker raises the row again — a close covers one download, not every one", async () => {
    const user = userEvent.setup();
    pwaStage.current = "installing";
    holdReload("an-open-composer-draft");
    confirmStaleBundle();
    await renderBand(info({ releaseAvailable: false }));
    await user.click(screen.getByRole("button", { name: "Hide this notice" }));
    await settleBand();
    expect(screen.queryByText("Downloading the new version…")).not.toBeInTheDocument();

    // That worker is over and a second `updatefound` starts another. The close was about the first.
    await act(async () => {
      pwaStage.set("idle");
    });
    await act(async () => {
      pwaStage.set("installing");
    });
    expect(screen.getByText("Downloading the new version…")).toBeInTheDocument();
  });
});

describe("auto-reload unless held", () => {
  it("with nothing held the app reloads itself and the band never asks for a tap", async () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    confirmStaleBundle();
    const { container } = await renderBand(info({ releaseAvailable: false, run: run("done") }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(band(container)).toBeNull(); // the band did not turn an auto-reload into a tap
  });

  it("with a hold active the band offers the tap the self-updater was going to offer anyway", async () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    holdReload("an-open-composer-draft");
    confirmStaleBundle();
    await renderBand(info({ releaseAvailable: false, run: run("done") }));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("Updated to 1.5.0. Tap to reload.")).toBeInTheDocument();
  });

  it("(c)'s tap takes the same reload path the footer button does", async () => {
    const user = userEvent.setup();
    holdReload("an-open-composer-draft");
    confirmStaleBundle();
    await renderBand(info({ run: run("done") }));
    await user.click(screen.getByText("Updated to 1.5.0. Tap to reload."));
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("updating 1 peer", () => {
  it("names the peer the lead is waiting on", async () => {
    const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "restarting" }];
    await renderBand(info({ run: run("done", { peers }) }));
    expect(screen.getByText("Updating 1 peer: minibuch")).toBeInTheDocument();
  });

  it("names both when two are moving", async () => {
    const peers: UpdatePeerLeg[] = [
      { name: "minibuch", state: "restarting" },
      { name: "cellar", state: "preflight" },
    ];
    await renderBand(info({ run: run("done", { peers }) }));
    expect(screen.getByText("Updating 2 peers: minibuch, cellar")).toBeInTheDocument();
  });

  it("is gone once all peers report done", async () => {
    const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "done" }];
    const { container } = await renderBand(info({ releaseAvailable: false, run: run("done", { peers }) }));
    expect(band(container)).toBeNull();
  });

  it("tapping it opens the Updates page", async () => {
    const user = userEvent.setup();
    const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "restarting" }];
    await renderBand(info({ run: run("done", { peers }) }));
    // The WHOLE ROW, and it stays that way: a moving peer is undismissable (the operator must be
    // able to see the end of a run somebody is still driving), so there is no ✕ for a row-wide tap
    // target to conflict with.
    await user.click(screen.getByText("Updating 1 peer: minibuch"));
    expect(await screen.findByText("the updates page")).toBeInTheDocument();
  });
});

describe("a packaged peer waits for its package manager", () => {
  it("says so instead of counting the peer among the ones still moving", async () => {
    const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "package-managed" }];
    await renderBand(info({ run: run("done", { peers }) }));
    expect(screen.getByText("minibuch waits for its package manager")).toBeInTheDocument();
  });

  it("is kept out of the peers line, which is about what the run is waiting on", async () => {
    const peers: UpdatePeerLeg[] = [
      { name: "minibuch", state: "restarting" },
      { name: "cellar", state: "package-managed" },
    ];
    await renderBand(info({ run: run("done", { peers }) }));
    // One peer, not two: the packaged machine is not one the run is waiting on.
    expect(screen.getByText("Updating 1 peer: minibuch")).toBeInTheDocument();
  });

  it("never spins — a packaged peer is a state, never something in progress", async () => {
    const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "package-managed" }];
    const { container } = await renderBand(info({ run: run("done", { peers }) }));
    expect(container.querySelector(".animate-spin")).toBeNull();
    // And it stays out of the red weight a rolled-back peer carries.
    expect(band(container)!.className).not.toContain("status-blocked");
  });
});

describe("dismissal is per version, and it belongs to the machine", () => {
  it("a run in flight carries no dismiss", async () => {
    await renderBand(info({ run: run("restarting") }));
    expect(screen.queryByRole("button", { name: "Dismiss this version" })).toBeNull();
  });

  it("dismissing closes the band on the tap and tells the bridge which version", async () => {
    const user = userEvent.setup();
    const { container } = await renderBand(info());
    await user.click(screen.getByRole("button", { name: "Dismiss this version" }));
    // Optimistic: the band is told to close on the tap, not on the next poll. It then spends the
    // one collapse duration sliding the strip away, which is the band's job and not this feature's.
    expect(collapse(container)).toHaveAttribute("data-state", "closed");
    expect(dismissUpdate).toHaveBeenCalledWith("1.5.0", "offer");
    await settleBand();
    expect(band(container)).toBeNull();
  });

  it("stays down on the NEXT SCREEN, because the snapshot carries the dismissal", async () => {
    // The second render is another browser (or this one after a poll): no local state, and the band
    // is still gone. This is the whole of M17/08 — the decision is the machine's, not the browser's.
    const { container } = await renderBand(info({ dismissedVersion: "1.5.0" }));
    expect(band(container)).toBeNull();
  });

  it("a newer release brings it back", async () => {
    const { container } = await renderBand(info({ latest: "1.6.0", dismissedVersion: "1.5.0" }));
    expect(band(container)).not.toBeNull();
    expect(screen.getByText("Collie 1.6.0 available.")).toBeInTheDocument();
  });

  it("a failed dismiss is a courtesy lost, not an error on screen", async () => {
    vi.mocked(dismissUpdate).mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    const { container } = await renderBand(info());
    await user.click(screen.getByRole("button", { name: "Dismiss this version" }));
    await settleBand();
    expect(band(container)).toBeNull();
  });
});

describe("a packaged host on the band", () => {
  const packaged = (over: Partial<UpdateInfo> = {}) =>
    info({ installKind: "packaged", packageCommand: "sudo pacman -Syu", ...over });

  it("names the package manager and never offers a tap-to-update", async () => {
    await renderBand(packaged());
    expect(screen.getByText("Collie 1.5.0 available via pacman.")).toBeInTheDocument();
    expect(screen.queryByText(/Tap to update/)).toBeNull();
  });

  it("still taps through to the updates page, where the command is", async () => {
    const user = userEvent.setup();
    await renderBand(packaged());
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByText("the updates page")).toBeInTheDocument();
  });

  it("can be dismissed, like the offer it replaces", async () => {
    const user = userEvent.setup();
    const { container } = await renderBand(packaged());
    await user.click(screen.getByRole("button", { name: "Dismiss this version" }));
    await settleBand();
    expect(band(container)).toBeNull();
    expect(dismissUpdate).toHaveBeenCalledWith("1.5.0", "offer");
  });
});

describe("hiding the quiet crew notice", () => {
  const managed: UpdatePeerLeg[] = [{ name: "minibuch", state: "package-managed" }];
  const quiet = () => info({ releaseAvailable: false, run: run("done", { peers: managed }) });

  it("carries its own label — a notice about another machine, not this version", async () => {
    await renderBand(quiet());
    expect(screen.getByRole("button", { name: "Hide this notice" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss this version" })).toBeNull();
  });

  it("hides on the tap and tells the bridge, in the crew scope", async () => {
    const user = userEvent.setup();
    const { container } = await renderBand(quiet());
    await user.click(screen.getByRole("button", { name: "Hide this notice" }));
    await settleBand();
    expect(band(container)).toBeNull();
    expect(dismissUpdate).toHaveBeenCalledWith("1.5.0", "crew");
  });

  it("stays down for the next screen, off the snapshot's own field", async () => {
    const { container } = await renderBand(info({ ...quiet(), dismissedCrewVersion: "1.5.0" }));
    expect(band(container)).toBeNull();
  });
});

describe("one height in every state, and the band's own", () => {
  it("wears the shared strip floor and adds no height or padding of its own", async () => {
    const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "restarting" }];
    const cases: (UpdateInfo | undefined)[] = [
      info(), // (a)
      info({ run: run("preflight") }), // (b)
      info({ run: run("staging") }),
      info({ run: run("restarting") }),
      info({ run: run("done", { peers }) }), // (d)
      info({
        run: run("done", {
          peers: [{ name: "minibuch", state: "rolled-back", reason: "health gate timed out" }],
        }),
      }),
    ];

    const classes: string[] = [];
    for (const update of cases) {
      const { container, unmount } = await renderBand(update);
      const row = band(container);
      expect(row).not.toBeNull();
      classes.push(row?.className ?? "");
      unmount();
    }

    // (s) too, which needs the store rather than a fixture.
    noteUpdateStarted();
    const started = await renderBand(info());
    classes.push(band(started.container)?.className ?? "");
    started.unmount();
    clearUpdateStarted();

    // A band that grew and shrank as a run progressed would reflow the route under the operator's
    // thumb mid-update. The floor is `ui/notice.tsx`'s now, shared with every other strip, which is
    // also what makes the band's arbitration height-invariant: a swap repaints the row, never
    // resizes it. Only the tone tokens may differ between these strings.
    for (const className of classes) {
      const tokens = className.split(/\s+/);
      expect(tokens).toContain("min-h-[33px]");
      // Nothing may add a second height or a vertical padding on top of the floor and its own py-1.
      const vertical = tokens.filter((token) =>
        /^(?:h-|min-h-|max-h-|py-|pt-|pb-)/.test(token),
      );
      expect(vertical).toEqual(["min-h-[33px]", "py-1"]);
    }
    // And the states really do differ only by tone, not by shape. Two tokens are allowed to vary
    // and neither changes a height: the status tint, and `text-left` — which a state wearing the
    // row-wide tap carries because its root is a <button>, and a <button> centres its text by
    // default while this one is a sentence.
    const recipes = new Set(
      classes.map((c) => c.replaceAll(/\S*status-\S+/g, "").replace("text-left", "").trim()),
    );
    expect(recipes.size).toBe(1);
  });
});

describe("the band owns the row; this feature owns the words", () => {
  it("reserves no safe-area inset of its own — the band above the header does", async () => {
    // THE REPORTED BUG, pinned at its source. This row set `env(safe-area-inset-top)` for itself,
    // as did the connection bar and as did the header, each written when it was the first thing on
    // the screen. Any two of them at once therefore paid for the notch twice, and ribbon + header
    // is the everyday case. One owner now, and it is the row's position in the viewport that
    // decides who: `ui/strip-host.tsx`.
    const { container } = await renderBand(info());
    expect(band(container)?.className).not.toMatch(/safe-area/);
    const inset = container.querySelector("[class*='safe-area-inset-top']");
    expect(inset).not.toBeNull();
    expect(inset?.contains(band(container))).toBe(true);
    // Exactly one element reserves it, in the whole band.
    expect(container.querySelectorAll("[class*='safe-area-inset-top']")).toHaveLength(1);
  });

  it("takes no position out of the layout flow, anywhere in the band", async () => {
    const { container } = await renderBand(info());
    for (const element of container.querySelectorAll("*")) {
      // `getAttribute`, not `.className`: an SVG's is an SVGAnimatedString and stringifies to
      // "[object SVGAnimatedString]", which passes every assertion below by saying nothing.
      const tokens = (element.getAttribute("class") ?? "").split(/\s+/);
      expect(tokens).not.toContain("fixed");
      expect(tokens).not.toContain("absolute");
      expect(tokens).not.toContain("sticky");
      expect(tokens.some((token) => token.startsWith("z-"))).toBe(false);
    }
  });

  it("draws nothing where the component itself sits", async () => {
    // `StripSlot` renders null: the feature stays next to the state machine that decides its
    // condition, and the pixels appear in the one band that arbitrates them. Without a host it is
    // silent rather than fatal — a route that forgot the band should be missing a banner, not blank.
    const router = createMemoryRouter(
      [{ id: ROOT_ROUTE_ID, path: "/", loader: () => homeData(info()), element: <UpdateRibbon /> }],
      { initialEntries: ["/"] },
    );
    const { container } = render(<RouterProvider router={router} />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });
});
