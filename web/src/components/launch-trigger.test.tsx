import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { DeviceAuth, Launcher } from "@/lib/types";

// Same seams as launch-strip.test: the store is stubbed at its hook, the bridge at api.launch. The
// hook under the button (useSpaceActions) stays real, so its read-only gate is exercised, not faked.
const { launchersValue } = vi.hoisted(() => ({
  launchersValue: { current: [] as readonly Launcher[] },
}));
vi.mock("@/lib/operator-config", () => ({
  useLaunchers: () => launchersValue.current,
  useOperatorCommands: () => [],
  useOperatorKeys: () => [],
}));

const { mockLaunch } = vi.hoisted(() => ({
  mockLaunch: vi.fn(async (_command: string, _session?: string) => ({
    ok: true as const,
    pane: {
      paneId: "w9:p1",
      workspaceId: "w9",
      workspaceLabel: "Runs & quota",
      tabId: "w9:t1",
      cwd: "/home",
    },
  })),
}));
// Explicit factory, the way every other component test stubs the api module: only the calls this
// tree can make are declared, so an unexpected one is a missing-function error rather than a silent
// pass-through to the network.
vi.mock("@/lib/api", () => ({ launch: mockLaunch }));

import { LaunchTrigger } from "./launch-trigger";

const peek: Launcher = { command: "rumen-peek", label: "Runs & quota", cwd: "/home" };
const quota: Launcher = { command: "showy-quota-peek", label: "Quota bars", cwd: "/home" };

function homeData(device: DeviceAuth | undefined): HomeData {
  return {
    bridge: "live",
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    session: undefined,
    device,
    notifications: { snoozedUntil: null },
    update: null,
    error: null,
    lastSeenAt: {},
  } as unknown as HomeData;
}

function makeRouter(device: DeviceAuth | undefined, readOnly = false) {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => homeData(device),
        element: <Outlet />,
        children: [{ index: true, element: <LaunchTrigger readOnly={readOnly} /> }],
      },
      { path: "/pane/:paneId", element: <div>pane</div> },
    ],
    { initialEntries: ["/"] },
  );
}

describe("LaunchTrigger", () => {
  it("renders no control at all when no launchers are declared", async () => {
    launchersValue.current = [];
    render(<RouterProvider router={makeRouter(undefined)} />);
    // This is what makes it safe to mount in every header: no rows, no icon, no touch target spent
    // in the one row of a phone screen where space is scarcest.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Launch" })).toBeNull());
  });

  it("opens a sheet listing every row with its command, and launches the tapped one", async () => {
    launchersValue.current = [peek, quota];
    mockLaunch.mockClear();
    const user = userEvent.setup();
    render(<RouterProvider router={makeRouter(undefined)} />);

    // Closed until asked: the sheet is the reach affordance, not a thing that greets you.
    expect(await screen.findByRole("button", { name: "Launch" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Launch" }));
    // A row shows the label AND the command — the sheet's whole reason for existing next to the
    // dashboard's bare buttons.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Runs & quota")).toBeInTheDocument();
    expect(screen.getByText("rumen-peek")).toBeInTheDocument();
    expect(screen.getByText("showy-quota-peek")).toBeInTheDocument();

    await user.click(screen.getByText("Quota bars"));
    expect(mockLaunch).toHaveBeenCalledExactlyOnceWith("showy-quota-peek", undefined);
  });

  it("explains a read-only device instead of offering rows it cannot run", async () => {
    launchersValue.current = [peek];
    mockLaunch.mockClear();
    const user = userEvent.setup();
    const ro: DeviceAuth = { enforced: true, device: "phone", authorized: false };
    render(<RouterProvider router={makeRouter(ro, true)} />);

    await user.click(await screen.findByRole("button", { name: "Launch" }));
    // Same posture as the pane action sheet: say so here rather than offer a tap the bridge refuses.
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByText("rumen-peek")).toBeNull();
    expect(mockLaunch).not.toHaveBeenCalled();
  });
});
