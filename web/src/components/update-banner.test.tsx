import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { checkForUpdate, type PrecacheProgress, type UpdateStage } from "@/lib/pwa";
import { __resetReloadGuard, holdReload } from "@/lib/reload-guard";
import { __resetSelfUpdate, __setReloadImpl, startSelfUpdate } from "@/lib/self-update";
import { __resetServerBuild, observeServerBuild } from "@/lib/server-build";
import type { UpdateInfo } from "@/lib/types";
import {
  UPDATE_LINE_LOOK,
  UPDATE_LINE_PULSE_MS,
  UpdateBanner,
  UpdateNoticeLine,
  arriveAtUpdateLine,
  bundlePercent,
  updateNotice,
  type BundleFacts,
} from "./update-banner";

// The service worker's two stores, as a box a case can set. `vi.hoisted` because a mock factory may
// not reach an ordinary module variable. Idle and no progress by default, which is every case below
// that is not about the app bundle.
interface WorkerBox {
  stage: UpdateStage;
  progress: PrecacheProgress | null;
}
const sw = vi.hoisted((): WorkerBox => ({
  stage: "idle",
  progress: null,
}));
vi.mock("@/lib/pwa", () => ({
  checkForUpdate: vi.fn(),
  getUpdateStage: () => sw.stage,
  subscribeUpdateStage: () => () => {},
  getPrecacheProgress: () => sw.progress,
  subscribePrecacheProgress: () => () => {},
}));

// A real, existing Collie release (kept `current` below it so the "available" scenario is honest).
const RELEASE_URL = "https://github.com/AltanS/collie/releases/tag/v0.10.3";
const someUpdate = (over: Partial<UpdateInfo>): UpdateInfo => ({
  current: "0.9.0",
  latest: "0.10.3",
  latestUrl: RELEASE_URL,
  releaseAvailable: false,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: null,
  ...over,
});

// The precedence is the load-bearing bit, so it's unit-tested pure. bridgeStale (restart the
// running process) outranks releaseAvailable (upgrade) since restarting is the cheaper, more urgent
// fix; an absent `update` (older bridge) and a "nothing pending" update both fall through to null.
describe("updateNotice", () => {
  it("returns null when update is absent (older bridge / no info)", () => {
    expect(updateNotice(undefined)).toBeNull();
  });

  it("returns null when nothing is pending", () => {
    expect(updateNotice(someUpdate({}))).toBeNull();
  });

  it("prefers the bridge restart over a release when both are pending", () => {
    expect(updateNotice(someUpdate({ bridgeStale: true, releaseAvailable: true }))).toEqual({
      line: "Bridge restart needed",
      command: "herdr plugin action invoke restart --plugin herdr.collie",
    });
  });

  it("names the available release and links to it, with no command (the release page carries them)", () => {
    expect(updateNotice(someUpdate({ releaseAvailable: true, latest: "0.10.3" }))).toEqual({
      line: "Collie 0.10.3 available",
      href: RELEASE_URL,
    });
  });

  it("names the consent command for a major, and ranks it below a routine release", () => {
    // A major is the one thing the plain update action will NOT take (ADR 0020), so its line carries
    // the `update-major` command rather than leaving the operator to tap update and stay behind.
    const major = "https://github.com/AltanS/collie/releases/tag/v1.0.0";
    expect(updateNotice(someUpdate({ majorAvailable: "1.0.0", majorUrl: major }))).toEqual({
      line: "Collie 1.0.0, a new major",
      href: major,
      command: "herdr plugin action invoke update-major --plugin herdr.collie",
    });
    // Both pending: take the one a routine update can actually deliver first.
    expect(
      updateNotice(
        someUpdate({ releaseAvailable: true, latest: "0.32.0", majorAvailable: "1.0.0", majorUrl: major }),
      ),
    ).toEqual({ line: "Collie 0.32.0 available", href: RELEASE_URL });
  });

  it("stays silent when a release is flagged but no version is known", () => {
    expect(updateNotice(someUpdate({ releaseAvailable: true, latest: null }))).toBeNull();
  });

  // The command spelling follows the install kind (M14/01 §5.3): Herdr's plugin actions reach only a
  // Herdr-managed (detached) checkout. A binary install, a linked dev clone and an unknown layout are
  // told the `collie` verbs; an ABSENT kind is an older, git-era bridge and keeps the Herdr spelling.
  it("spells the collie verbs on a binary install", () => {
    expect(updateNotice(someUpdate({ bridgeStale: true, installKind: "binary" }))?.command).toBe(
      "collie restart",
    );
    expect(
      updateNotice(someUpdate({ majorAvailable: "1.0.0", installKind: "binary" }))?.command,
    ).toBe("collie update --major");
  });

  it("spells the collie verbs on a linked clone and an unknown layout", () => {
    expect(updateNotice(someUpdate({ bridgeStale: true, installKind: "linked-clone" }))?.command).toBe(
      "collie restart",
    );
    expect(updateNotice(someUpdate({ bridgeStale: true, installKind: "unknown" }))?.command).toBe(
      "collie restart",
    );
  });

  it("keeps the Herdr actions on a Herdr-managed checkout, named or absent (older bridge)", () => {
    expect(
      updateNotice(someUpdate({ bridgeStale: true, installKind: "detached-checkout" }))?.command,
    ).toBe("herdr plugin action invoke restart --plugin herdr.collie");
    expect(
      updateNotice(someUpdate({ majorAvailable: "1.0.0", installKind: undefined }))?.command,
    ).toBe("herdr plugin action invoke update-major --plugin herdr.collie");
  });
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

// The banner reads its `update` from the root loader data, so drive it through a memory router that
// serves a HomeData with the field set — mirroring the real route nesting.
function renderBanner(update: UpdateInfo | undefined) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => homeData(update),
        element: (
          <div data-testid="root">
            <UpdateBanner />
          </div>
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

// ── A PACKAGE SWAP UNDER A LIVE PROCESS (M17/02) ─────────────────────────────
// `pacman -Syu` replaces the root while the bridge runs, so the version on disk stops being the
// version running. The HOST decides both the state and the command; the phone renders them.
describe("updateNotice — restart needed after a package swap", () => {
  it("outranks the stale-source restart and takes the host's own command", () => {
    expect(
      updateNotice(
        someUpdate({
          restartNeeded: true,
          restartCommand: "collie restart",
          bridgeStale: true,
          releaseAvailable: true,
        }),
      ),
    ).toEqual({
      line: "Collie was replaced on disk. Restart it.",
      command: "collie restart",
    });
  });

  it("says nothing on a bridge that sends neither field, which is every install before this", () => {
    expect(updateNotice(someUpdate({}))).toBeNull();
    // And a raised flag with no command to name falls through rather than printing a bare line: a
    // restart notice the operator cannot act on is a notice with nothing in it.
    expect(updateNotice(someUpdate({ restartNeeded: true }))).toBeNull();
  });
});

describe("UpdateBanner", () => {
  it("shows the release notice as a link to the release, with no command (the page carries it)", async () => {
    renderBanner(someUpdate({ releaseAvailable: true, latest: "0.10.3" }));
    const link = await screen.findByRole("link", { name: "Collie 0.10.3 available" });
    expect(link).toHaveAttribute("href", RELEASE_URL);
    expect(screen.queryByRole("button")).toBeNull(); // no copyable command for the release case
  });

  it("shows the package-swap restart line with the host's command", async () => {
    renderBanner(someUpdate({ restartNeeded: true, restartCommand: "collie restart" }));
    expect(await screen.findByText("Collie was replaced on disk. Restart it.")).toBeInTheDocument();
    expect(screen.getByText("collie restart")).toBeInTheDocument();
  });

  it("shows the restart line (no link) when the running bridge is stale", async () => {
    renderBanner(someUpdate({ bridgeStale: true }));
    expect(await screen.findByText("Bridge restart needed")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull(); // restart isn't a release — no GitHub link
    expect(
      screen.getByText("herdr plugin action invoke restart --plugin herdr.collie"),
    ).toBeInTheDocument();
  });

  it("renders nothing when there is no update info", async () => {
    renderBanner(undefined);
    await screen.findByTestId("root"); // wait for the loader to resolve
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/available|restart/i)).toBeNull();
  });
});

// ── A packaged install (ADR 0035) ────────────────────────────────────────────
// The kind that does not update itself. It is the one place the footer must NOT name an update
// command: `collie update --major` is exactly what the CLI refuses on an unwritable root, so
// printing it here would tell the operator to run the thing this build made fail.

describe("updateNotice — a system package", () => {
  it("names no update command for a major, and still links the release", () => {
    const notice = updateNotice(
      someUpdate({ majorAvailable: "2.0.0", majorUrl: RELEASE_URL, installKind: "packaged" }),
    );
    expect(notice?.command).toBeUndefined();
    expect(notice?.href).toBe(RELEASE_URL);
    // The LINE stays: that a major is out is worth knowing however it gets taken.
    expect(notice?.line).toContain("2.0.0");
  });

  it("every other kind still gets its command, so this is not a blanket removal", () => {
    expect(
      updateNotice(someUpdate({ majorAvailable: "2.0.0", installKind: "detached-checkout" }))?.command,
    ).toBe("herdr plugin action invoke update-major --plugin herdr.collie");
    expect(updateNotice(someUpdate({ majorAvailable: "2.0.0", installKind: "binary" }))?.command).toBe(
      "collie update --major",
    );
  });

  it("restart still carries a command — a package restarts like anything else on PATH", () => {
    // Only UPDATING is someone else's; the binary is on PATH and `collie restart` drives the unit.
    expect(updateNotice(someUpdate({ bridgeStale: true, installKind: "packaged" }))?.command).toBe(
      "collie restart",
    );
  });
});

// ── THE APP BUNDLE, FIRST (2026-11-06) ───────────────────────────────────────
// A tap on the header mark while the app updates lands on this line, so it leads with what the mark
// means: the download and how far it is, or the new build waiting for a reload.
const facts = (over: Partial<BundleFacts>): BundleFacts => ({
  stage: null,
  progress: null,
  reloadHeld: false,
  ...over,
});

describe("updateNotice — the app bundle", () => {
  it("says the download is happening, with the per cent of files that have landed", () => {
    expect(updateNotice(undefined, facts({ stage: "installing", progress: { done: 3, total: 12 } }))).toEqual({
      line: "Downloading the new version…",
      detail: "25% downloaded",
    });
  });

  it("names no per cent before the worker's first count", () => {
    expect(updateNotice(undefined, facts({ stage: "installing" }))).toEqual({
      line: "Downloading the new version…",
    });
  });

  it("offers the reload once the new build is in, and says it reloads on its own only under a hold", () => {
    expect(updateNotice(undefined, facts({ stage: "ready", reloadHeld: true }))).toEqual({
      line: "New version, tap to update",
      reload: true,
      detail: "It reloads on its own once nothing is in progress.",
    });
    // No hold means the self-updater already spent its one automatic reload: it will NOT reload by
    // itself, so the line must not promise that it will.
    expect(updateNotice(undefined, facts({ stage: "ready" }))).toEqual({
      line: "New version, tap to update",
      reload: true,
    });
  });

  it("outranks every release line: the restart, the package swap, the offer and the major", () => {
    const all = someUpdate({
      bridgeStale: true,
      releaseAvailable: true,
      majorAvailable: "1.0.0",
      restartNeeded: true,
      restartCommand: "collie restart",
    });
    expect(updateNotice(all, facts({ stage: "installing" }))?.line).toBe("Downloading the new version…");
    expect(updateNotice(all, facts({ stage: "ready" }))?.line).toBe("New version, tap to update");
  });

  it("falls through to the release lines when no bundle is being applied", () => {
    expect(updateNotice(someUpdate({ bridgeStale: true }), facts({}))?.line).toBe("Bridge restart needed");
  });
});

describe("bundlePercent", () => {
  it("is null with no count, or a count with nothing to divide by", () => {
    expect(bundlePercent(null)).toBeNull();
    expect(bundlePercent({ done: 0, total: 0 })).toBeNull();
  });

  it("is whole per cent, rounded down, and never past 100", () => {
    expect(bundlePercent({ done: 0, total: 7 })).toBe(0);
    expect(bundlePercent({ done: 2, total: 3 })).toBe(66);
    expect(bundlePercent({ done: 7, total: 7 })).toBe(100);
    expect(bundlePercent({ done: 9, total: 7 })).toBe(100);
  });
});

describe("UpdateBanner — the app bundle, from the real self-updater", () => {
  let stop: () => void;
  beforeEach(() => {
    vi.clearAllMocks();
    sw.stage = "idle";
    sw.progress = null;
    sessionStorage.clear();
    __resetServerBuild();
    __resetReloadGuard();
    __resetSelfUpdate();
    __setReloadImpl(() => {});
    stop = startSelfUpdate();
  });
  afterEach(() => {
    stop();
    __resetReloadGuard();
    __resetSelfUpdate();
  });

  /** A newer build seen twice, the self-updater's hysteresis. Under a hold it waits and says so. */
  function staleBundle() {
    observeServerBuild("1.5.0+new.1");
    observeServerBuild("1.5.0+new.1");
  }

  it("leads with the download and its per cent, over a release on offer", async () => {
    sw.stage = "installing";
    sw.progress = { done: 5, total: 10, at: Date.now() };
    holdReload("an-open-composer-draft");
    staleBundle();
    renderBanner(someUpdate({ releaseAvailable: true }));
    expect(await screen.findByText("Downloading the new version…")).toBeInTheDocument();
    expect(screen.getByText("50% downloaded")).toBeInTheDocument();
    // On the card, the default look while the app is applied.
    expect(screen.getByTestId("root").querySelector('[data-slot="notice"]')).not.toBeNull();
    expect(screen.queryByText("Collie 0.10.3 available")).toBeNull();
    // A download has nothing for a tap to do.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers the reload as a button that takes the build stamp's path, every time it is tapped", async () => {
    const user = userEvent.setup();
    holdReload("an-open-composer-draft");
    staleBundle();
    renderBanner(undefined);
    // The card, the default look while the app is applied: the line is words, the reload is a button.
    expect(await screen.findByText("New version, tap to update")).toBeInTheDocument();
    const reload = screen.getByRole("button", { name: "Update now" });
    expect(screen.getByText("It reloads on its own once nothing is in progress.")).toBeInTheDocument();
    await user.click(reload);
    await user.click(reload);
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("promises no automatic reload when the self-updater has already spent its one", async () => {
    // The once-per-build guard, pre-spent: the self-updater shows its flag instead of reloading.
    sessionStorage.setItem("collie:auto-reloaded-for=1.5.0+new.1", "1");
    staleBundle();
    renderBanner(undefined);
    expect(await screen.findByRole("button", { name: "Update now" })).toBeInTheDocument();
    expect(screen.queryByText("It reloads on its own once nothing is in progress.")).toBeNull();
  });

  it("says the download on the AUTOMATIC lane too, with no stale flag, once a worker controls the page", async () => {
    // Nothing is held, so the page will reload by itself and the self-updater's flag never rises.
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: {} } });
    try {
      sw.stage = "installing";
      sw.progress = { done: 1, total: 4, at: Date.now() };
      renderBanner(undefined);
      expect(await screen.findByText("Downloading the new version…")).toBeInTheDocument();
      expect(screen.getByText("25% downloaded")).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  });

  it("says nothing on the app's FIRST install, when no worker controls the page yet", async () => {
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: null } });
    try {
      sw.stage = "installing";
      renderBanner(undefined);
      await screen.findByTestId("root");
      expect(screen.queryByText("Downloading the new version…")).toBeNull();
    } finally {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  });

  it("goes back to the release line once the bundle on screen is current", async () => {
    holdReload("an-open-composer-draft");
    staleBundle();
    renderBanner(someUpdate({ releaseAvailable: true }));
    expect(await screen.findByRole("button", { name: "Update now" })).toBeInTheDocument();
    act(() => observeServerBuild("test"));
    expect(screen.getByRole("link", { name: "Collie 0.10.3 available" })).toBeInTheDocument();
  });
});

// THE CARD (2026-11-09, Altan's pick of three). While a new app build downloads or waits for the
// reload, the line is an inset box in the status "working" tone, edged on all four sides, in flow at
// its own place, and the reload is a real button. Every other line is as it was.
describe("UpdateNoticeLine — the app bundle on the card", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is the card by default", () => {
    expect(UPDATE_LINE_LOOK).toBe("card");
  });

  it("draws the download in a working-tone box with an edge on every side, and no button", () => {
    const { container } = render(
      <UpdateNoticeLine notice={{ line: "Downloading the new version…", detail: "25% downloaded" }} applying className="px-4 pt-3" />,
    );
    const card = container.querySelector<HTMLElement>('[data-slot="notice"]');
    expect(card).not.toBeNull();
    expect(card?.className).toContain("bg-status-working/15");
    expect(card?.className).toContain("border-status-working/40");
    // One uniform edge (`border`), never a left accent: the corner is the house 2px.
    expect(card?.className).toMatch(/(^|\s)border(\s|$)/);
    expect(card?.className).not.toMatch(/border-l-\d/);
    expect(card?.className).not.toMatch(/\b(fixed|sticky|absolute)\b/);
    // Inset on the caller's gutter, unlike the band.
    expect(container.firstElementChild?.className).toContain("px-4");
    expect(screen.getByText("25% downloaded")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers the reload as a real button, and the line stays words", async () => {
    const user = userEvent.setup();
    render(<UpdateNoticeLine notice={{ line: "New version, tap to update", reload: true }} applying />);
    expect(screen.queryByRole("button", { name: "New version, tap to update" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Update now" }));
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });
});

// The band, one of the two looks Altan did not pick, kept behind the constant.
describe("UpdateNoticeLine — the app bundle on the band", () => {
  beforeEach(() => vi.clearAllMocks());

  const downloading = { line: "Downloading the new version…", detail: "25% downloaded" };
  const waiting = { line: "New version, tap to update", reload: true as const };

  it("draws the download on a working-tone band in flow, edge to edge, with both rules", () => {
    const { container } = render(<UpdateNoticeLine notice={downloading} applying look="band" className="px-4 pt-3" />);
    const band = container.querySelector<HTMLElement>('[data-slot="notice"]');
    expect(band).not.toBeNull();
    expect(band?.className).toContain("bg-status-working/15");
    expect(band?.className).toContain("border-status-working/40");
    expect(band?.className).toContain("border-t");
    expect(band?.className).toContain("border-b");
    // In flow: nothing fixed, nothing sticky.
    expect(band?.className).not.toMatch(/\b(fixed|sticky|absolute)\b/);
    // The caller's side gutter gives way to the band's own, so it runs edge to edge.
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain("px-0");
    expect(wrapper?.className).not.toContain("px-4");
    expect(wrapper?.className).toContain("pt-3");
    expect(screen.getByText("Downloading the new version…")).toBeInTheDocument();
    expect(screen.getByText("25% downloaded")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the reload a button with today's name, on the band", async () => {
    const user = userEvent.setup();
    const { container } = render(<UpdateNoticeLine notice={waiting} applying look="band" />);
    expect(container.querySelector('[data-slot="notice"]')).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "New version, tap to update" }));
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("leaves every line that is not the bundle's exactly as before", () => {
    const { container } = render(<UpdateNoticeLine notice={{ line: "Collie 0.10.3 available", href: RELEASE_URL }} />);
    expect(container.querySelector('[data-slot="notice"]')).toBeNull();
    expect(container.firstElementChild?.className).toContain("text-center");
  });
});

describe("arriveAtUpdateLine", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  function bandIn() {
    const line = document.createElement("div");
    const band = document.createElement("div");
    band.setAttribute("data-slot", "notice");
    line.append(band);
    document.body.append(line);
    line.scrollIntoView = vi.fn();
    const animate = vi.fn();
    Object.defineProperty(band, "animate", { value: animate });
    return { line, band, animate };
  }

  it("brings the line into view, centred, and on the default look it does nothing else", () => {
    const { line, animate } = bandIn();
    arriveAtUpdateLine(line);
    expect(line.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(animate).not.toHaveBeenCalled();
    line.remove();
  });

  it("lights band-pulse up once, for a fixed time, so no animation is left running", () => {
    const { line, animate } = bandIn();
    arriveAtUpdateLine(line, "band-pulse");
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith(expect.any(Array), { duration: UPDATE_LINE_PULSE_MS, easing: "ease-out" });
    line.remove();
  });

  it("draws no highlight under reduced motion", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
    const { line, animate } = bandIn();
    arriveAtUpdateLine(line, "band-pulse");
    expect(line.scrollIntoView).toHaveBeenCalled();
    expect(animate).not.toHaveBeenCalled();
    line.remove();
  });
});
