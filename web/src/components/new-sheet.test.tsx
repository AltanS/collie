import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { CrewProvider } from "@/components/crew-provider";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { clearStatus } from "@/lib/status";
import type { ServerSummary, WorktreePlanResponse } from "@/lib/types";
import { server } from "@/test/setup";
import { NewSheet, type NewSheetFrom } from "./new-sheet";

// The sheet on its own: a branch from a pane (the plan, the folder kinds, the absolute target, the
// create), a row's pinned folder, a row with no branch, and a crew member that has no branches. The
// dashboard's half (the button, the agents, the unknown outcome, Again) is in
// routes/home-new-button.test.tsx; the pure rules in lib/new-sheet.test.ts.

function homeData(servers: ServerSummary[] = []): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers,
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
  };
}

function mount(opts: { from?: NewSheetFrom; servers?: ServerSummary[]; host?: string } = {}) {
  const data = homeData(opts.servers);
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: (
          <CrewProvider servers={data.servers} sessions={[]} ts={0} pollMs={1500}>
            <NewSheet open onClose={() => {}} scope={{ host: opts.host }} from={opts.from} />
          </CrewProvider>
        ),
      },
      { path: "/pane/:paneId", element: <div data-testid="pane" /> },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

function serveLaunchers(): void {
  server.use(
    http.get("/api/launchers", () =>
      HttpResponse.json({
        launchers: [
          { command: "htop", label: "htop", cwd: "/home/op/ops" },
          { command: "make watch", label: "watch" },
        ],
        home: "/home/op",
        harnesses: [{ id: "claude", label: "Claude Code", found: true }],
      }),
    ),
  );
}

/** A plan for `~/src/app`, on main, the pane on fix-old; the folder answers follow the query. */
function servePlan(seen: URLSearchParams[] = []): void {
  server.use(
    http.get("/api/worktree/plan", ({ request }) => {
      const q = new URL(request.url).searchParams;
      seen.push(q);
      const branch = q.get("branch") ?? "";
      const parent = q.get("parent");
      const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const plan: WorktreePlanResponse = {
        ok: true,
        repoRoot: "/home/op/src/app",
        defaultBranch: "main",
        currentBranch: "fix-old",
        branchValid: branch !== "a..b",
        defaultTarget: { path: `/home/op/.herdr/worktrees/app/${slug}`, exists: false },
      };
      if (parent === "~/.config") plan.parentTarget = { ok: false, error: "hidden", code: "worktree.folder_hidden" };
      else if (parent !== null) plan.parentTarget = { ok: true, path: `/home/op/trees/${slug}` };
      return HttpResponse.json(plan);
    }),
  );
}

const sheet = () => screen.findByRole("dialog", { name: "New" });

afterEach(() => {
  cleanup();
  clearStatus();
  localStorage.clear();
  __resetOperatorCommands();
});

describe("NewSheet — on a new branch, from a pane", () => {
  it("opens with the switch on, the pane's folder, a fresh name, and This branch as the start", async () => {
    serveLaunchers();
    servePlan();
    mount({ from: { cwd: "/home/op/src/app", branch: "fix-old" } });
    const s = await sheet();
    expect(await within(s).findByRole("switch", { name: /On a new branch/ })).toHaveAttribute("aria-checked", "true");
    expect(within(s).getByRole("textbox", { name: "Folder" })).toHaveValue("/home/op/src/app");
    expect(within(s).getByRole("textbox", { name: "Branch name" })).toHaveDisplayValue(/^worktree\//);
    // The plan arrives: Start from offers main and This branch, opened on This branch.
    await within(s).findByRole("radio", { name: "This branch" });
    expect(within(s).getByRole("radio", { name: "This branch" })).toHaveAttribute("aria-checked", "true");
    // Herdr's default: the predicted absolute folder is shown before Start.
    await waitFor(() =>
      expect(within(s).getByTestId("new-sheet-target")).toHaveTextContent(/New folder: ~\/\.herdr\/worktrees\/app\/worktree-/),
    );
  });

  it("Other folder shows the checked child of the parent, and Start sends it with the base and the agent", async () => {
    serveLaunchers();
    servePlan();
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/worktree", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({
          ok: true,
          alreadyOpen: false,
          launcherStarted: true,
          pane: { paneId: "w7:p1", workspaceId: "w7", workspaceLabel: "app", tabId: "w7:t1", cwd: "/home/op/trees/fix-tabs" },
        });
      }),
    );
    const router = mount({ from: { cwd: "/home/op/src/app", branch: "fix-old" } });
    const s = await sheet();
    const name = await within(s).findByRole("textbox", { name: "Branch name" });
    await userEvent.clear(name);
    await userEvent.type(name, "fix-tabs");
    await userEvent.click(within(s).getByRole("radio", { name: "Other folder" }));
    await userEvent.type(within(s).getByRole("textbox", { name: "Put the branch folder in" }), "~/trees");
    await waitFor(() => expect(within(s).getByTestId("new-sheet-target")).toHaveTextContent("New folder: ~/trees/fix-tabs"));
    expect(within(s).getByTestId("new-sheet-summary")).toHaveTextContent(
      "Claude Code in ~/src/app, new branch fix-tabs from fix-old",
    );
    await userEvent.click(within(s).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w7%3Ap1"));
    expect(bodies).toEqual([
      {
        cwd: "/home/op/src/app",
        branch: "fix-tabs",
        base: { kind: "ref", ref: "fix-old" },
        folder: { kind: "parent", parent: "~/trees" },
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        harness: "claude",
      },
    ]);
  });

  it("a parent the bridge refuses names its reason, and Start waits", async () => {
    serveLaunchers();
    servePlan();
    mount({ from: { cwd: "/home/op/src/app", branch: null } });
    const s = await sheet();
    await userEvent.click(await within(s).findByRole("radio", { name: "Other folder" }));
    await userEvent.type(within(s).getByRole("textbox", { name: "Put the branch folder in" }), "~/.config");
    await waitFor(() => expect(within(s).getByTestId("new-sheet-target")).toHaveTextContent("hidden"));
    expect(within(s).getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("a name git refuses says so, and Start waits", async () => {
    serveLaunchers();
    servePlan();
    mount({ from: { cwd: "/home/op/src/app", branch: null } });
    const s = await sheet();
    const name = await within(s).findByRole("textbox", { name: "Branch name" });
    await userEvent.clear(name);
    await userEvent.type(name, "a..b");
    await waitFor(() => expect(within(s).getByTestId("new-sheet-target")).toHaveTextContent("Git does not accept this branch name."));
    expect(within(s).getByRole("button", { name: "Start" })).toBeDisabled();
  });
});

describe("NewSheet — commands", () => {
  it("a row with a pinned folder shows that folder and no Folder field, and has no branch switch", async () => {
    serveLaunchers();
    mount();
    const s = await sheet();
    await userEvent.click(await within(s).findByRole("radio", { name: "htop" }));
    expect(within(s).queryByRole("textbox", { name: "Folder" })).toBeNull();
    expect(within(s).getByText("This command always runs in ~/ops.")).toBeInTheDocument();
    await waitFor(() => expect(within(s).queryByRole("switch", { name: /On a new branch/ })).toBeNull());
    expect(within(s).getByTestId("new-sheet-summary")).toHaveTextContent("htop in ~/ops");
  });

  it("Shell may start on a new branch", async () => {
    serveLaunchers();
    mount();
    const s = await sheet();
    await userEvent.click(await within(s).findByRole("radio", { name: "Shell" }));
    expect(await within(s).findByRole("switch", { name: /On a new branch/ })).toHaveAttribute("aria-checked", "false");
  });
});

describe("NewSheet — a crew", () => {
  const roster: ServerSummary[] = [
    { id: "lead", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 0 },
    { id: "mini", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 0 },
  ];

  it("a member has no branches: the top block says they are only on the lead", async () => {
    serveLaunchers();
    mount({ servers: roster, host: "mini" });
    const s = await sheet();
    expect(await within(s).findByRole("radio", { name: "minibuch" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(within(s).getByTestId("new-sheet-off")).toHaveTextContent("On a new branch: only on bluefin"));
    expect(within(s).getByTestId("new-sheet-off")).toHaveTextContent("Not available on minibuch");
  });
});
