import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { CrewProvider } from "./crew-provider";
import { AgentList, type HeadingNewTab } from "./agent-list";
import { HEADING_ADD_REACH } from "./workspace-new-tab";
import { tabCreateKey } from "@/hooks/use-spaces";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { useStatus, clearStatus } from "@/lib/status";
import type { Scope } from "@/lib/scope";
import { groupPanesByWorkspace, type WorkspaceGroup } from "@/lib/pane-groups";
import { paneName } from "@/lib/pane-name";
import { workspacePrefKey } from "./agent-list";
import { paneRowKey } from "@/lib/hosts";
import { currentPins, setPinned } from "@/lib/pins";
import { setMachineHidden, useHiddenMachines } from "@/lib/hidden-machines";
import type { AgentStatus, AgentView, MuxConfig, ServerSummary } from "@/lib/types";

function agent(
  paneId: string,
  status: AgentStatus,
  over: Partial<AgentView> = {},
): AgentView {
  return {
    paneId,
    workspaceId: "w0",
    workspaceLabel: paneId,
    workspaceNumber: 1,
    tabId: "w0:t1",
    agent: "claude",
    status,
    cwd: "/home/k/proj",
    focused: false,
    ...over,
  };
}

/** Section headings, in the order they render. Queried by role, because "needs you" is also the
 *  blocked STATUS_LABEL on every row's badge — matching on text alone catches both. */
/** One named tab of one named space — the group heading most of these cases assert on. */
const UI_WORK = { workspaceLabel: "collie-workspace", tabLabel: "UI work" } as const;

const headings = () =>
  screen.getAllByRole("heading").map((el) => el.textContent?.toLowerCase() ?? "");

/** Every PANE row button — never a Spaces filter chip (a button, in `<nav>`, sharing the workspace's
 *  own name) and never the one summary button on top (which can echo a row's own status words, e.g.
 *  "unseen"). Both are excluded by requiring a `<section>` ancestor: only a workspace group's rows
 *  have one (agent-list.tsx). */
const rowButtons = () => screen.getAllByRole("button").filter((b) => b.closest("section") !== null);

/** The `<section>` a workspace heading owns, so a query can be scoped away from the Spaces strip
 *  (whose chips share the heading's own text) without weakening what it asserts. */
const groupSection = (label: string) => screen.getByRole("heading", { name: label }).closest("section")!;

describe("AgentList — two axes, urgency then workspace", () => {
  const herd = [
    agent("blocked", "blocked", { lastActiveAt: 500, lastSeenAt: 1, sessionName: "blocked", ...UI_WORK }),
    agent("unseen", "done", { lastActiveAt: 400, lastSeenAt: 1, sessionName: "unseen", ...UI_WORK }),
    agent("busy", "working", { lastActiveAt: 300, lastSeenAt: 1, sessionName: "busy", ...UI_WORK }),
    agent("old", "idle", { lastActiveAt: 1, lastSeenAt: 200, sessionName: "old", ...UI_WORK }),
  ];

  // A blocked pane and an unseen one used to be pulled into their own "Needs you" / "Ready · unseen"
  // sections, out of their workspace. Today's redesign keeps every pane where it sits — urgency is a
  // MARK on the row and the heading, never a move (agent-list.tsx header comment).
  it("keeps every pane under its workspace heading — urgency marks a row, it never moves one", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} />);
    expect(headings()).toEqual(["collie-workspace"]);
    const section = groupSection("collie-workspace");
    // All four panes, blocked and unseen included, sit under that one heading.
    expect(within(section).getAllByRole("button")).toHaveLength(4);
    // The heading counts each state separately, as a bare number with an accessible name — never a
    // merged "needs you" count.
    expect(within(section).getByLabelText("1 needs you")).toBeInTheDocument();
    expect(within(section).getByLabelText("1 unseen")).toBeInTheDocument();
  });

  it("marks only the Ready·unseen row with the unread dot", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} />);
    // Scoped to the group: the top summary line also says "ready · unseen" in its own count.
    const section = groupSection("collie-workspace");
    const unseenRow = within(section).getByRole("button", { name: /unseen/ });
    expect(within(unseenRow).getByRole("img", { name: /unseen/i })).toBeInTheDocument();
    // The blocked ("Needs you") row is just as urgent, but it isn't a finished pane, so it never
    // gets the dot — the marker means "finished while you weren't looking", not "urgent".
    const blockedRow = within(section).getByRole("button", { name: /blocked/ });
    expect(within(blockedRow).queryByRole("img", { name: /unseen/i })).not.toBeInTheDocument();
  });

  // What used to be "pulled out until seen" now simply carries the mark, or doesn't — the pane's
  // position in its workspace group never changes either way.
  it("stays in its workspace group whether unseen or seen — the summary marks it, not a move", () => {
    const finished = agent("finished", "idle", { lastActiveAt: 200, lastSeenAt: 100, ...UI_WORK });
    const { rerender } = render(<AgentList agents={[finished]} onOpen={vi.fn()} />);
    expect(headings()).toEqual(["collie-workspace"]);
    // The summary spells it in words; the heading names the same count for a screen reader, with the
    // square drawn (but decorative) beside the number; the row carries the one square a screen reader
    // announces on its own.
    expect(screen.getByRole("button", { name: /1 unseen/i })).toBeInTheDocument();
    const section = groupSection("collie-workspace");
    expect(within(section).getByLabelText("1 unseen")).toBeInTheDocument();
    expect(within(section).getByRole("img", { name: "unseen" })).toBeInTheDocument();

    rerender(<AgentList agents={[{ ...finished, lastSeenAt: 300 }]} onOpen={vi.fn()} />);
    expect(headings()).toEqual(["collie-workspace"]);
    expect(screen.getByText(/nothing needs you/i)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "unseen" })).not.toBeInTheDocument();
  });

  it("has no Working and no Recent heading left to fold or to sort", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} />);
    expect(screen.queryByRole("heading", { name: /^working$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^recent$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch to/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { expanded: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { expanded: false })).not.toBeInTheDocument();
  });

  // The old "urgent section" carried a different `scope` than the workspace groups; now there is
  // only one list, so a blocked pane's own group carries both the row AND the mark.
  it("a blocked pane stays in its workspace group, with the heading lit and the summary counting it", () => {
    render(
      <AgentList
        agents={[agent("p", "blocked", { workspaceLabel: "moonward_os", tabLabel: "fix-auth" })]}
        onOpen={vi.fn()}
      />,
    );
    expect(headings()).toEqual(["moonward_os"]);
    const section = groupSection("moonward_os");
    const rows = within(section).getAllByRole("button");
    expect(rows).toHaveLength(1);
    // Line 2 is still the tab alone — the heading above already said the workspace.
    expect(rows[0]).toHaveTextContent("fix-auth");
    // The heading lights up with the worst status inside and counts it, as a number with an
    // accessible name...
    expect(within(section).getByLabelText("1 needs you")).toBeInTheDocument();
    // ...and the one summary slot at the top spells the same count in words.
    expect(screen.getByRole("button", { name: "1 needs you" })).toBeInTheDocument();
  });

  it("puts the TAB on line 2 of a workspace-grouped row — the heading said the workspace", () => {
    render(
      <AgentList
        agents={[
          agent("p", "idle", {
            workspaceLabel: "moonward_os",
            tabLabel: "fix-auth",
            sessionName: "rewrite the loader",
          }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    const row = screen.getByRole("button", { name: /rewrite the loader/ });
    const detail = row.querySelector('[data-slot="agent-row-detail"]')!;
    expect(detail).toHaveTextContent("fix-auth");
    // The workspace is the heading above; repeating it on the row is what this grouping saves.
    expect(detail).not.toHaveTextContent("moonward_os");
    // The title still carries line 1's weight and truncates on its own — the spare width is
    // `PaneMeta`'s `ml-auto` now, not the name's own `flex-1` (2026-09-14, so the unseen dot can
    // sit right after the name instead of at the far end of the row).
    expect(screen.getByText("rewrite the loader").className).toMatch(/truncate/);
    expect(screen.getByText("rewrite the loader").closest("[data-slot]")).toHaveAttribute(
      "data-slot",
      "agent-row-title",
    );
  });

  it("states one height for every row of a group, so nothing in it can shift", () => {
    render(
      <AgentList
        agents={[
          // A named tab, an unnamed one, and a hint: the three things that could differ in height.
          agent("a", "idle", {
            sessionName: "alpha",
            tabLabel: "UI work",
            hint: "a sentence the bridge composed",
          }),
          agent("b", "idle", { sessionName: "beta", tabLabel: "3" }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    for (const name of ["alpha", "beta"]) {
      const row = screen.getByRole("button", { name: new RegExp(name) });
      expect(row.firstElementChild?.className).toMatch(/(?:^|\s)h-11(?=\s|$)/);
      // Line 2 is a slot, not a line that comes and goes: it is there at a stated height whether
      // the tab named it or not.
      expect(row.querySelector('[data-slot="agent-row-detail"]')?.className).toMatch(
        /(?:^|\s)h-4(?=\s|$)/,
      );
    }
    // An unnamed tab reads its position instead — a positional number is not a name, but it is
    // still the fact the multiplexer gave this tab.
    const beta = screen.getByRole("button", { name: /beta/ });
    expect(beta.querySelector('[data-slot="agent-row-detail"]')?.textContent).toBe("tab 3");
    // The hint is the one fact that would make two rows of a group different heights.
    expect(screen.queryByText(/a sentence the bridge composed/)).not.toBeInTheDocument();
  });

  it("says so when nothing needs you, rather than leaving an absence to interpret", () => {
    render(<AgentList agents={[agent("only", "working", { lastActiveAt: 1 })]} onOpen={vi.fn()} />);
    expect(screen.getByText(/nothing needs you/i)).toBeInTheDocument();
  });

  it("stays quiet about it when something DOES need you", () => {
    render(<AgentList agents={[agent("b", "blocked")]} onOpen={vi.fn()} />);
    expect(screen.queryByText(/nothing needs you/i)).not.toBeInTheDocument();
  });

  it("drops the status pill on every row — the dot and the group say enough", () => {
    render(<AgentList agents={[agent("w", "working", { lastActiveAt: 1 })]} onOpen={vi.fn()} />);
    // The word survives for screen readers, but not as a pill on every row. Scoped to the row
    // buttons: the workspace filter chip carries the same status dot and would otherwise match too.
    const row = rowButtons()[0]!;
    expect(row.querySelector(".sr-only")?.textContent).toBe("working");
  });

  it("opens the pane behind a tapped row", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    // The whole PANE, not just its id: `w1:p1` names a different terminal on every machine in a
    // crew, and this list is one herd across all of them.
    const row = agent("p1", "blocked");
    render(<AgentList agents={[row]} onOpen={onOpen} />);
    // Scoped to the row buttons: the Spaces strip also carries a chip named "p1" now.
    await user.click(rowButtons()[0]!);
    // …and the row's own button, which the pane glide flies from (lib/glide.ts).
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(row, rowButtons()[0]);
  });

  it("marks each row as the pane glide's origin, keyed by the path its caller spells", () => {
    const row = agent("p1", "working");
    render(<AgentList agents={[row]} onOpen={vi.fn()} glideKeyOf={(a) => `/pane/${a.paneId}`} />);
    const button = rowButtons()[0]!;
    expect(button.dataset.glideOrigin).toBe("pane");
    expect(button.dataset.glideKey).toBe("/pane/p1");
    // The three parts that fly: the dot, the tile and the name, once each.
    for (const part of ["dot", "tile", "name"]) {
      expect(button.querySelectorAll(`[data-glide="${part}"]`)).toHaveLength(1);
    }
    expect(button.querySelector('[data-glide="name"]')?.textContent).toBe(paneName(row));
  });

  it("starts the pane's read when the finger lands, before the tap", () => {
    const onPress = vi.fn();
    const onOpen = vi.fn();
    const row = agent("p1", "working");
    render(<AgentList agents={[row]} onOpen={onOpen} onPress={onPress} />);
    fireEvent.pointerDown(rowButtons()[0]!);
    expect(onPress).toHaveBeenCalledExactlyOnceWith(row);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("leaves a row out of every glide when no key is given", () => {
    render(<AgentList agents={[agent("p1", "working")]} onOpen={vi.fn()} />);
    expect(rowButtons()[0]!.dataset.glideOrigin).toBeUndefined();
  });
});

describe("AgentList — the workspace headings", () => {
  it("shows the heading's counts as bare numbers with an accessible name, while the summary spells the words", () => {
    const { rerender } = render(
      <AgentList agents={[agent("a", "idle", UI_WORK)]} onOpen={vi.fn()} />,
    );
    // The header row: the `<h2>` and its trailing counts, never the rows below it — a row carries
    // its own sr-only status word ("idle"), which would otherwise look like a heading count too.
    const headerRow = () => screen.getByRole("heading", { name: "collie-workspace" }).parentElement!;
    // The heading shows the number alone...
    expect(within(headerRow()).getByText("1")).toBeInTheDocument();
    // ...but names it for a screen reader.
    expect(within(headerRow()).getByLabelText("1 idle")).toBeInTheDocument();
    // Nothing needs attention, so the summary leads with the all-clear check instead of a word.
    expect(screen.getByText(/nothing needs you/i)).toBeInTheDocument();

    rerender(
      <AgentList
        agents={[
          agent("a", "blocked", UI_WORK),
          agent("b", "idle", UI_WORK),
          agent("c", "idle", UI_WORK),
        ]}
        onOpen={vi.fn()}
      />,
    );
    // The heading counts each state separately, still as bare numbers.
    expect(within(headerRow()).getByLabelText("1 needs you")).toBeInTheDocument();
    expect(within(headerRow()).getByLabelText("2 idle")).toBeInTheDocument();
    expect(within(headerRow()).queryByText(/needs you|idle/)).not.toBeInTheDocument();
    // The one summary slot at the top spells every count in words while the line has the room (jsdom
    // has no layout, so it always has), and its button names every count in words.
    expect(screen.getByText("1 needs you")).toBeInTheDocument();
    expect(screen.getByText("2 idle")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^1 needs you\s*2 idle$/ })).toBeInTheDocument();
  });

  // A workspace whose every pane is blocked used to earn no heading at all — the group WAS the
  // urgency section. Today it still gets a heading, lit and counted like any other.
  it("keeps a blocked pane in its own group, whether it shares the workspace or fills it alone", () => {
    render(
      <AgentList
        agents={[
          // Three panes of one workspace, one of them blocked.
          agent("calm", "idle", { ...UI_WORK, sessionName: "calm" }),
          agent("quiet", "idle", { ...UI_WORK, sessionName: "quiet" }),
          agent("stuck", "blocked", { ...UI_WORK, sessionName: "stuck" }),
          // A second workspace with nothing but a blocked pane — it still gets its own heading.
          agent("alone", "blocked", {
            workspaceId: "w9",
            workspaceLabel: "moonward_os",
            workspaceNumber: 9,
            tabId: "w9:t1",
            sessionName: "alone",
          }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    expect(headings()).toEqual(["collie-workspace", "moonward_os"]);
    // One blocked plus two idle, not two blocked: the pane is counted where it sits, never pulled
    // out and counted twice.
    expect(within(groupSection("collie-workspace")).getByLabelText("1 needs you")).toBeInTheDocument();
    expect(within(groupSection("collie-workspace")).getByLabelText("2 idle")).toBeInTheDocument();
    expect(within(groupSection("moonward_os")).getByLabelText("1 needs you")).toBeInTheDocument();
    expect(within(groupSection("collie-workspace")).getAllByRole("button", { name: /stuck/ })).toHaveLength(1);
    expect(within(groupSection("moonward_os")).getAllByRole("button")).toHaveLength(1);
  });

  it("heads a group with the workspace, whatever its tabs are called", () => {
    render(
      <AgentList
        agents={[
          agent("a", "idle", { workspaceLabel: "collie-workspace", tabLabel: "2" }),
          agent("b", "idle", { workspaceLabel: "collie-workspace", tabId: "w0:t2", tabLabel: "docs" }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    expect(headings()).toEqual(["collie-workspace"]);
    expect(within(groupSection("collie-workspace")).getByLabelText("2 idle")).toBeInTheDocument();
  });

  it("runs the groups by workspace number, with each workspace's tabs inside it", () => {
    render(
      <AgentList
        agents={[
          agent("c", "idle", {
            workspaceId: "w2",
            workspaceLabel: "two",
            workspaceNumber: 2,
            tabId: "w2:t1",
            tabLabel: "later",
          }),
          agent("b", "idle", {
            workspaceLabel: "one",
            tabId: "w0:t2",
            tabLabel: "second",
          }),
          agent("a", "idle", { workspaceLabel: "one", tabId: "w0:t1", tabLabel: "first" }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    expect(headings()).toEqual(["one", "two"]);
    // Both tabs of the first workspace are rows under its one heading, in the bridge's order.
    // Scoped away from the Spaces strip, whose "one"/"two" chips are buttons too.
    const rows = rowButtons();
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("second"),
      expect.stringContaining("first"),
      expect.stringContaining("later"),
    ]);
  });
});

describe("AgentList — shells sit with their tab", () => {
  const shell = (paneId: string, over = {}) =>
    agent(paneId, "unknown", { kind: "shell", agent: "shell", ...over });

  it("puts a shell under its own tab's heading, after that tab's agents", () => {
    render(
      <AgentList
        agents={[agent("work", "idle", { ...UI_WORK, sessionName: "work" })]}
        shellPanes={[shell("logs", { ...UI_WORK, paneLabel: "logs" })]}
        onOpen={vi.fn()}
      />,
    );
    expect(headings()).toEqual(["collie-workspace"]);
    // Only the one agent counts — a shell is a row here, never a tally in the state count.
    expect(within(groupSection("collie-workspace")).getByLabelText("1 idle")).toBeInTheDocument();
    // Scoped away from the Spaces strip: its "collie-workspace" chip contains the substring "work".
    const rows = rowButtons();
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("work"),
      expect.stringContaining("logs"),
    ]);
  });

  it("opens a group for a workspace that holds nothing but shells", () => {
    render(
      <AgentList
        agents={[]}
        shellPanes={[
          shell("sh", { workspaceLabel: "collie-workspace", tabLabel: "logs", paneLabel: "tail -f" }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    expect(headings()).toEqual(["collie-workspace"]);
    expect(screen.queryByText(/no agents running/i)).not.toBeInTheDocument();
  });
});

describe("AgentList — the empty herd", () => {
  it("shows the herd-empty placeholder, and suppresses it when asked", () => {
    const { rerender } = render(<AgentList agents={[]} bridge="connected" onOpen={vi.fn()} />);
    expect(screen.getByText(/no agents running/i)).toBeInTheDocument();
    rerender(<AgentList agents={[]} bridge="connected" onOpen={vi.fn()} emptyState={false} />);
    expect(screen.queryByText(/no agents running/i)).not.toBeInTheDocument();
  });

  // M48 spec 01: a connected, empty herd on a device that may start something is the large card, and
  // the card is the one way in to the New page from there.
  it("offers the first-agent card in place of the placeholder when a start is possible", async () => {
    const onFirstStart = vi.fn();
    render(<AgentList agents={[]} bridge="connected" onOpen={vi.fn()} onFirstStart={onFirstStart} />);
    expect(screen.queryByText(/no agents running/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Start your first agent/ }));
    expect(onFirstStart).toHaveBeenCalledTimes(1);
  });

  it("never offers the card on a stale render or a bridge that is down", () => {
    const { rerender } = render(<AgentList agents={[]} bridge="connected" onOpen={vi.fn()} onFirstStart={vi.fn()} error />);
    expect(screen.queryByRole("button", { name: /Start your first agent/ })).toBeNull();
    rerender(<AgentList agents={[]} bridge="disconnected" onOpen={vi.fn()} onFirstStart={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Start your first agent/ })).toBeNull();
  });

  it("says it's waiting when the bridge is down, rather than 'no agents'", () => {
    render(<AgentList agents={[]} bridge="disconnected" onOpen={vi.fn()} />);
    expect(screen.getByText(/waiting for herdr/i)).toBeInTheDocument();
  });

  // The cold-boot-offline bug: the herd is empty because the fetch failed, not because nothing is
  // running — and a cached snapshot still reports `bridge: "connected"`, so `bridge` alone would let
  // "No agents running." through. Only a real answer may make that claim.
  it("never claims an empty herd on a stale render", () => {
    render(<AgentList agents={[]} bridge="connected" onOpen={vi.fn()} error />);
    expect(screen.queryByText(/no agents running/i)).not.toBeInTheDocument();
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument();
  });

  it("dates the disconnected placeholder when the cache can date it", () => {
    const at = new Date(2026, 0, 2, 14, 32).getTime();
    render(<AgentList agents={[]} onOpen={vi.fn()} error lastSeenAt={at} />);
    expect(screen.getByText(/last seen/i)).toHaveTextContent(/\d{1,2}[:.]\d{2}/);
  });

  it("says only 'Disconnected' when it cannot date the data", () => {
    render(<AgentList agents={[]} onOpen={vi.fn()} error />);
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });
});

describe("AgentList — an older bridge with no timestamps", () => {
  it("still renders a coherent dashboard, with Ready·unseen simply absent", () => {
    render(
      <AgentList
        agents={[
          agent("b", "blocked", { workspaceLabel: "collie-workspace", sessionName: "b" }),
          agent("w", "working", { workspaceLabel: "collie-workspace", sessionName: "w" }),
          agent("d", "done", { workspaceLabel: "collie-workspace", sessionName: "d" }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    // One workspace heading — with no timestamps `isUnseen` can never be true, so the "done" pane
    // never earns the unread mark; it is still just a pane in this group.
    expect(headings()).toEqual(["collie-workspace"]);
    expect(screen.queryByRole("img", { name: /unseen/i })).not.toBeInTheDocument();
    // The heading still lights up for the blocked pane, and counts the other two states too.
    const section = groupSection("collie-workspace");
    expect(within(section).getByLabelText("1 needs you")).toBeInTheDocument();
    expect(within(section).getByLabelText("1 working")).toBeInTheDocument();
    expect(within(section).getByLabelText("1 done")).toBeInTheDocument();
  });
});

// The key a device remembers a workspace by: machine, session and NAME, never Herdr's restart-unstable id.
const prefKeyOf = (p: AgentView) => workspacePrefKey(groupPanesByWorkspace([p])[0]!);

describe("AgentList — the workspace select", () => {
  const two = [
    agent("a", "idle", { workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1" }),
    agent("b", "idle", { workspaceId: "w2", workspaceLabel: "two", workspaceNumber: 2, tabId: "w2:t1" }),
  ];

  // An option's name is the workspace, then its state in words when it has one: "one · needs you".
  const select = () => screen.getByRole("combobox", { name: "Workspace" });
  const option = (label: RegExp | string) => within(select()).getByRole("option", { name: label });
  const optionNames = () => within(select()).getAllByRole("option").map((o) => o.textContent);

  it("is one select named Workspace: All workspaces, then one option per workspace in the list's order", () => {
    render(<AgentList agents={two} onOpen={vi.fn()} />);
    expect(optionNames()).toEqual(["All workspaces", "one", "two"]);
    expect(select()).toHaveValue("all");
    // No chip strip any more: the filter is this select alone.
    expect(screen.queryByRole("navigation", { name: /spaces/i })).toBeNull();
  });

  it("says a workspace's state in words on its option, where a native list cannot draw a dot", () => {
    const states = [
      agent("a", "blocked", { workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1" }),
      agent("b", "working", { workspaceId: "w2", workspaceLabel: "two", workspaceNumber: 2, tabId: "w2:t1" }),
      agent("c", "done", { workspaceId: "w3", workspaceLabel: "three", workspaceNumber: 3, tabId: "w3:t1", lastActiveAt: 200, lastSeenAt: 100 }),
      agent("d", "idle", { workspaceId: "w4", workspaceLabel: "four", workspaceNumber: 4, tabId: "w4:t1" }),
    ];
    render(<AgentList agents={states} onOpen={vi.fn()} />);
    expect(optionNames()).toEqual(["All workspaces", "one · needs you", "two · working", "three · unseen", "four"]);
  });

  it("keeps a hidden workspace hidden when Herdr renumbers its id", () => {
    const key = prefKeyOf(two[0]!);
    const renumbered = two.map((p, i) => (i === 0 ? { ...p, workspaceId: `${p.workspaceId}x`, tabId: `${p.workspaceId}x:t1` } : p));
    render(<AgentList agents={renumbered} onOpen={vi.fn()} hidden={[key]} />);
    expect(headings()).not.toContain("one");
  });

  it("isolates a workspace on a pick; All workspaces returns to all", async () => {
    const user = userEvent.setup();
    const onIsolate = vi.fn();
    const key = prefKeyOf(two[0]!);
    const { rerender } = render(<AgentList agents={two} onOpen={vi.fn()} onIsolate={onIsolate} />);
    await user.selectOptions(select(), option("one"));
    expect(onIsolate).toHaveBeenCalledExactlyOnceWith(key);

    rerender(<AgentList agents={two} onOpen={vi.fn()} isolated={key} onIsolate={onIsolate} />);
    // Isolated: only "one"'s group is left on screen, and the select shows it.
    expect(headings()).toEqual(["one"]);
    expect(option("one")).toHaveProperty("selected", true);

    await user.selectOptions(select(), option("All workspaces"));
    expect(onIsolate).toHaveBeenLastCalledWith(null);
  });

  it("has no way to hide a workspace (a native list has no long press), and offers none when none is hidden", () => {
    render(<AgentList agents={two} onOpen={vi.fn()} onToggleHidden={vi.fn()} />);
    expect(optionNames()).not.toContain("Show hidden workspaces");
  });

  it("keeps a hidden workspace in the select, marked hidden, with its group dropped from the list", () => {
    const key = prefKeyOf(two[0]!);
    render(<AgentList agents={two} onOpen={vi.fn()} hidden={[key]} />);
    // "one" no longer has a heading — its rows are gone from the list.
    expect(headings()).toEqual(["two"]);
    // Its option is still there, and says so.
    expect(optionNames()).toEqual(["All workspaces", "one · hidden", "two"]);
  });

  it("brings every hidden workspace back from one option, and leaves the choice on what it was", async () => {
    const user = userEvent.setup();
    const onToggleHidden = vi.fn();
    const hidden = two.map(prefKeyOf);
    render(<AgentList agents={two} onOpen={vi.fn()} hidden={hidden} onToggleHidden={onToggleHidden} />);
    await user.selectOptions(select(), option("Show hidden workspaces"));
    expect(onToggleHidden.mock.calls.map((c) => c[0])).toEqual(hidden);
    expect(select()).toHaveValue("all");
  });

  it("picks a hidden workspace to see it alone: isolate wins over hide", async () => {
    const user = userEvent.setup();
    const onIsolate = vi.fn();
    const key = prefKeyOf(two[0]!);
    render(<AgentList agents={two} onOpen={vi.fn()} hidden={[key]} onIsolate={onIsolate} />);
    await user.selectOptions(select(), option(/^one/));
    expect(onIsolate).toHaveBeenCalledExactlyOnceWith(key);
  });

  it("keeps the fixed order when a pane's status changes", () => {
    const panes = [
      agent("a", "idle", { workspaceLabel: "one", tabId: "w0:t1", sessionName: "first" }),
      agent("b", "idle", { workspaceLabel: "one", tabId: "w0:t1", sessionName: "second" }),
    ];
    const { rerender } = render(<AgentList agents={panes} onOpen={vi.fn()} />);
    // Identity, not raw text — a status change rewords the row's own sr-only status word, which
    // would otherwise look like a reorder to a plain textContent comparison.
    const order = () => rowButtons().map((r) => (within(r).queryByText("first") ? "first" : "second"));
    expect(order()).toEqual(["first", "second"]);

    rerender(
      <AgentList agents={[{ ...panes[0]!, status: "blocked" }, panes[1]!]} onOpen={vi.fn()} />,
    );
    // A status change marks the row (a tint, a dot) — it never reorders it. Pane id is the only
    // tiebreak `order: "fixed"` uses (lib/pane-groups.ts).
    expect(order()).toEqual(["first", "second"]);
  });
});

// PINNED PANES (ADR 0070): a Pinned group under the summary line on every tab, drawn from every
// workspace before isolate and hide, deaf to the needs-you switch, and each pinned pane listed once.
describe("AgentList — pinned panes", () => {
  const herd = [
    agent("a1", "idle", { workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1", sessionName: "orchestrator" }),
    agent("a2", "blocked", { workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1", sessionName: "stuck" }),
    agent("b1", "working", { workspaceId: "w2", workspaceLabel: "two", workspaceNumber: 2, tabId: "w2:t1", sessionName: "builder" }),
    agent("b2", "idle", { workspaceId: "w2", workspaceLabel: "two", workspaceNumber: 2, tabId: "w2:t1", sessionName: "quiet" }),
  ];
  const byName = (name: string) => herd.find((a) => a.sessionName === name)!;
  /** Pin these panes, in this order, and hand back the pins as the list's prop. */
  const pinned = (...names: string[]) => {
    let now = 0;
    for (const n of names) setPinned(byName(n), true, herd, ++now);
    return currentPins();
  };
  const pinnedRegion = () => screen.getByRole("region", { name: "Pinned" });
  const rowNames = (el: HTMLElement) =>
    within(el)
      .getAllByRole("button")
      .map((b) => herd.find((a) => within(b).queryByText(a.sessionName!))?.sessionName);

  it("draws no Pinned heading and no extra DOM when nothing is pinned", () => {
    const { container, rerender } = render(<AgentList agents={herd} onOpen={vi.fn()} />);
    const before = container.innerHTML;
    expect(screen.queryByRole("heading", { name: "Pinned" })).toBeNull();
    rerender(<AgentList agents={herd} onOpen={vi.fn()} pins={[]} />);
    expect(container.innerHTML).toBe(before);
  });

  it("draws Pinned under the summary line, as the first group, in place order", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} pins={pinned("builder", "orchestrator")} />);
    expect(headings()).toEqual(["pinned", "one", "two"]);
    // Place order, not pin order: workspace one before two.
    expect(rowNames(pinnedRegion())).toEqual(["orchestrator", "builder"]);
    // The summary line sits above the group.
    const summary = screen.getByRole("button", { name: /^\d+ needs you/ });
    expect(summary.compareDocumentPosition(pinnedRegion()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The heading is the muted section voice, an h2 with no dot and no count.
    const heading = within(pinnedRegion()).getByRole("heading", { level: 2, name: "Pinned" });
    expect(heading.textContent).toBe("Pinned");
  });

  it("takes a pinned row out of its workspace group, and the heading still counts every pane", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} pins={pinned("stuck")} />);
    const one = groupSection("one");
    expect(rowNames(one)).toEqual(["orchestrator"]);
    // The pinned pane is blocked, and workspace one's heading still says so.
    expect(within(one).getByLabelText("1 needs you")).toBeInTheDocument();
    expect(rowNames(pinnedRegion())).toEqual(["stuck"]);
  });

  it("drops a workspace group left with no rows, and keeps its option in the select", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} pins={pinned("builder", "quiet")} />);
    expect(headings()).toEqual(["pinned", "one"]);
    expect(within(screen.getByRole("combobox", { name: "Workspace" })).getByRole("option", { name: /^two/ })).toBeInTheDocument();
  });

  it("puts the place on line 2 of a pinned row, because no workspace heading says it", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} pins={pinned("builder")} />);
    const row = within(pinnedRegion()).getByRole("button");
    expect(row.querySelector('[data-slot="agent-row-detail"]')).toHaveTextContent(/^two/);
  });

  it("ignores isolate: a pin on another workspace still leads", () => {
    const pins = pinned("builder");
    const isolateOne = workspacePrefKey(groupPanesByWorkspace([herd[0]!])[0]!);
    render(<AgentList agents={herd} onOpen={vi.fn()} pins={pins} isolated={isolateOne} />);
    expect(headings()).toEqual(["pinned", "one"]);
    expect(rowNames(pinnedRegion())).toEqual(["builder"]);
  });

  it("ignores hide: a pin in a hidden workspace still leads", () => {
    const pins = pinned("builder");
    const hideTwo = workspacePrefKey(groupPanesByWorkspace([herd[2]!])[0]!);
    render(<AgentList agents={herd} onOpen={vi.fn()} pins={pins} hidden={[hideTwo]} />);
    expect(headings()).toEqual(["pinned", "one"]);
    expect(rowNames(pinnedRegion())).toEqual(["builder"]);
  });

  it("isolating a workspace whose panes are all pinned shows the Pinned group alone", () => {
    const pins = pinned("builder", "quiet");
    const isolateTwo = workspacePrefKey(groupPanesByWorkspace([herd[2]!])[0]!);
    render(<AgentList agents={herd} onOpen={vi.fn()} pins={pins} isolated={isolateTwo} />);
    expect(headings()).toEqual(["pinned"]);
  });

  it("ignores the needs-you switch: an idle pinned pane leads, and the groups keep only what needs you", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} pins={pinned("orchestrator")} needsYouOnly />);
    expect(rowNames(pinnedRegion())).toEqual(["orchestrator"]);
    expect(headings()).toEqual(["pinned", "one"]);
    expect(rowNames(groupSection("one"))).toEqual(["stuck"]);
  });

  it("shows only the Pinned group under an all-clear needs-you switch when every urgent pane is pinned", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} pins={pinned("stuck")} needsYouOnly />);
    expect(headings()).toEqual(["pinned"]);
  });

  it("leads Changes too, and hands the Changes body every shown workspace unchanged (A2)", () => {
    const renderBody = vi.fn((_shown: readonly WorkspaceGroup[]) => <p>changes body</p>);
    render(<AgentList agents={herd} onOpen={vi.fn()} pins={pinned("builder", "quiet")} renderBody={renderBody} />);
    expect(rowNames(pinnedRegion())).toEqual(["builder", "quiet"]);
    // Workspace two's panes are all pinned, and it still gets its change row, with every pane.
    const shown = renderBody.mock.calls[0]![0];
    expect(shown.map((g) => g.label)).toEqual(["one", "two"]);
    expect(shown[1]!.panes).toHaveLength(2);
    expect(pinnedRegion().compareDocumentPosition(screen.getByText("changes body")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens a pinned row's own pane, exactly as its workspace row would", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<AgentList agents={herd} onOpen={onOpen} pins={pinned("builder")} />);
    await user.click(within(pinnedRegion()).getByRole("button"));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(byName("builder"), expect.any(HTMLElement));
  });

  it("jumps the summary line to Pinned when a pinned pane needs you", async () => {
    const user = userEvent.setup();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<AgentList agents={herd} onOpen={vi.fn()} pins={pinned("stuck")} />);
    await user.click(screen.getByRole("button", { name: /^\d+ needs you/ }));
    expect(scroll.mock.contexts[0]).toBe(pinnedRegion());
    scroll.mockRestore();
  });

  it("opens the pane's sheet on a hold, and not the pane", () => {
    const onOpen = vi.fn();
    const onHold = vi.fn();
    render(<AgentList agents={herd} onOpen={onOpen} onHold={onHold} />);
    const row = within(groupSection("two")).getAllByRole("button")[0]!;
    fireEvent.contextMenu(row);
    expect(onHold).toHaveBeenCalledExactlyOnceWith(byName("builder"));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("focuses the moved row in its new place after a pin, and the summary line when the row left", () => {
    const pins = pinned("orchestrator");
    const { rerender } = render(
      <AgentList agents={herd} onOpen={vi.fn()} pins={pins} reveal={{ rowKey: paneRowKey(byName("orchestrator")) }} />,
    );
    expect(within(pinnedRegion()).getByRole("button")).toHaveFocus();
    // Unpinned with the switch on: an idle pane leaves the list, and focus goes to the summary line.
    setPinned(byName("orchestrator"), false, herd);
    rerender(
      <AgentList
        agents={herd}
        onOpen={vi.fn()}
        pins={currentPins()}
        needsYouOnly
        reveal={{ rowKey: paneRowKey(byName("orchestrator")) }}
      />,
    );
    expect(screen.getByRole("button", { name: /^\d+ needs you/ })).toHaveFocus();
  });

  it("lets the all-clear summary line hold focus once pins are in play", () => {
    const calm = herd.filter((a) => a.status !== "blocked");
    const { rerender } = render(<AgentList agents={calm} onOpen={vi.fn()} />);
    // With nothing pinned, the line is the disabled button it always was.
    expect(screen.getByRole("button", { name: /nothing needs you/i })).toBeDisabled();
    rerender(<AgentList agents={calm} onOpen={vi.fn()} needsYouOnly reveal={{ rowKey: paneRowKey(calm[0]!) }} />);
    const line = screen.getByRole("button", { name: /nothing needs you/i });
    expect(line).toHaveAttribute("aria-disabled", "true");
    expect(line).toHaveFocus();
  });
});

// HIDING A MACHINE (issue #288, M40/01): a crew's dashboard can leave a machine out. Its workspace
// groups leave the Dashboard, Crew and Changes, its chips give way to one dimmed stand-in chip with its worst
// dot, pins and isolate still win, the addressed machine always shows, and solo renders as before.
describe("AgentList — hiding a machine", () => {
  const member = (id: string, isLead = false): ServerSummary => ({
    id,
    name: id,
    isLead,
    reachable: true,
    protocol: "ok",
    lastSeenAt: 1_000,
  });
  const servers = [member("bluefin", true), member("workshop"), member("attic")];
  const on = (host: string, workspaceId: string, workspaceLabel: string, workspaceNumber: number) =>
    ({ host, workspaceId, workspaceLabel, workspaceNumber, tabId: `${workspaceId}:t1` }) as const;
  const herd = [
    agent("w1:p1", "idle", { ...on("bluefin", "w1", "collie", 1), sessionName: "lead-idle" }),
    agent("w1:p2", "blocked", { ...on("bluefin", "w1", "collie", 1), sessionName: "lead-stuck" }),
    agent("w1:p1", "blocked", { ...on("workshop", "w1", "moonward", 1), sessionName: "peer-stuck" }),
    agent("w2:p1", "idle", { ...on("workshop", "w2", "docs", 2), sessionName: "peer-idle" }),
    agent("w1:p1", "working", { ...on("attic", "w1", "attic-ws", 1), sessionName: "attic-busy" }),
  ];
  const byName = (name: string) => herd.find((a) => a.sessionName === name)!;
  const select = () => screen.getByRole("combobox", { name: "Workspace" });
  const optionNames = () => within(select()).getAllByRole("option").map((o) => o.textContent);
  const standIn = (name: string) => within(select()).getByRole("option", { name: `Show ${name}'s panes` });
  const summaryLine = () => screen.getByRole("button", { name: /^\d+ needs you/ });

  it("leaves a hidden machine's workspaces out of Panes, and the summary line still counts them", () => {
    render(<AgentList agents={herd} servers={servers} hiddenMachines={["workshop"]} onOpen={vi.fn()} />);
    expect(headings()).toEqual(["collie", "attic-ws"]);
    // workshop's blocked pane is off the list and still in the count: nothing is silenced.
    expect(summaryLine()).toHaveAccessibleName(/^2 needs you/);
  });

  it("leaves a hidden machine out of the needs-you list too", () => {
    render(<AgentList agents={herd} servers={servers} hiddenMachines={["workshop"]} needsYouOnly onOpen={vi.fn()} />);
    expect(headings()).toEqual(["collie"]);
    expect(rowButtons()).toHaveLength(1);
  });

  it("hands Changes only the shown machines' workspaces, so it stops asking a hidden machine", () => {
    const renderBody = vi.fn((_shown: readonly WorkspaceGroup[]) => <p>changes body</p>);
    render(
      <AgentList agents={herd} servers={servers} hiddenMachines={["workshop"]} renderBody={renderBody} onOpen={vi.fn()} />,
    );
    expect(renderBody.mock.calls[0]![0].map((g) => g.label)).toEqual(["collie", "attic-ws"]);
  });

  it("keeps a pinned pane on a hidden machine in the Pinned group, leading the list", () => {
    setPinned(byName("peer-idle"), true, herd, 1);
    render(
      <AgentList agents={herd} servers={servers} hiddenMachines={["workshop"]} pins={currentPins()} onOpen={vi.fn()} />,
    );
    expect(headings()).toEqual(["pinned", "collie", "attic-ws"]);
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(within(pinned).getByText("peer-idle")).toBeInTheDocument();
  });

  it("lets isolate win: an isolated workspace on a hidden machine shows, its option right after the machine's", () => {
    const isolated = prefKeyOf(byName("peer-idle"));
    render(
      <AgentList agents={herd} servers={servers} hiddenMachines={["workshop"]} isolated={isolated} onOpen={vi.fn()} />,
    );
    expect(headings()).toEqual(["docs"]);
    expect(optionNames()).toEqual(["All workspaces", "collie · needs you", "Show workshop's panes", "docs", "attic-ws · working"]);
    expect(within(select()).getByRole("option", { name: "docs" })).toHaveProperty("selected", true);
  });

  it("jumps the summary line to an urgent pane on a hidden machine by isolating its workspace", async () => {
    const user = userEvent.setup();
    const onIsolate = vi.fn();
    // Only the peer's pane needs you, so the jump's target is on the hidden machine.
    const calmLead = herd.map((a) => (a.sessionName === "lead-stuck" ? { ...a, status: "idle" as const } : a));
    render(
      <AgentList agents={calmLead} servers={servers} hiddenMachines={["workshop"]} onIsolate={onIsolate} onOpen={vi.fn()} />,
    );
    await user.click(summaryLine());
    expect(onIsolate).toHaveBeenCalledExactlyOnceWith(prefKeyOf(byName("peer-stuck")));
  });

  it("never hides the machine the dashboard addresses: the lead when ?h= is absent", () => {
    const { rerender } = render(
      <AgentList agents={herd} servers={servers} hiddenMachines={["bluefin", "workshop"]} onOpen={vi.fn()} />,
    );
    expect(headings()).toEqual(["collie", "attic-ws"]);
    // On workshop the stored lead comes back into force, and workshop itself shows.
    rerender(
      <AgentList
        agents={herd}
        servers={servers}
        hiddenMachines={["bluefin", "workshop"]}
        addressedHost="workshop"
        onOpen={vi.fn()}
      />,
    );
    expect(headings()).toEqual(["moonward", "docs", "attic-ws"]);
  });

  it("filters nothing with a machine id the roster no longer lists", () => {
    render(<AgentList agents={herd} servers={servers} hiddenMachines={["cellar"]} onOpen={vi.fn()} />);
    expect(headings()).toEqual(["collie", "moonward", "docs", "attic-ws"]);
  });

  it("renders a solo machine list byte-identically, whatever is stored", () => {
    const solo = herd.map(({ host: _host, ...rest }) => rest);
    const { container, rerender } = render(<AgentList agents={solo} onOpen={vi.fn()} />);
    const before = container.innerHTML;
    rerender(<AgentList agents={solo} hiddenMachines={["workshop", ""]} onOpen={vi.fn()} />);
    expect(container.innerHTML).toBe(before);
  });

  it("swaps a hidden machine's workspaces for one \"Show <machine>'s panes\" option, at their place", () => {
    render(<AgentList agents={herd} servers={servers} hiddenMachines={["workshop"]} onOpen={vi.fn()} />);
    expect(optionNames()).toEqual(["All workspaces", "collie · needs you", "Show workshop's panes", "attic-ws · working"]);
    // It is an action, not a place: the select stays on All workspaces.
    expect(select()).toHaveValue("all");
  });

  it("draws no such option for a hidden machine with no panes", () => {
    const leadOnly = herd.filter((a) => a.host !== "attic");
    render(<AgentList agents={leadOnly} servers={servers} hiddenMachines={["attic"]} onOpen={vi.fn()} />);
    expect(within(select()).queryByRole("option", { name: /^Show attic/ })).toBeNull();
  });

  it("keeps the option of a hidden machine that is down", () => {
    const down = servers.map((s) => (s.id === "workshop" ? { ...s, reachable: false } : s));
    render(<AgentList agents={herd} servers={down} hiddenMachines={["workshop"]} onOpen={vi.fn()} />);
    expect(standIn("workshop")).toBeInTheDocument();
  });

  it("a pick of the option shows the machine again, and the select stays on what it was", async () => {
    const user = userEvent.setup();
    function Dashboard() {
      const hidden = useHiddenMachines(true);
      return (
        <AgentList
          agents={herd}
          servers={servers}
          hiddenMachines={hidden}
          onShowMachine={(host) => setMachineHidden(host, false, servers)}
          onOpen={vi.fn()}
        />
      );
    }
    setMachineHidden("workshop", true, servers);
    render(<Dashboard />);
    expect(headings()).toEqual(["collie", "attic-ws"]);

    await user.selectOptions(select(), standIn("workshop"));
    expect(headings()).toEqual(["collie", "moonward", "docs", "attic-ws"]);
    expect(within(select()).queryByRole("option", { name: /^Show workshop/ })).toBeNull();
    expect(select()).toHaveValue("all");
  });
});

// A NEW TAB FROM THE WORKSPACE HEADING (M40/03, issue 290). Each strong heading ends in a "+" that
// asks its OWN machine whether it can open a tab, sends the create to that machine and session, and
// refuses on the tap when that machine is not taking writes. Every strong heading reserves the
// "+"'s 28px, drawn or not.
describe("AgentList — the heading's new tab (M40/03)", () => {
  afterEach(() => {
    __resetOperatorCommands();
    clearStatus();
  });

  const LEAD = "bluefin";
  const PEER = "workshop";
  const servers: ServerSummary[] = [
    { id: LEAD, name: LEAD, isLead: true, reachable: true, protocol: "ok", lastSeenAt: 1_000 },
    { id: PEER, name: PEER, isLead: false, reachable: true, protocol: "ok", lastSeenAt: 990 },
  ];
  /** Two machines, and each calls its first space `w1`: the collision the address exists for. */
  const crew = [
    agent("w1:p1", "blocked", { workspaceId: "w1", workspaceLabel: "webapp", workspaceNumber: 1, tabId: "w1:t1", host: LEAD }),
    agent("w2:p1", "working", { workspaceId: "w2", workspaceLabel: "collie", workspaceNumber: 2, tabId: "w2:t1", host: LEAD }),
    agent("w1:p1", "idle", { workspaceId: "w1", workspaceLabel: "moonward", workspaceNumber: 1, tabId: "w1:t1", host: PEER }),
  ];
  const plus = (name: string) => screen.queryByRole("button", { name: `New tab in ${name}` });
  /** The heading row of a workspace: the `SectionHeader` div holding the <h2> and the trailing slot. */
  const headingRow = (label: string) => screen.getByRole("heading", { name: label }).parentElement!;

  function wiring(over: Partial<HeadingNewTab> = {}): HeadingNewTab {
    return { scope: {}, creating: new Set(), onNewTab: vi.fn(), ...over };
  }

  /** Serve `/api/config` per machine: the lead's block, and the peer's own when `peer` is given. */
  function declaresCreateTab(lead: boolean, peer?: boolean): void {
    const block = (createTab: boolean): MuxConfig => ({
      name: "reference",
      capabilities: { createTab },
      unsupportedKeys: [],
      notes: { createTab: "no tabs here." },
    });
    server.use(
      http.get("/api/config", ({ request }) => {
        const host = new URL(request.url).searchParams.get("host");
        const mux = host === PEER && peer !== undefined ? block(peer) : block(lead);
        return HttpResponse.json({ push: false, vapidPublicKey: "", mux });
      }),
    );
  }

  it("new tab: puts a '+' on every workspace heading, named for its workspace, and none on Pinned", async () => {
    const herd = crew.filter((a) => a.host === LEAD);
    setPinned(herd[1]!, true, herd);
    render(<AgentList agents={herd} onOpen={vi.fn()} servers={servers} pins={currentPins()} newTab={wiring()} />);
    expect(await screen.findByRole("button", { name: "New tab in webapp" })).toBeInTheDocument();
    // `collie`'s one pane is pinned, so its group, heading and "+" are gone (ADR 0070); the space view
    // keeps its own "+". Pinned carries none: it holds panes, not a workspace.
    expect(plus("collie")).toBeNull();
    const pinnedRegion = screen.getByRole("region", { name: "Pinned" });
    expect(within(pinnedRegion).queryByRole("button", { name: /^New tab in / })).toBeNull();
  });

  it("new tab: draws none without the route's wiring, and every strong heading reserves its 28px either way", () => {
    const herd = crew.filter((a) => a.host === LEAD);
    const { rerender } = render(<AgentList agents={herd} onOpen={vi.fn()} servers={servers} />);
    expect(screen.queryByRole("button", { name: /^New tab in / })).toBeNull();
    for (const label of ["webapp", "collie"]) expect(headingRow(label)).toHaveClass("min-h-7");
    rerender(<AgentList agents={herd} onOpen={vi.fn()} servers={servers} newTab={wiring()} />);
    for (const label of ["webapp", "collie"]) expect(headingRow(label)).toHaveClass("min-h-7");
  });

  it("new tab: asks each heading's own machine, and hides the '+' where that machine cannot open a tab", async () => {
    declaresCreateTab(true, false);
    render(<AgentList agents={crew} onOpen={vi.fn()} servers={servers} newTab={wiring()} />);
    expect(await screen.findByRole("button", { name: "New tab in webapp" })).toBeInTheDocument();
    await waitFor(() => expect(plus("moonward")).toBeNull());
    expect(plus("collie")).not.toBeNull();
    // Hidden, not explained: no note, and the heading keeps its height.
    expect(screen.queryByText("no tabs here.")).toBeNull();
    expect(headingRow("moonward")).toHaveClass("min-h-7");
  });

  it("new tab: a lead that cannot open a tab hides every lead heading's '+'", async () => {
    declaresCreateTab(false);
    render(<AgentList agents={crew.filter((a) => a.host === LEAD)} onOpen={vi.fn()} servers={servers} newTab={wiring()} />);
    await waitFor(() => expect(plus("webapp")).toBeNull());
    expect(plus("collie")).toBeNull();
  });

  it("new tab: sends the heading's own machine and session, never the ambient ones", async () => {
    const onNewTab = vi.fn<(workspaceId: string, at: Scope) => void>();
    const user = userEvent.setup();
    // The URL is on the PEER: the lead's heading must still go to the lead.
    render(
      <AgentList agents={crew} onOpen={vi.fn()} servers={servers} newTab={wiring({ scope: { host: PEER }, onNewTab })} />,
    );
    await user.click(await screen.findByRole("button", { name: "New tab in moonward" }));
    await user.click(screen.getByRole("button", { name: "New tab in webapp" }));
    expect(onNewTab).toHaveBeenCalledTimes(2);
    expect(onNewTab.mock.calls[0]).toEqual(["w1", { host: PEER }]);
    // The lead normalises to no host at all: absent means the lead (lib/scope.ts).
    const [, leadAt] = onNewTab.mock.calls[1]!;
    expect(onNewTab.mock.calls[1]![0]).toBe("w1");
    expect(leadAt.host).toBeUndefined();
  });

  it("new tab: a widened list's heading carries its own session", async () => {
    const onNewTab = vi.fn<(workspaceId: string, at: Scope) => void>();
    const widened = [
      agent("w1:p1", "idle", { workspaceId: "w1", workspaceLabel: "notes", workspaceNumber: 1, session: "work" }),
    ];
    render(
      <AgentList
        agents={widened}
        onOpen={vi.fn()}
        newTab={wiring({
          onNewTab,
          sessions: [
            { name: "default", isPrimary: true, reachable: true, agents: 0, working: 0, blocked: 0 },
            { name: "work", isPrimary: false, reachable: true, agents: 1, working: 0, blocked: 0 },
          ],
        })}
      />,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "New tab in notes" }));
    expect(onNewTab).toHaveBeenCalledWith("w1", expect.objectContaining({ session: "work" }));
  });

  it("new tab: refuses on a machine not taking writes, with its reason, and sends nothing", async () => {
    const onNewTab = vi.fn();
    const quiet = servers.map((s) => (s.id === PEER ? { ...s, reachable: false, lastSeenAt: 1_000 } : s));
    function StatusText() {
      return <output aria-label="status">{useStatus()?.text ?? ""}</output>;
    }
    const { container } = render(
      <CrewProvider servers={quiet} sessions={[]} ts={60_000} pollMs={1500}>
        <AgentList agents={crew} onOpen={vi.fn()} servers={quiet} newTab={wiring({ onNewTab })} />
        <StatusText />
      </CrewProvider>,
    );
    const peerPlus = await within(container).findByRole("button", { name: "New tab in moonward" });
    // Still drawn and still live: a control that vanished with the machine's state would move the row.
    expect(peerPlus).toBeEnabled();
    await userEvent.setup().click(peerPlus);
    expect(onNewTab).not.toHaveBeenCalled();
    expect(within(container).getByRole("status", { name: "status" })).toHaveTextContent(/workshop/);
    // The lead is taking writes: its heading still sends.
    await userEvent.setup().click(within(container).getByRole("button", { name: "New tab in webapp" }));
    expect(onNewTab).toHaveBeenCalledTimes(1);
  });

  it("new tab: shows busy only on the heading whose create is in flight, never on the other machine's w1", async () => {
    render(
      <AgentList
        agents={crew}
        onOpen={vi.fn()}
        servers={servers}
        newTab={wiring({ creating: new Set([tabCreateKey("w1", { host: PEER })]) })}
      />,
    );
    const peerPlus = await screen.findByRole("button", { name: "New tab in moonward" });
    expect(peerPlus).toBeDisabled();
    expect(peerPlus).toHaveAttribute("aria-busy", "true");
    const leadPlus = screen.getByRole("button", { name: "New tab in webapp" });
    expect(leadPlus).toBeEnabled();
    expect(leadPlus).toHaveAttribute("aria-busy", "false");
  });

  it("new tab: a 28px face with the heading's 44px reach, inside a row that is at least as tall", async () => {
    render(<AgentList agents={crew} onOpen={vi.fn()} servers={servers} newTab={wiring()} />);
    const button = await screen.findByRole("button", { name: "New tab in webapp" });
    expect(button).toHaveClass("size-7", ...HEADING_ADD_REACH.split(" "));
    // -9px from the padding box, 1px inside the dashed border: 26 + 18 = 44 across and down, 8px past
    // the circle on each side, which is exactly the 8px gap down to the first row (agent-list.tsx).
    expect(HEADING_ADD_REACH).toContain("before:-inset-[9px]");
    expect(button.closest("section")).toHaveClass("gap-2");
    expect(headingRow("webapp")).toHaveClass("min-h-7");
  });
});

// THE PIN HINT (M38/02): one quiet line on the Panes tab, where the Pinned group will stand, saying a
// hold pins a pane. Only on Panes, only with a hold wired, only while nothing is pinned, only on three
// or more rows, and gone for good on this device after its X or the first pin.
describe("AgentList — the pin hint", () => {
  const herd = [
    agent("a1", "idle", { workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1", sessionName: "orchestrator" }),
    agent("a2", "blocked", { workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1", sessionName: "stuck" }),
    agent("b1", "working", { workspaceId: "w2", workspaceLabel: "two", workspaceNumber: 2, tabId: "w2:t1", sessionName: "builder" }),
  ];
  const HOLD = "Hold a pane to pin it here.";
  const RIGHT_CLICK = "Right-click a pane to pin it here.";
  const FLAG = "collie:pin-hint:v1";
  const hint = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-slot="notice"]');
  const dismiss = () => screen.getByRole("button", { name: "Dismiss hint" });

  afterEach(() => vi.unstubAllGlobals());

  /** A device whose primary pointer is a mouse: `(pointer: fine)` matches, nothing else does. */
  function finePointer() {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: fine)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  it("hint: shows on Panes under the summary line, before the first group, with the pin glyph", () => {
    const { container } = render(<AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} />);
    const line = hint(container)!;
    expect(line).toHaveTextContent(HOLD);
    // The quiet register: the neutral notice, muted ink, a uniform edge and no status colour.
    expect(line).toHaveClass("border", "text-muted-foreground");
    expect(line.className).not.toMatch(/status-|border-l-|primary/u);
    expect(line.querySelector("svg.lucide-pin")).not.toBeNull();
    const summary = screen.getByRole("button", { name: /^\d+ needs you/ });
    expect(summary.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(groupSection("one")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // It leaves through a Collapse, never a bare unmount.
    expect(line.closest('[data-slot="collapse"]')).not.toBeNull();
  });

  it("hint: never with the needs-you switch on, or on Changes and Crew", () => {
    const { container, rerender } = render(<AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} needsYouOnly />);
    expect(hint(container)).toBeNull();
    rerender(<AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} renderBody={() => <p>changes body</p>} />);
    expect(hint(container)).toBeNull();
    expect(screen.queryByText(HOLD)).toBeNull();
  });

  it("hint: never on a list without a hold to teach", () => {
    const { container } = render(<AgentList agents={herd} onOpen={vi.fn()} />);
    expect(hint(container)).toBeNull();
  });

  it("hint: needs at least three pane rows on show, shells included, after isolate", async () => {
    const { container, rerender } = render(<AgentList agents={herd.slice(0, 2)} onOpen={vi.fn()} onHold={vi.fn()} />);
    expect(hint(container)).toBeNull();
    // A bare shell is a pane row too.
    const shell = agent("s1", "idle", { kind: "shell", workspaceId: "w2", workspaceLabel: "two", workspaceNumber: 2, tabId: "w2:t1" });
    rerender(<AgentList agents={herd.slice(0, 2)} shellPanes={[shell]} onOpen={vi.fn()} onHold={vi.fn()} />);
    expect(hint(container)).toHaveTextContent(HOLD);
    // Isolating workspace one leaves two rows on show, and the line slides shut.
    const isolateOne = workspacePrefKey(groupPanesByWorkspace([herd[0]!])[0]!);
    rerender(<AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} isolated={isolateOne} />);
    await waitFor(() => expect(screen.queryByText(HOLD)).toBeNull());
  });

  it("hint: hidden while a pin is stored, a dormant one too", () => {
    const { container, rerender } = render(
      <AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} pins={[{ row: paneRowKey(herd[2]!), space: "two", at: 1 }]} />,
    );
    expect(hint(container)).toBeNull();
    // A pin whose pane is not on screen draws nothing, and still says the gesture is known.
    rerender(<AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} pins={[{ row: "gone", space: "elsewhere", at: 1 }]} />);
    expect(hint(container)).toBeNull();
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
  });

  it("hint: the X writes the flag, the line slides shut, and it stays gone on this device", async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(<AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} />);
    expect(localStorage.getItem(FLAG)).toBeNull();
    await user.click(dismiss());
    expect(localStorage.getItem(FLAG)).toBe("1");
    // Collapse holds the words through its exit, then the box leaves.
    await waitFor(() => expect(hint(container)).toBeNull());
    unmount();
    // A fresh mount, as a reload would give, draws nothing.
    const again = render(<AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} />);
    expect(hint(again.container)).toBeNull();
  });

  it("hint: the X hands focus to the first row below, never to body", async () => {
    const user = userEvent.setup();
    render(<AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} />);
    dismiss().focus();
    await user.keyboard("{Enter}");
    expect(within(groupSection("one")).getAllByRole("button")[0]).toHaveFocus();
  });

  it("hint: the first pin writes the flag, and the line stays gone after every pin is removed", async () => {
    const { container, rerender } = render(<AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} pins={currentPins()} />);
    expect(hint(container)).toHaveTextContent(HOLD);
    act(() => setPinned(herd[2]!, true, herd));
    expect(localStorage.getItem(FLAG)).toBe("1");
    rerender(<AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} pins={currentPins()} />);
    expect(screen.getByRole("region", { name: "Pinned" })).toBeInTheDocument();
    act(() => setPinned(herd[2]!, false, herd));
    rerender(<AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} pins={currentPins()} />);
    expect(currentPins()).toHaveLength(0);
    await waitFor(() => expect(hint(container)).toBeNull());
  });

  it("hint: a render, a tab switch or a poll writes no flag", () => {
    const { rerender } = render(<AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} />);
    rerender(<AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} needsYouOnly />);
    rerender(<AgentList agents={[...herd]} onOpen={vi.fn()} onHold={vi.fn()} />);
    expect(localStorage.getItem(FLAG)).toBeNull();
  });

  it("hint: says right-click on a device whose pointer is a mouse", () => {
    finePointer();
    const { container } = render(<AgentList agents={herd} onOpen={vi.fn()} onHold={vi.fn()} />);
    expect(hint(container)).toHaveTextContent(RIGHT_CLICK);
    expect(screen.queryByText(HOLD)).toBeNull();
  });
});

// THE ORDER TOGGLE (ADR 0071, "The dashboard takes the setting"): Place is the dashboard as it was,
// byte for byte; Activity and Cache fold the workspace groups into one list under one heading. The
// reading is frozen: a poll repaints a row where it stands, and only the operator's tap, the page
// coming back to the foreground, or a changed order takes a new one.
describe("AgentList — the order select", () => {
  // Two workspaces, and activity order disagrees with place order on every row, so a pass cannot be
  // an accident of the arrival order. Place order: alpha (one), beta (one), gamma (two), delta (two).
  // `lastSeenAt` equal to the clock: the pane is seen, so only `beta` (blocked) needs you.
  const timed = (a: AgentView, lastActiveAt: number): AgentView => ({ ...a, lastActiveAt, lastSeenAt: lastActiveAt });
  const summaryLine = () => document.getElementById("dash-summary-line")!;
  const ws = (n: 1 | 2) =>
    n === 1
      ? { workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1" }
      : { workspaceId: "w2", workspaceLabel: "two", workspaceNumber: 2, tabId: "w2:t1" };
  const herd = [
    timed(agent("a", "idle", { ...ws(1), sessionName: "alpha" }), 100),
    timed(agent("b", "blocked", { ...ws(1), sessionName: "beta" }), 400),
    timed(agent("c", "working", { ...ws(2), sessionName: "gamma" }), 300),
    timed(agent("d", "idle", { ...ws(2), sessionName: "delta" }), 200),
  ];
  const names = () =>
    rowButtons().map((b) => ["alpha", "beta", "gamma", "delta"].find((n) => within(b).queryByText(n) !== null));
  const props = { onOpen: vi.fn(), onOrderChange: vi.fn() };

  it("order: place keeps the workspace groups, and offers the select beside the workspace select", () => {
    render(<AgentList agents={herd} {...props} order="place" />);
    expect(headings()).toEqual(["one", "two"]);
    expect(names()).toEqual(["alpha", "beta", "gamma", "delta"]);
    const select = screen.getByRole("combobox", { name: "Pane order" });
    expect(select).toHaveValue("place");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Place", "Activity", "Cache"]);
    // The two selects share one row, the workspace filter first; the alarm has the row above.
    const row = select.closest('[data-slot="select"]')!.parentElement!.parentElement!;
    expect(row).toContainElement(screen.getByRole("combobox", { name: "Workspace" }));
    expect(row).not.toContainElement(summaryLine());
  });

  it("order: draws no control, and the summary line keeps its place, when nothing can store the answer", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} />);
    expect(screen.queryByRole("combobox", { name: "Pane order" })).toBeNull();
  });

  it("order: reports a pick and changes nothing itself", async () => {
    const user = userEvent.setup();
    const onOrderChange = vi.fn();
    render(<AgentList agents={herd} onOpen={vi.fn()} order="place" onOrderChange={onOrderChange} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Pane order" }), "activity");
    expect(onOrderChange).toHaveBeenCalledWith("activity");
    expect(headings()).toEqual(["one", "two"]);
  });

  it("order: activity is ONE flat list under one heading, newest first, with no workspace heading and no '+'", async () => {
    render(
      <AgentList
        agents={herd}
        {...props}
        order="activity"
        newTab={{ scope: {}, creating: new Set(), onNewTab: vi.fn() }}
      />,
    );
    expect(headings()).toEqual(["newest first(4)"]);
    expect(names()).toEqual(["beta", "gamma", "delta", "alpha"]);
    expect(screen.queryByRole("button", { name: /^New tab in / })).toBeNull();
    // Each row still names its workspace, on line 2, since no heading above it does.
    const rows = rowButtons();
    expect(within(rows[0]!).getByText("one")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("two")).toBeInTheDocument();
    // The workspace select keeps its options.
    expect(within(screen.getByRole("combobox", { name: "Workspace" })).getByRole("option", { name: /^two/ })).toBeInTheDocument();
  });

  it("order: cache runs soonest-to-go-cold first, with the pane that has no cache last", () => {
    const now = Date.now();
    const warm = (a: AgentView, msLeft: number): AgentView => ({
      ...a,
      cache: { state: "warm", ttlSeconds: 300, ruleId: "r", confidence: "documented", expiresAt: now + msLeft },
    });
    render(
      <AgentList
        agents={[warm(herd[0]!, 600_000), herd[1]!, warm(herd[2]!, 60_000), warm(herd[3]!, 120_000)]}
        {...props}
        order="cache"
      />,
    );
    expect(headings()).toEqual(["going cold first(4)"]);
    expect(names()).toEqual(["gamma", "delta", "alpha", "beta"]);
  });

  it("order: pins lead and are ranked inside themselves", () => {
    let now = 0;
    setPinned(herd[0]!, true, herd, ++now);
    setPinned(herd[3]!, true, herd, ++now);
    render(<AgentList agents={herd} {...props} order="activity" pins={currentPins()} />);
    expect(headings()).toEqual(["pinned", "newest first(2)"]);
    const pinnedRegion = screen.getByRole("region", { name: "Pinned" });
    // delta (200) outranks alpha (100) inside Pinned, though alpha comes first in place order.
    const inPinned = within(pinnedRegion)
      .getAllByRole("button")
      .map((b) => ["alpha", "delta"].find((n) => within(b).queryByText(n) !== null));
    expect(inPinned).toEqual(["delta", "alpha"]);
    // Listed once: the rest are the ranked list.
    expect(names().slice(-2)).toEqual(["beta", "gamma"]);
  });

  it("order: the filters run first and never sort", () => {
    // The switch keeps only the pane that needs you; isolate keeps one workspace; the ranking then runs
    // over what is left.
    const { rerender } = render(<AgentList agents={herd} {...props} order="activity" needsYouOnly />);
    expect(names()).toEqual(["beta"]);
    rerender(<AgentList agents={herd} {...props} order="activity" isolated={workspacePrefKey(groupPanesByWorkspace(herd, [], { order: "fixed" })[1]!)} />);
    expect(names()).toEqual(["gamma", "delta"]);
    rerender(<AgentList agents={herd} {...props} order="activity" hidden={[workspacePrefKey(groupPanesByWorkspace(herd, [], { order: "fixed" })[0]!)]} />);
    expect(names()).toEqual(["gamma", "delta"]);
  });

  it("order: holds its order while a pane's clock moves under it (the freeze)", () => {
    const { rerender } = render(<AgentList agents={herd} {...props} order="activity" />);
    const before = names();
    rerender(<AgentList agents={[timed(herd[0]!, 9_000), herd[1]!, herd[2]!, herd[3]!]} {...props} order="activity" />);
    expect(names()).toEqual(before);
    // A status change is a poll too: it repaints, it does not move.
    rerender(<AgentList agents={[herd[0]!, { ...herd[1]!, status: "idle" }, herd[2]!, herd[3]!]} {...props} order="activity" />);
    expect(names()).toEqual(before);
  });

  it("order: a pane that arrives after the reading ranks last, not first", () => {
    const { rerender } = render(<AgentList agents={herd} {...props} order="activity" />);
    const newest = timed(agent("e", "idle", { ...ws(1), sessionName: "epsilon" }), 99_999);
    rerender(<AgentList agents={[...herd, newest]} {...props} order="activity" />);
    const last = rowButtons().at(-1)!;
    expect(within(last).getByText("epsilon")).toBeInTheDocument();
  });

  it("order: changing the order takes a new reading", () => {
    const { rerender } = render(<AgentList agents={herd} {...props} order="place" />);
    rerender(<AgentList agents={herd} {...props} order="activity" />);
    expect(names()).toEqual(["beta", "gamma", "delta", "alpha"]);
  });

  it("order: the page coming back to the foreground takes a new reading", () => {
    const { rerender } = render(<AgentList agents={herd} {...props} order="activity" />);
    rerender(<AgentList agents={[timed(herd[0]!, 9_000), herd[1]!, herd[2]!, herd[3]!]} {...props} order="activity" />);
    expect(names()[0]).toBe("beta");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(names()[0]).toBe("alpha");
  });

  it("order: the summary line jumps to the first urgent row in the ranked list", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<AgentList agents={herd} {...props} order="activity" />);
    await user.click(summaryLine());
    expect(scrollIntoView).toHaveBeenCalled();
    expect(within(rowButtons()[0]!).getByText("beta")).toBeInTheDocument();
  });

  it("order: the Changes tab draws no order select, and keeps its own body and the row's height", () => {
    render(<AgentList agents={herd} {...props} order="activity" renderBody={() => <p>changes body</p>} />);
    expect(screen.queryByRole("combobox", { name: "Pane order" })).toBeNull();
    // The workspace select stays: it narrows the workspaces Changes lists.
    expect(screen.getByRole("combobox", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByText("changes body")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /newest first/i })).toBeNull();
    expect(summaryLine().parentElement).toHaveClass("min-h-11");
  });

  it("needs-you switch: drawn at the end of the summary line only when given a way to flip, and reports a tap", async () => {
    const user = userEvent.setup();
    const onNeedsYouOnlyChange = vi.fn();
    const { rerender } = render(<AgentList agents={herd} {...props} />);
    expect(screen.queryByRole("button", { name: "Show only panes that need you" })).toBeNull();
    rerender(<AgentList agents={herd} {...props} onNeedsYouOnlyChange={onNeedsYouOnlyChange} />);
    const sw = screen.getByRole("button", { name: "Show only panes that need you" });
    expect(sw).toHaveAttribute("aria-pressed", "false");
    // One row with the summary line, the switch at its right end.
    expect(sw.parentElement!.parentElement).toBe(summaryLine().parentElement);
    await user.click(sw);
    expect(onNeedsYouOnlyChange).toHaveBeenCalledWith(true);
    rerender(<AgentList agents={herd} {...props} needsYouOnly onNeedsYouOnlyChange={onNeedsYouOnlyChange} />);
    expect(screen.getByRole("button", { name: "Show only panes that need you" })).toHaveAttribute("aria-pressed", "true");
    // Pressed again, it asks for off.
    await user.click(screen.getByRole("button", { name: "Show only panes that need you" }));
    expect(onNeedsYouOnlyChange).toHaveBeenLastCalledWith(false);
  });

  it("needs-you switch: a tab with its own body hides the switch and the order select, and keeps both slots", () => {
    render(<AgentList agents={herd} {...props} onNeedsYouOnlyChange={vi.fn()} renderBody={() => <p>crew body</p>} />);
    expect(screen.queryByRole("button", { name: "Show only panes that need you" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Pane order" })).toBeNull();
    expect(summaryLine().parentElement).toHaveClass("min-h-11");
    expect(summaryLine().parentElement!.querySelector(".invisible")).not.toBeNull();
    const selectRow = screen.getByRole("combobox", { name: "Workspace" }).closest('[data-slot="select"]')!.parentElement!;
    expect(selectRow.querySelector(".invisible")).not.toBeNull();
  });
});
