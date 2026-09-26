import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentList } from "./agent-list";
import { groupPanesByWorkspace, type WorkspaceGroup } from "@/lib/pane-groups";
import { paneName } from "@/lib/pane-name";
import { workspacePrefKey } from "./agent-list";
import { paneRowKey } from "@/lib/hosts";
import { currentPins, setPinned } from "@/lib/pins";
import { setMachineHidden, useHiddenMachines } from "@/lib/hidden-machines";
import type { AgentStatus, AgentView, ServerSummary } from "@/lib/types";

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
    // The one summary slot at the top spells the very same counts in words.
    expect(screen.getByText("1 needs you")).toBeInTheDocument();
    expect(screen.getByText("2 idle")).toBeInTheDocument();
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

describe("AgentList — the Spaces filter strip", () => {
  const two = [
    agent("a", "idle", { workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1" }),
    agent("b", "idle", { workspaceId: "w2", workspaceLabel: "two", workspaceNumber: 2, tabId: "w2:t1" }),
  ];

  // A chip's accessible name is its status word run straight into its label ("idleone", no space) —
  // never an exact "one" — so every chip lookup below is a Spaces-strip-scoped substring match.
  const chip = (label: string) =>
    within(screen.getByRole("navigation", { name: /spaces/i })).getByRole("button", {
      name: new RegExp(label),
    });

  it("keeps a hidden workspace hidden when Herdr renumbers its id", () => {
    const key = prefKeyOf(two[0]!);
    const renumbered = two.map((p, i) => (i === 0 ? { ...p, workspaceId: `${p.workspaceId}x`, tabId: `${p.workspaceId}x:t1` } : p));
    render(<AgentList agents={renumbered} onOpen={vi.fn()} hidden={[key]} />);
    expect(headings()).not.toContain("one");
  });

  it("isolates a workspace on a chip tap; tapping it again returns to all", async () => {
    const user = userEvent.setup();
    const onIsolate = vi.fn();
    const key = prefKeyOf(two[0]!);
    const { rerender } = render(<AgentList agents={two} onOpen={vi.fn()} onIsolate={onIsolate} />);
    await user.click(chip("one"));
    expect(onIsolate).toHaveBeenCalledExactlyOnceWith(key);

    rerender(<AgentList agents={two} onOpen={vi.fn()} isolated={key} onIsolate={onIsolate} />);
    // Isolated: only "one"'s group is left on screen.
    expect(headings()).toEqual(["one"]);
    expect(chip("one")).toHaveAttribute("aria-current", "true");

    await user.click(chip("one"));
    expect(onIsolate).toHaveBeenLastCalledWith(null);
  });

  it("hides a workspace via long-press (contextmenu), calling onToggleHidden with its key", () => {
    const onToggleHidden = vi.fn();
    render(<AgentList agents={two} onOpen={vi.fn()} onToggleHidden={onToggleHidden} />);
    // A long-press reaches the DOM as a `contextmenu` event (Android Chrome / right-click) —
    // components/ui/chip.tsx wires it through `useLongPress`.
    fireEvent.contextMenu(chip("one"));
    expect(onToggleHidden).toHaveBeenCalledExactlyOnceWith(prefKeyOf(two[0]!));
  });

  it("keeps a hidden chip in the strip, dimmed and marked hidden — the group itself drops", () => {
    const key = prefKeyOf(two[0]!);
    render(<AgentList agents={two} onOpen={vi.fn()} hidden={[key]} />);
    // "one" no longer has a heading — its rows are gone from the list.
    expect(headings()).toEqual(["two"]);
    // Its chip is still in the strip, and says so for screen readers.
    const hiddenChip = screen.getByRole("button", { name: /one/ });
    expect(within(hiddenChip).getByText(/hidden/i)).toBeInTheDocument();
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
// workspace before isolate and hide, deaf to the Focus filter, and each pinned pane listed once.
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

  it("drops a workspace group left with no rows, and keeps its chip in the strip", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} pins={pinned("builder", "quiet")} />);
    expect(headings()).toEqual(["pinned", "one"]);
    expect(within(screen.getByRole("navigation", { name: /spaces/i })).getByRole("button", { name: /two/ })).toBeInTheDocument();
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

  it("ignores the Focus filter: an idle pinned pane leads, and the groups keep only what needs you", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} pins={pinned("orchestrator")} needsYouOnly />);
    expect(rowNames(pinnedRegion())).toEqual(["orchestrator"]);
    expect(headings()).toEqual(["pinned", "one"]);
    expect(rowNames(groupSection("one"))).toEqual(["stuck"]);
  });

  it("shows only the Pinned group under an all-clear Focus when every urgent pane is pinned", () => {
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
    // Unpinned on Focus: an idle pane leaves the list, and focus goes to the summary line.
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
// groups leave Panes, Focus and Changes, its chips give way to one dimmed stand-in chip with its worst
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
  const strip = () => within(screen.getByRole("navigation", { name: /spaces/i }));
  const chipNames = () => strip().getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
  const standIn = (name: string) => strip().getByRole("button", { name: `Show ${name}'s panes` });
  const summaryLine = () => screen.getByRole("button", { name: /^\d+ needs you/ });

  it("leaves a hidden machine's workspaces out of Panes, and the summary line still counts them", () => {
    render(<AgentList agents={herd} servers={servers} hiddenMachines={["workshop"]} onOpen={vi.fn()} />);
    expect(headings()).toEqual(["collie", "attic-ws"]);
    // workshop's blocked pane is off the list and still in the count: nothing is silenced.
    expect(summaryLine()).toHaveAccessibleName(/^2 needs you/);
  });

  it("leaves a hidden machine out of Focus too", () => {
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

  it("lets isolate win: an isolated workspace on a hidden machine shows, its chip right after the machine's", () => {
    const isolated = prefKeyOf(byName("peer-idle"));
    render(
      <AgentList agents={herd} servers={servers} hiddenMachines={["workshop"]} isolated={isolated} onOpen={vi.fn()} />,
    );
    expect(headings()).toEqual(["docs"]);
    expect(chipNames()).toEqual(["All", "collie", "Show workshop's panes", "docs", "attic-ws"].map((n) => expect.stringContaining(n)));
    expect(strip().getByRole("button", { name: /docs/ })).toHaveAttribute("aria-current", "true");
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

  it("swaps a hidden machine's chips for one dimmed stand-in chip, at its place, with its worst dot", () => {
    render(<AgentList agents={herd} servers={servers} hiddenMachines={["workshop"]} onOpen={vi.fn()} />);
    expect(chipNames()).toEqual(["All", "collie", "Show workshop's panes", "attic-ws"].map((n) => expect.stringContaining(n)));
    const chip = standIn("workshop");
    // The machine's name for the eye, its worst status for the ear, and the server glyph in its tint.
    expect(chip).toHaveTextContent("workshop");
    expect(chip).toHaveAccessibleDescription("needs you");
    expect(chip.querySelector("svg")?.getAttribute("class")).toMatch(/text-host-\d/);
    // Drawn dimmed, like a hidden workspace's chip.
    expect(chip.className).toContain("border-dashed");
    expect(chip).not.toHaveAttribute("aria-current");
  });

  it("draws no stand-in chip for a hidden machine with no panes", () => {
    const leadOnly = herd.filter((a) => a.host !== "attic");
    render(<AgentList agents={leadOnly} servers={servers} hiddenMachines={["attic"]} onOpen={vi.fn()} />);
    expect(strip().queryByRole("button", { name: /^Show attic/ })).toBeNull();
  });

  it("keeps the stand-in chip of a hidden machine that is down, with its last good dot", () => {
    const down = servers.map((s) => (s.id === "workshop" ? { ...s, reachable: false } : s));
    render(<AgentList agents={herd} servers={down} hiddenMachines={["workshop"]} onOpen={vi.fn()} />);
    expect(standIn("workshop")).toHaveAccessibleDescription("needs you");
  });

  it("a tap on the stand-in chip shows the machine again, and focus lands on the chip in its place", async () => {
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

    await user.click(standIn("workshop"));
    expect(headings()).toEqual(["collie", "moonward", "docs", "attic-ws"]);
    expect(strip().queryByRole("button", { name: /^Show workshop/ })).toBeNull();
    // The machine's first workspace chip took the stand-in's place, and focus with it.
    expect(strip().getByRole("button", { name: /moonward/ })).toHaveFocus();
  });
});
