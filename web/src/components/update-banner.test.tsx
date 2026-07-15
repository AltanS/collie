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

  it("stays silent when a release is flagged but no version is known", () => {
    expect(updateNotice(someUpdate({ releaseAvailable: true, latest: null }))).toBeNull();
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
    session: undefined,
    snoozedUntil: null,
    update,
    error: false,
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

describe("UpdateBanner", () => {
  it("shows the release notice as a link to the release, with no command (the page carries it)", async () => {
    renderBanner(someUpdate({ releaseAvailable: true, latest: "0.10.3" }));
    const link = await screen.findByRole("link", { name: "Collie 0.10.3 available" });
    expect(link).toHaveAttribute("href", RELEASE_URL);
    expect(screen.queryByRole("button")).toBeNull(); // no copyable command for the release case
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
