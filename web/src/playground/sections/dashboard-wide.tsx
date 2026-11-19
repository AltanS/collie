// The dashboard on a large screen, shipped (ADR 0158). Altan picked "Needs you first, then Spaces" from the
// `dashboard-wide` proposal round on 2026-11-19. This section is the final state and nothing beside it: the
// real header, the real `AgentList` in its `wide` form (a band of the sessions that need you over a grid of
// fixed 384px Space columns, the control block as one row), the Spaces navigator under the grid in one
// Space's width, the bottom tab bar as wide as the grid, and the New button at the grid's right edge. The
// screen is 1280px wide, so the grid is three columns; the column count is the rule of `lib/wide-dashboard.ts`
// for the width the scroller measures. Every control is live.
//
// DEV-ONLY, unreachable from the app entry. Every word on the screen is the app's own.

import { useState, type ReactNode } from "react";

import { AgentList, type HeadingNewTab } from "@/components/agent-list";
import { AppHeaderHost, RouteHeader, SettingsGear } from "@/components/app-header";
import { Icon } from "@/components/icons/icon";
import { SpaceOverview } from "@/components/space-overview";
import { FabButton } from "@/components/ui/fab";
import { TabBar } from "@/components/ui/tab-bar";
import { useElementWidth } from "@/hooks/use-element-width";
import type { DashView } from "@/lib/dash-view";
import { t, tn } from "@/lib/i18n";
import type { PaneOrder } from "@/lib/pane-order";
import { countBlocked, hasReady } from "@/lib/triage";
import type { AgentStatus, AgentView, TabView, WorkspaceView } from "@/lib/types";
import { contentWidth, SPACE_WIDTH, spaceColumns, WIDE_GUTTER } from "@/lib/wide-dashboard";

import { homeSolo, TS } from "../fixtures";
import { PackedRootRouter } from "../harness";
import { Card, Group, Section, type SectionDef } from "../layout";
import { useCardFilter } from "./shared";

export const DEF: SectionDef = {
  id: "dashboard-wide",
  title: "Dashboard on a large screen",
  intent:
    "The dashboard in the expanded width class (900px and wider) with Large-screen layout not Off: a band of the sessions that need you or finished unseen, each with its question, over a grid of Space columns 384px wide that wrap in rows. The band is a copy: each session keeps its row in its Space. The tab bar is as wide as the grid. The phone and Off keep the one column.",
};

// ── Sample data: twelve Spaces of mixed size ─────────────────────────────────────────────────────

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
      ["shell", "unknown", "ssh workshop"],
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

interface Herd {
  readonly agents: AgentView[];
  readonly shellPanes: AgentView[];
  readonly workspaces: WorkspaceView[];
  readonly tabs: TabView[];
}

/** The seeds as the bridge sends them: one workspace, its tabs, and a pane per seat. */
function herdOf(seeds: readonly SpaceSeed[]): Herd {
  const out: Herd = { agents: [], shellPanes: [], workspaces: [], tabs: [] };
  seeds.forEach((seed, i) => {
    const ws = `w${i + 1}`;
    out.workspaces.push({ workspaceId: ws, number: i + 1, label: seed.label, focused: i === 0, activeTabId: `${ws}:t1`, tabCount: seed.tabs.length, paneCount: seed.seats.length });
    seed.tabs.forEach((label, ti) => {
      out.tabs.push({ tabId: `${ws}:t${ti + 1}`, workspaceId: ws, number: ti + 1, label, focused: ti === 0, paneCount: 1 });
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

const HERD = herdOf(SEEDS);

/** Wired to nothing: the "+" shows where it sits. */
const HEADING_NEW_TAB: HeadingNewTab = { scope: {}, creating: new Set(), onNewTab: () => {} };

// ── The screen ───────────────────────────────────────────────────────────────────────────────────

const SCREEN_WIDTH = 1280;
const SCREEN_HEIGHT = 800;

/** One live screen, called INSIDE the card's router, because the router freezes its children. */
function LiveScreen() {
  const [order, setOrder] = useState<PaneOrder>("place");
  const [isolated, setIsolated] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [needsYou, setNeedsYou] = useState(false);
  const [view, setView] = useState<DashView>("dashboard");
  const [spacesOpen, setSpacesOpen] = useState(false);
  const filter = useCardFilter();
  const [measure, width] = useElementWidth<HTMLDivElement>(SCREEN_WIDTH, "client");
  const columns = spaceColumns(width);
  const column = contentWidth(columns);
  const blocked = countBlocked(HERD.agents);
  return (
    <AppHeaderHost bridge="connected" error={false}>
      <RouteHeader wordmark width={column} rightTrail={<SettingsGear scope={{}} />} />
      <div data-pg-scroll ref={measure} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto w-full pb-24" style={{ maxWidth: column, paddingInline: WIDE_GUTTER }}>
          <AgentList
            wide={{ columns }}
            filter={filter}
            agents={HERD.agents}
            shellPanes={HERD.shellPanes}
            bridge="connected"
            onOpen={() => {}}
            tabs={HERD.tabs}
            workspaces={HERD.workspaces}
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
          <div style={{ width: SPACE_WIDTH }}>
            <div className="-mx-4">
              <SpaceOverview
                workspaces={HERD.workspaces}
                agents={HERD.agents}
                shellPanes={HERD.shellPanes}
                onOpen={() => {}}
                onNewSpace={() => {}}
                open={spacesOpen}
                onOpenChange={setSpacesOpen}
              />
            </div>
          </div>
        </div>
      </div>
      <div className="mx-auto w-full" style={{ maxWidth: column }}>
        <TabBar<DashView>
          label={t("home.tabs.aria")}
          active={view}
          onSelect={setView}
          items={[
            {
              value: "dashboard",
              label: t("home.tabs.dashboard"),
              icon: <Icon name="tab-dashboard" className="size-5" />,
              badge: blocked,
              dot: blocked === 0 && hasReady(HERD.agents),
              badgeLabel: blocked > 0 ? tn("home.tabs.blocked", blocked) : t("home.tabs.unseen"),
            },
            { value: "changes", label: t("files.title"), icon: <Icon name="files" className="size-5" /> },
          ]}
        />
      </div>
      {/* The New button at the grid's right edge, over the tab bar, as the route's fixed layer draws it. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[calc(3.5rem+1px+1rem)] z-30 mx-auto flex justify-end px-6" style={{ maxWidth: column }}>
        <FabButton label={t("home.new.label")} onClick={() => {}} />
      </div>
    </AppHeaderHost>
  );
}

/**
 * The screen: `SCREEN_WIDTH` px wide, a ring instead of a border so the content is exactly that wide. It does
 * NOT scroll itself. The header sits outside the scroller and the frame's `transform` makes it the containing
 * block of anything fixed.
 */
function Screen({ children }: { children: ReactNode }) {
  return (
    <div
      ref={(el) => el?.style.setProperty("--app-h", `${SCREEN_HEIGHT}px`)}
      data-pg-frame=""
      onScroll={(e) => {
        e.currentTarget.scrollTop = 0;
      }}
      className="relative isolate flex max-w-none flex-col overflow-hidden rounded-sm bg-background ring-1 ring-rule"
      style={{ width: SCREEN_WIDTH, height: SCREEN_HEIGHT, transform: "translate(0)" }}
    >
      {children}
    </div>
  );
}

export function DashboardWideSection() {
  return (
    <Section def={DEF}>
      <Group title="Large screen">
        <Card
          state="dashboard-wide"
          label="Needs you first, then Spaces"
          reach="open the dashboard in a window 900px wide or more, with Large-screen layout on Auto."
          note="The route measures its scroller; this card is fixed at 1280px, so the grid is three columns."
          span="all"
        >
          {/* The page keeps a 16px gutter each side; the frame takes it back so the screen is exactly 1280. */}
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <Screen>
              <PackedRootRouter data={{ ...homeSolo, agents: HERD.agents, shellPanes: HERD.shellPanes, workspaces: HERD.workspaces, tabs: HERD.tabs, servers: [] }}>
                <LiveScreen />
              </PackedRootRouter>
            </Screen>
          </div>
        </Card>
      </Group>
    </Section>
  );
}
