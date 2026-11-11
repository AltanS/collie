// The REAL place components of the tricks explainer, fed one made-up program trick, "Release gates", so
// every place shows the same trick: the belt's mark, the status line's chip, the Dashboard's tile, the
// bottom bar's item, the trick session, and a Decision it posts on the Hill. Each mounts the app's own
// component over a store of its own; a tap shows the busy state and goes nowhere.
// The pattern is the "Trick places" section's (../sections/trick-places.tsx), cut to one trick.
// DEV-ONLY, like the rest of `src/playground/`.

import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { ActionsRow } from "@/components/actions-row";
import { AgentViewScreen } from "@/components/agent-view-screen";
import { beltMarksOf } from "@/components/belt-trick-mark";
import type { ViewSendResult } from "@/components/composer";
import { DashboardTabBar } from "@/components/dashboard-tab-bar";
import { DecisionCard } from "@/components/decision-card";
import { ModelTag } from "@/components/model-tag";
import { TrickDashboardStrip } from "@/components/trick-place-items";
import { TrickSpaceSection } from "@/components/trick-session";
import { statusItemsOf } from "@/components/trick-status-item";
import { HILL_IDLE } from "@/hooks/use-hill-answer";
import type { HillDecision } from "@/lib/hill/wire";
import { partKey, type TrickTapReply, type View, type WireTrickInfo, type WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, useTrickParts, type TricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { mintRequestId } from "@/lib/worktree-name";

import { VIEW_NOW, VIEW_SCREEN, VIEW_SESSION } from "../fixtures/agent-view";
import { gateStrip, playgroundMedia, trickOpen } from "../fixtures/hill/decisions";

const HOST = "workshop";
const NOW = Date.now();
const AS_OF = new Date(NOW - 20_000).toISOString();
const IGNORE = () => {};
const RUN = () => Promise.resolve(true);

/** The one program trick every place shows. */
export const GATES: WireTrickInfo = { host: HOST, id: "gates", name: "Release gates", icon: "flask", on: true, state: "ok", places: ["belt", "status", "dashboard", "tabbar", "session"] };

function wire(value: WireTrickPart["value"]): WireTrickPart {
  return { host: HOST, trick: "gates", part: value.id, rev: 1, value, asOf: AS_OF, fresh: "5m" };
}

const GATES_VIEW: View = [
  { kind: "number", text: "5/7", attrs: { label: "gates green", tone: "accent" } },
  {
    kind: "list",
    kids: [
      { kind: "row", text: "e2e: pane glide", attrs: { end: "red", tone: "danger" } },
      { kind: "row", text: "windows", attrs: { end: "running", tone: "warn" } },
    ],
  },
];

const BELT = wire({ at: "belt", id: "belt", mark: { icon: "flask", label: "5/7", tone: "accent", intent: "rerun" } });
const STATUS = wire({ at: "status", id: "status", chip: { text: "e2e red", icon: "flask", tone: "warn" } });
const TILE = wire({ at: "dashboard", id: "dashboard", item: { icon: "flask", label: "Gates", badge: "5/7", tone: "accent" } });
const TAB = wire({ at: "tabbar", id: "tabbar", item: { icon: "flask", label: "Gates", badge: 2, tone: "warn" } });
const SESSION = wire({
  at: "session",
  id: "gates",
  name: "Release gates",
  tone: "accent",
  subtitle: "e2e red, windows running",
  progress: { value: 5, max: 7 },
  actions: [{ id: "rerun", label: "Rerun red", intent: "rerun", icon: "refresh" }],
  view: GATES_VIEW,
});

const PARTS = [BELT, STATUS, TILE, TAB, SESSION];

/** A store over a stand-in bridge that answers a tap after a moment, so the busy state is seen. */
function gatesStore(): TricksStore {
  return createTricksStore({
    fetchTricks: () => Promise.resolve({ rev: 1, tricks: [GATES], parts: PARTS, present: PARTS.map(partKey) }),
    tapTrick: (_host, _trick, body) => new Promise<TrickTapReply>((resolve) => setTimeout(() => resolve({ rid: body.rid, code: "ok" }), 1500)),
    mintRequestId,
  });
}

function useStore(): TricksStore {
  const store = useMemo(gatesStore, []);
  useEffect(() => {
    void store.syncTricks(1);
  }, [store]);
  return store;
}

/** The trick session as the snapshot lists it: a pane of kind "trick". */
const GATES_PANE: AgentView = {
  paneId: `trick:${HOST}:gates:gates`,
  workspaceId: `trick:${HOST}`,
  workspaceLabel: "Tricks",
  workspaceNumber: 4,
  tabId: `trick:${HOST}:gates`,
  agent: "gates",
  status: "idle",
  cwd: "",
  focused: false,
  kind: "trick",
  view: partKey(SESSION),
  paneLabel: "Release gates",
  subtitle: "e2e red, windows running",
  progress: { kind: "percent", value: 71 },
};

/** A phone-wide box: the glass a place's component sits on. */
export function Glass({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`w-full max-w-[390px] overflow-hidden rounded-sm border border-border bg-background ${className ?? "px-4 py-3"}`}>{children}</div>;
}

/** The belt under a session's screen, scrolled to its end, where a trick's mark stands after Collie's own buttons. */
export function RealBelt() {
  const store = useStore();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = box.current?.querySelector<HTMLElement>("div.overflow-x-auto");
    const id = window.setTimeout(() => strip?.scrollTo({ left: strip.scrollWidth }), 400);
    return () => window.clearTimeout(id);
  }, []);
  const marks = beltMarksOf({ parts: [BELT], handlersFor: () => ({}), sessions: [GATES_PANE], onOpenSession: IGNORE, store });
  return (
    <div ref={box}>
      <ActionsRow
        general={[
          { id: "keys", icon: "keys-drawer", label: "Keys", onSelect: IGNORE },
          { id: "screen", icon: "screen", label: "Screen", onSelect: IGNORE },
        ]}
        agent="claude"
        onRun={RUN}
        marks={marks}
        changes={{ onClick: IGNORE, label: "Files" }}
        handle={{ ref: IGNORE, onClick: IGNORE, label: "Switch pane" }}
      />
    </div>
  );
}

const USAGE = { context: 42, limits: [{ window: "5h" as const, used: 58 }] };

/** The status line over a session's screen: Collie's own items, then the trick's chip. */
export function RealStatus() {
  const store = useStore();
  const trailing = useMemo(() => statusItemsOf({ parts: [STATUS], sessions: [GATES_PANE], onOpenSession: IGNORE, store }), [store]);
  return (
    <div className="relative h-12 w-full max-w-[390px] overflow-hidden rounded-sm border border-border bg-background">
      <p className="px-3 pt-2 font-mono text-xs text-muted-foreground">Running the e2e leg again.</p>
      <ModelTag model="claude-opus-5-5" usage={USAGE} trailing={trailing} />
    </div>
  );
}

/** The strip of tiles at the top of the Dashboard. */
export function RealTiles() {
  const store = useStore();
  return <TrickDashboardStrip sessions={[GATES_PANE]} onOpenSession={IGNORE} store={store} />;
}

/** The Dashboard's bottom bar: Collie's views, the Hill, then the trick's item after a thin divider. */
export function RealTabBar() {
  const store = useStore();
  const tabbarParts = useTrickParts("tabbar", undefined, store);
  return (
    <DashboardTabBar
      view="dashboard"
      onSelect={IGNORE}
      crew={false}
      files
      blockedCount={0}
      readyUnseen={false}
      hill={1}
      onOpenHill={IGNORE}
      tabbarParts={tabbarParts}
      sessions={[GATES_PANE]}
      onOpenSession={IGNORE}
      store={store}
    />
  );
}

/** The trick session's row on the Dashboard, under Tricks. */
export function RealSessionRow() {
  return <TrickSpaceSection sessions={[GATES_PANE]} onOpen={IGNORE} />;
}

/** A Decision a trick posted: the trick is the sender, and its answer goes back to the trick's program. */
export const GATES_ASKS: HillDecision = {
  ...trickOpen,
  from: { ...trickOpen.from, label: "Release gates", trickId: "gates", trickKey: "tag-1-28-2" },
  title: "Tag 1.28.2 with the e2e gate red?",
  summary: "Six of the seven gates are green. The e2e gate failed once, on a timing budget.",
  options: [
    { intent: "rerun", label: "Rerun e2e first" },
    { intent: "tag", label: "Tag it now", confirm: "Tag now" },
  ],
  recommends: { intent: "rerun", why: "The same case passed on the last two runs." },
  // The gates as chips, and the red one with its proof: the fixture's view without its link.
  view: gateStrip.view?.slice(0, 2),
};

/** The Hill card of that Decision, open. */
export function RealHillCard({ decision = GATES_ASKS }: { decision?: HillDecision }) {
  return <DecisionCard decision={decision} answer={HILL_IDLE} onSend={IGNORE} mediaSource={playgroundMedia} />;
}

const NO_TAP = (): Promise<ViewSendResult> => Promise.resolve({ sent: false, line: null, code: null });

/** An agent view of a session, with its first screen: a made-up view trick, "Release view". */
export function RealAgentView() {
  return (
    <div className="flex h-[620px] flex-col overflow-hidden">
      <AgentViewScreen name="Release view" session={VIEW_SESSION} view={VIEW_SCREEN} working={false} entries={[]} canAct onTap={NO_TAP} onLink={IGNORE} now={VIEW_NOW} />
    </div>
  );
}
