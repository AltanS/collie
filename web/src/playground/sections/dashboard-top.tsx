// The dashboard's top section, shipped (2026-10-07). Altan picked "One control bar" from a design round
// of five and asked for two changes: the workspace and the order are SELECT fields, and the line of
// state words stays ONE line at every phone width. This section is the production top, nothing
// composed beside it: each card is the real header over the real `AgentList`, from the same sample
// data, so what the cards show is what the dashboard draws. The round's comparison options are gone.
//
// The cards differ in the phone's WIDTH, because width is what the one-line rule is about: 412, 390
// and 360 are the three it is measured at (components/status-counts.tsx, `SummaryCounts`). The last
// two use the crowded herd, every state at two digits, which is the worst the line has to take.
// Every card is live: pick a workspace, flip the needs-you switch, change the order.
//
// DEV-ONLY, unreachable from the app entry. Every word on the phones is the app's own.

import { useState, type ReactNode } from "react";

import { AgentList, type HeadingNewTab } from "@/components/agent-list";
import { AppHeaderHost, RouteHeader, SettingsGear } from "@/components/app-header";
import { ServerSwitcher } from "@/components/server-switcher";
import { SessionSwitcher } from "@/components/session-switcher";
import { sessionsOnHost } from "@/lib/hosts";
import type { PaneOrder } from "@/lib/pane-order";
import type { AgentView, ServerSummary, WorkspaceView } from "@/lib/types";
import type { HomeData } from "@/lib/loaders";

import { herd, homeSolo, sessionsSolo, shells, spaces, tabs, TS } from "../fixtures";
import { Card, Group, PackedRootRouter, Section, type SectionDef } from "../harness";

export const DEF: SectionDef = {
  id: "dashboard-top",
  title: "Dashboard top",
  intent:
    "The top of the dashboard as shipped: the header, ONE line of state words with the needs-you switch at its right end, then a workspace select and an order select on one row. The line stays one line at 412, 390 and 360px; the last two cards are the crowded herd that tests it. Every card is live.",
};

// ── Sample data ──────────────────────────────────────────────────────────────────────────────────
//
// The playground's own herd and shells, with the four workspaces renamed after the ones on Altan's
// phone and two more added, so the workspace select has a realistic list to open.

const WORKSPACE_NAMES = new Map([
  ["w1", "klaracase"],
  ["w2", "openplate-workspace"],
  ["w3", "bay-workspace"],
  ["w4", "collie-workspace"],
]);

function renamed(pane: AgentView): AgentView {
  const clone: AgentView = structuredClone(pane);
  const label = WORKSPACE_NAMES.get(clone.workspaceId);
  if (label !== undefined) {
    clone.workspaceLabel = label;
    clone.cwd = clone.cwd.replace(/[^/]+$/, label);
  }
  return clone;
}

function renamedSpace(space: WorkspaceView): WorkspaceView {
  const clone: WorkspaceView = structuredClone(space);
  clone.label = WORKSPACE_NAMES.get(clone.workspaceId) ?? clone.label;
  return clone;
}

/** A copy of a herd pane moved into a new workspace, so the sample has six of them. */
function movedInto(fromPaneId: string, workspaceId: string, number: number, label: string): AgentView {
  const source = herd.find((p) => p.paneId === fromPaneId);
  if (source === undefined) throw new Error(`dashboard-top: no fixture pane ${fromPaneId}`);
  const clone: AgentView = structuredClone(source);
  clone.paneId = `${workspaceId}:p1`;
  clone.workspaceId = workspaceId;
  clone.workspaceNumber = number;
  clone.workspaceLabel = label;
  clone.tabId = `${workspaceId}:t1`;
  clone.cwd = clone.cwd.replace(/[^/]+$/, label);
  return clone;
}

const AGENTS: AgentView[] = [
  ...herd.map(renamed),
  movedInto("w3:p1", "w5", 5, "sportsight-wp"),
  movedInto("w1:p2", "w6", 6, "pigeon"),
];
const SHELLS: AgentView[] = shells.map(renamed);

/** The lead is called bluefin, as on Altan's phone; a second machine makes the machine chip appear. */
const ROSTER: ServerSummary[] = [
  { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: TS - 2_000 },
  { id: "minibuch", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: TS - 3_000 },
];

const DATA: HomeData = {
  ...homeSolo,
  agents: AGENTS,
  shellPanes: SHELLS,
  workspaces: [
    ...spaces.map(renamedSpace),
    { workspaceId: "w5", number: 5, label: "sportsight-wp", focused: false, activeTabId: "w5:t1", tabCount: 1, paneCount: 1 },
    { workspaceId: "w6", number: 6, label: "pigeon", focused: false, activeTabId: "w6:t1", tabCount: 1, paneCount: 1 },
  ],
  servers: ROSTER,
  sessions: sessionsSolo,
};


/**
 * The herd with every state at two digits, so the line of words is as wide as it can honestly get:
 * 12 need you, 11 unseen, 14 working, 10 done, 15 idle. Clones of the sample's panes, spread over
 * its workspaces, each with its own pane id. A done or idle pane is unseen when it finished after the
 * operator last looked, and seen when it did not (lib/triage.ts `isUnseen`).
 */
function crowded(): AgentView[] {
  const kinds: { status: AgentView["status"]; unseen: boolean; count: number }[] = [
    { status: "blocked", unseen: false, count: 12 },
    { status: "done", unseen: true, count: 11 },
    { status: "working", unseen: false, count: 14 },
    { status: "done", unseen: false, count: 10 },
    { status: "idle", unseen: false, count: 15 },
  ];
  const out: AgentView[] = [];
  let n = 0;
  for (const kind of kinds) {
    for (let i = 0; i < kind.count; i++) {
      const base = AGENTS[n % AGENTS.length]!;
      const clone: AgentView = structuredClone(base);
      clone.paneId = `${base.paneId}-x${n}`;
      clone.status = kind.status;
      clone.lastActiveAt = kind.unseen ? TS - 60_000 : TS - 3_600_000;
      clone.lastSeenAt = kind.unseen ? TS - 3_600_000 : TS - 60_000;
      out.push(clone);
      n += 1;
    }
  }
  return out;
}

const CROWDED_AGENTS: AgentView[] = crowded();
const CROWDED: HomeData = { ...DATA, agents: CROWDED_AGENTS, shellPanes: [] };

/** Wired to nothing, as in the Dashboard section: the "+" shows where it sits. */
const HEADING_NEW_TAB: HeadingNewTab = { scope: {}, creating: new Set(), onNewTab: () => {} };

/** The real dashboard header: the mark, machine and session chips, the gear. */
function DashHeader({ data }: { data: HomeData }) {
  const sessions = sessionsOnHost(data.sessions ?? [], data.scope, data.servers);
  return (
    <RouteHeader
      wordmark
      width="column"
      rightLead={
        <>
          <ServerSwitcher servers={data.servers ?? []} scope={data.scope} agents={data.agents} />
          <SessionSwitcher sessions={sessions} scope={data.scope} viewAll={false} />
        </>
      }
      rightTrail={<SettingsGear scope={data.scope} />}
    />
  );
}

/** One card's live list: called INSIDE the card's router, because the router freezes its children. */
function LiveDashboard({ data }: { data: HomeData }) {
  const [order, setOrder] = useState<PaneOrder>("place");
  const [isolated, setIsolated] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [needsYou, setNeedsYou] = useState(false);
  return (
    <AppHeaderHost bridge="connected" error={false}>
      <DashHeader data={data} />
      <div data-pg-scroll className="min-h-0 flex-1 overflow-y-auto">
        <AgentList
          agents={data.agents}
          shellPanes={data.shellPanes}
          bridge="connected"
          onOpen={() => {}}
          tabs={tabs}
          servers={ROSTER}
          newTab={HEADING_NEW_TAB}
          order={order}
          onOrderChange={setOrder}
          isolated={isolated}
          hidden={hidden}
          onIsolate={setIsolated}
          onToggleHidden={(key) => setHidden((now) => (now.includes(key) ? now.filter((k) => k !== key) : [...now, key]))}
          needsYouOnly={needsYou}
          onNeedsYouOnlyChange={setNeedsYou}
        />
      </div>
    </AppHeaderHost>
  );
}

/**
 * The phone: `width` px wide, a ring instead of a border so the content is exactly that wide. It does
 * NOT scroll itself. The app's header sits outside the scroller and a sheet is fixed to the screen,
 * so the frame's `transform` makes it their containing block.
 */
function Phone({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  return (
    <div
      // `--app-h` is what a sheet sizes itself to; the frame's height stands in for the viewport's.
      ref={(el) => el?.style.setProperty("--app-h", `${height}px`)}
      data-pg-phone
      // A sheet focuses its panel on open, and the browser then scrolls this overflow-hidden frame to
      // show it, which would carry the sheet's own containing block off the screen. The frame never scrolls.
      onScroll={(e) => {
        e.currentTarget.scrollTop = 0;
      }}
      className="relative isolate flex max-w-none flex-col overflow-hidden rounded-sm bg-background ring-1 ring-rule"
      style={{ width, height, transform: "translate(0)" }}
    >
      {children}
    </div>
  );
}

const FRAME_HEIGHT = 720;

interface CardDef {
  label: string;
  reach: string;
  width: number;
  data: HomeData;
}

const CARDS: readonly CardDef[] = [
  { label: "412px", reach: "open the dashboard on a large phone.", width: 412, data: DATA },
  { label: "390px", reach: "open the dashboard on an iPhone.", width: 390, data: DATA },
  { label: "360px", reach: "open the dashboard on the narrowest phone the rule is measured at.", width: 360, data: DATA },
  {
    label: "Crowded herd, 360px",
    reach: "open the dashboard with dozens of panes in every state on the narrowest phone; the words give way, the line stays one line.",
    width: 360,
    data: CROWDED,
  },
  {
    label: "Crowded herd, 412px",
    reach: "open the dashboard with dozens of panes in every state on a large phone.",
    width: 412,
    data: CROWDED,
  },
];

function TopCard({ def, state }: { def: CardDef; state: string }) {
  return (
    <Card state={state} label={def.label} reach={def.reach} span={1}>
      {/* The page keeps a 16px gutter each side; the frame takes it back so a 412px phone is 412. */}
      <div className="-mx-4 overflow-x-auto sm:mx-0">
        <Phone width={def.width} height={FRAME_HEIGHT}>
          <PackedRootRouter data={def.data}>
            <LiveDashboard data={def.data} />
          </PackedRootRouter>
        </Phone>
      </div>
    </Card>
  );
}

export function DashboardTopSection() {
  return (
    <Section def={DEF}>
      <Group title="Widths">
        {/* Literal handles, written out: the e2e roll call reads the state props from source. */}
        <TopCard state="dashboard-top-412" def={CARDS[0]!} />
        <TopCard state="dashboard-top-390" def={CARDS[1]!} />
        <TopCard state="dashboard-top-360" def={CARDS[2]!} />
        <TopCard state="dashboard-top-crowded-360" def={CARDS[3]!} />
        <TopCard state="dashboard-top-crowded-412" def={CARDS[4]!} />
      </Group>
    </Section>
  );
}
