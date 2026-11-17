import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import type { AccountHarness, AccountIdentity, AccountRow } from "@/lib/accounts";
import type { AgentView } from "@/lib/types";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { flowOf, forgetFlow, rememberFlow } from "@/lib/change-login";
import { body, defaultRow, HARNESS_CLAUDE, HARNESS_CODEX, serveAccounts, workRow } from "@/test/accounts-fixtures";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { SettingsAccountRoute } from "./settings-accounts";
import { ChangeLoginResultView, SettingsChangeLoginRoute } from "./settings-change-login";

// CHANGE LOGIN (M101): the account's page offers it where the account reads signed in; its own page says
// who is signed in and what happens to the sessions that run, starts the same sign-in as "Sign in again",
// and after Finish says who is signed in now. Made-up addresses only.

const ME: AccountIdentity = { signedIn: true, email: "me@example.com", plan: "max" };
const OTHER: AccountIdentity = { signedIn: true, email: "other@example.com", plan: "pro" };
const CLAUDE = { ...HARNESS_CLAUDE, reachesRunningSessions: true as const, signInHosts: ["claude.com", "platform.claude.com"] };
const PANE = { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "sign-in", tabId: "w9:t1", cwd: "/home/op/.local/state/collie/sign-in" };

/** A running agent pane of the snapshot, named by its session name. */
function agentPane(paneId: string, over: Partial<AgentView> = {}): AgentView {
  return { paneId, workspaceId: "w1", workspaceLabel: "lodge", workspaceNumber: 1, tabId: "w1:t1", agent: "claude", status: "working", cwd: "/home/dev/lodge", focused: false, ...over };
}

/** The page under the root route, whose data is the snapshot the sessions' names come from. */
function mount(entries: string[], agents: AgentView[] = []) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => null,
        children: [
          { index: true, element: <div data-testid="home" /> },
          { path: "settings/accounts", element: <div data-testid="list" /> },
          { path: "settings/accounts/:id", element: withHeaderHost(<SettingsAccountRoute />) },
          { path: "settings/accounts/:id/login", element: withHeaderHost(<SettingsChangeLoginRoute />) },
          { path: "pane/:paneId", element: <div data-testid="pane" /> },
        ],
      },
    ],
    {
      initialEntries: entries,
      initialIndex: entries.length - 1,
      hydrationData: { loaderData: { [ROOT_ROUTE_ID]: { agents, shellPanes: [], workspaces: [], tabs: [], sessions: [], servers: [] } } },
    },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** Serve the list with `rows`, swapping to `then` once a pane was closed. */
function serveList(rows: AccountRow[], then?: AccountRow[], harnesses: AccountHarness[] = [CLAUDE]) {
  let closed = false;
  const closes: string[] = [];
  server.use(
    http.get("/api/accounts", () => HttpResponse.json(body({ harnesses, accounts: closed && then !== undefined ? then : rows }))),
    http.post("/api/pane/:paneId/close", ({ params }) => {
      closed = true;
      closes.push(String(params.paneId));
      return HttpResponse.json({ ok: true });
    }),
  );
  return closes;
}

function serveLaunch(posted: unknown[]) {
  server.use(
    http.post("/api/launch", async ({ request }) => {
      posted.push(await request.json());
      return HttpResponse.json({ ok: true, pane: PANE });
    }),
  );
}

afterEach(() => {
  cleanup();
  forgetFlow("acc-work");
  forgetFlow("claude:default");
});

describe("Change login: the account's page", () => {
  it("offers Change login where the account reads signed in, and Sign in again where it does not or cannot tell", async () => {
    serveAccounts(body({ harnesses: [CLAUDE], accounts: [defaultRow({ identity: { signedIn: false } }), workRow({ identity: ME })] }));
    const router = mount(["/settings/accounts", "/settings/accounts/acc-work"]);
    await userEvent.click(await screen.findByRole("button", { name: "Change login" }));
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/accounts/acc-work/login"));
    cleanup();
    mount(["/settings/accounts", `/settings/accounts/${encodeURIComponent("claude:default")}`]);
    expect(await screen.findByRole("button", { name: "Sign in again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change login" })).toBeNull();
  });
});

describe("Change login: before the start", () => {
  it("says who is signed in, that the running sessions continue, how many run, and that the old login stays", async () => {
    serveList([defaultRow(), workRow({ identity: ME, running: 2 })]);
    mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"]);
    expect(await screen.findByText("me@example.com · Max")).toBeInTheDocument();
    expect(screen.getByText("Its sessions follow.")).toBeInTheDocument();
    expect(screen.getByText("2 sessions of this profile are running now.")).toBeInTheDocument();
    expect(screen.getByText("The old login stays until the new sign-in works.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change login" })).toBeInTheDocument();
  });

  it("one running session reads in the singular, and an account no session uses has no count line", async () => {
    serveList([defaultRow(), workRow({ identity: ME, running: 1 })]);
    mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"]);
    expect(await screen.findByText("1 session of this profile is running now.")).toBeInTheDocument();
    cleanup();
    serveList([defaultRow(), workRow({ identity: ME })]);
    mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"]);
    expect(await screen.findByText("Its sessions follow.")).toBeInTheDocument();
    expect(screen.queryByText(/running now/)).toBeNull();
  });

  it("says what the page does first, under who is signed in and above the reach line", async () => {
    serveList([defaultRow(), workRow({ identity: ME, running: 2 })]);
    mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"]);
    const signedIn = await screen.findByText("me@example.com · Max");
    const what = screen.getByText("This profile gets another login.");
    const reach = screen.getByText("Its sessions follow.");
    expect(signedIn.compareDocumentPosition(what) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(what.compareDocumentPosition(reach) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says the other profiles keep their login only where the agent has more than one profile", async () => {
    serveList([defaultRow(), workRow({ identity: ME })]);
    mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"]);
    expect(await screen.findByText("Your other profiles keep their login.")).toBeInTheDocument();
    expect(screen.getByText("The old login stays until the new sign-in works.")).toBeInTheDocument();
    cleanup();
    // Default alone for Claude Code, while another agent's profile does not count.
    const codexOnly = defaultRow({ id: "codex:default", harness: "codex", folder: "~/.codex" });
    serveList([defaultRow({ identity: ME }), codexOnly], undefined, [CLAUDE, HARNESS_CODEX]);
    mount(["/settings/accounts/claude%3Adefault", `/settings/accounts/${encodeURIComponent("claude:default")}/login`]);
    expect(await screen.findByText("This profile gets another login.")).toBeInTheDocument();
    expect(screen.queryByText("Your other profiles keep their login.")).toBeNull();
  });

  it("lists the sessions that run in the profile, named from the snapshot, with their space", async () => {
    const agents = [
      agentPane("w1:p1", { sessionName: "Fix the build" }),
      agentPane("w2:p1", { workspaceId: "w2", workspaceLabel: "workshop", tabId: "w2:t1", sessionName: "Write docs" }),
    ];
    serveList([defaultRow(), workRow({ identity: ME, running: 2, panes: ["w1:p1", "w2:p1"] })]);
    mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"], agents);
    const first = await screen.findByRole("button", { name: /Fix the build/ });
    expect(first).toHaveTextContent("lodge");
    expect(screen.getByRole("button", { name: /Write docs/ })).toHaveTextContent("workshop");
    expect(screen.getByText("Sessions outside Collie that use this profile follow too.")).toBeInTheDocument();
  });

  it("a tap on a session goes to it", async () => {
    serveList([defaultRow(), workRow({ identity: ME, running: 1, panes: ["w1:p1"] })]);
    const router = mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"], [agentPane("w1:p1", { sessionName: "Fix the build" })]);
    await userEvent.click(await screen.findByRole("button", { name: /Fix the build/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w1%3Ap1"));
  });

  it("skips a pane id the snapshot does not know, and draws no list and no outside line with no pane", async () => {
    serveList([defaultRow(), workRow({ identity: ME, running: 2, panes: ["w1:p1", "w9:p9"] })]);
    mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"], [agentPane("w1:p1", { sessionName: "Fix the build" })]);
    expect(await screen.findByRole("button", { name: /Fix the build/ })).toBeInTheDocument();
    expect(screen.queryByText(/w9:p9/)).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    cleanup();
    serveList([defaultRow(), workRow({ identity: ME, running: 1, panes: ["w9:p9"] })]);
    mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"], [agentPane("w1:p1")]);
    expect(await screen.findByText("Its sessions follow.")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.queryByText(/outside Collie/)).toBeNull();
    cleanup();
    serveList([defaultRow(), workRow({ identity: ME })]);
    mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"], [agentPane("w1:p1")]);
    expect(await screen.findByText("Its sessions follow.")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.queryByText(/outside Collie/)).toBeNull();
  });

  it("an agent whose sign-in does not reach running sessions shows no list and no outside line", async () => {
    const codex = defaultRow({ id: "codex:default", harness: "codex", folder: "~/.codex", identity: ME, running: 1, panes: ["w1:p1"] });
    serveList([codex], undefined, [HARNESS_CODEX]);
    mount(["/settings/accounts/codex%3Adefault", `/settings/accounts/${encodeURIComponent("codex:default")}/login`], [agentPane("w1:p1", { sessionName: "Fix the build" })]);
    expect(await screen.findByText("Sessions you start from now on use the new login.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Fix the build/ })).toBeNull();
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.queryByText(/outside Collie/)).toBeNull();
  });

  it("an agent whose sign-in is not proven to reach running sessions says only new sessions use it, with no count", async () => {
    const codex = defaultRow({ id: "codex:default", harness: "codex", folder: "~/.codex", identity: ME, running: 3 });
    serveList([codex], undefined, [HARNESS_CODEX]);
    mount(["/settings/accounts/codex%3Adefault", `/settings/accounts/${encodeURIComponent("codex:default")}/login`]);
    expect(await screen.findByText("Sessions you start from now on use the new login.")).toBeInTheDocument();
    expect(screen.getByText("This profile gets another login.")).toBeInTheDocument();
    expect(screen.queryByText("Its sessions follow.")).toBeNull();
    expect(screen.queryByText(/running now/)).toBeNull();
  });
});

describe("Change login: the start and the end", () => {
  it("starts the same sign-in as Sign in again, lands on the sign-in session, and remembers the flow", async () => {
    serveList([defaultRow(), workRow({ identity: ME })]);
    const posted: unknown[] = [];
    serveLaunch(posted);
    const router = mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"]);
    await userEvent.click(await screen.findByRole("button", { name: "Change login" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    expect(posted).toEqual([{ harness: "claude", account: "acc-work", signIn: true, requestId: expect.any(String) }]);
    expect(flowOf("acc-work")).toMatchObject({ account: "acc-work", paneId: "w9:p1", before: ME });
  });

  it("Default names the agent alone, as Sign in again does", async () => {
    serveList([defaultRow({ identity: ME })]);
    const posted: unknown[] = [];
    serveLaunch(posted);
    mount(["/settings/accounts/claude%3Adefault", `/settings/accounts/${encodeURIComponent("claude:default")}/login`]);
    await userEvent.click(await screen.findByRole("button", { name: "Change login" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ harness: "claude", signIn: true, requestId: expect.any(String) });
  });

  it("a refused start is said on the page and remembers nothing", async () => {
    serveList([defaultRow(), workRow({ identity: ME })]);
    server.use(http.post("/api/launch", () => HttpResponse.json({ ok: false, error: "x", code: "accounts.unknown" }, { status: 400 })));
    mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"]);
    await userEvent.click(await screen.findByRole("button", { name: "Change login" }));
    expect(await screen.findByText(/The sign-in did not start/)).toBeInTheDocument();
    expect(flowOf("acc-work")).toBeUndefined();
  });

  it("back on the page while the sign-in runs: Open sign-in goes to it, Finish closes it and says the new login", async () => {
    rememberFlow({ account: "acc-work", paneId: "w9:p1", before: ME, from: "/settings/accounts/acc-work" });
    const closes = serveList([defaultRow(), workRow({ identity: ME })], [defaultRow(), workRow({ identity: OTHER })]);
    const router = mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"]);
    expect(await screen.findByText("The sign-in runs in its own session. Sign in there, then come back here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open sign-in" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(await screen.findByText("Signed in as other@example.com")).toBeInTheDocument();
    expect(screen.getByText("Pro plan")).toBeInTheDocument();
    expect(screen.getByText("Your running sessions use this login from their next message.")).toBeInTheDocument();
    expect(closes).toEqual(["w9:p1"]);
    expect(flowOf("acc-work")).toBeUndefined();
    await userEvent.click(screen.getByRole("button", { name: "Back to the profile" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/accounts/acc-work"));
  });

  it("the same account signed in again, or a sign-in left or refused, reads 'Still signed in as'", async () => {
    rememberFlow({ account: "acc-work", paneId: "w9:p1", before: ME, from: null });
    serveList([defaultRow(), workRow({ identity: ME })], [defaultRow(), workRow({ identity: ME })]);
    mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"]);
    await userEvent.click(await screen.findByRole("button", { name: "Finish" }));
    expect(await screen.findByText("Still signed in as me@example.com")).toBeInTheDocument();
    expect(screen.queryByText(/use this login from their next message/)).toBeNull();
  });

  it("a folder that reads signed out after the flow says the sign-in did not finish", async () => {
    rememberFlow({ account: "acc-work", paneId: "w9:p1", before: undefined, from: null });
    serveList([defaultRow(), workRow({ identity: { signedIn: false } })], [defaultRow(), workRow({ identity: { signedIn: false } })]);
    mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"]);
    await userEvent.click(await screen.findByRole("button", { name: "Finish" }));
    expect(await screen.findByText("The sign-in did not finish.")).toBeInTheDocument();
  });

  it("finishes on its own once the agent names a new email while the sign-in runs, and goes back to the session it came from", async () => {
    rememberFlow({ account: "acc-work", paneId: "w9:p1", before: ME, from: "/pane/w1%3Ap3" });
    // The bridge already re-read the agent: the list names the new login before Finish.
    const closes = serveList([defaultRow(), workRow({ identity: OTHER })], [defaultRow(), workRow({ identity: OTHER })]);
    const router = mount(["/pane/w1%3Ap3", "/settings/accounts/acc-work/login"]);
    expect(await screen.findByText("Signed in as other@example.com")).toBeInTheDocument();
    expect(closes).toEqual(["w9:p1"]);
    await userEvent.click(screen.getByRole("button", { name: "Back to the session" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w1%3Ap3"));
  });

  it("a list answer with no accounts field after Finish says the agent did not say, and the page stands", async () => {
    rememberFlow({ account: "acc-work", paneId: "w9:p1", before: ME, from: null });
    let closed = false;
    server.use(
      http.get("/api/accounts", () => HttpResponse.json(closed ? { version: 99 } : body({ harnesses: [CLAUDE], accounts: [defaultRow(), workRow({ identity: ME })] }))),
      http.post("/api/pane/:paneId/close", () => {
        closed = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"]);
    await userEvent.click(await screen.findByRole("button", { name: "Finish" }));
    expect(await screen.findByText(/did not say who is signed in now/, undefined, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Back to the/ })).toBeInTheDocument();
  }, 20_000);

  it("a close that fails says the sign-in session may still be open", async () => {
    rememberFlow({ account: "acc-work", paneId: "w9:p1", before: ME, from: null });
    server.use(
      http.get("/api/accounts", () => HttpResponse.json(body({ harnesses: [CLAUDE], accounts: [defaultRow(), workRow({ identity: ME })] }))),
      http.post("/api/pane/:paneId/close", () => HttpResponse.json({ ok: false, error: "gone", code: "pane.close_failed" })),
    );
    mount(["/settings/accounts/acc-work", "/settings/accounts/acc-work/login"]);
    await userEvent.click(await screen.findByRole("button", { name: "Finish" }));
    expect(await screen.findByText("The sign-in session may still be open. Close it from its own page.")).toBeInTheDocument();
  });
});

describe("Change login: the result screen", () => {
  it("an agent that did not say who is signed in says so, and one not proven to reach running sessions says new ones use it", () => {
    render(<ChangeLoginResultView result={{ kind: "unknown" }} reach={{ kind: "running", count: 0 }} stillOpen={false} backTo="account" onBack={() => {}} />);
    expect(screen.getByText(/The agent did not say who is signed in now/)).toBeInTheDocument();
    cleanup();
    render(<ChangeLoginResultView result={{ kind: "changed", email: "other@example.com" }} reach={{ kind: "newOnly" }} stillOpen={false} backTo="session" onBack={() => {}} />);
    expect(screen.getByText("Signed in as other@example.com")).toBeInTheDocument();
    expect(screen.getByText("Sessions you start from now on use the new login.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to the session" })).toBeInTheDocument();
  });
});
