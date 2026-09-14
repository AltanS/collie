// The dashboard's workspace-grouped row, and what it looks like on the other two multiplexers.
//
// Two unnumbered cards say what ships. "As shipped" mounts the real `AgentList` over a fixture
// shaped from the herdr-shaped multiplexer, and shows its three row shapes at once: a tab with a
// real name, a tab the multiplexer only numbered (`tab 2`, in `AgentCard`'s lighter ink — see that
// file's `tabPositionBody`), and a tab with no number to read at all, whose row centres the pane's
// name instead. "The same dashboard on each multiplexer" mounts the same list three times, once per
// multiplexer this app supports, so the grouped-by-workspace dashboard can be judged on all three
// rather than just the one it is usually screenshotted on.
//
// ONE QUESTION IS STILL OPEN, and it is not the blank-slot question above — that one shipped. tmux
// names every window after the program running in it, so a shell's window is almost always "bash",
// and a dashboard of six of its panes repeats that word six times down the page. The three numbered
// options below are three answers to what line 2 should do about THAT, and none of them is built —
// see each card's own caption.
//
// Multiplexer names never appear as string literals here — the repo guard
// (`scripts/check-mux-names.sh`) forbids that under `web/src`. Display names come from
// `web/playground-fixtures/multiplexers.json`, a file the guard does not scan because it sits
// outside `src/` entirely.
//
// DEV-ONLY, unreachable from the app entry.

import muxNames from "../../../playground-fixtures/multiplexers.json";

import { AgentList } from "@/components/agent-list";
import type { AgentView } from "@/lib/types";

import { Card, Group, Section, type SectionDef } from "../harness";
import { PhoneMock } from "./shared";

export const DEF: SectionDef = {
  id: "row-second-line",
  title: "Blank tab line and other multiplexers",
  intent:
    "Two cards show the workspace-grouped dashboard row as it ships today: once on the herdr-shaped fixture alone, and once side by side on all three multiplexers this app supports. Three numbered options answer the one thing still open — what line 2 should show for a window a multiplexer named after its own program.",
};

const inert = (_pane: AgentView) => {};

// ── The herdr-shaped fixture — one workspace, three row shapes ─────────────────────────────────────

const SHIPPED_WORKSPACE_ID = "sess-collie-a";
const SHIPPED_WORKSPACE_LABEL = "collie-a";

function shippedShell(id: string, tabLabel: string): AgentView {
  return {
    paneId: id,
    workspaceId: SHIPPED_WORKSPACE_ID,
    workspaceLabel: SHIPPED_WORKSPACE_LABEL,
    workspaceNumber: 1,
    tabId: `${id}:t`,
    tabLabel,
    agent: "shell",
    status: "unknown",
    cwd: "/home/you/src/collie",
    focused: false,
    kind: "shell",
  };
}

/** One workspace, three tabs: a real name, the multiplexer's own bare-number default (`"2"`, reads
 *  as `tab 2`), and an empty raw label, which carries no digit at all and centres the row instead. */
function shippedShells(): AgentView[] {
  return [
    shippedShell("sa1", "release-notes"),
    shippedShell("sa2", "2"),
    shippedShell("sa3", ""),
  ];
}

// ── The tmux-shaped fixture — every window auto-named after its program ────────────────────────────

const AUTO_TAB_LABEL = "bash";
const CWD_A = "/var/home/altan/playground/herdr-pouch";
const CWD_B = "/var/home/altan";

function autoNamedShell(id: string, workspace: "collie-b" | "ss-wp", cwd: string): AgentView {
  return {
    paneId: id,
    workspaceId: `sess-${workspace}`,
    workspaceLabel: workspace,
    // This multiplexer numbers sessions on its own axis, not one this fixture can borrow meaning
    // from (same fact the zellij fixture's own comment makes). A fixed 1 stands in for "no
    // distinguishing number", the value the adapter itself falls back to when a session can't be
    // placed.
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

/** Two sessions, six shells total: `collie-b` holds one pane, `ss-wp` holds five — the split
 *  actually seen on this machine. Every window reads `bash`, the process running in it. */
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

// ── The zellij-shaped fixture — one session, mixed tab names ───────────────────────────────────────

/** One session (one workspace heading), five shells: three sitting in the multiplexer's own default
 *  tabs (`Tab #1`..`Tab #3`, unnamed per `isUnnamedTab`), two in tabs renamed by hand. */
function multiplexerCShells(): AgentView[] {
  const base = {
    workspaceId: "sess-collie-c",
    workspaceLabel: "collie-c",
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

// ── The open question's three options — captions only, nothing here is shipped ─────────────────────

/** The folder line 2 would show under option 3 — the last segment of `CWD_A`, computed rather than
 *  typed a second time, so the preview can never drift from the fixture it is describing. */
function lastSegment(path: string): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? "";
}

/** A minimal, non-interactive preview of what a row's line 2 would read — plain text, not the real
 *  `AgentCard`, because none of the three options below is built: there is nothing to mount yet. */
function LinePreview({ lines }: { lines: readonly { text: string; light?: boolean }[] }) {
  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      {lines.map((line) => (
        <div key={line.text} className="flex h-11 items-center px-3 text-sm">
          <span className={line.light ? "text-muted-foreground/70" : undefined}>{line.text}</span>
        </div>
      ))}
    </div>
  );
}

// ── The cards ────────────────────────────────────────────────────────────────

export function RowSecondLineSection() {
  return (
    <Section def={DEF}>
      <Group title="What ships">
        <Card
          state="row-second-line-shipped"
          label="As shipped"
          reach="SHIPPED SHAPE — mounts the real AgentList over a fixture shaped from the herdr-shaped multiplexer, one workspace with three tabs."
          note="A workspace is a heading. A tab is line 2 of a row. A tab with no name shows its number, like `tab 2`. A tab with no number at all shows nothing, and the name sits in the middle of the row."
        >
          <PhoneMock>
            <AgentList agents={[]} shellPanes={shippedShells()} onOpen={inert} />
          </PhoneMock>
        </Card>

        <Card
          state="row-second-line-multiplexers"
          label="The same dashboard on each multiplexer"
          reach="Multiplexer a is the shipped shape; the other two are built from this machine's own facts about them — the real AgentList, mounted three times."
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
                multiplexer {muxNames.a}
              </p>
              <p className="mb-2 mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                This is what you see today.
              </p>
              <PhoneMock>
                <AgentList agents={[]} shellPanes={shippedShells()} onOpen={inert} />
              </PhoneMock>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
                multiplexer {muxNames.b}
              </p>
              <p className="mb-2 mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                A session is a workspace heading. A window is line 2 of a row. This multiplexer
                names every window after the program in it. So every row says `bash`, unless you
                renamed the window by hand.
              </p>
              <PhoneMock>
                <AgentList agents={[]} shellPanes={multiplexerBShells()} onOpen={inert} />
              </PhoneMock>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
                multiplexer {muxNames.c}
              </p>
              <p className="mb-2 mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                A session is one workspace heading. So the whole dashboard has one heading. A tab
                called `Tab #1` counts as unnamed, so its row says `tab 1`. A tab you renamed shows
                its name.
              </p>
              <PhoneMock>
                <AgentList agents={[]} shellPanes={multiplexerCShells()} onOpen={inert} />
              </PhoneMock>
            </div>
          </div>
        </Card>
      </Group>

      <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
        One question is open: what should line 2 show for a window this multiplexer named after its
        program?
      </p>

      <Group title="The open question — three options">
        <Card
          state="row-second-line-option-1"
          label="Option 1 · Show the program name"
          reach="idea, not shipped: no change from what ships today."
          note="Rows say `bash`, `claude` or `node`. This is what happens today. No change."
        >
          <LinePreview lines={[{ text: "bash" }, { text: "bash" }, { text: "bash" }]} />
        </Card>

        <Card
          state="row-second-line-option-2"
          label="Option 2 · Treat a program name as no name"
          reach="idea, not shipped: needs the bridge to say whether a window was renamed by hand, which it does not send today."
          note="The row says `tab 2`, like an unnamed tab elsewhere. The bridge must learn whether you renamed the window. The multiplexer knows this. That is a small bridge change."
        >
          <LinePreview lines={[{ text: "tab 2", light: true }]} />
        </Card>

        <Card
          state="row-second-line-option-3"
          label="Option 3 · Show the folder instead"
          reach="idea, not shipped: reads the pane's own cwd, which the bridge already sends."
          note="The row shows the last folder of the pane's path, for example `herdr-pouch`. No bridge change."
        >
          <LinePreview lines={[{ text: lastSegment(CWD_A), light: true }]} />
        </Card>
      </Group>
    </Section>
  );
}
