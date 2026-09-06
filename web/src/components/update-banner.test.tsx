import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { UpdateInfo } from "@/lib/types";
import { UpdateBanner, updateNotice } from "./update-banner";

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
      line: "Collie 1.0.0 — a new major",
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
