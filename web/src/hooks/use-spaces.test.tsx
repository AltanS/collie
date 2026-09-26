import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { resetPollIntent, topologyBursting } from "@/lib/poll-intent";
import type { Scope } from "@/lib/scope";
import { tabCreateKey, useSpaceActions } from "./use-spaces";

// Stub the bridge's create endpoints at the api seam — same idiom launch-strip.test.tsx uses for
// api.launch. Only the calls this tree can make are declared.
const { mockCreateTab, mockCreateWorkspace } = vi.hoisted(() => ({
  mockCreateTab: vi.fn(),
  mockCreateWorkspace: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  createTab: mockCreateTab,
  createWorkspace: mockCreateWorkspace,
}));

function homeData(): HomeData {
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
    update: undefined,
    error: false,
    authError: false,
  };
}

function pane(workspaceId: string) {
  return {
    ok: true as const,
    pane: { paneId: `${workspaceId}:p1`, workspaceId, workspaceLabel: workspaceId, tabId: `${workspaceId}:t1`, cwd: "/home" },
  };
}

// A refusal, not a success — `open()` returns without navigating on `ok: false`, so the Harness
// stays mounted and the busy flag alone is what these guard tests need to watch. Success is used
// only where the test needs the create to actually LAND (the topology-burst case below).
function refused() {
  return { ok: false as const, error: "nope" };
}

// A minimal harness that exposes the two guarded creates as buttons — the shape every real caller
// (tab-strip.tsx, space-strip.tsx) reduces to: tap a "+", read the busy set back.
function Harness({ w1 = "w1", w2 = "w2" }: { w1?: string; w2?: string }) {
  const { newTab, newSpace, creatingTab, creatingSpace } = useSpaceActions();
  return (
    <div>
      <button onClick={() => void newTab(w1)}>new-tab-{w1}</button>
      <button onClick={() => void newTab(w2)}>new-tab-{w2}</button>
      <button onClick={() => void newSpace({})}>new-space</button>
      <span data-testid="creating-w1">{String(creatingTab.has(tabCreateKey(w1, undefined)))}</span>
      <span data-testid="creating-w2">{String(creatingTab.has(tabCreateKey(w2, undefined)))}</span>
      <span data-testid="creating-space">{String(creatingSpace)}</span>
    </div>
  );
}

/** A crew member's space, addressed the way a dashboard heading addresses it (M40/03). */
const PEER: Scope = { host: "workshop" };

// The dashboard's shape: one list across every machine, so two headings can both name `w1` — the
// lead's (ambient, no `at`) and a peer's (its own `at`). Each "+" hands its own scope in.
function AddressedHarness() {
  const { newTab, creatingTab } = useSpaceActions();
  return (
    <div>
      <button onClick={() => void newTab("w1", PEER)}>new-tab-peer-w1</button>
      <button onClick={() => void newTab("w1")}>new-tab-lead-w1</button>
      <span data-testid="creating-peer-w1">{String(creatingTab.has(tabCreateKey("w1", PEER)))}</span>
      <span data-testid="creating-lead-w1">{String(creatingTab.has(tabCreateKey("w1", undefined)))}</span>
    </div>
  );
}

function makeRouter(harness = <Harness />) {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => homeData(),
        element: <Outlet />,
        children: [{ index: true, element: harness }],
      },
      { path: "/pane/:paneId", element: <div>pane</div> },
    ],
    { initialEntries: ["/"] },
  );
}

describe("useSpaceActions — creating busy state", () => {
  beforeEach(() => {
    mockCreateTab.mockClear();
    mockCreateWorkspace.mockClear();
    resetPollIntent();
  });

  it("a double tap on the same Space's '+' creates once", async () => {
    let release = (): void => {};
    mockCreateTab.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(refused());
        }),
    );
    const user = userEvent.setup();
    render(<RouterProvider router={makeRouter()} />);

    await user.click(await screen.findByRole("button", { name: "new-tab-w1" }));
    await waitFor(() => expect(screen.getByTestId("creating-w1")).toHaveTextContent("true"));
    await user.click(screen.getByRole("button", { name: "new-tab-w1" }));
    release();
    await waitFor(() => expect(screen.getByTestId("creating-w1")).toHaveTextContent("false"));

    expect(mockCreateTab).toHaveBeenCalledTimes(1);
  });

  it("a different Space's '+' is not blocked while another is creating", async () => {
    let release = (): void => {};
    mockCreateTab.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(refused());
        }),
    );
    mockCreateTab.mockResolvedValueOnce(refused());
    const user = userEvent.setup();
    render(<RouterProvider router={makeRouter()} />);

    await user.click(await screen.findByRole("button", { name: "new-tab-w1" }));
    await waitFor(() => expect(screen.getByTestId("creating-w1")).toHaveTextContent("true"));
    expect(screen.getByTestId("creating-w2")).toHaveTextContent("false");

    await user.click(screen.getByRole("button", { name: "new-tab-w2" }));
    expect(mockCreateTab).toHaveBeenCalledTimes(2);
    release();
  });

  it("after a successful create the poll intent owes a topology burst", async () => {
    mockCreateTab.mockResolvedValueOnce(pane("w1"));
    const user = userEvent.setup();
    render(<RouterProvider router={makeRouter()} />);

    expect(topologyBursting()).toBe(false);
    await user.click(await screen.findByRole("button", { name: "new-tab-w1" }));
    await waitFor(() => expect(topologyBursting()).toBe(true));
  });

  it("newSpace guards behind a single global flag", async () => {
    let release = (): void => {};
    mockCreateWorkspace.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(refused());
        }),
    );
    const user = userEvent.setup();
    render(<RouterProvider router={makeRouter()} />);

    await user.click(await screen.findByRole("button", { name: "new-space" }));
    await waitFor(() => expect(screen.getByTestId("creating-space")).toHaveTextContent("true"));
    await user.click(screen.getByRole("button", { name: "new-space" }));
    release();
    await waitFor(() => expect(screen.getByTestId("creating-space")).toHaveTextContent("false"));

    expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);
  });
});

// M40/03: a workspace heading on the dashboard names its own machine, and the dashboard is one list
// across a crew. The create must go to THAT machine and the step down must land there, never on the
// machine the URL happens to address; and a peer's `w1` is not the lead's `w1`.
describe("useSpaceActions — newTab addressed to a scope", () => {
  beforeEach(() => {
    mockCreateTab.mockReset();
    resetPollIntent();
  });

  it("an addressed newTab creates on that machine and opens the new pane there", async () => {
    mockCreateTab.mockResolvedValueOnce(pane("w1"));
    const user = userEvent.setup();
    const router = makeRouter(<AddressedHarness />);
    render(<RouterProvider router={router} />);

    await user.click(await screen.findByRole("button", { name: "new-tab-peer-w1" }));

    expect(mockCreateTab).toHaveBeenCalledTimes(1);
    expect(mockCreateTab).toHaveBeenCalledWith("w1", {}, PEER);
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w1%3Ap1"));
    expect(new URLSearchParams(router.state.location.search).get("h")).toBe("workshop");
  });

  it("an addressed newTab keeps a peer's w1 apart from the lead's w1", async () => {
    let release = (): void => {};
    mockCreateTab.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(refused());
        }),
    );
    mockCreateTab.mockResolvedValueOnce(refused());
    const user = userEvent.setup();
    render(<RouterProvider router={makeRouter(<AddressedHarness />)} />);

    await user.click(await screen.findByRole("button", { name: "new-tab-peer-w1" }));
    await waitFor(() => expect(screen.getByTestId("creating-peer-w1")).toHaveTextContent("true"));
    // The lead's `w1` shares the peer's number and nothing else: its "+" is not busy, and a tap on it
    // is sent, to the lead.
    expect(screen.getByTestId("creating-lead-w1")).toHaveTextContent("false");
    await user.click(screen.getByRole("button", { name: "new-tab-lead-w1" }));
    expect(mockCreateTab).toHaveBeenCalledTimes(2);
    expect(mockCreateTab).toHaveBeenLastCalledWith("w1", {}, {});
    release();
    await waitFor(() => expect(screen.getByTestId("creating-peer-w1")).toHaveTextContent("false"));
  });
});
