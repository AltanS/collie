import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { DeviceAuth, Launcher } from "@/lib/types";

// Stub the launcher store at its seam — same idiom as operator-commands tests: the component
// reads the hook, so we control what the hook returns per-case without touching the network.
const { launchersValue } = vi.hoisted(() => {
  const current: readonly Launcher[] = [];
  return { launchersValue: { current } };
});
vi.mock("@/lib/operator-config", () => ({
  useLaunchers: () => launchersValue.current,
  // The other hooks are not used by LaunchStrip, but the module may be imported elsewhere
  // in the test runtime; keep the mock shape minimal.
  useOperatorCommands: () => [],
  useOperatorKeys: () => [],
}));

// Stub the bridge's launch endpoint at the api seam, so the hook's read-only short-circuit
// (which fires before api.launch) can be proven by "api never called". The hook itself stays real.
const { mockLaunch } = vi.hoisted(() => ({
  mockLaunch: vi.fn(async (_command: string, _scope?: { host?: string; session?: string }) => ({
    ok: true as const,
    pane: {
      paneId: "p1",
      workspaceId: "w1",
      workspaceLabel: "peek",
      tabId: "t1",
      cwd: "/home",
    },
  })),
}));
// Explicit factory, the way every other component test stubs the api module: only the calls this
// tree can make are declared, so an unexpected one is a missing-function error rather than a silent
// pass-through to the network.
vi.mock("@/lib/api", () => ({ launch: mockLaunch }));

import { LaunchStrip } from "./launch-strip";

const peek: Launcher = { command: "rumen-peek", label: "Runs & quota", cwd: "/home" };
const quota: Launcher = { command: "showy-quota-peek", label: "Quota bars", cwd: "/home" };

function homeData(device: DeviceAuth | undefined): HomeData {
  return {
    bridge: "connected",
    device,
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
    update: undefined,
    error: false,
    authError: false,
  };
}

function makeRouter(device: DeviceAuth | undefined, open: boolean | null = null) {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => homeData(device),
        element: <Outlet />,
        children: [{ index: true, element: <LaunchStrip open={open} onOpenChange={onOpenChange} /> }],
      },
      { path: "/pane/:paneId", element: <div>pane</div> },
    ],
    { initialEntries: ["/"] },
  );
}

const onOpenChange = vi.fn();

describe("LaunchStrip", () => {
  it("renders nothing when no launchers are configured", async () => {
    launchersValue.current = [];
    mockLaunch.mockClear();
    render(<RouterProvider router={makeRouter(undefined)} />);
    // Empty → null, so an operator who never set `launchers.toml` sees today's dashboard byte
    // for byte: no section, no heading, no chrome.
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it("renders one button per launcher using its label", async () => {
    launchersValue.current = [peek, quota];
    mockLaunch.mockClear();
    render(<RouterProvider router={makeRouter(undefined)} />);
    expect(await screen.findByRole("button", { name: "Runs & quota" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quota bars" })).toBeInTheDocument();
    // Three buttons: the two launchers plus the section's own fold header.
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("tapping a button calls the launch API with that launcher command", async () => {
    launchersValue.current = [peek, quota];
    mockLaunch.mockClear();
    const user = userEvent.setup();
    render(<RouterProvider router={makeRouter(undefined)} />);
    await screen.findByRole("button", { name: "Runs & quota" });

    await user.click(screen.getByRole("button", { name: "Runs & quota" }));
    // The strip delegates to useSpaceActions.launch which POSTs to /api/launch; the command
    // string is an allowlist key, not an arbitrary shell line the client gets to run.
    // The scope rides as the second argument — `{}` is the lead's primary session.
    expect(mockLaunch).toHaveBeenCalledExactlyOnceWith("rumen-peek", {});
  });

  it("double tap launches once", async () => {
    launchersValue.current = [peek, quota];
    mockLaunch.mockClear();
    // A launch is the slowest create there is — the bridge waits for the new shell to draw before
    // it types — so hold this one open and tap again, the way an impatient thumb does.
    let release = (): void => {};
    mockLaunch.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        ok: true as const,
        pane: { paneId: "p1", workspaceId: "w1", workspaceLabel: "peek", tabId: "t1", cwd: "/home" },
      };
    });
    const user = userEvent.setup();
    render(<RouterProvider router={makeRouter(undefined)} />);
    const button = await screen.findByRole("button", { name: "Runs & quota" });

    await user.click(button);
    // In flight → the row is disabled, so the second tap has nothing to hit and the hook's
    // per-command guard refuses it even if one gets through.
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    expect(mockLaunch).toHaveBeenCalledTimes(1);

    // The neighbouring launcher is a different intention and stays live throughout.
    expect(screen.getByRole("button", { name: "Quota bars" })).toBeEnabled();
    release();
  });

  it("a read-only device does not fire the launch API", async () => {
    launchersValue.current = [peek];
    mockLaunch.mockClear();
    const user = userEvent.setup();
    // Build the read-only record the way fixtures do: `enforced` + not `authorized` → read-only.
    const ro: DeviceAuth = { enforced: true, device: "phone", authorized: false };
    render(<RouterProvider router={makeRouter(ro)} />);
    expect(await screen.findByRole("button", { name: "Runs & quota" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Runs & quota" }));
    // The hook short-circuits via readOnlyRef before reaching api.launch — same gate every
    // other structural create (newTab/newSpace) uses, so there is no third pattern to learn.
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it("folds to its header, keeping the count visible", async () => {
    launchersValue.current = [peek, quota];
    render(<RouterProvider router={makeRouter(undefined, false)} />);

    // Folded, the buttons are gone but the header still says how many there are — the count is the
    // reason to unfold, and this is the section whose height a config file decides.
    expect(await screen.findByRole("button", { name: /^Launch/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // The count rides in the header's accessible name, so it survives the fold.
    expect(screen.getByRole("button", { name: /^Launch/ })).toHaveAccessibleName(/2/);
    expect(screen.queryByRole("button", { name: "Runs & quota" })).toBeNull();
  });

  it("reports a fold toggle to the dashboard, which persists it", async () => {
    launchersValue.current = [peek, quota];
    onOpenChange.mockClear();
    const user = userEvent.setup();
    render(<RouterProvider router={makeRouter(undefined, null)} />);

    // Un-chosen (`null`) resolves open at this count, so the toggle asks for closed.
    await user.click(await screen.findByRole("button", { name: /^Launch/ }));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});
