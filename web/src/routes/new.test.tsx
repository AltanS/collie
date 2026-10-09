import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { CrewProvider } from "@/components/crew-provider";
import { useRootData } from "@/lib/route-data";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { t } from "@/lib/i18n";
import { KIND_KEY } from "@/lib/new-page";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { clearStatus } from "@/lib/status";
import type { AgentView, HarnessInfo, MuxCapability, MuxConfig, ServerSummary, WorktreePlanResponse } from "@/lib/types";
import { fixtureAgents } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { NewRoute } from "./new";

// THE NEW PAGE (M48 spec 01), through the router at `/new`: what the address carries (`?machine=`,
// `?pane=`), the Agent and Command selects with the reasons on what cannot run, the memory of the
// half chosen, the two docs links, Back with and without a history, the start and where it lands, and
// the worktree block. The button that goes there is in routes/home-new-button.test.tsx; the pure rules
// are in lib/new-page.test.ts.

function homeData(servers: ServerSummary[] = [], agents: AgentView[] = []): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents,
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

interface MountOptions {
  /** The entries the memory router starts with; the last is the one on screen. */
  entries?: string[];
  servers?: ServerSummary[];
  agents?: AgentView[];
}

/** The crew context the app's root layout gives every route, fed by the root loader's data. */
function Crew() {
  const data = useRootData();
  return (
    <CrewProvider servers={data.servers} sessions={[]} ts={0} pollMs={1500}>
      <Outlet />
    </CrewProvider>
  );
}

function mount(opts: MountOptions = {}) {
  const data = homeData(opts.servers, opts.agents);
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        // A fresh object each run, so a test that changes `data` and revalidates is seen.
        loader: () => ({ ...data }),
        element: withHeaderHost(<Crew />),
        children: [
          { index: true, element: <div data-testid="home" /> },
          { path: "new", element: <NewRoute /> },
          { path: "pane/:paneId", element: <div data-testid="pane" /> },
        ],
      },
    ],
    { initialEntries: opts.entries ?? ["/new"] },
  );
  render(<RouterProvider router={router} />);
  return Object.assign(router, { data });
}

const HARNESSES: readonly HarnessInfo[] = [
  { id: "claude", label: "Claude Code", found: true },
  { id: "codex", label: "Codex", found: true },
  { id: "grok", label: "Grok", found: false },
];

/** `null` answers as a bridge before 1.19.0 does: with no `harnesses` at all. */
interface LaunchersBody {
  launchers: Array<{ command: string; label: string; cwd?: string }>;
  home: string;
  harnesses?: readonly HarnessInfo[];
}

function serveLaunchers(harnesses: readonly HarnessInfo[] | null = HARNESSES): void {
  server.use(
    http.get("/api/launchers", () => {
      const body: LaunchersBody = {
        launchers: [
          { command: "htop", label: "htop", cwd: "/home/op/ops" },
          { command: "make watch", label: "watch" },
        ],
        home: "/home/op",
      };
      if (harnesses !== null) body.harnesses = harnesses;
      return HttpResponse.json(body);
    }),
  );
}

/** Serve an `/api/config` whose mux block declares exactly `capabilities`. */
function declares(capabilities: Partial<Record<MuxCapability, boolean>>): void {
  const mux: MuxConfig = { name: "reference", capabilities, unsupportedKeys: [], notes: {} };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
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

function serveLaunch(bodies: unknown[], fail: number[] = []): void {
  server.use(
    http.post("/api/launch", async ({ request }) => {
      bodies.push(await request.json());
      if (fail.includes(bodies.length)) return new HttpResponse("bad gateway", { status: 502 });
      return HttpResponse.json({
        ok: true,
        pane: { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "new", tabId: "w9:t1", cwd: "/home/op" },
      });
    }),
  );
}

const roster: ServerSummary[] = [
  { id: "lead", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 0 },
  { id: "mini", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 0 },
];

/** A pane on the lead, in a repo, on `fix-old`. */
const PANE: AgentView = {
  ...fixtureAgents[0]!,
  paneId: "w1:p1",
  cwd: "/home/op/src/app",
  gitHead: { kind: "branch", name: "fix-old" },
};

const agentSelect = () => screen.findByRole("combobox", { name: "Agent" });
const commandSelect = () => screen.findByRole("combobox", { name: "Command" });
const summary = () => screen.getByTestId("new-page-summary");

afterEach(() => {
  cleanup();
  clearStatus();
  localStorage.clear();
  __resetOperatorCommands();
});

describe("the New page: the route", () => {
  it("is a full page: the app header with a 44px back arrow, a New title, and Start in the bottom bar", async () => {
    serveLaunchers();
    mount();
    expect(await screen.findByRole("heading", { name: "New" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" }).className).toContain("size-11");
    expect(document.querySelectorAll("header")).toHaveLength(1);
    const start = screen.getByRole("button", { name: "Start" });
    expect(start.closest('[data-slot="bottom-bar"]')).not.toBeNull();
    // The bar is under the scroller, not inside it, so it stays above the keyboard.
    expect(document.querySelector("main")?.contains(start)).toBe(false);
  });

  it("lets the machine select go on a solo install", async () => {
    serveLaunchers();
    mount();
    await agentSelect();
    expect(screen.queryByRole("combobox", { name: "Host" })).toBeNull();
  });
});

describe("the New page: the address", () => {
  it("?machine= opens a crew on that machine, and the select wears it", async () => {
    serveLaunchers();
    mount({ entries: ["/new?machine=mini"], servers: roster });
    const select = await screen.findByRole("combobox", { name: "Host" });
    expect(select).toHaveValue("mini");
    await waitFor(() => expect(summary()).toHaveTextContent("on minibuch"));
  });

  it("no ?machine= opens on the machine the lead shows", async () => {
    serveLaunchers();
    mount({ servers: roster });
    expect(await screen.findByRole("combobox", { name: "Host" })).toHaveValue("lead");
  });

  it("?pane= opens on that pane's folder with the worktree switch on and its branch as the start", async () => {
    serveLaunchers();
    servePlan();
    mount({ entries: [`/new?pane=${encodeURIComponent("w1:p1")}`], agents: [PANE] });
    expect(await screen.findByRole("switch", { name: /New worktree/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("textbox", { name: "Folder" })).toHaveValue("/home/op/src/app");
    expect(screen.getByRole("textbox", { name: "Branch name" })).toHaveDisplayValue(/^worktree\//);
    await screen.findByRole("radio", { name: "This branch" });
    expect(screen.getByRole("radio", { name: "This branch" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() =>
      expect(screen.getByTestId("new-page-target")).toHaveTextContent(/New folder: ~\/\.herdr\/worktrees\/app\/worktree-/),
    );
  });

  it("a pane's page has no machine select: a worktree is the lead's", async () => {
    serveLaunchers();
    servePlan();
    mount({ entries: [`/new?pane=${encodeURIComponent("w1:p1")}`], agents: [PANE], servers: roster });
    await screen.findByRole("switch", { name: /New worktree/ });
    expect(screen.queryByRole("combobox", { name: "Host" })).toBeNull();
  });

  it("a pane that is gone leaves the plain page, with the switch off", async () => {
    serveLaunchers();
    mount({ entries: [`/new?pane=${encodeURIComponent("w9:p9")}`], agents: [PANE] });
    expect(await screen.findByRole("switch", { name: /New worktree/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("textbox", { name: "Folder" })).toHaveValue("");
  });
});

describe("the New page: Agent and Command", () => {
  it("Agent lists every agent the machine knows; one not installed stays, disabled, with its reason in brackets", async () => {
    serveLaunchers();
    mount();
    const select = await agentSelect();
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Claude Code",
      "Codex",
      "Grok (not installed)",
    ]);
    expect(within(select).getByRole("option", { name: "Grok (not installed)" })).toBeDisabled();
    expect(within(select).getByRole("option", { name: "Codex" })).toBeEnabled();
    expect(select).toHaveValue("claude");
    expect(summary()).toHaveTextContent("Claude Code in ~");
  });

  it("the Agent select's lead is the chosen agent's own icon", async () => {
    serveLaunchers();
    mount();
    const select = await agentSelect();
    await waitFor(() => expect(select).toHaveValue("claude"));
    expect(select.parentElement?.querySelector("svg")).not.toBeNull();
    await userEvent.selectOptions(select, "Codex");
    expect(select).toHaveValue("codex");
    expect(summary()).toHaveTextContent("Codex in ~");
  });

  it("Command lists Shell first, then the machine's rows, and a row with a pinned folder shows that folder", async () => {
    serveLaunchers();
    mount();
    await userEvent.click(await screen.findByRole("radio", { name: "Command" }));
    const select = await commandSelect();
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Shell", "htop", "watch"]);
    await userEvent.selectOptions(select, "htop");
    expect(screen.queryByRole("textbox", { name: "Folder" })).toBeNull();
    expect(screen.getByText("This command always runs in ~/ops.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("switch", { name: /New worktree/ })).toBeNull());
    expect(summary()).toHaveTextContent("htop in ~/ops");
  });

  it("an older Collie: opens on Command, the Agent select is empty and disabled with a note, and Shell still starts", async () => {
    serveLaunchers(null);
    mount();
    // No agent starts there, so once the answer is in the page opens on Command.
    await waitFor(() => expect(screen.getByRole("radio", { name: "Command" })).toHaveAttribute("aria-checked", "true"));
    expect(summary()).toHaveTextContent("Shell in ~");
    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeEnabled());
    await userEvent.click(screen.getByRole("radio", { name: "Agent" }));
    const select = await agentSelect();
    expect(select).toBeDisabled();
    expect(within(select).queryAllByRole("option").filter((o) => o.textContent !== "")).toEqual([]);
    // The note under the Agent select, and the worktree block's own reason: the same words, twice.
    expect(screen.getAllByText(/runs an older Collie, which cannot start agents by name/)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("the other machines' reasons ride in the machine select: unreachable stays, disabled", async () => {
    serveLaunchers();
    mount({
      servers: [roster[0]!, { ...roster[1]!, reachable: false, lastSeenAt: 0 }],
    });
    const select = await screen.findByRole("combobox", { name: "Host" });
    expect(within(select).getByRole("option", { name: "minibuch (unreachable)" })).toBeDisabled();
    expect(within(select).getByRole("option", { name: "bluefin" })).toBeEnabled();
  });

  it("a machine that stops taking writes while chosen says why, in full, under the select, and Start waits", async () => {
    serveLaunchers();
    const router = mount({ entries: ["/new?machine=mini"], servers: roster });
    const select = await screen.findByRole("combobox", { name: "Host" });
    expect(select).toHaveValue("mini");
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    router.data.servers = [roster[0]!, { ...roster[1]!, reachable: false }];
    await router.revalidate();
    expect(await screen.findByText(/minibuch is unreachable/)).toBeInTheDocument();
    // jest-dom skips a disabled option in `toHaveValue`; the browser shows it, so read the selection itself.
    if (!(select instanceof HTMLSelectElement)) throw new Error("the machine control is a select");
    expect(select.selectedOptions[0]?.textContent).toBe("minibuch (unreachable)");
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("remembers the half chosen, per machine, and opens on it next time", async () => {
    serveLaunchers();
    const first = mount({ servers: roster });
    await userEvent.click(await screen.findByRole("radio", { name: "Command" }));
    expect(JSON.parse(localStorage.getItem(KIND_KEY) ?? "{}")).toEqual({ lead: "command" });
    first.dispose();
    cleanup();

    // The same machine opens on Command; another machine has no memory and opens on Agent.
    mount({ servers: roster });
    expect(await screen.findByRole("radio", { name: "Command" })).toHaveAttribute("aria-checked", "true");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Host" }), "minibuch");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Agent" })).toHaveAttribute("aria-checked", "true"));
    await userEvent.click(screen.getByRole("radio", { name: "Command" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Host" }), "bluefin");
    // Back on the first machine, Command is still what it chose.
    await waitFor(() => expect(screen.getByRole("radio", { name: "Command" })).toHaveAttribute("aria-checked", "true"));
    expect(JSON.parse(localStorage.getItem(KIND_KEY) ?? "{}")).toEqual({ lead: "command", mini: "command" });
  });

  it("a start remembers its half too", async () => {
    serveLaunchers();
    serveLaunch([]);
    mount();
    await userEvent.click(await screen.findByRole("radio", { name: "Command" }));
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(KIND_KEY) ?? "{}")).toEqual({ "": "command" }));
  });
});

describe("the New page: the docs links", () => {
  it("Agent has How to add an agent, Command has How to add a command, each in a new tab", async () => {
    serveLaunchers();
    mount();
    await agentSelect();
    const agentLink = screen.getByRole("link", { name: "How to add an agent" });
    expect(agentLink).toHaveAttribute("href", "https://colliepwa.dev/docs/configure#your-own-launchers");
    expect(agentLink).toHaveAttribute("target", "_blank");
    expect(agentLink).toHaveAttribute("rel", expect.stringContaining("noopener"));
    // The other half is in the page but inert and hidden, so it is not a link a person can reach.
    expect(screen.queryByRole("link", { name: "How to add a command" })).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "Command" }));
    const commandLink = await screen.findByRole("link", { name: "How to add a command" });
    expect(commandLink).toHaveAttribute("href", "https://colliepwa.dev/docs/configure#your-own-launchers");
    expect(commandLink).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("link", { name: "How to add an agent" })).toBeNull();
  });
});

describe("the New page: Back", () => {
  it("steps back to the screen it was opened from", async () => {
    serveLaunchers();
    const router = mount({ entries: ["/"] });
    await router.navigate("/new", { state: { from: "/" } });
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.historyAction).toBe("POP");
  });

  it("steps back to the pane it was opened from", async () => {
    serveLaunchers();
    servePlan();
    const pane = `/pane/${encodeURIComponent("w1:p1")}`;
    const router = mount({ entries: [pane] });
    await router.navigate(`/new?pane=${encodeURIComponent("w1:p1")}`, { state: { from: pane } });
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(pane));
  });

  it("with no history behind it, goes to the dashboard", async () => {
    serveLaunchers();
    const router = mount({ entries: ["/new"] });
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.location.search).toBe("");
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("with no history behind it, keeps the machine the page was for", async () => {
    serveLaunchers();
    const router = mount({ entries: ["/new?machine=mini"], servers: roster });
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.location.search).toBe("?h=mini");
  });
});

describe("the New page: Start", () => {
  it("starts the chosen agent by id, then lands on the new pane in place of the page", async () => {
    serveLaunchers();
    const bodies: unknown[] = [];
    serveLaunch(bodies);
    const router = mount({ entries: ["/"] });
    await router.navigate("/new", { state: { from: "/" } });
    await userEvent.selectOptions(await agentSelect(), "Codex");
    await userEvent.type(screen.getByRole("textbox", { name: "Folder" }), "~/src/app");
    expect(summary()).toHaveTextContent("Codex in ~/src/app");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    expect(bodies).toEqual([{ harness: "codex", cwd: "~/src/app", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
    // The page was REPLACED by the pane, so Back from the pane does not land on a used form.
    await router.navigate(-1);
    expect(router.state.location.pathname).toBe("/");
  });

  it("an answer that never came is shown, never re-sent, and Try again sends the SAME request id", async () => {
    serveLaunchers();
    const bodies: Array<{ requestId?: string }> = [];
    serveLaunch(bodies, [1]);
    const router = mount();
    await waitFor(async () => expect(await agentSelect()).toHaveValue("claude"));
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Collie could not confirm the start.");
    expect(bodies).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    expect(bodies[1]?.requestId).toBe(bodies[0]?.requestId);
  });

  it("the next visit offers Again with the last start, and one tap runs it", async () => {
    serveLaunchers();
    const bodies: unknown[] = [];
    serveLaunch(bodies);
    const router = mount();
    await userEvent.selectOptions(await agentSelect(), "Codex");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    await router.navigate("/new");
    await userEvent.click(await screen.findByRole("button", { name: /Again: Codex/ }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ harness: "codex" });
  });

  it("an older Collie starts Shell through its space create", async () => {
    serveLaunchers(null);
    const created: unknown[] = [];
    server.use(
      http.post("/api/workspace", async ({ request }) => {
        created.push(await request.json());
        return HttpResponse.json({
          ok: true,
          pane: { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "new", tabId: "w9:t1", cwd: "/home/op" },
        });
      }),
    );
    const router = mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    expect(created).toEqual([{}]);
  });
});

// A REFUSED START ALWAYS SHOWS. The page mounted no status surface, so a refusal published with
// `setStatus` went nowhere (and lingered for the next screen): a typed `projects` started nothing and
// said nothing. A refusal now comes back to the page and is said in a Notice above Start.
describe("the New page: a refused Start", () => {
  /** Every refusal a launch can answer, with the detail its sentence needs. */
  const LAUNCH_REFUSALS = [
    { code: "launch.not_allowlisted", detail: undefined },
    { code: "launch.unknown_harness", detail: { harness: "claude" } },
    { code: "launch.bad_folder", detail: undefined },
    { code: "launch.folder_missing", detail: { folder: "/home/op/projects" } },
    { code: "launch.pane_unknown", detail: undefined },
    { code: "workspace.create_failed", detail: { reason: "herdr is gone" } },
  ] as const;

  it.each(LAUNCH_REFUSALS)("$code is said above Start, and nothing is published to a status line", async ({ code, detail }) => {
    serveLaunchers();
    server.use(
      http.post("/api/launch", () => HttpResponse.json({ ok: false, error: "english", code, detail }, { status: 400 })),
    );
    const router = mount();
    await waitFor(async () => expect(await agentSelect()).toHaveValue("claude"));
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    const shown = await screen.findByTestId("new-page-refusal");
    expect(shown).toHaveTextContent(t(`apiError.${code}`, detail));
    expect(shown.closest('[role="alert"]')).not.toBeNull();
    // The page stays, Start is live again, and the status surface holds nothing.
    expect(router.state.location.pathname).toBe("/new");
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect(document.querySelector("output")).toBeNull();
  });

  it("a refusal that came as a value (a 200 with ok: false) shows too", async () => {
    serveLaunchers();
    server.use(
      http.post("/api/launch", () =>
        HttpResponse.json({ ok: false, error: "x", code: "launch.folder_missing", detail: { folder: "/home/op/nope" } }),
      ),
    );
    mount();
    await waitFor(async () => expect(await agentSelect()).toHaveValue("claude"));
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByTestId("new-page-refusal")).toHaveTextContent("There is no folder /home/op/nope on this machine.");
  });

  it("a refused worktree start shows its reason too", async () => {
    serveLaunchers();
    servePlan();
    server.use(
      http.post("/api/worktree", () =>
        HttpResponse.json({ ok: false, error: "x", code: "worktree.not_a_repo", detail: { reason: "no repo" } }),
      ),
    );
    const router = mount({ entries: [`/new?pane=${encodeURIComponent("w1:p1")}`], agents: [PANE] });
    await screen.findByRole("textbox", { name: "Branch name" });
    await waitFor(() => expect(screen.getByTestId("new-page-target")).toHaveTextContent("New folder"));
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByTestId("new-page-refusal")).toHaveTextContent(t("apiError.worktree.not_a_repo"));
    expect(router.state.location.pathname).toBe("/new");
  });

  it("the refusal is the box the summary stood in, and a changed ask brings the summary back", async () => {
    serveLaunchers();
    server.use(
      http.post("/api/launch", () => HttpResponse.json({ ok: false, error: "x", code: "launch.bad_folder" }, { status: 400 })),
    );
    mount();
    await waitFor(async () => expect(await agentSelect()).toHaveValue("claude"));
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    const shown = await screen.findByTestId("new-page-refusal");
    // One cell holds both, so showing the refusal resizes nothing.
    expect(shown.closest("[data-active]")?.parentElement).toBe(summary().parentElement?.parentElement);
    await userEvent.type(screen.getByRole("textbox", { name: "Folder" }), "x");
    await waitFor(() => expect(screen.queryByTestId("new-page-refusal")).toBeNull());
    expect(summary()).toBeVisible();
  });

  it("a name with no leading / or ~ is shown as the full path under home, and sent as typed", async () => {
    serveLaunchers();
    const bodies: unknown[] = [];
    serveLaunch(bodies);
    mount();
    await waitFor(async () => expect(await agentSelect()).toHaveValue("claude"));
    await userEvent.type(screen.getByRole("textbox", { name: "Folder" }), "projects");
    expect(summary()).toHaveTextContent("Claude Code in ~/projects");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ harness: "claude", cwd: "projects" });
  });
});

describe("the New page: New worktree", () => {
  it("is titled a worktree, and its line says branch", async () => {
    serveLaunchers();
    mount();
    const toggle = await screen.findByRole("switch", { name: /New worktree/ });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByText("A new branch in its own folder, so this agent does not change the files of another."),
    ).toBeInTheDocument();
    expect(screen.queryByText("On a new branch")).toBeNull();
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
    const router = mount({ entries: [`/new?pane=${encodeURIComponent("w1:p1")}`], agents: [PANE] });
    const name = await screen.findByRole("textbox", { name: "Branch name" });
    await userEvent.clear(name);
    await userEvent.type(name, "fix-tabs");
    await userEvent.click(screen.getByRole("radio", { name: "Other folder" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Put the branch folder in" }), "~/trees");
    await waitFor(() => expect(screen.getByTestId("new-page-target")).toHaveTextContent("New folder: ~/trees/fix-tabs"));
    expect(summary()).toHaveTextContent("Claude Code in ~/src/app, new branch fix-tabs from fix-old");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
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
    mount({ entries: [`/new?pane=${encodeURIComponent("w1:p1")}`], agents: [{ ...PANE, gitHead: undefined }] });
    await userEvent.click(await screen.findByRole("radio", { name: "Other folder" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Put the branch folder in" }), "~/.config");
    await waitFor(() => expect(screen.getByTestId("new-page-target")).toHaveTextContent("hidden"));
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("a name git refuses says so, and Start waits", async () => {
    serveLaunchers();
    servePlan();
    mount({ entries: [`/new?pane=${encodeURIComponent("w1:p1")}`], agents: [PANE] });
    const name = await screen.findByRole("textbox", { name: "Branch name" });
    await userEvent.clear(name);
    await userEvent.type(name, "a..b");
    await waitFor(() => expect(screen.getByTestId("new-page-target")).toHaveTextContent("Git does not accept this branch name."));
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("Shell may start in a worktree", async () => {
    serveLaunchers();
    mount();
    await userEvent.click(await screen.findByRole("radio", { name: "Command" }));
    expect(await screen.findByRole("switch", { name: /New worktree/ })).toHaveAttribute("aria-checked", "false");
  });

  it("with no worktrees on the multiplexer the block stays, the switch is off and disabled, and it says why", async () => {
    serveLaunchers();
    declares({ createWorktree: false });
    mount();
    const toggle = await screen.findByRole("switch", { name: /New worktree/ });
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(await screen.findByText("needs Herdr")).toBeInTheDocument();
  });

  it("on a member the block stays, disabled, and says it is only on the lead", async () => {
    serveLaunchers();
    mount({ entries: ["/new?machine=mini"], servers: roster });
    const toggle = await screen.findByRole("switch", { name: /New worktree/ });
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(await screen.findByText("only on bluefin")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
