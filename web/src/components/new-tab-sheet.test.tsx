import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import type { StartAsk, StartOutcome } from "@/hooks/use-spaces";
import { launchersKey, type LaunchersState } from "@/lib/launchers";
import type { Scope } from "@/lib/scope";
import type { LauncherItem } from "@/lib/types";
import { NewTabSheet } from "./new-tab-sheet";

const HOME = "/home/op";

function item(over: Partial<LauncherItem> & Pick<LauncherItem, "key" | "start" | "group" | "label">): LauncherItem {
  return { source: "builtin", noPrompts: false, branch: true, available: true, ...over };
}

/** A machine's list as the bridge sends it: agents, the shell, then the command rows. */
const ITEMS: LauncherItem[] = [
  item({ key: "harness:claude", start: { harness: "claude" }, group: "agents", label: "Claude Code", harness: "claude" }),
  item({ key: "harness:codex", start: { harness: "codex" }, group: "agents", label: "Codex", harness: "codex", available: false, reason: "not_found" }),
  item({
    key: "row:claude --dangerously-skip-permissions",
    start: { command: "claude --dangerously-skip-permissions" },
    group: "agents",
    label: "Claude, no prompts",
    harness: "claude",
    command: "claude --dangerously-skip-permissions",
    source: "operator",
    noPrompts: true,
  }),
  item({ key: "shell", start: { shell: true }, group: "commands", label: "Shell" }),
  item({ key: "row:htop", start: { command: "htop" }, group: "commands", label: "htop", command: "htop", source: "operator", branch: false }),
  item({
    key: "row:make logs",
    start: { command: "make logs" },
    group: "commands",
    label: "Logs",
    command: "make logs",
    cwd: `${HOME}/infra`,
    source: "operator",
    branch: false,
    from: "lead",
  }),
];

function launchers(scope: Scope | undefined, over: Partial<LaunchersState> = {}): LaunchersState {
  return {
    launchers: [],
    home: HOME,
    harnesses: [],
    items: ITEMS,
    adding: null,
    recentRuns: null,
    loadedFor: launchersKey(scope),
    ...over,
  };
}

const BESIDE = { paneId: "w2:p1", workspaceId: "w2", cwd: `${HOME}/code/moonward` };

function mount(over: { outcomes?: StartOutcome[]; list?: LaunchersState; scope?: Scope; open?: boolean } = {}) {
  const asks: { ask: StartAsk; at: Scope | undefined }[] = [];
  const outcomes = [...(over.outcomes ?? [{ kind: "done" }])];
  // A start that waits for the test to release it, so the busy state can be read.
  let release: (() => void) | null = null;
  const calls = { closed: 0, asks, hold: false, release: () => release?.() };
  function Harness() {
    const [open, setOpen] = useState(over.open ?? true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          reopen
        </button>
        <NewTabSheet
          open={open}
          onClose={() => {
            calls.closed += 1;
            setOpen(false);
          }}
          label="moonward"
          beside={BESIDE}
          scope={over.scope}
          launchers={over.list ?? launchers(over.scope)}
          start={async (ask, at) => {
            asks.push({ ask, at });
            if (calls.hold) await new Promise<void>((resolve) => (release = resolve));
            return outcomes.shift() ?? { kind: "done" };
          }}
        />
      </>
    );
  }
  const router = createMemoryRouter(
    [
      { path: "/", element: <Harness /> },
      { path: "/new", element: <p>the new page</p> },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  return { calls, router };
}

const sheet = () => within(screen.getByRole("dialog", { name: "New tab in moonward" }));
const row = (name: RegExp | string) => sheet().getByRole("button", { name });

describe("NewTabSheet, the rows", () => {
  it("lists the agents, then the commands, then Just a shell and More options, under the workspace's folder", () => {
    mount();
    const names = sheet()
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((n) => n !== "" && !/close/i.test(n));
    expect(names.map((n) => n.split(/(?=No prompts|Lead|not installed|claude --|htop$|This command)/)[0])).toEqual([
      "Claude Code",
      "Codex",
      "Claude, no prompts",
      "htop",
      "Logs",
      "Just a shell",
      "More options",
    ]);
    expect(sheet().getByText("In ~/code/moonward")).toBeInTheDocument();
    // The section names sit above their groups, agents first.
    const text = sheet().getByText("Agents").compareDocumentPosition(sheet().getByText("Commands"));
    expect(text & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("dims an agent that cannot start and says why, and marks a no-prompts row, a lead's row and a pinned folder", () => {
    mount();
    const codex = row(/Codex/);
    expect(codex).toBeDisabled();
    expect(codex).toHaveTextContent("not installed");
    expect(row(/Claude, no prompts/)).toHaveTextContent("No prompts");
    const logs = row(/Logs/);
    expect(logs).toHaveTextContent("Lead");
    expect(logs).toHaveTextContent("This command always runs in ~/infra.");
    expect(row(/htop/)).toHaveTextContent("htop");
    expect(row(/htop/)).not.toHaveTextContent("Lead");
  });

  it("lists no rows of another machine before this machine's answer is in, and says it is reading", () => {
    mount({ scope: { host: "minibuch" }, list: launchers({ host: "atlas" }) });
    expect(sheet().queryByRole("button", { name: /Claude Code/ })).toBeNull();
    expect(sheet().getByText("Reading the agents on this machine…")).toBeInTheDocument();
    expect(row("Just a shell")).toBeEnabled();
  });

  it("draws nothing while closed", () => {
    mount({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("NewTabSheet, a tap", () => {
  it("starts an agent as a tab beside the workspace's pane, with a fresh request id, and closes on done", async () => {
    const { calls } = mount({ scope: { host: "minibuch" }, list: launchers({ host: "minibuch" }) });
    await userEvent.click(row(/Claude Code/));
    await waitFor(() => expect(calls.closed).toBe(1));
    expect(calls.asks).toHaveLength(1);
    const { ask, at } = calls.asks[0]!;
    expect(at).toEqual({ host: "minibuch" });
    expect(ask.what).toEqual({ kind: "harness", id: "claude" });
    expect(ask.beside).toEqual({ paneId: "w2:p1", workspaceId: "w2" });
    expect(ask.requestId).toMatch(/\S/);
    expect(ask.legacyShell).toBeUndefined();
    // A built-in agent carries its id in `what`; only an agent ROW sends its harness beside it.
    expect(ask.rowHarness).toBeUndefined();
    expect(ask.cwd).toBeUndefined();
  });

  it("sends a command row by its line, and an agent row with its harness", async () => {
    const { calls } = mount();
    await userEvent.click(row(/htop/));
    await waitFor(() => expect(calls.closed).toBe(1));
    expect(calls.asks[0]!.ask.what).toEqual({ kind: "row", command: "htop" });
    expect(calls.asks[0]!.ask.rowHarness).toBeUndefined();
  });

  it("takes the legacy tab path for Just a shell, the create the + always sent", async () => {
    const { calls } = mount();
    await userEvent.click(row("Just a shell"));
    await waitFor(() => expect(calls.closed).toBe(1));
    expect(calls.asks[0]!.ask).toMatchObject({ what: { kind: "shell" }, legacyShell: true, beside: { paneId: "w2:p1", workspaceId: "w2" } });
    expect(calls.asks[0]!.ask.cwd).toBeUndefined();
  });

  it("spins the tapped row and makes every row inert while a start is in flight", async () => {
    const { calls } = mount();
    calls.hold = true;
    await userEvent.click(row(/htop/));
    await waitFor(() => expect(row(/htop/)).toHaveAttribute("aria-busy", "true"));
    expect(row(/Claude Code/)).toBeDisabled();
    expect(row("Just a shell")).toBeDisabled();
    expect(row("More options")).toBeDisabled();
    await userEvent.click(row(/Claude Code/));
    expect(calls.asks).toHaveLength(1);
    calls.release();
    await waitFor(() => expect(calls.closed).toBe(1));
  });

  it("asks first for a row that skips prompts, and starts nothing on Cancel", async () => {
    localStorage.clear();
    const { calls } = mount();
    await userEvent.click(row(/Claude, no prompts/));
    const confirm = within(await screen.findByRole("dialog", { name: "Start without prompts?" }));
    await userEvent.click(confirm.getByRole("button", { name: "Cancel" }));
    expect(calls.asks).toHaveLength(0);
    await userEvent.click(row(/Claude, no prompts/));
    const again = within(await screen.findByRole("dialog", { name: "Start without prompts?" }));
    await userEvent.click(again.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(calls.asks).toHaveLength(1));
    expect(calls.asks[0]!.ask).toMatchObject({ what: { kind: "row", command: "claude --dangerously-skip-permissions" }, rowHarness: "claude" });
  });

  it("goes to the New page for this workspace on More options", async () => {
    const { calls, router } = mount({ scope: { host: "minibuch", session: "work" } });
    await userEvent.click(row("More options"));
    expect(calls.closed).toBe(1);
    expect(router.state.location.pathname).toBe("/new");
    const q = new URLSearchParams(router.state.location.search);
    expect(q.get("beside")).toBe("w2:p1");
    expect(q.get("machine")).toBe("minibuch");
    expect(q.get("s")).toBe("work");
    expect(q.get("pane")).toBeNull();
  });
});

describe("NewTabSheet, the outcome", () => {
  it("keeps the sheet open with the refusal as a notice", async () => {
    const { calls } = mount({ outcomes: [{ kind: "refused", message: "This machine is not taking writes." }] });
    await userEvent.click(row(/htop/));
    expect(await sheet().findByRole("alert")).toHaveTextContent("This machine is not taking writes.");
    expect(calls.closed).toBe(0);
    expect(row(/htop/)).toBeEnabled();
  });

  it("shows no notice for an empty refusal (a start already in flight)", async () => {
    const { calls } = mount({ outcomes: [{ kind: "refused", message: "" }] });
    await userEvent.click(row(/htop/));
    await waitFor(() => expect(row(/htop/)).toBeEnabled());
    expect(sheet().queryByRole("alert")).toBeNull();
    expect(calls.closed).toBe(0);
  });

  it("keeps the sheet open on an unknown outcome, and a retry of that row sends the same request id", async () => {
    const { calls } = mount({ outcomes: [{ kind: "unknown" }, { kind: "unknown" }, { kind: "done" }] });
    await userEvent.click(row(/Claude Code/));
    expect(await sheet().findByText(/Collie could not confirm the start/)).toBeInTheDocument();
    expect(calls.closed).toBe(0);
    await userEvent.click(row(/Claude Code/));
    await waitFor(() => expect(calls.asks).toHaveLength(2));
    expect(calls.asks[1]!.ask.requestId).toBe(calls.asks[0]!.ask.requestId);
    // Another row is another intention, with an id of its own.
    await userEvent.click(row(/htop/));
    await waitFor(() => expect(calls.asks).toHaveLength(3));
    expect(calls.asks[2]!.ask.requestId).not.toBe(calls.asks[0]!.ask.requestId);
    await waitFor(() => expect(calls.closed).toBe(1));
  });

  it("starts clean when opened again: no notice from the last time", async () => {
    mount({ outcomes: [{ kind: "refused", message: "Nope." }] });
    await userEvent.click(row(/htop/));
    expect(await sheet().findByRole("alert")).toHaveTextContent("Nope.");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "reopen" }));
    expect(sheet().queryByRole("alert")).toBeNull();
  });
});
