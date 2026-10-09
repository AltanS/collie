import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { resetPollIntent, topologyBursting } from "@/lib/poll-intent";
import type { Scope } from "@/lib/scope";
import { clearStatus, useStatus } from "@/lib/status";
import { tabCreateKey, useSpaceActions } from "./use-spaces";

// Stub the bridge's create endpoints at the api seam — same idiom launch-strip.test.tsx uses for
// api.launch. Only the calls this tree can make are declared.
const { mockCreateTab, mockCreateWorkspace, mockCreateWorktreeAt, mockStartLaunch, mockLaunch, mockOutcomeUnknown } =
  vi.hoisted(() => ({
    mockCreateTab: vi.fn(),
    mockCreateWorkspace: vi.fn(),
    mockCreateWorktreeAt: vi.fn(),
    mockStartLaunch: vi.fn(),
    mockLaunch: vi.fn(),
    mockOutcomeUnknown: vi.fn(),
  }));
vi.mock("@/lib/api", () => ({
  createTab: mockCreateTab,
  createWorkspace: mockCreateWorkspace,
  createWorktreeAt: mockCreateWorktreeAt,
  startLaunch: mockStartLaunch,
  launch: mockLaunch,
  outcomeUnknown: mockOutcomeUnknown,
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

function makeRouter(harness = <Harness />, root: Partial<HomeData> = {}) {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => ({ ...homeData(), ...root }),
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

// THE NEW SHEET'S START (M48, ADR 0091, ADR 0093): one call for every kind, with the sheet's request
// id. It answers what became of it, and an outcome nobody can confirm is the sheet's to say, so the
// status line stays quiet then and nothing is re-sent.
describe("useSpaceActions — start", () => {
  const REQUEST_ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";

  beforeEach(() => {
    for (const mock of [mockCreateWorktreeAt, mockStartLaunch, mockCreateWorkspace, mockOutcomeUnknown]) mock.mockReset();
    delete document.body.dataset.outcome;
    clearStatus();
    resetPollIntent();
  });

  /** The status line, outside the router, so it outlives the step into the new pane. */
  function StatusProbe() {
    return <span data-testid="status-probe">{useStatus()?.text ?? ""}</span>;
  }

  function StartHarness({ ask }: { ask: Parameters<ReturnType<typeof useSpaceActions>["start"]>[0] }) {
    const { start } = useSpaceActions();
    return (
      <button
        onClick={() => {
          void (async () => {
            document.body.dataset.outcome = await start(ask);
          })();
        }}
      >
        start
      </button>
    );
  }

  async function press(ask: Parameters<typeof StartHarness>[0]["ask"]) {
    const user = userEvent.setup();
    const router = makeRouter(<StartHarness ask={ask} />);
    render(
      <>
        <RouterProvider router={router} />
        <StatusProbe />
      </>,
    );
    await user.click(await screen.findByRole("button", { name: "start" }));
    await waitFor(() => expect(document.body.dataset.outcome).toBeDefined());
    return router;
  }

  it("an agent by id goes to /api/launch with its folder and the request id, and lands on the pane", async () => {
    mockStartLaunch.mockResolvedValueOnce(pane("w7"));
    const router = await press({ what: { kind: "harness", id: "claude" }, cwd: "~/src/app", requestId: REQUEST_ID });
    expect(mockStartLaunch).toHaveBeenCalledWith({ kind: "harness", id: "claude" }, { cwd: "~/src/app", requestId: REQUEST_ID }, {});
    expect(document.body.dataset.outcome).toBe("done");
    expect(router.state.location.pathname).toBe("/pane/w7%3Ap1");
  });

  it("a shell on an older machine goes through its plain space create", async () => {
    mockCreateWorkspace.mockResolvedValueOnce(pane("w7"));
    await press({ what: { kind: "shell" }, cwd: "/srv", requestId: REQUEST_ID, legacyShell: true });
    expect(mockCreateWorkspace).toHaveBeenCalledWith({ cwd: "/srv" }, {});
    expect(mockStartLaunch).not.toHaveBeenCalled();
  });

  it("a branch start sends the folder, base and agent, and a launcher that did not start says so", async () => {
    mockCreateWorktreeAt.mockResolvedValueOnce({ ...pane("w7"), alreadyOpen: false, launcherStarted: false, launcherError: "gone" });
    await press({
      what: { kind: "harness", id: "codex" },
      requestId: REQUEST_ID,
      branch: { cwd: "~/src/app", name: "fix-tabs", base: { kind: "default" }, folder: { kind: "parent", parent: "~/trees" } },
    });
    expect(mockCreateWorktreeAt).toHaveBeenCalledWith(
      {
        cwd: "~/src/app",
        branch: "fix-tabs",
        base: { kind: "default" },
        folder: { kind: "parent", parent: "~/trees" },
        requestId: REQUEST_ID,
        what: { kind: "harness", id: "codex" },
      },
      {},
    );
    expect(document.body.dataset.outcome).toBe("done");
    expect(screen.getByTestId("status-probe")).toHaveTextContent(
      "The worktree is ready, but the agent did not start. Start it in the new shell.",
    );
  });

  it("no answer is unknown: nothing is said and nothing is re-sent", async () => {
    mockStartLaunch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mockOutcomeUnknown.mockReturnValueOnce(true);
    await press({ what: { kind: "shell" }, requestId: REQUEST_ID });
    expect(document.body.dataset.outcome).toBe("unknown");
    expect(mockStartLaunch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("status-probe")).toHaveTextContent("");
  });

  it("a refusal is refused, and the status line says it", async () => {
    mockStartLaunch.mockResolvedValueOnce({ ok: false, error: "unknown agent: x", code: "launch.unknown_harness", detail: { harness: "x" } });
    await press({ what: { kind: "harness", id: "x" }, requestId: REQUEST_ID });
    expect(document.body.dataset.outcome).toBe("refused");
    expect(screen.getByTestId("status-probe")).toHaveTextContent("This machine does not start x.");
  });
});

// NOTHING SAVED CAN ACT (M46, ADR 0087 rule 8). A cold open draws the saved herd before the bridge
// answers; every create here is a write at ids read from that snapshot. Each entry point refuses and
// sends nothing, whether the herd is the saved copy (the dashboard) or the caller's own liveness says
// no (the pane view).
describe("useSpaceActions — a saved copy refuses every structural write", () => {
  const ALL = ["new-tab", "new-space", "start", "launch"] as const;

  beforeEach(() => {
    for (const mock of [mockCreateTab, mockCreateWorkspace, mockCreateWorktreeAt, mockStartLaunch, mockLaunch]) mock.mockReset();
    clearStatus();
    resetPollIntent();
  });

  function WritesHarness({ canWrite }: { canWrite?: () => boolean }) {
    const actions = useSpaceActions(canWrite);
    const status = useStatus();
    const run = {
      "new-tab": () => void actions.newTab("w1"),
      "new-space": () => void actions.newSpace({}),
      start: () => void actions.start({ what: { kind: "shell" }, requestId: "r1" }),
      launch: () => void actions.launch("claude"),
    } satisfies Record<(typeof ALL)[number], () => void>;
    return (
      <div>
        {ALL.map((name) => (
          <button key={name} onClick={() => run[name]()}>
            {name}
          </button>
        ))}
        <span data-testid="status">{status?.text ?? ""}</span>
      </div>
    );
  }

  const REFUSAL = "Saved copy. Reconnect to make changes.";
  const writes = () => [mockCreateTab, mockCreateWorkspace, mockCreateWorktreeAt, mockStartLaunch, mockLaunch];

  it.each(ALL)("%s sends nothing while the herd on screen is the saved copy", async (name) => {
    const user = userEvent.setup();
    render(<RouterProvider router={makeRouter(<WritesHarness />, { stale: true })} />);
    await user.click(await screen.findByRole("button", { name }));
    expect(screen.getByTestId("status")).toHaveTextContent(REFUSAL);
    for (const mock of writes()) expect(mock).not.toHaveBeenCalled();
  });

  it.each(ALL)("%s sends nothing while the caller's own read is not live", async (name) => {
    const user = userEvent.setup();
    render(<RouterProvider router={makeRouter(<WritesHarness canWrite={() => false} />)} />);
    await user.click(await screen.findByRole("button", { name }));
    expect(screen.getByTestId("status")).toHaveTextContent(REFUSAL);
    for (const mock of writes()) expect(mock).not.toHaveBeenCalled();
  });

  it("a live herd and a live caller still create", async () => {
    mockCreateTab.mockResolvedValueOnce(refused());
    const user = userEvent.setup();
    render(<RouterProvider router={makeRouter(<WritesHarness canWrite={() => true} />)} />);
    await user.click(await screen.findByRole("button", { name: "new-tab" }));
    await waitFor(() => expect(mockCreateTab).toHaveBeenCalledTimes(1));
  });
});
