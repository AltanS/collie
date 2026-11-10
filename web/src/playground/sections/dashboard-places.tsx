// The "Dashboard places" section of the states playground (2026-11-10, the owner's pick A5 from "Hill
// look", built): the real Dashboard pieces with fixtures. The tricks' tiles at the top of the list
// (`TrickDashboardStrip`, the `dashboard` place), the pane list, and the route's bottom bar
// (`DashboardTabBar`): Crew, Dashboard, Files, the Hill with its count, and the tricks' `tabbar` items
// scrolling after a divider. Each card runs over a tricks store of its own, so nothing reaches a bridge.
//
// `?place=<case>#dashboard-places` draws one case over the whole screen, for a phone and for the shots;
// `&shot=1` hides the close button.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { AgentList } from "@/components/agent-list";
import { AppHeaderHost, RouteHeader } from "@/components/app-header";
import { DashboardTabBar } from "@/components/dashboard-tab-bar";
import { TrickDashboardStrip } from "@/components/trick-place-items";
import type { DashView } from "@/lib/dash-view";
import type { PaneOrder } from "@/lib/pane-order";
import { countBlocked } from "@/lib/triage";
import { partKey, type PlaceItem, type TrickIcon, type WireTrickInfo, type WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, useTrickParts, type TricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";

import { herd, homeSolo, tabs } from "../fixtures";
import { RootRouter } from "../harness";
import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "dashboard-places",
  title: "Dashboard places",
  intent: "The Hill in the bottom bar, the tricks' tiles at the top and their items in the bar, with fixtures.",
};

const noop = () => {};
const AS_OF = new Date().toISOString();

interface Fixture {
  id: string;
  name: string;
  icon: TrickIcon;
  badge?: number | string;
  tone?: PlaceItem["tone"];
}

/** The nine tricks of the Hill look round, so the built cases read against its shots. */
const TRICKS: readonly Fixture[] = [
  { id: "legs", name: "Legs", icon: "flask", badge: "23/34", tone: "accent" },
  { id: "tracker", name: "Tracker", icon: "file", badge: "M96" },
  { id: "triage", name: "Triage", icon: "eye", badge: 3, tone: "warn" },
  { id: "spend", name: "Spend", icon: "tag", badge: "$7.42" },
  { id: "deploy", name: "Deploy", icon: "play", tone: "ok", badge: "green" },
  { id: "quiet", name: "Quiet", icon: "bell" },
  { id: "notes", name: "Notes", icon: "note" },
  { id: "crew", name: "Crew", icon: "crew", badge: 2 },
  { id: "search", name: "Search", icon: "search" },
];

interface PlaceCase {
  id: string;
  label: string;
  /** How many of `TRICKS` draw a tile, and how many an item in the bar. */
  tiles: number;
  bar: number;
  /** The open Decisions on the Hill. */
  hill: number;
}

const CASES: readonly PlaceCase[] = [
  { id: "none", label: "no tricks, 3 open", tiles: 0, bar: 0, hill: 3 },
  { id: "tiles-3", label: "3 tiles", tiles: 3, bar: 0, hill: 3 },
  { id: "tiles-9", label: "9 tiles, scrolling", tiles: 9, bar: 0, hill: 3 },
  { id: "bar-2", label: "2 bar items", tiles: 0, bar: 2, hill: 3 },
  { id: "bar-6", label: "6 bar items, scrolling", tiles: 0, bar: 6, hill: 3 },
  { id: "hill-0", label: "Hill, none open", tiles: 0, bar: 0, hill: 0 },
  { id: "hill-12", label: "Hill, 12 open", tiles: 0, bar: 0, hill: 12 },
  { id: "busy", label: "6 tiles, 12 open (A5 busy)", tiles: 6, bar: 0, hill: 12 },
];

function part(trick: Fixture, at: "dashboard" | "tabbar"): WireTrickPart {
  const item: PlaceItem = { icon: trick.icon, label: trick.name };
  if (trick.badge !== undefined) item.badge = trick.badge;
  if (trick.tone !== undefined) item.tone = trick.tone;
  return { host: "bluefin", trick: trick.id, part: at, rev: 1, asOf: AS_OF, fresh: "24h", value: { at, id: at, item } };
}

/** A trick session for the first two tricks, so their tiles and items are buttons; the rest are inert. */
function trickSession(trick: Fixture): AgentView {
  return {
    paneId: `trick:bluefin:${trick.id}:${trick.id}`,
    workspaceId: "trick:bluefin",
    workspaceLabel: "Tricks",
    workspaceNumber: 4,
    tabId: `trick:bluefin:${trick.id}`,
    agent: trick.id,
    status: "idle",
    cwd: "",
    focused: false,
    kind: "trick",
  };
}
const SESSIONS: readonly AgentView[] = TRICKS.slice(0, 2).map(trickSession);

function storeFor(c: PlaceCase): TricksStore {
  const parts = [...TRICKS.slice(0, c.tiles).map((t) => part(t, "dashboard")), ...TRICKS.slice(0, c.bar).map((t) => part(t, "tabbar"))];
  const tricks = TRICKS.map((t): WireTrickInfo => ({ host: "bluefin", id: t.id, name: t.name, icon: t.icon, on: true, state: "ok", places: ["dashboard", "tabbar"] }));
  return createTricksStore({
    fetchTricks: () => Promise.resolve({ rev: 1, tricks, parts, present: parts.map(partKey) }),
    tapTrick: (_host, _trick, body) => Promise.resolve({ rid: body.rid, code: "ok" }),
    mintRequestId: () => "00000000-0000-4000-8000-000000000001",
  });
}

/**
 * The Dashboard as `routes/home.tsx` composes it, on a crew with a screen. The state and the store's
 * hooks live INSIDE the router: `RootRouter` builds its tree once, so a prop computed above it would
 * never reach the bar again.
 */
function PlacesDashboard({ c }: { c: PlaceCase }) {
  const store = useMemo(() => storeFor(c), [c]);
  useEffect(() => {
    void store.syncTricks(1);
  }, [store]);
  return (
    <RootRouter data={homeSolo}>
      <PlacesScreen c={c} store={store} />
    </RootRouter>
  );
}

function PlacesScreen({ c, store }: { c: PlaceCase; store: TricksStore }) {
  const [view, setView] = useState<DashView>("dashboard");
  const [order, setOrder] = useState<PaneOrder>("place");
  const [needsYou, setNeedsYou] = useState(false);
  const tabbarParts = useTrickParts("tabbar", undefined, store);
  return (
    <AppHeaderHost bridge="connected" error={false}>
      <RouteHeader wordmark width="column" />
      <div data-pg-scroll className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {view === "dashboard" && <TrickDashboardStrip sessions={SESSIONS} onOpenSession={noop} store={store} />}
        <AgentList
          agents={herd}
          shellPanes={[]}
          bridge="connected"
          onOpen={noop}
          tabs={tabs}
          order={order}
          onOrderChange={setOrder}
          isolated={[]}
          hidden={[]}
          onIsolate={noop}
          onToggleHidden={noop}
          needsYouOnly={view === "dashboard" && needsYou}
          onNeedsYouOnlyChange={setNeedsYou}
        />
      </div>
      <DashboardTabBar
        view={view}
        onSelect={setView}
        crew
        files
        blockedCount={countBlocked(herd)}
        readyUnseen={false}
        hill={c.hill}
        onOpenHill={noop}
        tabbarParts={tabbarParts}
        sessions={SESSIONS}
        onOpenSession={noop}
        store={store}
      />
    </AppHeaderHost>
  );
}

function Phone({ children }: { children: ReactNode }) {
  const box: CSSProperties & { "--app-h"?: string } = { width: 390, height: 760, transform: "translate(0)", "--app-h": "760px" };
  return (
    <div data-pg-frame="" className="relative isolate flex max-w-full flex-col overflow-hidden rounded-sm bg-background ring-1 ring-rule" style={box}>
      {children}
    </div>
  );
}

function param(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

/** One case over the whole screen, for a phone and for the shots. */
function Solo({ c }: { c: PlaceCase }) {
  const style: CSSProperties & { "--app-h"?: string } = { "--app-h": "100dvh" };
  return (
    <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-background text-foreground" style={style}>
      <PlacesDashboard c={c} />
      {param("shot") !== "1" && (
        <a
          href="?#dashboard-places"
          aria-label="Close"
          className="fixed top-20 right-4 z-[61] flex h-11 min-w-11 items-center justify-center rounded-sm border border-border bg-card px-2 text-sm font-semibold shadow-md"
        >
          ×
        </a>
      )}
    </div>
  );
}

export function DashboardPlacesSection() {
  const solo = CASES.find((c) => c.id === param("place"));
  if (solo !== undefined) return <Solo c={solo} />;
  return (
    <Section def={DEF}>
      <Group title="The Dashboard with the Hill and the tricks' places">
        {CASES.map((c) => (
          <Card key={c.id} state={`dashboard-places-${c.id}`} label={c.label}>
            <a href={`?place=${c.id}#dashboard-places`} className="text-xs text-muted-foreground underline">
              full screen
            </a>
            <Phone>
              <PlacesDashboard c={c} />
            </Phone>
          </Card>
        ))}
      </Group>
    </Section>
  );
}
