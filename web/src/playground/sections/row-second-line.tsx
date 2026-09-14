// The blank tab line, and what the dashboard looks like on the two other multiplexers.
//
// THE COMPLAINT: the workspace-grouped row (`AgentCard scope="place"`, shipped in `agent-card.tsx`)
// states a fixed 44px — line 1 the pane's name, line 2 a 16px slot for the tab name — and that slot
// renders EMPTY when the tab has no name of its own (`isUnnamedTab` in `lib/pane-name.ts`). Altan's
// read: the empty slot looks ugly, the name floats near the top of the row over a gap that says
// nothing. He also asked to see this dashboard on the two multiplexers Collie supports besides the
// one the screenshots are usually taken on.
//
// OPTIONS 1 TO 4 answer the first half, and they all add ONE prop, `AgentCard`'s new `blankTab`
// (`"gap" | "center" | "cwd" | "position" | "raw"`, default `"gap"` — see that file for the full
// contract). `"gap"` is what ships today and is what every row outside this section still gets;
// picking one of the other four here is a decision to ship it as the new default, not a change that
// has landed. `AgentList` grew the same prop, forwarded to its workspace-grouped rows only, purely so
// these cards can mount the REAL list rather than a redrawn row.
//
// OPTIONS 5 TO 7 answer the second half: the same real `AgentList`, over fixtures shaped from the
// live facts about the other two multiplexers (never named here — see CLAUDE.md's repo guard, and
// `scripts/check-mux-names.sh`). Nothing in `AgentCard` or `AgentList` changes for these three; they
// are here to be looked at, not to justify a prop.
//
// DEV-ONLY, unreachable from the app entry.

import { AgentList } from "@/components/agent-list";
import type { BlankTabMode } from "@/components/agent-card";
import type { AgentView } from "@/lib/types";

import { Card, Group, Section, type SectionDef } from "../harness";
import { PhoneMock } from "./shared";

export const DEF: SectionDef = {
  id: "row-second-line",
  title: "Blank tab line and other multiplexers",
  intent:
    "Seven numbered options. 1 to 4 try a treatment for the workspace-grouped row's blank tab line, each behind AgentCard's new blankTab prop, defaulted OFF (today's row is untouched). 5 to 7 mount the same real dashboard list on fixtures shaped from the other two multiplexers this app supports, so the grouped-by-workspace dashboard can be judged on all three rather than just the one it was screenshotted on.",
};

const inert = (_pane: AgentView) => {};

// ── Options 1-4: one workspace with an unnamed tab, and a second with a named one for contrast ────

const KAZ_WORKSPACE_ID = "wk1";
const KAZ_WORKSPACE_LABEL = "workspace-kaz";
const KAZ_TAB_ID = "wk1:t2";
/** The multiplexer's own default for an unlabelled tab: a bare position, never a name
 *  (`isUnnamedTab`). "2" rather than "1" so the row is visibly not the workspace's first tab. */
const KAZ_TAB_RAW = "2";

const RIDGE_WORKSPACE_ID = "wk2";
const RIDGE_WORKSPACE_LABEL = "workspace-ridge";
const RIDGE_TAB_ID = "wk2:t1";
const RIDGE_TAB_LABEL = "release-notes";

/** The named-tab neighbour every options-1-to-4 card carries, so a blank slot is judged beside a row
 *  that has something in it rather than in isolation. */
const ridgeAgent: AgentView = {
  paneId: "wk2:p1",
  workspaceId: RIDGE_WORKSPACE_ID,
  workspaceLabel: RIDGE_WORKSPACE_LABEL,
  workspaceNumber: 2,
  tabId: RIDGE_TAB_ID,
  tabLabel: RIDGE_TAB_LABEL,
  paneLabel: "release checks",
  agent: "claude",
  status: "idle",
  cwd: "/home/you/src/workspace-ridge",
  focused: false,
  kind: "agent",
};

/** One workspace's agent panes and bare shells, the shape `KazCard` hands to `AgentList`. */
interface KazPanes {
  agents: AgentView[];
  shellPanes: AgentView[];
}

/** The unnamed tab's two panes, at their ordinary cwd — the shape options 1, 3 and 4 stand on. The
 *  agent's cwd sits exactly at the workspace root, which is what option 2's "cwd" mode reads as
 *  saying nothing more than the heading already does. */
function kazPanes(): KazPanes {
  const agent: AgentView = {
    paneId: "wk1:p1",
    workspaceId: KAZ_WORKSPACE_ID,
    workspaceLabel: KAZ_WORKSPACE_LABEL,
    workspaceNumber: 1,
    tabId: KAZ_TAB_ID,
    tabLabel: KAZ_TAB_RAW,
    paneLabel: "kaz work",
    agent: "claude",
    status: "working",
    cwd: "/home/you/src/workspace-kaz",
    focused: false,
    kind: "agent",
  };
  const shell: AgentView = {
    paneId: "wk1:p2",
    workspaceId: KAZ_WORKSPACE_ID,
    workspaceLabel: KAZ_WORKSPACE_LABEL,
    workspaceNumber: 1,
    tabId: KAZ_TAB_ID,
    tabLabel: KAZ_TAB_RAW,
    agent: "shell",
    status: "unknown",
    cwd: "/home/you/src/workspace-kaz",
    focused: false,
    kind: "shell",
  };
  return { agents: [agent], shellPanes: [shell] };
}

/** Option 2's variant: the agent pane's cwd runs a segment deeper than the workspace root, so its
 *  tail ("api") says something the heading doesn't; the shell stays at the root, which is the
 *  fallback-to-centred case in the SAME card. */
function kazPanesWithCwdTail(): KazPanes {
  const base = kazPanes();
  const [agent] = base.agents;
  if (agent) agent.cwd = "/home/you/src/workspace-kaz/api";
  return base;
}

function KazCard({
  blankTab,
  cwdTail = false,
}: {
  blankTab: BlankTabMode;
  cwdTail?: boolean;
}) {
  const { agents, shellPanes } = cwdTail ? kazPanesWithCwdTail() : kazPanes();
  return (
    <PhoneMock>
      <AgentList
        agents={[...agents, ridgeAgent]}
        shellPanes={shellPanes}
        onOpen={inert}
        blankTab={blankTab}
      />
    </PhoneMock>
  );
}

// ── Options 5-7: fixtures shaped from the other two multiplexers' own facts ────────────────────────
//
// Session labels are never the real ones — CLAUDE.md's repo guard bans the words themselves, so
// "collie-b" and "collie-c" stand in for the two session names actually seen on this machine, and
// the cwd examples below drop the multiplexer's own name out of the path while keeping its shape.

/** Every window in this session carries the process's own name — the multiplexer's default, never
 *  set by hand. Six panes total (1 + 5), because that is the split actually seen on this machine. */
const AUTO_TAB_LABEL = "bash";
const CWD_A = "/var/home/altan/playground/pouch";
const CWD_B = "/var/home/altan";

function autoNamedShell(id: string, workspace: "collie-b" | "ss-wp", cwd: string): AgentView {
  return {
    paneId: id,
    workspaceId: `sess-${workspace}`,
    workspaceLabel: workspace,
    // The multiplexer numbers sessions on its own axis, and it is not one this fixture can borrow
    // meaning from — see the "position" comment on the collie-c fixture below for the same fact on
    // the other multiplexer. A fixed 1 stands in for "no distinguishing number", the same value the
    // adapter itself falls back to when a session can't be placed.
    workspaceNumber: 1,
    tabId: `${id}:t`,
    tabLabel: AUTO_TAB_LABEL,
    agent: "shell",
    status: "unknown",
    cwd,
    focused: false,
    kind: "shell",
  };
}

function multiplexerBShells(): AgentView[] {
  return [
    autoNamedShell("mb1", "collie-b", CWD_A),
    autoNamedShell("mb2", "ss-wp", CWD_A),
    autoNamedShell("mb3", "ss-wp", CWD_B),
    autoNamedShell("mb4", "ss-wp", CWD_A),
    autoNamedShell("mb5", "ss-wp", CWD_B),
    autoNamedShell("mb6", "ss-wp", CWD_A),
  ];
}

/** A window's label counts as hand-set when it is anything OTHER than the process the multiplexer
 *  would have named it after on its own — the fixture-side stand-in for the adapter fact this
 *  option's caption names: the bridge doesn't yet say which window was renamed, only what it's
 *  called now. */
const AUTO_PROCESS_NAMES: ReadonlySet<string> = new Set(["bash", "zsh", "fish", "sh", "claude", "node"]);

/** Blanks a window's label when it merely repeats the process name, previewing what an adapter that
 *  DID report "renamed by hand" would let the row do today with `blankTab="center"` — see this
 *  option's own caption for why the real fix is not here. */
function hideAutoLabels(panes: readonly AgentView[]): AgentView[] {
  return panes.map((p) =>
    p.tabLabel !== undefined && AUTO_PROCESS_NAMES.has(p.tabLabel) ? { ...p, tabLabel: "" } : p,
  );
}

/** One session, five shells: three sitting in the multiplexer's own default tabs (unnamed, per
 *  {@link isUnnamedTab}), two in tabs the operator named by hand. `cwd` is often empty on this
 *  multiplexer, per the facts this fixture is built from. */
function multiplexerCShells(): AgentView[] {
  const base = {
    workspaceId: "sess-collie-c",
    workspaceLabel: "collie-c",
    // This multiplexer sends no real per-session number — every session reads the same constant off
    // the adapter, which is the fact option 7's caption discusses.
    workspaceNumber: 1,
    agent: "shell",
    status: "unknown" as const,
    focused: false,
    kind: "shell" as const,
  };
  return [
    { ...base, paneId: "mc1", tabId: "mc1:t", tabLabel: "Tab #1", cwd: "" },
    { ...base, paneId: "mc2", tabId: "mc2:t", tabLabel: "Tab #2", cwd: "" },
    { ...base, paneId: "mc3", tabId: "mc3:t", tabLabel: "Tab #3", cwd: "" },
    { ...base, paneId: "mc4", tabId: "mc4:t", tabLabel: "beacon-proof", cwd: "/home/you/src/collie" },
    { ...base, paneId: "mc5", tabId: "mc5:t", tabLabel: "freshness-probe", cwd: "" },
  ];
}

// ── The cards ────────────────────────────────────────────────────────────────

export function RowSecondLineSection() {
  return (
    <Section def={DEF}>
      <Group title="Options 1 to 4 — the blank tab line, behind AgentCard's new blankTab prop">
        <Card
          state="row-second-line-centered"
          label="Option 1 · centred — the row keeps its 44px, the name just moves"
          reach={`idea, not shipped: mounts the real AgentList, with AgentCard's new blankTab="center" prop set on this card alone.`}
          note={`When the tab is unnamed the 16px slot is skipped outright, so the row's own flex centring puts the name in the middle of the 44px row instead of pinned near its top over an empty gap. Costs nothing extra — no new markup, no new height — and it is the fallback every other mode below lands on when it has nothing to say. Picking this means shipping blankTab="center" as AgentCard's new default.`}
        >
          <KazCard blankTab="center" />
        </Card>

        <Card
          state="row-second-line-cwd"
          label="Option 2 · path tail — the blank slot shows where the pane actually is"
          reach={`idea, not shipped: mounts the real AgentList with blankTab="cwd"; this card's agent pane sits a segment below the workspace root on purpose, and its shell sibling sits at the root.`}
          note={`The unnamed tab's slot shows the LAST segment of the pane's cwd, muted — but only when that segment says more than the workspace heading already does. The agent row here runs in workspace-kaz/api, so its slot reads "api"; the shell sibling runs in workspace-kaz itself, which is exactly the heading's own name, so its slot falls back to option 1's centred treatment in the SAME card. The two rows side by side are the point: this mode is only sometimes better than blank, and the fallback is what keeps it from ever being WORSE.`}
        >
          <KazCard blankTab="cwd" cwdTail />
        </Card>

        <Card
          state="row-second-line-position"
          label="Option 3 · position — the slot names the tab's place in words"
          reach={`idea, not shipped: mounts the real AgentList with blankTab="position"; the fixture's raw tab label is "2", the multiplexer's own bare-number default for an unlabelled tab.`}
          note={`"tab 2", muted and a shade lighter than a real tab name, read off the digit already sitting in the multiplexer's own raw label — never invented. Falls back to centred when that raw label carries no digit at all (an empty label, which does happen — see option 7). It answers a real question (which of this workspace's tabs is this?) at the cost of teaching the operator a new vocabulary word for something the tab strip already shows by position.`}
        >
          <KazCard blankTab="position" />
        </Card>

        <Card
          state="row-second-line-raw"
          label="Option 4 · raw id — the slot says exactly what the multiplexer calls it"
          reach={`idea, not shipped: mounts the real AgentList with blankTab="raw"; same fixture as option 3, so the two can be read side by side.`}
          note={`The multiplexer's own raw tab label, "2", untouched, in the lighter ink — the row stops pretending it knows anything the multiplexer didn't already say. Honest, and also the least dressed up: on the multiplexer that numbers tabs "1", "2", "3" this reads almost the same as option 3's words; on the one that defaults to "Tab #1" (option 7) it would print that whole string verbatim, which is a stranger thing to show an operator than a bare digit.`}
        >
          <KazCard blankTab="raw" />
        </Card>
      </Group>

      <Group title="Options 5 to 7 — the same dashboard, on the other two multiplexers">
        <Card
          state="row-second-line-b-shipped"
          label="Option 5 · the other multiplexer, as shipped today"
          reach="SHIPPED SHAPE — mounts the real AgentList over a fixture built from this machine's own two sessions on that multiplexer, six shells total, blankTab left at its default."
          note={`Every row here reads the same: line 1 "shell", line 2 "bash". Nothing is broken — every tab genuinely IS named that — but it is the whole reason this option exists to be looked at: that multiplexer auto-names every window after the process running in it, and a shell's process is almost always the same word, so a list of six of its panes repeats "bash" six times down the page. The tab name carries no information here, and no blankTab mode changes that, because these tabs are NOT unnamed by isUnnamedTab's rule — they carry a real string, it just happens to be uninformative.`}
        >
          <PhoneMock>
            <AgentList agents={[]} shellPanes={multiplexerBShells()} onOpen={inert} />
          </PhoneMock>
        </Card>

        <Card
          state="row-second-line-b-hidden"
          label="Option 6 · the other multiplexer, with its auto-names hidden"
          reach={`idea, not shipped: same six-shell fixture as option 5, transformed on the FIXTURE side (a window label equal to a known shell/agent process name is blanked before the list ever sees it) — not a change to isUnnamedTab, and not a new prop, since AgentCard's existing blankTab="center" already does the rest.`}
          note={`Treat a window whose label equals the process running in it as unnamed, and every row here falls to option 1's centred treatment. It reads better, and it is ALSO NOT TRUE IN GENERAL: an operator who deliberately named a window "bash" — unlikely, but the multiplexer can't tell the two apart any more than this card can — would lose that name silently. The real fix is the adapter reporting whether the window was renamed by hand, which the multiplexer itself knows and Collie's bridge does not yet ask for; that is a bridge change, not a frontend one, and this card only previews what the row would look like the day it lands.`}
        >
          <PhoneMock>
            <AgentList agents={[]} shellPanes={hideAutoLabels(multiplexerBShells())} onOpen={inert} blankTab="center" />
          </PhoneMock>
        </Card>

        <Card
          state="row-second-line-c"
          label="Option 7 · the third multiplexer, one session, mixed tab names"
          reach={`idea, not shipped: mounts the real AgentList over a fixture built from this machine's own session on the third multiplexer — five shells, three in that multiplexer's own default tabs, two renamed by hand — with blankTab="center" on the three default ones.`}
          note={`One session means one workspace, which means exactly ONE heading on the whole dashboard — every other multiplexer's screenshot in this section shows at least two. The three default-tab rows (its own "Tab #1"/"Tab #2"/"Tab #3" shape, already unnamed by isUnnamedTab) sit centred; "beacon-proof" and "freshness-probe" carry real names and render exactly as they do today. THE ORDERING QUESTION: this multiplexer sends no real per-session workspace number (the adapter hard-codes the same constant for every one), so groupPanesByWorkspace's comparator sorts on a.workspaceNumber minus b.workspaceNumber between two equal constants, which is 0, not NaN — the tie falls through to the bridge's own first-seen order and stays stable. NaN only enters that comparison if a workspace number were MISSING outright rather than constant, which this adapter doesn't do; checked directly (Array.prototype.toSorted coerces a NaN comparator result to +0 per spec, so even that case would stay stable, not misorder) — not fixed here either way, since one group in this fixture never exercises a comparison between two groups at all.`}
        >
          <PhoneMock>
            <AgentList agents={[]} shellPanes={multiplexerCShells()} onOpen={inert} blankTab="center" />
          </PhoneMock>
        </Card>
      </Group>
    </Section>
  );
}
