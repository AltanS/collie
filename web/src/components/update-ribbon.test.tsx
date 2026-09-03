import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkForUpdate } from "@/lib/pwa";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetReloadGuard, holdReload } from "@/lib/reload-guard";
import { __resetSelfUpdate, __setReloadImpl, startSelfUpdate } from "@/lib/self-update";
import { __resetServerBuild, observeServerBuild } from "@/lib/server-build";
import { clearUpdateStarted, noteUpdateStarted } from "@/lib/update-ribbon";
import type { UpdateInfo, UpdatePeerLeg, UpdateRun, UpdateRunState } from "@/lib/types";
import { BAND_CLASS, UpdateRibbon, __resetUpdateRibbon } from "./update-ribbon";

// The ONE update band. The reading behind it is pinned in `lib/update-ribbon.test.ts`; this file is
// about the row that reaches the screen — its words, its tap, its dismiss, and the two structural
// promises it makes to the layout above it (fixed height, in-flow).
//
// The bundle states are driven through the REAL self-updater, the way the real poll drives it: a
// build id that is not ours, observed twice (the hysteresis), with or without a reload hold.

vi.mock("@/lib/pwa", () => ({ checkForUpdate: vi.fn() }));

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
        element: <UpdateRibbon />,
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

/** The band's own row — the element carrying the band class. Null when the band is silent. */
function band(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="status"]');
}

/** Drive the self-updater to CONFIRMED-stale. With a hold it shows a row; without one it reloads. */
function confirmStaleBundle(): void {
  observeServerBuild(NEWER_BUILD);
  observeServerBuild(NEWER_BUILD);
}

let stop: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  __resetUpdateRibbon();
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
  __resetUpdateRibbon();
});

describe("update ribbon states — the row on screen", () => {
  it("renders nothing at all when there is nothing to say", async () => {
    const { container } = await renderBand(info({ releaseAvailable: false }));
    expect(band(container)).toBeNull();
  });

  it("(a) offers the release and names the version", async () => {
    await renderBand(info());
    expect(screen.getByText("Collie 1.5.0 available. Tap to update.")).toBeInTheDocument();
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
      screen.getByText("minibuch rolled back: health gate timed out. See Updates."),
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
  it("tapping the offer opens the Updates page", async () => {
    const user = userEvent.setup();
    await renderBand(info());
    await user.click(screen.getByText("Collie 1.5.0 available. Tap to update."));
    expect(await screen.findByText("the updates page")).toBeInTheDocument();
  });

  it("tapping the offer never reloads the bundle and never posts an update", async () => {
    const user = userEvent.setup();
    const posts = vi.fn();
    globalThis.addEventListener("submit", posts);
    await renderBand(info());
    await user.click(screen.getByText("Collie 1.5.0 available. Tap to update."));
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

describe("pwa path unchanged", () => {
  it("with no Collie update running, the band is the same PWA row it has always been", async () => {
    const user = userEvent.setup();
    holdReload("an-open-composer-draft");
    confirmStaleBundle();
    await renderBand(info({ releaseAvailable: false }));
    expect(screen.getByText("New version — tap to update")).toBeInTheDocument();
    await user.click(screen.getByText("New version — tap to update"));
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
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
    await user.click(screen.getByText("Updating 1 peer: minibuch"));
    expect(await screen.findByText("the updates page")).toBeInTheDocument();
  });
});

describe("dismissal is per version", () => {
  it("only the offer carries a dismiss", async () => {
    await renderBand(info({ run: run("restarting") }));
    expect(screen.queryByRole("button", { name: "Dismiss this version" })).toBeNull();
  });

  it("dismissing hides the offer, and it survives a re-render (a poll)", async () => {
    const user = userEvent.setup();
    const { container, rerender } = await renderBand(info());
    await user.click(screen.getByRole("button", { name: "Dismiss this version" }));
    expect(band(container)).toBeNull();
    rerender(<div />); // the poll re-renders the tree; the pin is storage, not component state
    const second = await renderBand(info());
    expect(band(second.container)).toBeNull();
  });

  it("a newer release brings it back", async () => {
    const user = userEvent.setup();
    await renderBand(info());
    await user.click(screen.getByRole("button", { name: "Dismiss this version" }));
    const next = await renderBand(info({ latest: "1.6.0" }));
    expect(band(next.container)).not.toBeNull();
    expect(screen.getByText("Collie 1.6.0 available. Tap to update.")).toBeInTheDocument();
  });
});

describe("fixed band height", () => {
  it("is one height in every state, with only the text changing", async () => {
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

    for (const className of classes) {
      // The full recipe, verbatim — height, padding and the truncating row all come from one string.
      expect(className).toContain(BAND_CLASS);
      // Nothing may add a second height or a vertical padding on top of it.
      expect(className).not.toMatch(/\b(?:h-|min-h-|max-h-|py-|pt-|pb-)/);
    }
  });
});

describe("in-flow, never over the header", () => {
  it("takes no position out of the layout flow", async () => {
    const { container } = await renderBand(info());
    const className = band(container)?.className ?? "";
    expect(className).toContain("shrink-0");
    // Whole class tokens only: `env(safe-area-inset-top)` is part of the recipe, not an escape.
    expect(className.split(/\s+/)).not.toContain("fixed");
    expect(className.split(/\s+/)).not.toContain("absolute");
    expect(className.split(/\s+/)).not.toContain("sticky");
    expect(className).not.toMatch(/(?:^|\s)z-/);
  });

  it("the recipe itself carries no escape", async () => {
    // BAND_CLASS is what every state renders, so the promise is a property of that one string.
    expect(BAND_CLASS.split(/\s+/)).not.toContain("fixed");
    expect(BAND_CLASS.split(/\s+/)).not.toContain("absolute");
    expect(BAND_CLASS.split(/\s+/)).not.toContain("sticky");
    expect(BAND_CLASS).not.toMatch(/(?:^|\s)z-/);
    expect(BAND_CLASS).toContain("shrink-0");
    expect(BAND_CLASS).toContain("env(safe-area-inset-top)");
  });
});
