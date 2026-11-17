import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { body, defaultRow, FOUND_ALT, HARNESS_CLAUDE, HARNESS_CODEX, serveAccounts, serveAccountsStatus, workRow } from "@/test/accounts-fixtures";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { rememberStartError } from "@/lib/accounts";
import type { AccountWindow } from "@/lib/accounts";
import { SettingsRoute } from "./settings";
import { SettingsAccountAddRoute, SettingsAccountRoute, SettingsAccountsRoute } from "./settings-accounts";

// ACCOUNTS IN SETTINGS (M101): the index row, the list with the folders found in use, the Add form and one
// account's page. The wire is the contract block of the bridge spec, served by the test fakes below.

function mount(entry: string) {
  const router = createMemoryRouter(
    [
      { path: "/", element: <div data-testid="home" /> },
      { path: "/settings", element: withHeaderHost(<SettingsRoute />) },
      { path: "/settings/accounts", element: withHeaderHost(<SettingsAccountsRoute />) },
      { path: "/settings/accounts/add", element: withHeaderHost(<SettingsAccountAddRoute />) },
      { path: "/settings/accounts/:id", element: withHeaderHost(<SettingsAccountRoute />) },
      { path: "/settings/:section", element: <div data-testid="section" /> },
      { path: "/machines", element: <div data-testid="machines" /> },
      { path: "/pane/:paneId", element: <div data-testid="pane" /> },
    ],
    { initialEntries: ["/settings", entry], initialIndex: 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const W = (window: string, usedPct: number | null, over: Partial<AccountWindow> = {}): AccountWindow => ({ window, usedPct, resetsAt: null, ...over });

afterEach(() => cleanup());

describe("Settings: the Accounts row", () => {
  it("is offered, with its quiet caption, while the machine answers the accounts route", async () => {
    serveAccounts(body());
    mount("/settings");
    const row = await screen.findByRole("button", { name: /Profiles/ });
    expect(row).toHaveTextContent("One login per agent");
  });

  it("counts the added accounts in its caption", async () => {
    serveAccounts(body({ accounts: [defaultRow(), workRow(), workRow({ id: "acc-2", label: "Alt" })] }));
    mount("/settings");
    expect(await screen.findByRole("button", { name: /Profiles/ })).toHaveTextContent("2 added");
  });

  it("sits right after Harness configurations", async () => {
    serveAccounts(body());
    mount("/settings");
    await screen.findByRole("button", { name: /Profiles/ });
    const titles = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    const at = (word: string) => titles.findIndex((x) => x.startsWith(word));
    expect(at("Profiles")).toBe(at("Harness configurations") + 1);
  });

  it("is not drawn when the route answers 404", async () => {
    serveAccountsStatus(404);
    mount("/settings");
    await screen.findByRole("button", { name: /Appearance/ });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("button", { name: /Profiles/ })).toBeNull();
  });
});

describe("Accounts: the intro", () => {
  it("is one line with a closed More, and More opens the example in place and Less closes it", async () => {
    serveAccounts(body());
    mount("/settings/accounts");
    expect(await screen.findByText("A profile is signed in on its own.")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "More" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/For example, Work with your work subscription/)).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/For example, Work with your work subscription beside Default with your personal one\. You pick the profile when you start a session, and the session stays in it\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Less" }));
    await waitFor(() => expect(screen.queryByText(/For example, Work/)).toBeNull());
  });

  it("starts closed on every visit and stores nothing", async () => {
    serveAccounts(body());
    mount("/settings/accounts");
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    cleanup();
    const before = JSON.stringify({ ...localStorage });
    mount("/settings/accounts");
    expect(await screen.findByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");
    expect(JSON.stringify({ ...localStorage })).toBe(before);
  });
});

describe("Accounts: the list", () => {
  it("shows Default alone with the add button and no found block", async () => {
    serveAccounts(body());
    mount("/settings/accounts");
    expect(await screen.findByText("Default")).toBeInTheDocument();
    expect(screen.getByText("~/.claude, no variable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(screen.queryByText(/in use$/)).toBeNull();
    // With nothing added, the remove note has nothing to say yet.
    expect(screen.queryByText(/Remove forgets the label only/)).toBeNull();
  });

  it("offers the folders found in use, each with its own Add", async () => {
    serveAccounts(body({ found: [FOUND_ALT, { harness: "claude", folder: "~/.config/claude-team", path: "/home/op/.config/claude-team", why: "name" }] }));
    mount("/settings/accounts");
    expect(await screen.findByText("Found 2 folders in use")).toBeInTheDocument();
    expect(screen.getByText("~/.claude-alt")).toBeInTheDocument();
    expect(screen.getByText("Claude Code · A session reported it")).toBeInTheDocument();
    expect(screen.getByText("Claude Code · The name and layout match")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add" }).length).toBeGreaterThanOrEqual(3);
  });

  it("adds a found folder as an own account after asking only for the name, prefilled", async () => {
    serveAccounts(body({ found: [FOUND_ALT] }));
    const posted: unknown[] = [];
    server.use(
      http.post("/api/accounts", async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ account: workRow({ id: "acc-alt", label: "Alt", kind: "own" }) });
      }),
    );
    mount("/settings/accounts");
    await screen.findByText("Found 1 folder in use");
    const row = screen.getByText("~/.claude-alt").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Add" }));
    const field = await screen.findByRole("textbox", { name: "Name" });
    expect(field).toHaveValue("Alt");
    await userEvent.clear(field);
    await userEvent.type(field, "Spare");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ harness: "claude", label: "Spare", kind: "own", path: "/home/op/.claude-alt" });
  });

  it("draws each Add of a found folder at the 44 px tap floor", async () => {
    serveAccounts(body({ found: [FOUND_ALT] }));
    mount("/settings/accounts");
    await screen.findByText("Found 1 folder in use");
    const add = within(screen.getByText("~/.claude-alt").closest("li")!).getByRole("button", { name: "Add" });
    expect(add).toHaveClass("h-11");
  });

  it("says why when the sheet's add is refused, and stays open", async () => {
    serveAccounts(body({ found: [FOUND_ALT] }));
    server.use(http.post("/api/accounts", () => HttpResponse.json({ ok: false, error: "x", code: "accounts.label_taken" }, { status: 409 })));
    mount("/settings/accounts");
    await screen.findByText("Found 1 folder in use");
    await userEvent.click(within(screen.getByText("~/.claude-alt").closest("li")!).getByRole("button", { name: "Add" }));
    await screen.findByRole("textbox", { name: "Name" });
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Another profile of this agent has this name.")).toBeInTheDocument();
  });

  it("lists two accounts, a remove note, and groups the agents with their labels", async () => {
    serveAccounts(
      body({
        harnesses: [HARNESS_CLAUDE, HARNESS_CODEX],
        accounts: [defaultRow(), workRow(), defaultRow({ id: "codex:default", harness: "codex", folder: "~/.codex" })],
      }),
    );
    mount("/settings/accounts");
    expect(await screen.findByText("Work")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByText(/Remove forgets the label only/)).toBeInTheDocument();
    expect(screen.getByText("~/.claude-work")).toBeInTheDocument();
  });

  it("draws no windows as one quiet line, one window as one bar, four as four", async () => {
    serveAccounts(
      body({
        accounts: [
          defaultRow({ windows: [] }),
          workRow({ windows: [W("7d", 91, { resetsAt: null })] }),
          workRow({ id: "acc-4", label: "Four", windows: [W("5h", 10), W("7d", 20), W("7d:sonnet", 30, { label: "Sonnet" }), W("spend", 40, { label: "Spend" })] }),
        ],
      }),
    );
    mount("/settings/accounts");
    await screen.findByText("Four");
    expect(screen.getByText("No usage limit reported.")).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).queryAllByRole("progressbar")).toHaveLength(0);
    expect(within(rows[1]!).getAllByRole("progressbar")).toHaveLength(1);
    expect(within(rows[2]!).getAllByRole("progressbar")).toHaveLength(4);
    for (const label of ["5 hours", "Week · Sonnet", "Spend"]) expect(within(rows[2]!).getByText(label)).toBeInTheDocument();
    expect(within(rows[1]!).getByText("91% used")).toHaveClass("text-status-blocked");
    expect(within(rows[2]!).getByText("40% used")).not.toHaveClass("text-status-blocked");
  });

  it("draws a window past its reset as 'reset', and the age or 'in use now' in the foot", async () => {
    serveAccounts(
      body({
        accounts: [
          defaultRow({ live: true }),
          workRow({ windows: [W("7d", null)], seenAt: Date.now() - 2 * 3600_000 }),
        ],
      }),
    );
    mount("/settings/accounts");
    expect(await screen.findByText("reset")).toBeInTheDocument();
    expect(screen.getByText(/^In use now · /)).toBeInTheDocument();
    expect(screen.getByText(/^Last seen .*ago · ~\/\.claude-work$/)).toBeInTheDocument();
  });

  it("a row says how many sessions run in place of 'In use now': 1, 2, and live with none counted", async () => {
    serveAccounts(
      body({
        accounts: [
          defaultRow({ live: true, running: 1 }),
          workRow({ live: true, running: 2 }),
          workRow({ id: "acc-spare", label: "Spare", folder: "~/.claude-spare", live: true, running: 0 }),
          workRow({ id: "acc-idle", label: "Idle", folder: "~/.claude-idle", live: true }),
        ],
      }),
    );
    mount("/settings/accounts");
    expect(await screen.findByText(/^1 session · /)).toBeInTheDocument();
    expect(screen.getByText(/^2 sessions · ~\/\.claude-work$/)).toBeInTheDocument();
    // Only a sign-in session runs: the old words, whether the count is 0 or absent.
    expect(screen.getByText(/^In use now · ~\/\.claude-spare$/)).toBeInTheDocument();
    expect(screen.getByText(/^In use now · ~\/\.claude-idle$/)).toBeInTheDocument();
    expect(screen.queryByText(/^1 session · .*In use now/)).toBeNull();
  });

  it("a row with no session and no live pane keeps the age of the reading", async () => {
    serveAccounts(body({ accounts: [workRow({ seenAt: Date.now() - 2 * 3600_000, running: 0 })] }));
    mount("/settings/accounts");
    expect(await screen.findByText(/^Last seen .*ago · ~\/\.claude-work$/)).toBeInTheDocument();
  });

  it("a row opens the account's page", async () => {
    serveAccounts(body({ accounts: [defaultRow(), workRow()] }));
    const router = mount("/settings/accounts");
    await userEvent.click(await screen.findByRole("button", { name: /Work/ }));
    expect(router.state.location.pathname).toBe("/settings/accounts/acc-work");
  });

  it("the add button opens the Add page", async () => {
    serveAccounts(body());
    const router = mount("/settings/accounts");
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    expect(router.state.location.pathname).toBe("/settings/accounts/add");
  });

  it("on a machine with no accounts the page says so and draws no add button", async () => {
    serveAccountsStatus(404);
    mount("/settings/accounts");
    expect(await screen.findByText("Profiles are not available on this machine.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });
});

describe("Accounts: one account", () => {
  it("shows a shared account: kind words, windows with reset times, folder and the terminal line", async () => {
    serveAccounts(body({ accounts: [defaultRow(), workRow({ windows: [W("5h", 42, { resetsAt: Date.now() + 3600_000 })] })] }));
    mount("/settings/accounts/acc-work");
    expect(await screen.findByText("Shares setup and sessions with Default")).toBeInTheDocument();
    expect(screen.getByText(/Project trust, MCP servers added with the agent's own command and the theme are also per profile\./)).toBeInTheDocument();
    expect(screen.getByText(/^Resets /)).toBeInTheDocument();
    expect(screen.getByText("CLAUDE_CONFIG_DIR=~/.claude-work claude")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("an own account says it is used as it is", async () => {
    serveAccounts(body({ accounts: [defaultRow(), workRow({ kind: "own", label: "Alt", folder: "~/.claude-alt" })] }));
    mount("/settings/accounts/acc-work");
    expect(await screen.findByText("Collie uses the folder as it is: its own history, settings and sessions.")).toBeInTheDocument();
  });

  it("Default cannot be removed and says no variable is set", async () => {
    serveAccounts(body());
    mount(`/settings/accounts/${encodeURIComponent("claude:default")}`);
    expect(await screen.findByText("~/.claude (no variable set)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  });

  it("says which entries are not linked, without calling the account broken", async () => {
    serveAccounts(body({ accounts: [defaultRow(), workRow({ unlinked: ["skills", "plugins"] })] }));
    mount("/settings/accounts/acc-work");
    expect(await screen.findByText("Not linked: skills, plugins. The profile still works; these stay separate.")).toBeInTheDocument();
  });

  it("says when the hooks are missing and shows the line that installs them", async () => {
    serveAccounts(body({ accounts: [defaultRow(), workRow({ kind: "own", hooks: "missing" })] }));
    mount("/settings/accounts/acc-work");
    expect(await screen.findByText("Collie's hooks are not installed in this folder. Sessions here may not show as agents.")).toBeInTheDocument();
    expect(screen.getByText("CLAUDE_CONFIG_DIR=~/.claude-work collie hooks install claude")).toBeInTheDocument();
  });

  it("draws neither notice for installed hooks and a clean link pass", async () => {
    serveAccounts(body({ accounts: [defaultRow(), workRow({ hooks: "installed", unlinked: [] })] }));
    mount("/settings/accounts/acc-work");
    await screen.findByText("Shares setup and sessions with Default");
    expect(screen.queryByText(/Not linked/)).toBeNull();
    expect(screen.queryByText(/hooks are not installed/)).toBeNull();
  });

  it("asks once before Remove, then forgets the label and returns to the list", async () => {
    serveAccounts(body({ accounts: [defaultRow(), workRow()] }));
    const posted: unknown[] = [];
    server.use(
      http.post("/api/accounts/remove", async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );
    const router = mount("/settings/accounts/acc-work");
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(posted).toHaveLength(0);
    expect(await screen.findByText(/Remove forgets the label only/)).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ id: "acc-work" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/accounts"));
  });

  it("Sign in again starts the agent with the account and the sign-in flag, then lands on the pane", async () => {
    serveAccounts(body({ accounts: [defaultRow(), workRow()] }));
    const posted: unknown[] = [];
    server.use(
      http.post("/api/launch", async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ ok: true, pane: { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "new", tabId: "w9:t1", cwd: "/home/op" } });
      }),
    );
    const router = mount("/settings/accounts/acc-work");
    await userEvent.click(await screen.findByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    expect(posted).toEqual([{ harness: "claude", account: "acc-work", signIn: true, requestId: expect.any(String) }]);
  });

  it("Sign in again for Default names the agent alone, with no account", async () => {
    serveAccounts(body());
    const posted: unknown[] = [];
    server.use(
      http.post("/api/launch", async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ ok: true, pane: { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "new", tabId: "w9:t1", cwd: "/home/op" } });
      }),
    );
    mount(`/settings/accounts/${encodeURIComponent("claude:default")}`);
    await userEvent.click(await screen.findByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ harness: "claude", signIn: true, requestId: expect.any(String) });
  });

  it("a refused sign-in start is said on the page", async () => {
    serveAccounts(body({ accounts: [defaultRow(), workRow()] }));
    server.use(http.post("/api/launch", () => HttpResponse.json({ ok: false, error: "x", code: "accounts.unknown" }, { status: 400 })));
    mount("/settings/accounts/acc-work");
    await userEvent.click(await screen.findByRole("button", { name: "Sign in again" }));
    expect(await screen.findByText(/The sign-in did not start: This profile does not exist any more/)).toBeInTheDocument();
  });

  it("opens with the reason when the start after Create failed", async () => {
    serveAccounts(body({ accounts: [defaultRow(), workRow()] }));
    rememberStartError("acc-work", "no screen here");
    mount("/settings/accounts/acc-work");
    expect(await screen.findByText("The sign-in did not start: no screen here")).toBeInTheDocument();
  });

  it("an id the list does not hold reads as gone", async () => {
    serveAccounts(body());
    mount("/settings/accounts/acc-missing");
    expect(await screen.findByText("This profile is not in the list any more.")).toBeInTheDocument();
  });
});

describe("Accounts: Add", () => {
  it("offers the kinds only where the agent offers both, and shows the folder and the terminal line", async () => {
    serveAccounts(body({ harnesses: [HARNESS_CLAUDE, HARNESS_CODEX], accounts: [defaultRow()] }));
    mount("/settings/accounts/add");
    const name = await screen.findByRole("textbox", { name: "Name" });
    expect(screen.getByRole("radio", { name: "Shared with Default" })).toBeInTheDocument();
    await userEvent.type(name, "Work");
    expect(screen.getAllByText("~/.claude-work").length).toBeGreaterThan(0);
    expect(screen.getByText("CLAUDE_CONFIG_DIR=~/.claude-work claude")).toBeInTheDocument();
    expect(screen.getByText("Collie makes the folder and the links")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Agent" }), "Codex");
    expect(screen.queryByRole("radio", { name: "Shared with Default" })).toBeNull();
    expect(screen.getByText("Collie uses the folder as it is")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Folder" })).toBeInTheDocument();
  });

  it("shows no terminal line for an own folder the page already knows is invalid, and no error text", async () => {
    serveAccounts(body({ harnesses: [HARNESS_CLAUDE, HARNESS_CODEX], accounts: [defaultRow()] }));
    mount("/settings/accounts/add");
    await screen.findByRole("textbox", { name: "Name" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Agent" }), "Codex");
    const folder = screen.getByRole("textbox", { name: "Folder" });
    await userEvent.type(folder, "/home/op/ok");
    expect(screen.getByText("The same profile from a desktop terminal")).toBeInTheDocument();
    await userEvent.type(folder, "$x");
    expect(screen.queryByText("The same profile from a desktop terminal")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await userEvent.clear(folder);
    await userEvent.type(folder, "/home/op/ok");
    expect(screen.getByText("The same profile from a desktop terminal")).toBeInTheDocument();
  });

  it("creates a shared account, then starts the sign-in on the same agent and lands on the pane", async () => {
    serveAccounts(body());
    const added: unknown[] = [];
    const started: unknown[] = [];
    server.use(
      http.post("/api/accounts", async ({ request }) => {
        added.push(await request.json());
        return HttpResponse.json({ account: workRow() });
      }),
      http.post("/api/launch", async ({ request }) => {
        started.push(await request.json());
        return HttpResponse.json({ ok: true, pane: { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "new", tabId: "w9:t1", cwd: "/home/op" } });
      }),
    );
    const router = mount("/settings/accounts/add");
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "Work");
    await userEvent.click(screen.getByRole("button", { name: "Create and sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    expect(added).toEqual([{ harness: "claude", label: "Work", kind: "shared", requestId: expect.any(String) }]);
    expect(started).toEqual([{ harness: "claude", account: "acc-work", signIn: true, requestId: expect.any(String) }]);
  });

  it("an own folder is chosen from the found ones and sent by its absolute path", async () => {
    serveAccounts(body({ found: [FOUND_ALT] }));
    const added: unknown[] = [];
    server.use(
      http.post("/api/accounts", async ({ request }) => {
        added.push(await request.json());
        return HttpResponse.json({ account: workRow({ kind: "own" }) });
      }),
      http.post("/api/launch", () => HttpResponse.json({ ok: false, error: "x" }, { status: 400 })),
    );
    mount("/settings/accounts/add");
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "Alt");
    await userEvent.click(screen.getByRole("radio", { name: "Own folder" }));
    await userEvent.click(screen.getByRole("radio", { name: "~/.claude-alt" }));
    expect(screen.getByRole("textbox", { name: "Folder" })).toHaveValue("~/.claude-alt");
    await userEvent.click(screen.getByRole("button", { name: "Create and sign in" }));
    await waitFor(() => expect(added).toHaveLength(1));
    expect(added[0]).toMatchObject({ harness: "claude", label: "Alt", kind: "own", path: "/home/op/.claude-alt" });
  });

  it("the own-folder field says once, whatever is typed, that a missing folder is made empty", async () => {
    serveAccounts(body({ found: [FOUND_ALT] }));
    mount("/settings/accounts/add");
    await userEvent.click(await screen.findByRole("radio", { name: "Own folder" }));
    const hint = "If the folder does not exist yet, Collie makes it empty.";
    expect(screen.getAllByText(hint)).toHaveLength(1);
    await userEvent.type(screen.getByRole("textbox", { name: "Folder" }), "~/.claude-new");
    expect(screen.getAllByText(hint)).toHaveLength(1);
    await userEvent.click(screen.getByRole("radio", { name: "~/.claude-alt" }));
    expect(screen.getAllByText(hint)).toHaveLength(1);
    // The shared kind has no folder field, and no such line.
    await userEvent.click(screen.getByRole("radio", { name: "Shared with Default" }));
    expect(screen.queryByText(hint)).toBeNull();
  });

  it("the button waits for a name", async () => {
    serveAccounts(body());
    mount("/settings/accounts/add");
    expect(await screen.findByRole("button", { name: "Create and sign in" })).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Work");
    expect(screen.getByRole("button", { name: "Create and sign in" })).toBeEnabled();
  });

  it("a refused add stays on the form with the bridge's reason, and starts nothing", async () => {
    serveAccounts(body());
    let launched = 0;
    server.use(
      http.post("/api/accounts", () => HttpResponse.json({ ok: false, error: "x", code: "accounts.folder_taken" }, { status: 409 })),
      http.post("/api/launch", () => {
        launched += 1;
        return HttpResponse.json({ ok: false, error: "x" }, { status: 400 });
      }),
    );
    const router = mount("/settings/accounts/add");
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "Work");
    await userEvent.click(screen.getByRole("button", { name: "Create and sign in" }));
    expect(await screen.findByText("Another profile already uses this folder.")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings/accounts/add");
    expect(launched).toBe(0);
  });

  it("when the sign-in cannot start the account stays and its page opens with the reason", async () => {
    serveAccounts(body({ accounts: [defaultRow(), workRow()] }));
    server.use(
      http.post("/api/accounts", () => HttpResponse.json({ account: workRow() })),
      http.post("/api/launch", () => HttpResponse.json({ ok: false, error: "x", code: "launch.bad_folder" }, { status: 400 })),
    );
    const router = mount("/settings/accounts/add");
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "Work");
    await userEvent.click(screen.getByRole("button", { name: "Create and sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/accounts/acc-work"));
    expect(await screen.findByText(/The sign-in did not start: /)).toBeInTheDocument();
  });
});

describe("Accounts: the same login twice", () => {
  const ME = { signedIn: true, email: "me@example.com", plan: "max" };

  it("each of two profiles with one login names the other, on the list and on the profile's page", async () => {
    serveAccounts(body({ accounts: [defaultRow({ identity: ME }), workRow({ identity: { ...ME, email: "Me@Example.com" } })] }));
    const router = mount("/settings/accounts");
    expect(await screen.findByText("Same login as Work.")).toBeInTheDocument();
    expect(screen.getByText("Same login as Default.")).toBeInTheDocument();
    await router.navigate("/settings/accounts/acc-work");
    expect(await screen.findByText("Signed in as")).toBeInTheDocument();
    expect(screen.getByText("Same login as Default.")).toBeInTheDocument();
    expect(screen.queryByText("Same login as Work.")).toBeNull();
  });

  it("is not said for different logins, another agent's profile, or a profile not signed in", async () => {
    serveAccounts(
      body({
        harnesses: [HARNESS_CLAUDE, HARNESS_CODEX],
        accounts: [
          defaultRow({ identity: ME }),
          workRow({ identity: { signedIn: true, email: "other@example.com" } }),
          defaultRow({ id: "codex:default", harness: "codex", folder: "~/.codex", identity: ME }),
          workRow({ id: "acc-spare", label: "Spare", folder: "~/.claude-spare", identity: { signedIn: false, email: "me@example.com" } }),
        ],
      }),
    );
    mount("/settings/accounts");
    expect(await screen.findByText("Spare")).toBeInTheDocument();
    expect(screen.queryByText(/Same login as/)).toBeNull();
  });
});

describe("Accounts: who is signed in", () => {
  it("the list shows the email under the name, 'Not signed in', or nothing when the agent cannot tell", async () => {
    serveAccounts(
      body({
        harnesses: [HARNESS_CLAUDE, HARNESS_CODEX],
        accounts: [
          defaultRow({ identity: { signedIn: true, email: "me@example.com", plan: "max" } }),
          workRow({ identity: { signedIn: false } }),
          defaultRow({ id: "codex:default", harness: "codex", folder: "~/.codex" }),
        ],
      }),
    );
    mount("/settings/accounts");
    expect(await screen.findByText("me@example.com")).toBeInTheDocument();
    expect(screen.getByText("Not signed in")).toBeInTheDocument();
    // The plan is for the account's page only.
    expect(screen.queryByText(/Max/)).toBeNull();
    const codex = screen.getByRole("region", { name: "Codex" });
    expect(within(codex).queryByText(/signed in|@/)).toBeNull();
  });

  it("a long email keeps both ends in the list and the whole address on the account's page", async () => {
    const email = "someone.with.a.long.name@engineering.example-company.com";
    serveAccounts(body({ accounts: [defaultRow(), workRow({ identity: { signedIn: true, email, plan: "max" } })] }));
    const router = mount("/settings/accounts");
    const row = await screen.findByRole("button", { name: /Work/ });
    expect(row).toHaveTextContent(email);
    await router.navigate("/settings/accounts/acc-work");
    expect(await screen.findByText("Signed in as")).toBeInTheDocument();
    expect(screen.getByText(`${email} · Max`)).toBeInTheDocument();
  });

  it("the account's page says 'Not signed in', and draws no row when the agent cannot tell", async () => {
    serveAccounts(body({ accounts: [defaultRow({ identity: { signedIn: false } }), workRow()] }));
    mount(`/settings/accounts/${encodeURIComponent("claude:default")}`);
    expect(await screen.findByText("Not signed in")).toBeInTheDocument();
    expect(screen.queryByText("Signed in as")).toBeNull();
    cleanup();
    mount("/settings/accounts/acc-work");
    expect(await screen.findByText("Shares setup and sessions with Default")).toBeInTheDocument();
    expect(screen.queryByText("Signed in as")).toBeNull();
    expect(screen.queryByText("Not signed in")).toBeNull();
  });
});
