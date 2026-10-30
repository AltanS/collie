import { meaningfulTabLabel, meaningfulTerminalTitle } from "../../activity.ts";
import type { AgentStatus } from "../../types.ts";
import { MUX_AGENT_NAMES, MUX_SHELL_AGENT } from "../agents.ts";
import type { MuxPane, MuxSnapshot, MuxSpace, MuxTab } from "../types.ts";
import type { WireForeground, WireLayout, WireStatus, WireTerminal } from "./client.ts";

// THE MAPPING, pure: core terminals plus herdr-app's layout document in, the port's snapshot out.
// Its own module so every rule below is tested without a socket (layout.test.ts).
//
//   herdr-app space  (label `herdr.space`)  →  Collie SPACE   (the space id, `sp…`)
//   herdr-app tab    (label `herdr.tab`)    →  Collie TAB     (the tab id, `tb…`)
//   core terminal    (`t7`)                 →  Collie PANE    (the address, carried unchanged)
//
// The labels are the truth for WHERE a terminal belongs: herdr-app shows a terminal in the space
// and tab its labels name, even one it did not start (AGENTS.md § The model). The document gives
// the names and the order. A terminal without the labels belongs to no herdr-app space, so it sits
// in one implicit space with one tab ({@link IMPLICIT_SPACE_ID}).
//
// A terminal on another machine (`box/t7`) is dropped before anything else: its journal, uploads
// and audit log sit on that machine, and it is reached through the Collie running there
// (ADR 0036, MUX_CONTRACT.md § Host locality).

/** The labels herdr-app sets on every terminal it shows (AGENTS.md). */
export const SPACE_LABEL = "herdr.space";
export const TAB_LABEL = "herdr.tab";
/** herdr-app's display names for a terminal's space and tab, `"<space> / <tab>"`. */
export const WHERE_LABEL = "where";

/** The space, and its one tab, for terminals herdr-app does not show. */
export const IMPLICIT_SPACE_ID = "herdr-core";
export const IMPLICIT_TAB_ID = "herdr-core.1";

/** Whether an address names a terminal on THIS machine. Another machine's is `machine/t7`. */
export function isLocalAddress(address: string): boolean {
  return address.length > 0 && !address.includes("/");
}

/**
 * The Collie harness name for each program name the core has been seen to report in `status.app`,
 * where it is not already a Collie name. Claude Code reports `claude-code` (probed on the live
 * core). A name that IS a Collie harness name maps to itself without an entry.
 */
const AGENT_BY_APP = new Map<string, string>([
  ["claude-code", "claude"],
  ["cursor-agent", "cursor"],
]);

// Checked at load: every name above must be one the contract accepts.
for (const name of AGENT_BY_APP.values()) {
  if (!MUX_AGENT_NAMES.includes(name)) throw new Error(`herdr-core adapter maps to ${name}, which is not a Collie harness`);
}

/** The Collie harness name for a reported app, or `null` when Collie has no such harness. */
export function agentForApp(app: string): string | null {
  const key = app.trim().toLowerCase();
  if (key === "") return null;
  const mapped = AGENT_BY_APP.get(key);
  if (mapped !== undefined) return mapped;
  return MUX_AGENT_NAMES.includes(key) ? key : null;
}

/** A program's status word in Collie's triage words. `error` has no Collie word, so it is unknown. */
export function agentStatus(state: string): AgentStatus {
  switch (state) {
    case "idle":
      return "idle";
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    default:
      return "unknown";
  }
}

/** A pane's harness and its triage word. */
interface PaneAgent {
  readonly agent: string;
  readonly status: AgentStatus;
}

/**
 * The pane's agent and status. The program's own OSC 7501 report wins. A program that sends none
 * (omp 18.6.1), or whose report names no app, is named from the foreground process, through the same table as a report: a shell,
 * or any process Collie has no harness for, stays a shell. A name taken from the process carries no
 * status, because only a report says what the program is doing.
 */
function agentOf(status: WireStatus | null, foreground: WireForeground | null): PaneAgent {
  if (status !== null && status.app.trim() !== "") {
    // A program that names itself decides, even when Collie has no harness for the name.
    const reported = agentForApp(status.app);
    if (reported === null) return { agent: MUX_SHELL_AGENT, status: "unknown" };
    return { agent: reported, status: agentStatus(status.state) };
  }
  const running = foreground === null ? null : agentForApp(foreground.name);
  if (running !== null) return { agent: running, status: "unknown" };
  return { agent: MUX_SHELL_AGENT, status: "unknown" };
}

/** The last part of a path, `~` for the home folder, or `""`. */
function folderName(path: string, home: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  if (trimmed === "") return "";
  if (home !== "" && trimmed === home.replace(/\/+$/u, "")) return "~";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** herdr-app's display names for one terminal's place; either may be empty. */
interface WhereNames {
  readonly space: string;
  readonly tab: string;
}

/** `where` split into its space and tab names. */
function whereParts(terminal: WireTerminal | undefined): WhereNames {
  const where = terminal?.labels[WHERE_LABEL] ?? "";
  const cut = where.lastIndexOf(" / ");
  if (cut < 0) return { space: where.trim(), tab: "" };
  return { space: where.slice(0, cut).trim(), tab: where.slice(cut + 3).trim() };
}

interface SpaceDraft {
  readonly id: string;
  readonly docName: string;
  readonly folder: string;
  readonly tabs: TabDraft[];
}

interface TabDraft {
  readonly id: string;
  readonly docName: string;
  readonly terminals: WireTerminal[];
}

type MutableMuxPane = { -readonly [K in keyof MuxPane]: MuxPane[K] };
type MutableMuxSpace = { -readonly [K in keyof MuxSpace]: MuxSpace[K] };

/**
 * The snapshot for these terminals and this layout document.
 *
 * Only LIVE local terminals become panes. Spaces and tabs keep the document's order, and ids the
 * document does not know follow in the order the terminals list them. A space or a tab with no
 * terminal in this snapshot is left out, so every count is a count of what the snapshot carries
 * (MUX_CONTRACT.md § Counts). Nothing is focused: the core has no focus, and herdr-app keeps its
 * own per screen (HC_API.md § Documents).
 */
export function toSnapshot(terminals: readonly WireTerminal[], layout: WireLayout | null, home: string): MuxSnapshot {
  const live = terminals.filter((terminal) => isLocalAddress(terminal.address) && terminal.state === "live");
  const spaces: SpaceDraft[] = [];
  const spaceById = new Map<string, SpaceDraft>();
  const tabById = new Map<string, TabDraft>();
  for (const space of layout?.spaces ?? []) {
    const draft: SpaceDraft = { id: space.id, docName: space.name, folder: space.folder, tabs: [] };
    spaces.push(draft);
    spaceById.set(space.id, draft);
    for (const tab of space.tabs) {
      const tabDraft: TabDraft = { id: tab.id, docName: tab.name, terminals: [] };
      draft.tabs.push(tabDraft);
      tabById.set(tab.id, tabDraft);
    }
  }
  let implicit: SpaceDraft | null = null;
  for (const terminal of live) {
    const spaceId = terminal.labels[SPACE_LABEL] ?? "";
    const tabId = terminal.labels[TAB_LABEL] ?? "";
    if (spaceId === "" || tabId === "") {
      implicit ??= { id: IMPLICIT_SPACE_ID, docName: "", folder: "", tabs: [{ id: IMPLICIT_TAB_ID, docName: "", terminals: [] }] };
      implicit.tabs[0]?.terminals.push(terminal);
      continue;
    }
    let space = spaceById.get(spaceId);
    if (space === undefined) {
      space = { id: spaceId, docName: "", folder: "", tabs: [] };
      spaces.push(space);
      spaceById.set(spaceId, space);
    }
    let tab = tabById.get(tabId);
    if (tab === undefined) {
      tab = { id: tabId, docName: "", terminals: [] };
      space.tabs.push(tab);
      tabById.set(tabId, tab);
    }
    tab.terminals.push(terminal);
  }
  if (implicit !== null) spaces.push(implicit);

  const panes: MuxPane[] = [];
  const outSpaces: MuxSpace[] = [];
  const outTabs: MuxTab[] = [];
  for (const space of spaces) {
    // A tab is shown by its place among the tabs that hold a terminal here, as herdr-app numbers them.
    const shown = space.tabs.filter((tab) => tab.terminals.length > 0);
    if (shown.length === 0) continue;
    const first = shown[0]?.terminals[0];
    const spaceNumber = outSpaces.length + 1;
    const label =
      space.id === IMPLICIT_SPACE_ID
        ? IMPLICIT_SPACE_ID
        : space.docName || whereParts(first).space || folderName(first?.foreground?.cwd || first?.cwd || space.folder, home) || space.id;
    const outSpace: MutableMuxSpace = {
      spaceId: space.id,
      number: spaceNumber,
      label,
      focused: false,
      activeTabId: shown[0]?.id ?? "",
      tabCount: shown.length,
      paneCount: shown.reduce((sum, tab) => sum + tab.terminals.length, 0),
    };
    if (space.folder !== "") outSpace.folder = space.folder;
    outSpaces.push(outSpace);
    shown.forEach((tab, index) => {
      const place = String(index + 1);
      const tabLabel = tab.docName || whereParts(tab.terminals[0]).tab || place;
      outTabs.push({ tabId: tab.id, spaceId: space.id, number: index + 1, label: tabLabel, focused: false, paneCount: tab.terminals.length });
      for (const terminal of tab.terminals) panes.push(toPane(terminal, { space, label, spaceNumber, tab, tabLabel }));
    });
  }
  return { panes, spaces: outSpaces, tabs: outTabs };
}

interface PanePlace {
  readonly space: SpaceDraft;
  readonly label: string;
  readonly spaceNumber: number;
  readonly tab: TabDraft;
  readonly tabLabel: string;
}

function toPane(terminal: WireTerminal, place: PanePlace): MuxPane {
  const { agent, status } = agentOf(terminal.status, terminal.foreground);
  const pane: MutableMuxPane = {
    paneId: terminal.address,
    spaceId: place.space.id,
    spaceLabel: place.label,
    spaceNumber: place.spaceNumber,
    tabId: place.tab.id,
    // Where the program is now, which is what herdr-app names a space after; the start folder when
    // nothing runs in the foreground.
    cwd: terminal.foreground?.cwd || terminal.cwd,
    focused: false,
    alive: true,
    agent,
    status,
  };
  // A tab label worth showing: the name somebody gave it, never a place number (meaningfulTabLabel).
  const tabLabel = place.tab.docName || meaningfulTabLabel(place.tabLabel);
  if (tabLabel !== undefined && tabLabel !== "") pane.tabLabel = tabLabel;
  if (place.tab.docName !== "") pane.tabNamed = true;
  // The name the terminal was started with is a person's or an agent's choice, not a title the
  // program printed, so it is the pane's label (MUX_CONTRACT.md § Pane naming).
  if (terminal.name !== "") pane.paneLabel = terminal.name;
  const title = meaningfulTerminalTitle(terminal.title, undefined, agent, place.label);
  if (title !== undefined && title !== "") pane.terminalTitle = title;
  // A raw process fact for presentation only, never the agent (MuxPane.foregroundCommand).
  if (terminal.foreground !== null && terminal.foreground.name !== "") pane.foregroundCommand = terminal.foreground.name;
  return pane;
}
