// The places chapter's REAL screens: the Dashboard, a session, a trick's Page, the Hill and an agent view,
// each the app's own components at phone size, fed the official tricks (Release Gates, PR Inbox, Running
// Builds, Design Review, Morph) with made-up data. A `Lit` frame dims everything on a screen but the parts
// it names, and can number them. No playground fixture: the data is place-world.ts. The session screen
// is the whole real pane view (`AgentChat`, as the pane route mounts it): it reads
// the app's own tricks store, which `useSceneTricks` feeds while the chapter is mounted by answering
// `GET /api/tricks` in place of a bridge (the pattern of the "Trick settings" section).
// DEV-ONLY, like the rest of `src/playground/`.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { AgentChat } from "@/components/agent-chat";
import { AgentList } from "@/components/agent-list";
import { AppHeaderHost, RouteHeader } from "@/components/app-header";
import { footAir } from "@/components/dashboard-route-bar";
import { DashboardTabBar } from "@/components/dashboard-tab-bar";
import { CrewProvider } from "@/components/crew-provider";
import { DecisionCard } from "@/components/decision-card";
import { HillHeader, HillView } from "@/components/hill-view";
import { TrickDashboardStrip } from "@/components/trick-place-items";
import { TrickSpaceSection } from "@/components/trick-session";
import { HILL_IDLE } from "@/hooks/use-hill-answer";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { countBlocked } from "@/lib/triage";
import { partKey, type TricksReply, type View, type WireTrickInfo, type WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, syncTricks, useTrickParts, type TricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TrickSessionBody, TrickSessionHeaderRow } from "@/routes/trick-session";

import { HUE_VAR } from "./hues";
import { MorphScreen } from "./morph";
import { AGENTS, GATES_DECISION, HOME, SESSION_PANE, SESSION_TEXT } from "./place-world";

const HOST = "workshop";
const AS_OF = new Date().toISOString();
const IGNORE = () => {};

// ── The official tricks, with made-up data ────────────────────────────────────────────────────────

function info(id: string, name: string, icon: WireTrickInfo["icon"], places: WireTrickInfo["places"]): WireTrickInfo {
  return { host: HOST, id, name, icon, on: true, state: "ok", places };
}

const TRICKS: readonly WireTrickInfo[] = [
  info("release-gates", "Release Gates", "flask", ["dashboard", "tabbar", "status", "belt", "session"]),
  info("pr-inbox", "PR Inbox", "git-pull-request", ["dashboard", "tabbar", "status", "belt", "session"]),
  info("running-builds", "Running Builds", "play", ["dashboard", "status", "session"]),
  info("design-review", "Design Review", "eye", ["dashboard", "tabbar", "status", "belt", "session"]),
];

function wire(trick: string, value: WireTrickPart["value"]): WireTrickPart {
  return { host: HOST, trick, part: value.id, rev: 1, value, asOf: AS_OF, fresh: "24h" };
}

const GATES_VIEW: View = [
  { kind: "number", text: "5/7", attrs: { label: "gates green", tone: "accent" } },
  {
    kind: "list",
    kids: [
      { kind: "row", text: "e2e: pane glide", attrs: { end: "red", tone: "danger" } },
      { kind: "row", text: "windows", attrs: { end: "running", tone: "warn" } },
      { kind: "row", text: "unit, web, lint, types", attrs: { end: "green", tone: "ok" } },
    ],
  },
];

const BUILDS_VIEW: View = [
  {
    kind: "list",
    kids: [
      { kind: "row", text: "web: vite build", attrs: { end: "1 min", tone: "warn" } },
      { kind: "row", text: "api: bun test", attrs: { end: "12 s", tone: "warn" } },
    ],
  },
];

/** Every part the scenes draw. Each lit part has a word nothing else on its screen shows, so `Lit` can find it. */
const PARTS: readonly WireTrickPart[] = [
  wire("release-gates", { at: "dashboard", id: "dashboard", item: { icon: "flask", label: "Gates", badge: "5/7", tone: "accent" } }),
  wire("pr-inbox", { at: "dashboard", id: "dashboard", item: { icon: "git-pull-request", label: "Inbox", badge: 3, tone: "warn" } }),
  wire("running-builds", { at: "dashboard", id: "dashboard", item: { icon: "play", label: "Builds", badge: 2 } }),
  wire("release-gates", { at: "tabbar", id: "tabbar", item: { icon: "flask", label: "Gates", badge: 2, tone: "warn" } }),
  wire("design-review", { at: "tabbar", id: "tabbar", item: { icon: "eye", label: "Review", badge: 2 } }),
  wire("release-gates", { at: "status", id: "status", chip: { text: "e2e red", icon: "flask", tone: "warn" } }),
  wire("release-gates", { at: "belt", id: "belt", mark: { icon: "flask", label: "5/7", tone: "accent", intent: "rerun" } }),
  wire("pr-inbox", { at: "belt", id: "belt", mark: { icon: "git-pull-request", label: "3 PRs", tone: "warn", intent: "open" } }),
  wire("release-gates", {
    at: "session",
    id: "main",
    name: "Release Gates",
    tone: "accent",
    subtitle: "e2e red, windows running",
    progress: { value: 5, max: 7 },
    actions: [{ id: "rerun", label: "Rerun red", intent: "rerun", icon: "refresh" }],
    view: GATES_VIEW,
  }),
  wire("running-builds", { at: "session", id: "main", name: "Running Builds", subtitle: "serves 72f6936", view: BUILDS_VIEW }),
  wire("pr-inbox", { at: "session", id: "main", name: "PR Inbox", subtitle: "3 wait for you", view: [] }),
  wire("design-review", { at: "session", id: "main", name: "Design Review", subtitle: "2 wait for your yes", view: [] }),
];

const REPLY: TricksReply = { rev: 1, tricks: [...TRICKS], parts: [...PARTS], present: PARTS.map(partKey) };

/** A trick's Page as the snapshot lists it: a pane of kind "trick". */
function pagePane(trick: string, label: string, subtitle: string, status: AgentView["status"]): AgentView {
  const part = PARTS.find((p) => p.trick === trick && p.value.at === "session");
  return {
    paneId: `trick:${HOST}:${trick}:main`,
    workspaceId: `trick:${HOST}`,
    workspaceLabel: "Tricks",
    workspaceNumber: 4,
    tabId: `trick:${HOST}:${trick}`,
    agent: trick,
    status,
    cwd: "",
    focused: false,
    kind: "trick",
    view: part === undefined ? undefined : partKey(part),
    paneLabel: label,
    sessionName: label,
    subtitle,
  };
}

const GATES_PAGE = pagePane("release-gates", "Release Gates", "e2e red, windows running", "working");
const PAGES: readonly AgentView[] = [
  pagePane("running-builds", "Running Builds", "serves 72f6936", "idle"),
  GATES_PAGE,
  pagePane("pr-inbox", "PR Inbox", "3 wait for you", "idle"),
  pagePane("design-review", "Design Review", "2 wait for your yes", "idle"),
];

function sceneStore(): TricksStore {
  return createTricksStore({
    fetchTricks: () => Promise.resolve(REPLY),
    tapTrick: (_host, _trick, body) => Promise.resolve({ rid: body.rid, code: "ok" }),
    mintRequestId: () => "00000000-0000-4000-8000-000000000002",
  });
}

function useSceneStore(): TricksStore {
  const store = useMemo(sceneStore, []);
  useEffect(() => {
    void store.syncTricks(1);
  }, [store]);
  return store;
}

/** How many mounted users want the answer, and the fetch it stands in front of while any does. */
let users = 0;
let realFetch: typeof window.fetch | null = null;

/**
 * While mounted, `GET /api/tricks` answers the scenes' tricks, and the app's own store syncs once, so the
 * real pane view draws Release Gates's chip in its status line and the two marks on its Belt. Nothing
 * goes on the network; every other request passes through untouched. Counted: the first user puts the
 * answer in front of `fetch`, the last one takes it away, in whatever order they unmount.
 */
export function useSceneTricks(): void {
  useEffect(() => {
    users += 1;
    if (users === 1) {
      const real = window.fetch;
      realFetch = real;
      window.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
        if (url.pathname !== "/api/tricks") return real(input, init);
        return Promise.resolve(new Response(JSON.stringify(REPLY), { status: 200, headers: { "content-type": "application/json" } }));
      };
    }
    void syncTricks(1);
    return () => {
      users -= 1;
      if (users === 0 && realFetch !== null) {
        window.fetch = realFetch;
        realFetch = null;
      }
    };
  }, []);
}

// ── Lighting and sizing ──────────────────────────────────────────────────────────────────────────

/** A part to light: how to find it on the screen, and its callout number, if any. */
export interface Target {
  find: (root: HTMLElement) => Element | null;
  n?: number;
}

/** The element whose own text is `text`, then its nearest control or row: what a person sees as the part. */
export function byText(text: string): Target["find"] {
  return (root) => {
    for (const el of root.querySelectorAll("*")) {
      const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim();
      if (own !== text) continue;
      // Never past the screen: the screen itself may sit in a list item of the page.
      const part = el.closest("button, a, [role='button'], li");
      return part !== null && root.contains(part) ? part : (el.parentElement ?? el);
    }
    return null;
  };
}

/** The first element a selector matches. */
export function bySelector(selector: string): Target["find"] {
  return (root) => root.querySelector(selector);
}

interface Hole {
  x: number;
  y: number;
  w: number;
  h: number;
  n?: number;
}

/** Light some parts of a screen: everything else under a veil, each lit part ringed, numbered when asked. */
export function Lit({ targets, children }: { targets: readonly Target[]; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [holes, setHoles] = useState<readonly Hole[]>([]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    const measure = () => {
      const base = el.getBoundingClientRect();
      const k = el.offsetWidth > 0 ? base.width / el.offsetWidth : 1;
      setHoles(
        targets.flatMap((t) => {
          const hit = t.find(el);
          if (hit === null) return [];
          const r = hit.getBoundingClientRect();
          if (r.width === 0) return [];
          return [{ x: (r.left - base.left) / k, y: (r.top - base.top) / k, w: r.width / k, h: r.height / k, n: t.n }];
        }),
      );
    };
    measure();
    const ids = [200, 700, 1600].map((ms) => window.setTimeout(measure, ms));
    const observer = "ResizeObserver" in window ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => {
      for (const id of ids) window.clearTimeout(id);
      observer?.disconnect();
    };
  }, [targets]);
  const mask = useRef(`lit-${Math.random().toString(36).slice(2)}`).current;
  return (
    <div ref={box} className="relative flex h-full w-full flex-col">
      {children}
      {targets.length > 0 && (
        <svg aria-hidden className="pointer-events-none absolute inset-0 z-[70] h-full w-full">
          <defs>
            <mask id={mask}>
              <rect width="100%" height="100%" fill="white" />
              {holes.map((h, i) => (
                <rect key={i} x={h.x - 4} y={h.y - 4} width={h.w + 8} height={h.h + 8} rx={2} fill="black" />
              ))}
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="var(--background)" opacity={0.78} mask={`url(#${mask})`} />
          {holes.map((h, i) => (
            <g key={i}>
              <rect x={h.x - 4} y={h.y - 4} width={h.w + 8} height={h.h + 8} rx={2} fill="none" stroke={HUE_VAR.trick} strokeWidth={2.5} />
              {h.n !== undefined && (
                <g>
                  <circle cx={Math.min(h.x + h.w + 2, 376)} cy={Math.max(h.y - 4, 14)} r={13} fill={HUE_VAR.trick} />
                  <text x={Math.min(h.x + h.w + 2, 376)} y={Math.max(h.y - 4, 14) + 5} textAnchor="middle" fontSize={15} fontWeight={700} fill="var(--background)">
                    {h.n}
                  </text>
                </g>
              )}
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}

/** The height of a caption line above a phone screen, at 390 px. */
export const CAPTION_H = 44;

/**
 * A phone screen, 390 px wide, scaled as a picture scales: down to a narrower column, and, with `fill`, up
 * to a wider one too, so a figure fills its box. A `caption` takes a line of its own above the screen.
 */
export function PhoneScreen({ height = 760, children, label, fill = false, caption }: { height?: number; children: ReactNode; label: string; fill?: boolean; caption?: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = outer.current;
    if (el === null || !("ResizeObserver" in window)) return;
    const measure = () => {
      if (el.clientWidth > 0) setScale(fill ? el.clientWidth / 390 : Math.min(1, el.clientWidth / 390));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fill]);
  const total = height + (caption === undefined ? 0 : CAPTION_H);
  const box: CSSProperties = { width: 390, height: total, transform: `scale(${String(scale)})`, transformOrigin: "0 0" };
  const frame: CSSProperties & { "--app-h"?: string } = { height, "--app-h": `${String(height)}px` };
  return (
    <div ref={outer} role="img" aria-label={label} className={cn("w-full", !fill && "max-w-[390px]")} style={{ height: total * scale }}>
      <div style={box}>
        {caption !== undefined && <div className="flex items-center" style={{ height: CAPTION_H }}>{caption}</div>}
        <div data-pg-frame="" className="relative isolate flex flex-col overflow-hidden rounded-sm bg-background ring-1 ring-rule" style={frame}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** The app's root route on a memory router: the screens read the snapshot from it, as in the app. Nothing navigates. */
function SceneRoot({ children }: { children: ReactNode }) {
  const [router] = useState(() => createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => HOME, element: children }], { initialEntries: ["/"] }));
  return <RouterProvider router={router} />;
}

/** The whole real pane view of one session, as the pane route mounts it, with the session's text as a prop. */
function PaneRoot() {
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => HOME,
          element: (
            <CrewProvider servers={HOME.servers} sessions={HOME.sessions} ts={HOME.ts} pollMs={3_000}>
              <AppHeaderHost bridge={HOME.bridge} error={false}>
                <AgentChat
                  paneId={SESSION_PANE.paneId}
                  agent={{ ...SESSION_PANE, sendProtocol: true }}
                  agents={HOME.agents}
                  shellPanes={HOME.shellPanes}
                  tabs={HOME.tabs}
                  text={SESSION_TEXT}
                  requestedLines={400}
                  revision={1}
                  device={HOME.device}
                  bridge={HOME.bridge}
                  error={false}
                  onBack={IGNORE}
                  onSelect={IGNORE}
                />
              </AppHeaderHost>
            </CrewProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    ),
  );
  return <RouterProvider router={router} />;
}

// ── The screens ──────────────────────────────────────────────────────────────────────────────────

/** The Dashboard, as `routes/home.tsx` composes it: the tiles, three agents, the Tricks rows, the bottom bar. */
function DashboardInner() {
  const store = useSceneStore();
  const tabbarParts = useTrickParts("tabbar", undefined, store);
  const agents = AGENTS;
  return (
    <AppHeaderHost bridge="connected" error={false}>
      <RouteHeader wordmark width="column" />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <TrickDashboardStrip sessions={PAGES} onOpenSession={IGNORE} store={store} />
        <AgentList
          agents={agents}
          shellPanes={[]}
          bridge="connected"
          onOpen={IGNORE}
          tabs={HOME.tabs}
          order="place"
          onOrderChange={IGNORE}
          isolated={[]}
          hidden={[]}
          onIsolate={IGNORE}
          onToggleHidden={IGNORE}
          needsYouOnly={false}
          onNeedsYouOnlyChange={IGNORE}
        />
        <TrickSpaceSection sessions={PAGES} onOpen={IGNORE} />
      </div>
      <DashboardTabBar
        view="dashboard"
        onSelect={IGNORE}
        crew
        files
        blockedCount={countBlocked(agents)}
        readyUnseen={false}
        hill={2}
        onOpenHill={IGNORE}
        tabbarParts={tabbarParts}
        sessions={PAGES}
        onOpenSession={IGNORE}
        store={store}
      />
    </AppHeaderHost>
  );
}

export function DashboardScene() {
  return (
    <SceneRoot>
      <DashboardInner />
    </SceneRoot>
  );
}

/** A trick's Page, as `routes/trick-session.tsx` composes it: Release Gates, with the bottom bar. */
function PageInner({ pane }: { pane: AgentView }) {
  const store = useSceneStore();
  const tabbarParts = useTrickParts("tabbar", undefined, store);
  return (
    <AppHeaderHost bridge="connected" error={false}>
      <RouteHeader width="column" override={<TrickSessionHeaderRow pane={pane} onBack={IGNORE} />} />
      <TrickSessionBody pane={pane} onLink={IGNORE} barBelow store={store} />
      <DashboardTabBar
        view={null}
        onSelect={IGNORE}
        crew
        files
        blockedCount={0}
        readyUnseen={false}
        hill={2}
        onOpenHill={IGNORE}
        currentTrick={{ host: HOST, trick: pane.agent ?? "" }}
        tabbarParts={tabbarParts}
        sessions={PAGES}
        onOpenSession={IGNORE}
        store={store}
      />
    </AppHeaderHost>
  );
}

export function PageScene() {
  return (
    <SceneRoot>
      <PageInner pane={GATES_PAGE} />
    </SceneRoot>
  );
}

/** The Hill's page, with the Decision Release Gates posted. */
function HillInner() {
  const store = useSceneStore();
  const tabbarParts = useTrickParts("tabbar", undefined, store);
  const open = useMemo(() => [GATES_DECISION], []);
  return (
    <AppHeaderHost bridge="connected" error={false}>
      <HillHeader count={1} nowCount={0} onBack={IGNORE} />
      <div className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden px-4 pt-4", footAir(true, "pb-4"))}>
        <HillView open={open} closed={[]} kept={new Map()} renderCard={(d) => <DecisionCard key={d.id} decision={d} answer={HILL_IDLE} onSend={IGNORE} />} />
      </div>
      <DashboardTabBar
        view={null}
        onSelect={IGNORE}
        crew
        files
        blockedCount={0}
        readyUnseen={false}
        hill={1}
        onOpenHill={IGNORE}
        hillCurrent
        tabbarParts={tabbarParts}
        sessions={PAGES}
        onOpenSession={IGNORE}
        store={store}
      />
    </AppHeaderHost>
  );
}

export function HillScene() {
  return (
    <SceneRoot>
      <HillInner />
    </SceneRoot>
  );
}

/** An agent session: the whole real pane view, its status line and Belt reading the app's tricks store. */
export function SessionScene() {
  const box = useRef<HTMLDivElement>(null);
  // The Belt scrolls; the tricks' marks stand at its end, after Collie's own keys. Show the end.
  useEffect(() => {
    const ids = [500, 1500].map((ms) =>
      window.setTimeout(() => {
        for (const strip of box.current?.querySelectorAll<HTMLElement>("div.overflow-x-auto") ?? []) strip.scrollLeft = strip.scrollWidth;
      }, ms),
    );
    return () => {
      for (const id of ids) window.clearTimeout(id);
    };
  }, []);
  return (
    <div ref={box} className="flex h-full flex-col">
      <PaneRoot />
    </div>
  );
}

/** The Morph view of a session: one screen its agent drew, under Collie's band. */
export function AgentViewScene() {
  return (
    <div className="flex h-full flex-col">
      <MorphScreen />
    </div>
  );
}

export type SceneId = "dashboard" | "page" | "session" | "agent-view" | "hill";

export function Scene({ id }: { id: SceneId }) {
  switch (id) {
    case "dashboard":
      return <DashboardScene />;
    case "page":
      return <PageScene />;
    case "session":
      return <SessionScene />;
    case "agent-view":
      return <AgentViewScene />;
    case "hill":
      return <HillScene />;
  }
}
