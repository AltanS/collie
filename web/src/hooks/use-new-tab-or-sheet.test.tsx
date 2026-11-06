import { act, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import type { AgentView, LauncherItem, LaunchersResponse } from "@/lib/types";
import type { Scope } from "@/lib/scope";
import { server } from "@/test/msw";
import { besideOf, useNewTabOrSheet, type NewTabActions, type NewTabTarget } from "./use-new-tab-or-sheet";

const SHELL: LauncherItem = { key: "shell", start: { shell: true }, group: "commands", label: "Shell", source: "builtin", noPrompts: false, branch: true, available: true };
const CLAUDE: LauncherItem = { key: "harness:claude", start: { harness: "claude" }, group: "agents", label: "Claude Code", harness: "claude", source: "builtin", noPrompts: false, branch: true, available: true };
const CODEX_OFF: LauncherItem = { ...CLAUDE, key: "harness:codex", start: { harness: "codex" }, label: "Codex", harness: "codex", available: false, reason: "not_found" };

/** Serves `items` per host (`?host=`, absent for the lead), counting the reads, optionally held until released. */
function serve(byHost: Record<string, LauncherItem[]>) {
  const reads: string[] = [];
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  server.use(
    http.get("/api/launchers", async ({ request }) => {
      const host = new URL(request.url).searchParams.get("host") ?? "";
      reads.push(host);
      if (gate !== null) await gate;
      const body: LaunchersResponse = { launchers: [], home: "/home/op", harnesses: [], items: byHost[host] ?? [SHELL] };
      return HttpResponse.json(body);
    }),
  );
  return {
    reads,
    hold: () => {
      gate = new Promise<void>((resolve) => (open = resolve));
    },
    release: () => {
      gate = null;
      open?.();
    },
  };
}

const BESIDE = { paneId: "w1:p1", workspaceId: "w1", cwd: "/home/op/webapp" };

function mount(opts: { refuse?: boolean; ambient?: Scope } = {}) {
  const calls = { newTab: new Array<[string, Scope | undefined]>(), start: 0 };
  const actions: NewTabActions = {
    newTab: async (workspaceId, at) => {
      calls.newTab.push([workspaceId, at]);
    },
    start: async () => {
      calls.start += 1;
      return { kind: "done" };
    },
    refuseCreate: () => opts.refuse === true,
  };
  let request: (t: NewTabTarget) => void = () => {};
  function Harness() {
    const plus = useNewTabOrSheet(actions, opts.ambient);
    request = plus.request;
    return <>{plus.sheet}</>;
  }
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Harness /> }])} />);
  return { calls, tap: (t: NewTabTarget) => request(t) };
}

const dialog = (name: string) => screen.queryByRole("dialog", { name });

describe("useNewTabOrSheet", () => {
  it("opens the sheet for a machine with an agent to offer, titled with the workspace", async () => {
    const world = serve({ "": [CLAUDE, SHELL] });
    const { calls, tap } = mount();
    await waitFor(() => expect(world.reads).toHaveLength(1));
    act(() => tap({ workspaceId: "w1", label: "webapp", beside: BESIDE }));
    const sheet = within(await screen.findByRole("dialog", { name: "New tab in webapp" }));
    expect(await sheet.findByRole("button", { name: /Claude Code/ })).toBeEnabled();
    expect(calls.newTab).toEqual([]);
  });

  it("makes the shell at once, with no sheet, when nothing beyond the shell can start", async () => {
    const world = serve({ "": [CODEX_OFF, SHELL] });
    const { calls, tap } = mount();
    await waitFor(() => expect(world.reads).toHaveLength(1));
    // Wait for the answer itself, not only the request: the decision is made on the tap.
    await new Promise((r) => setTimeout(r, 50));
    act(() => tap({ workspaceId: "w1", label: "webapp", beside: BESIDE }));
    expect(dialog("New tab in webapp")).toBeNull();
    expect(calls.newTab).toEqual([["w1", undefined]]);
    // It reads again behind the shell, so a row added since shows on the next "+".
    await waitFor(() => expect(world.reads.length).toBeGreaterThan(1));
  });

  it("gives the refusal first: no sheet, no create", async () => {
    serve({ "": [CLAUDE, SHELL] });
    const { calls, tap } = mount({ refuse: true });
    act(() => tap({ workspaceId: "w1", label: "webapp", beside: BESIDE }));
    await new Promise((r) => setTimeout(r, 20));
    expect(dialog("New tab in webapp")).toBeNull();
    expect(calls.newTab).toEqual([]);
  });

  it("makes the plain tab when no pane of the workspace is in hand", async () => {
    serve({ "": [CLAUDE, SHELL] });
    const { calls, tap } = mount();
    act(() => tap({ workspaceId: "w1", label: "webapp", at: { host: "minibuch" } }));
    await waitFor(() => expect(calls.newTab).toEqual([["w1", { host: "minibuch" }]]));
    expect(dialog("New tab in webapp")).toBeNull();
  });

  it("reads the tapped heading's own machine, and lists none of the ambient machine's rows meanwhile", async () => {
    const world = serve({ "": [CLAUDE, SHELL], minibuch: [CODEX_OFF, { ...CLAUDE, label: "Claude on minibuch" }, SHELL] });
    const { tap } = mount();
    await waitFor(() => expect(world.reads).toEqual([""]));
    world.hold();
    act(() => tap({ workspaceId: "w1", label: "notes", at: { host: "minibuch" }, beside: BESIDE }));
    const sheet = within(await screen.findByRole("dialog", { name: "New tab in notes" }));
    expect(sheet.getByText("Reading the agents on this machine…")).toBeInTheDocument();
    expect(sheet.queryByRole("button", { name: /Claude Code/ })).toBeNull();
    world.release();
    expect(await sheet.findByRole("button", { name: /Claude on minibuch/ })).toBeEnabled();
    expect(world.reads).toEqual(["", "minibuch"]);
  });

  it("steps aside for the shell when the answer that comes in offers nothing", async () => {
    const world = serve({ minibuch: [CODEX_OFF, SHELL] });
    const { calls, tap } = mount();
    await waitFor(() => expect(world.reads).toEqual([""]));
    world.hold();
    act(() => tap({ workspaceId: "w4", label: "notes", at: { host: "minibuch" }, beside: BESIDE }));
    expect(await screen.findByRole("dialog", { name: "New tab in notes" })).toBeInTheDocument();
    world.release();
    await waitFor(() => expect(calls.newTab).toEqual([["w4", { host: "minibuch" }]]));
    await waitFor(() => expect(dialog("New tab in notes")).toBeNull());
  });

  it("reads the list again on every opening", async () => {
    const world = serve({ "": [CLAUDE, SHELL] });
    const { tap } = mount();
    await waitFor(() => expect(world.reads).toHaveLength(1));
    act(() => tap({ workspaceId: "w1", label: "webapp", beside: BESIDE }));
    await screen.findByRole("dialog", { name: "New tab in webapp" });
    await waitFor(() => expect(world.reads).toHaveLength(2));
  });
});

describe("besideOf", () => {
  const pane = (paneId: string, workspaceId: string, host?: string): AgentView => {
    const p: AgentView = {
      paneId,
      workspaceId,
      workspaceLabel: "x",
      workspaceNumber: 1,
      tabId: `${workspaceId}:t1`,
      agent: "shell",
      status: "idle",
      cwd: `/home/op/${paneId}`,
      focused: false,
    };
    if (host !== undefined) p.host = host;
    return p;
  };

  it("takes the workspace's first pane on that machine, never the same-numbered space of another", () => {
    const panes = [pane("w1:p9", "w1", "atlas"), pane("w2:p1", "w2"), pane("w1:p1", "w1"), pane("w1:p2", "w1")];
    expect(besideOf(panes, "w1", undefined)).toEqual({ paneId: "w1:p1", workspaceId: "w1", cwd: "/home/op/w1:p1" });
    expect(besideOf(panes, "w1", "atlas")?.paneId).toBe("w1:p9");
    expect(besideOf(panes, "w3", undefined)).toBeUndefined();
  });
});
