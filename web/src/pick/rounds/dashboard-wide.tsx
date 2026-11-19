// "The dashboard on a large screen", a pick round: four answers for the landing screen of a window 900px
// and wider. Today the dashboard is the phone's column, capped at 640px (`routes/home.tsx`,
// `max-w-screen-sm`), with empty margins on a desktop. A pick round is a proposal in the workspace's design
// app (`design propose <worktree> dashboard-wide`), never a design reference entry.
//
// THE FRAME. The design app draws every option in a 390px phone frame. A wide screen does not fit one, so
// each case draws a whole screen at its real size (1024 to 2560px wide) and scales it down to the frame's
// width; "Actual size" above it shows it at 100% to pan. Taps work at either scale.
//
// Every option is drawn from the real components (`components/wide-dashboard.tsx`: `SpaceCard` over
// `SectionHeader`, `ListGroup` and `AgentCard`), with the real header, control block, Spaces navigator,
// tab bar and New button around it, on fixture data. Nothing here sends anything.
//
// After the pick: the chosen option becomes the route's large-screen body and a design reference entry;
// delete this file, its test, its line in ../rounds.ts, and the three options not chosen.

import { useState, type ReactNode } from "react";

import { AgentList } from "@/components/agent-list";
import { AppHeaderHost, RouteHeader, SettingsGear } from "@/components/app-header";
import { PaneOrderSelect, WorkspaceFilter } from "@/components/dash-selects";
import { Icon } from "@/components/icons/icon";
import { NeedsYouSwitch } from "@/components/needs-you-switch";
import { ServerSwitcher } from "@/components/server-switcher";
import { SpaceOverview } from "@/components/space-overview";
import { StatusSummaryLine } from "@/components/status-counts";
import { Button } from "@/components/ui/button";
import { FabButton } from "@/components/ui/fab";
import { TabBar } from "@/components/ui/tab-bar";
import { SUMMARY_LINE_TAP_TARGET } from "@/components/ui/tap-target";
import { ToggleButton } from "@/components/ui/toggle-button";
import {
  DashboardWideBoard,
  DashboardWideColumns,
  DashboardWideRows,
  DashboardWideStrip,
  type ControlPlace,
  type WideDashboardProps,
} from "@/components/wide-dashboard";
import { useElementWidth } from "@/hooks/use-element-width";
import { stripEntries, type DashView } from "@/lib/dash-view";
import { t, tn } from "@/lib/i18n";
import { groupPanesByWorkspace } from "@/lib/pane-groups";
import type { PaneOrder } from "@/lib/pane-order";
import { countBlocked, hasReady, needsYou } from "@/lib/triage";
import type { AgentStatus, AgentView, ServerSummary, TabView, WorkspaceView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { gridWidth, spaceColumns, WIDE_GUTTER } from "@/lib/wide-dashboard";
import { homeSolo, rosterTrio, TS } from "@/playground/fixtures";
import { PackedRootRouter } from "@/playground/harness";

import type { PickCase, PickOption, PickRoundDef } from "../types";

// ── The herd: twelve Spaces of mixed size ─────────────────────────────────────────────────────────

const MIN = 60_000;

/** One session of a Space: the harness (`shell` for a bare shell), its state, and the line it shows. */
type Seat = readonly [agent: string, status: AgentStatus, title: string, hint?: string];

interface SpaceSeed {
  readonly label: string;
  readonly tabs: readonly string[];
  readonly seats: readonly Seat[];
}

const SEEDS: readonly SpaceSeed[] = [
  {
    label: "collie",
    tabs: ["feat/crew-overview", "docs", "shell"],
    seats: [
      ["claude", "blocked", "crew overview", "waiting on a permission prompt: run `bun run build`"],
      ["claude", "working", "rewriting ARCHITECTURE.md"],
      ["codex", "idle", "pnpm test --watch"],
      ["pi", "working", "dashboard poll cadence"],
      ["shell", "unknown", "shell"],
    ],
  },
  {
    label: "example-api",
    tabs: ["fix-deploy", "billing-webhooks"],
    seats: [
      ["codex", "blocked", "fix deploy", "asked you a question and is waiting for the answer"],
      ["claude", "done", "billing webhooks"],
      ["codex", "working", "running drizzle-kit generate"],
      ["shell", "unknown", "logs"],
    ],
  },
  { label: "nixcfg", tabs: ["flake-bump"], seats: [["claude", "working", "flake bump"], ["claude", "idle", "hosts"]] },
  { label: "blog", tabs: ["post/collie-launch"], seats: [["opencode", "working", "launch post"]] },
  { label: "dotfiles", tabs: ["shell"], seats: [["shell", "unknown", "shell"]] },
  {
    label: "infra",
    tabs: ["traefik", "headscale"],
    seats: [
      ["claude", "done", "traefik routes"],
      ["codex", "working", "headscale acl"],
      ["shell", "unknown", "ssh minibuch"],
    ],
  },
  {
    label: "design-system",
    tabs: ["tokens", "icons", "docs"],
    seats: [
      ["claude", "working", "token audit"],
      ["claude", "working", "icon sweep"],
      ["pi", "idle", "docs pass"],
      ["codex", "working", "storybook upgrade"],
      ["opencode", "idle", "contrast check"],
      ["shell", "unknown", "vite"],
    ],
  },
  {
    label: "mobile-app",
    tabs: ["login-flow"],
    seats: [
      ["claude", "blocked", "login flow", "a password prompt is on screen; tap Type to answer yourself"],
      ["codex", "idle", "push setup"],
    ],
  },
  { label: "data-pipeline", tabs: ["backfill"], seats: [["claude", "working", "backfill march"]] },
  { label: "docs-site", tabs: ["search"], seats: [["gemini", "done", "search index"], ["shell", "unknown", "preview"]] },
  {
    label: "research",
    tabs: ["papers", "notes"],
    seats: [
      ["claude", "idle", "paper notes"],
      ["claude", "idle", "reading list"],
      ["pi", "working", "summaries"],
    ],
  },
  { label: "scratch", tabs: ["shell"], seats: [["shell", "unknown", "shell"]] },
];

/** All calm: nothing blocked, nothing finished unseen. */
function calmed(seed: SpaceSeed): SpaceSeed {
  return { ...seed, seats: seed.seats.map(([agent, status, title]) => [agent, status === "blocked" || status === "done" ? "idle" : status, title] as const) };
}

interface Herd {
  readonly agents: AgentView[];
  readonly shellPanes: AgentView[];
  readonly workspaces: WorkspaceView[];
  readonly tabs: TabView[];
}

/** The seeds as the bridge sends them: one workspace, its tabs, and a pane per seat, on `hostOf(i)`. */
function herdOf(seeds: readonly SpaceSeed[], hostOf: (i: number) => string | undefined = () => undefined): Herd {
  const out: Herd = { agents: [], shellPanes: [], workspaces: [], tabs: [] };
  seeds.forEach((seed, i) => {
    const host = hostOf(i);
    const ws = `w${i + 1}`;
    const space: WorkspaceView = { workspaceId: ws, number: i + 1, label: seed.label, focused: i === 0, activeTabId: `${ws}:t1`, tabCount: seed.tabs.length, paneCount: seed.seats.length };
    if (host !== undefined) space.host = host;
    out.workspaces.push(space);
    seed.tabs.forEach((label, ti) => {
      const tab: TabView = { tabId: `${ws}:t${ti + 1}`, workspaceId: ws, number: ti + 1, label, focused: ti === 0, paneCount: 1 };
      if (host !== undefined) tab.host = host;
      out.tabs.push(tab);
    });
    seed.seats.forEach(([agent, status, title, hint], si) => {
      const ti = si % seed.tabs.length;
      const age = ((i * 7 + si * 13) % 50) + 1;
      const pane: AgentView = {
        paneId: `${ws}:p${si + 1}`,
        workspaceId: ws,
        workspaceLabel: seed.label,
        workspaceNumber: i + 1,
        tabId: `${ws}:t${ti + 1}`,
        tabLabel: seed.tabs[ti],
        agent,
        status,
        cwd: `/home/you/src/${seed.label}`,
        focused: false,
        lastActiveAt: TS - age * MIN,
        // A finished pane is unseen when it moved after the person last looked.
        lastSeenAt: TS - (status === "done" ? age + 30 : age) * MIN,
      };
      if (host !== undefined) pane.host = host;
      if (agent === "shell") {
        out.shellPanes.push({ ...pane, kind: "shell", paneLabel: title });
        return;
      }
      pane.terminalTitle = title;
      if (hint !== undefined) pane.hint = hint;
      out.agents.push(pane);
    });
  });
  return out;
}

const HERD_TWELVE = herdOf(SEEDS);
const HERD_THREE = herdOf(SEEDS.slice(0, 3));
const HERD_CALM = herdOf(SEEDS.map(calmed));
const HERD_EMPTY: Herd = { agents: [], shellPanes: [], workspaces: [], tabs: [] };
/** Two machines: the first seven Spaces on the lead, the other five on a crew member. */
const HERD_CREW = herdOf(SEEDS, (i) => (i < 7 ? "lodge" : "workshop"));
const TWO_MACHINES: readonly ServerSummary[] = rosterTrio.slice(0, 2);
/** Two sessions this device pinned (ADR 0070), from two Spaces. */
const PINS: ReadonlySet<string> = new Set(["w7:p1", "w2:p3"]);

// ── The cases: one switch for every option ───────────────────────────────────────────────────────

interface Shot {
  readonly herd: Herd;
  readonly width: number;
  readonly height: number;
  readonly servers?: readonly ServerSummary[];
  readonly pins?: ReadonlySet<string>;
}

const SHOTS = new Map<string, Shot>([
  ["three", { herd: HERD_THREE, width: 1280, height: 800 }],
  ["twelve", { herd: HERD_TWELVE, width: 1280, height: 800 }],
  ["twelve-1024", { herd: HERD_TWELVE, width: 1024, height: 768 }],
  ["twelve-1920", { herd: HERD_TWELVE, width: 1920, height: 1080 }],
  ["twelve-2560", { herd: HERD_TWELVE, width: 2560, height: 1080 }],
  ["pinned", { herd: HERD_TWELVE, width: 1440, height: 900, pins: PINS }],
  ["calm", { herd: HERD_CALM, width: 1280, height: 800 }],
  ["crew", { herd: HERD_CREW, width: 1440, height: 900, servers: TWO_MACHINES }],
  ["empty", { herd: HERD_EMPTY, width: 1280, height: 800 }],
]);

const CASES: readonly PickCase[] = [
  { id: "twelve", label: "12 Spaces, 1280" },
  { id: "three", label: "3 Spaces, 1280" },
  { id: "twelve-1024", label: "12 Spaces, 1024" },
  { id: "twelve-1920", label: "12 Spaces, 1920" },
  { id: "twelve-2560", label: "12 Spaces, ultrawide 2560" },
  { id: "pinned", label: "Two pinned, 1440" },
  { id: "calm", label: "Nothing needs you, 1280" },
  { id: "crew", label: "Two machines, 1440" },
  { id: "empty", label: "Empty, 1280" },
];

function shotOf(caseId: string): Shot {
  const shot = SHOTS.get(caseId);
  if (shot === undefined) throw new Error(`dashboard-wide: no case ${caseId}`);
  return shot;
}

// ── The parts around the option: the control block, the header, the bar, the New button ─────────

/** The dashboard's control block, from its real parts with local state: one row across the grid, or the phone's two rows. */
function Controls({ place, herd, servers }: { place: ControlPlace; herd: Herd; servers?: readonly ServerSummary[] }) {
  const [on, setOn] = useState(false);
  const [order, setOrder] = useState<PaneOrder>("place");
  const groups = groupPanesByWorkspace(herd.agents, herd.shellPanes, { order: "fixed", tabs: herd.tabs, workspaces: herd.workspaces, servers });
  const summary = (
    <StatusSummaryLine
      panes={herd.agents}
      allClear={!herd.agents.some(needsYou)}
      onJump={() => undefined}
      className={cn("min-w-0 flex-1", SUMMARY_LINE_TAP_TARGET)}
    />
  );
  const filter = (
    <WorkspaceFilter
      className={place === "row" ? "w-72 shrink-0" : "min-w-0 flex-1"}
      entries={stripEntries(groups, new Set(), new Set())}
      isolatedKeys={new Set()}
      isHidden={() => false}
      servers={servers}
      onIsolate={() => undefined}
    />
  );
  const orderSelect = <PaneOrderSelect order={order} onChange={setOrder} className="shrink-0" />;
  const magnifier = <ToggleButton pressed={false} onPressedChange={() => undefined} label={t("sessionFilter.toggle")} icon={<Icon name="search" className="size-4 shrink-0" />} />;
  if (place === "row") {
    return (
      <div className="flex min-h-11 items-center gap-3">
        {summary}
        {filter}
        {orderSelect}
        <div className="-mr-2 flex shrink-0 items-center">
          <NeedsYouSwitch on={on} onChange={setOn} />
          {magnifier}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-11 items-center justify-between gap-2">
        {summary}
        <div className="-mr-2 shrink-0">
          <NeedsYouSwitch on={on} onChange={setOn} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        {filter}
        {orderSelect}
        <div className="-mr-2 shrink-0">{magnifier}</div>
      </div>
    </div>
  );
}

/** What follows the list on the phone. Launch, Programs and the Tricks Space draw nothing on this data; the Spaces navigator stays, folded. */
function After({ herd }: { herd: Herd }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="-mx-4">
      <SpaceOverview workspaces={herd.workspaces} agents={herd.agents} shellPanes={herd.shellPanes} onOpen={() => undefined} onNewSpace={() => undefined} open={open} onOpenChange={setOpen} />
    </div>
  );
}

type Layout = (props: WideDashboardProps) => ReactNode;

/**
 * One screen of the given size: the header and the tab bar as wide as the content, the option's body
 * between them, and the New button at the content's right edge over the bar, where the phone has it.
 */
function Screen({ state, shot, Body, fullBleed }: { state: string; shot: Shot; Body: Layout; fullBleed: boolean }) {
  const [view, setView] = useState<DashView>("dashboard");
  const { herd, width, height, servers } = shot;
  const empty = herd.agents.length === 0 && herd.shellPanes.length === 0;
  const content = fullBleed || empty ? width : gridWidth(spaceColumns(width)) + 2 * WIDE_GUTTER;
  const side = (width - content) / 2;
  const blocked = countBlocked(herd.agents);
  const crew = servers !== undefined && servers.length > 1;
  const pins = shot.pins;
  const body = empty ? (
    // The empty dashboard is the phone's first-start card, centred at one Space's width.
    <div className="mx-auto w-96 pt-16">
      <AgentList agents={[]} bridge="connected" onOpen={() => undefined} onFirstStart={() => undefined} />
    </div>
  ) : (
    <Body
      width={width}
      agents={herd.agents}
      shellPanes={herd.shellPanes}
      tabs={herd.tabs}
      workspaces={herd.workspaces}
      servers={servers}
      isPinned={pins === undefined ? undefined : (p) => pins.has(p.paneId)}
      onOpen={() => undefined}
      controls={{ row: <Controls place="row" herd={herd} servers={servers} />, column: <Controls place="column" herd={herd} servers={servers} /> }}
      after={<After herd={herd} />}
    />
  );
  return (
    <PackedRootRouter data={{ ...homeSolo, agents: herd.agents, shellPanes: herd.shellPanes, workspaces: herd.workspaces, tabs: herd.tabs, servers: servers === undefined ? [] : [...servers] }}>
      <div data-state={state} data-width={width} className="relative flex flex-col overflow-hidden bg-background text-foreground" style={{ width, height }}>
        <div className="mx-auto w-full" style={{ maxWidth: content }}>
          <AppHeaderHost bridge="connected" error={false}>
            <RouteHeader
              wordmark
              rightLead={crew ? <ServerSwitcher servers={[...servers]} scope={{}} agents={herd.agents} /> : undefined}
              rightTrail={<SettingsGear scope={{}} />}
            />
          </AppHeaderHost>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{body}</div>
        <div className="mx-auto w-full" style={{ maxWidth: content }}>
          <TabBar<DashView>
            label={t("home.tabs.aria")}
            active={view}
            onSelect={setView}
            items={[
              ...(crew ? [{ value: "crew" as const, label: t("crew.title"), icon: <Icon name="crew" className="size-5" /> }] : []),
              {
                value: "dashboard",
                label: t("home.tabs.dashboard"),
                icon: <Icon name="tab-dashboard" className="size-5" />,
                badge: blocked,
                dot: blocked === 0 && hasReady(herd.agents),
                badgeLabel: blocked > 0 ? tn("home.tabs.blocked", blocked) : t("home.tabs.unseen"),
              },
              { value: "changes", label: t("files.title"), icon: <Icon name="files" className="size-5" /> },
            ]}
          />
        </div>
        <div className="absolute z-30" style={{ right: side + WIDE_GUTTER, bottom: 56 + 1 + 16 }}>
          <FabButton label={t("home.new.label")} onClick={() => undefined} />
        </div>
      </div>
    </PackedRootRouter>
  );
}

/**
 * The frame: the screen scaled to the phone frame's width, or at 100% to pan. Frame chrome, not part of
 * any option; the words are the round's, not the app's.
 */
function Stage({ shot, children }: { shot: Shot; children: ReactNode }) {
  const [measure, room] = useElementWidth<HTMLDivElement>(390);
  const [actual, setActual] = useState(false);
  const scale = actual ? 1 : Math.min(1, room / shot.width);
  return (
    <div ref={measure} className="flex min-h-full flex-1 flex-col bg-muted">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 bg-background px-3 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {shot.width} × {shot.height}
        </span>
        <Button type="button" size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={() => setActual((a) => !a)}>
          {actual ? "Fit width" : "Actual size"}
        </Button>
      </div>
      <div className={cn("min-h-0 flex-1", actual ? "overflow-auto" : "overflow-hidden")}>
        <div style={{ width: shot.width * scale, height: shot.height * scale }}>
          <div style={{ width: shot.width, height: shot.height, transform: `scale(${scale})`, transformOrigin: "top left" }}>{children}</div>
        </div>
      </div>
    </div>
  );
}

function option(n: number, label: string, state: string, Body: Layout, fullBleed = false): PickOption {
  return {
    n,
    label,
    state,
    render: (caseId) => {
      const shot = shotOf(caseId);
      return (
        <Stage shot={shot}>
          <Screen state={state} shot={shot} Body={Body} fullBleed={fullBleed} />
        </Stage>
      );
    },
  };
}

const OPTIONS: readonly PickOption[] = [
  option(1, "Spaces wrap in rows", "dashboard-wide-rows", DashboardWideRows),
  option(2, "Spaces stack in columns", "dashboard-wide-columns", DashboardWideColumns),
  option(3, "A strip of Spaces", "dashboard-wide-strip", DashboardWideStrip, true),
  option(4, "Needs you first, then Spaces", "dashboard-wide-board", DashboardWideBoard),
];

const ROUND: PickRoundDef = { title: "The dashboard on a large screen", options: OPTIONS, cases: CASES, frameHeight: 760 };

export default ROUND;
