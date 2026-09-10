// Layout primitives and the router harnesses the playground needs to mount REAL components in a
// state the page cannot otherwise reach. DEV-ONLY (see `playground.html`).
//
// Copy is plain English and does not go through `t()`. That is the one deliberate departure from the
// repo rule, and it is bounded: none of this text ships — the file is unreachable from the app entry
// and absent from `dist`. The components it mounts do their own translating, so switching the app's
// locale still repaints every state below.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { AgentChat } from "@/components/agent-chat";
import { AppHeaderHost } from "@/components/app-header";
import { ConnectionBanner } from "@/components/connection-banner";
import { CrewProvider } from "@/components/crew-provider";
import { StripHost } from "@/components/ui/strip-host";
import { UpdateRibbon } from "@/components/update-ribbon";
import { CONNECTION_LOST_MS, TROUBLE_MS } from "@/hooks/use-connection-lost";
import { __resetConnectionHealth, markLive } from "@/lib/connection-health";
import { saveDraft } from "@/lib/drafts";
import {
  PANE_ROUTE_ID,
  ROOT_ROUTE_ID,
  type DevicesData,
  type HistoryData,
  type HomeData,
  type CrewData,
  type PaneData,
} from "@/lib/loaders";
import { internScope, scopeFromUrl, scopeKey } from "@/lib/scope";
import type { DeviceAuth } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CrewRoute } from "@/routes/crew";
import { DetailRoute } from "@/routes/detail";
import { HistoryRoute } from "@/routes/history";
import { HomeRoute } from "@/routes/home";
import { BootSplash, RootError, RootLayout } from "@/routes/root";
import { SettingsRoute } from "@/routes/settings";
import { SpaceRoute } from "@/routes/space";
import { UpdatesRoute } from "@/routes/updates";
import type { PaneFixture } from "./fixtures";

// ── The shared connection clock ──────────────────────────────────────────────
//
// `lib/connection-health.ts` is ONE module-scoped clock on purpose: the banner, the header dog and
// the boot splash all derive from it so they can never disagree. That is also why this page cannot
// show "troubled" and "lost" side by side — there is a single anchor, and two different answers to
// "how long since the last live poll" cannot both be true at once. Forking the components to take
// the state as a prop would break the very property the clock exists to guarantee.
//
// So the playground drives the real store instead, with the real exported mutators, and every
// clock-fed state on the page moves together. Flipping the control in the top bar is exactly what a
// real outage does — which makes "do the bar and the dog agree?" the easy thing to check.
//
// THE CONTROL IS GLOBAL, NOT SECTION-LOCAL, and that follows from the same fact: there is one store,
// so a control parked inside "Boot & connection" would silently be repainting the header dog on the
// Dashboard tab too, even while that tab is not mounted. A top-bar control tells the truth about its
// own reach — and since only the selected tab mounts, "Boot & connection" and "Dashboard" are never
// both on screen to compare directly; the shared clock is what keeps them honest anyway.

export type ClockMode = "live" | "trouble" | "lost";

export const CLOCK_OPTIONS = [
  { value: "live", label: "Live" },
  { value: "trouble", label: "Trouble" },
  { value: "lost", label: "Lost" },
] as const satisfies readonly { value: ClockMode; label: string }[];

/**
 * Hold the shared health anchor at the chosen age. Re-stamped every second so "trouble" cannot drift
 * on into "lost" while you look at it, and so a real `/api/config` probe or a visibility change
 * cannot quietly recover the page underneath you.
 */
export function useConnectionClock(mode: ClockMode): void {
  useEffect(() => {
    // Every mode re-stamps, including "live". Nothing polls on this page, so a single markLive()
    // would age past 15s while you were reading and quietly escalate the whole page — the healthy
    // state has to be held open exactly as deliberately as the broken ones.
    const behind =
      mode === "live" ? 0 : mode === "trouble" ? TROUBLE_MS + 750 : CONNECTION_LOST_MS + 1_000;
    const stamp = () => (behind === 0 ? markLive() : __resetConnectionHealth(Date.now() - behind));
    stamp();
    const id = window.setInterval(stamp, 1_000);
    return () => window.clearInterval(id);
  }, [mode]);
}

// ── Router harnesses ─────────────────────────────────────────────────────────

/**
 * A data router carrying the root snapshot under the real `ROOT_ROUTE_ID`, which is what
 * `useOptionalRootData()` reads — the update chip, the header's freshness stamp and the crew census
 * all need it. Built once (`useState`'s lazy initialiser) so the route element is stable; the
 * components inside subscribe to their own module stores and re-render without it.
 *
 * IT CARRIES THE BAND, exactly as `routes/root.tsx` does. `UpdateRibbon` and `ConnectionBanner`
 * render nothing where they sit — they register a `StripSlot` with `ui/strip-host.tsx` and the band
 * paints the winner — so a card that mounts one of them without a host would show an empty stage and
 * report a bug that is not there. It costs the cards that mount no strip nothing: the band collapses
 * to no height, and a header inside it goes on reserving the safe-area inset itself.
 */
export function RootRouter({ data, children }: { data: HomeData; children: ReactNode }) {
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => data,
          element: <StripHost>{children}</StripHost>,
        },
      ],
      { initialEntries: ["/"] },
    ),
  );
  return <RouterProvider router={router} />;
}

/**
 * The same root, plus the `CrewProvider` the host-aware surfaces read. Tier-2 health is derived
 * there, against the LEAD's clock (`home.ts`) — never the phone's — so anything mounted inside gets
 * the same host health the real app would have derived for the same snapshot.
 */
export function PackedRootRouter({ data, children }: { data: HomeData; children: ReactNode }) {
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => data,
          element: (
            <CrewProvider
              servers={data.servers}
              sessions={data.sessions}
              ts={data.ts}
              pollMs={3_000}
            >
              {children}
            </CrewProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    ),
  );
  return <RouterProvider router={router} />;
}

/**
 * The crew census on its own router, assembled the way `routes/crew.test.tsx` assembles it: the root
 * route publishes the snapshot AND the `CrewProvider`, and `/crew` carries the census. A `crew` of
 * `{ status: null }` is the solo/empty card — the real 404 answer, not a stub.
 */
export function CrewRouter({ home, crew }: { home: HomeData; crew: CrewData }) {
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => home,
          element: (
            <CrewProvider
              servers={home.servers}
              sessions={home.sessions}
              ts={home.ts}
              pollMs={3_000}
            >
              <AppHeaderHost bridge={home.bridge} error={false}>
                <Outlet />
              </AppHeaderHost>
            </CrewProvider>
          ),
          children: [
            { index: true, element: <div className="p-4 text-sm text-muted-foreground">home</div> },
            { path: "crew", loader: () => crew, element: <CrewRoute /> },
          ],
        },
      ],
      { initialEntries: ["/crew"] },
    ),
  );
  return <RouterProvider router={router} />;
}

/**
 * Settings on a memory router, with its OWN loader supplying the paired-device registry — the same
 * `DevicesData` shape `devicesLoader` returns, so the Paired devices card renders its real list
 * rather than its empty fallback.
 *
 * Two things on this page still reach the network, and both are meant to: `fetchConfig()` fills the
 * diagnostics panel's server build, and the push control asks the browser about its own
 * subscription. Both fail soft — the page renders whole either way, and against a dev proxy pointed
 * at a live bridge they answer for real.
 */
export function SettingsRouter({
  home,
  devices,
  start = "/settings",
}: {
  home: HomeData;
  devices: DevicesData;
  /** Which of the two routes to open on. `/settings/updates` is the Updates page, a child of
   *  Settings, so the same router serves both and "back" works between them. */
  start?: "/settings" | "/settings/updates";
}) {
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => home,
          element: (
            <CrewProvider
              servers={home.servers}
              sessions={home.sessions}
              ts={home.ts}
              pollMs={3_000}
            >
              <AppHeaderHost bridge={home.bridge} error={false}>
                <Outlet />
              </AppHeaderHost>
            </CrewProvider>
          ),
          children: [
            { index: true, element: <div className="p-4 text-sm text-muted-foreground">home</div> },
            { path: "settings", loader: () => devices, element: <SettingsRoute /> },
            { path: "settings/updates", element: <UpdatesRoute /> },
          ],
        },
      ],
      { initialEntries: [start] },
    ),
  );
  return <RouterProvider router={router} />;
}

/**
 * The WHOLE pane view — header breadcrumb, StatusBadge, mirror and composer — on a memory router.
 *
 * It is mountable in full, and that is worth stating plainly because it is the one thing on this
 * page that looks like it should need a live bridge and does not: `AgentChat` takes the pane's text
 * as a PROP. The polling that keeps that prop fresh lives in the root layout, not here, so handing
 * it a captured screen out of `fixtures/panes/` gives the real component the real bytes with no
 * fetch anywhere. Nothing is stubbed and no half-component is mounted.
 *
 * What is NOT live: every WRITE. Tapping a dialog option, sending a reply or pressing a key posts to
 * `/api/pane/…`, which on this page is whatever the dev proxy answers — usually nothing. The screen
 * therefore never advances in response to a tap. Read it as a photograph you can inspect, not as a
 * terminal you can drive.
 */
export function PaneRouter({
  home,
  fixture,
  readOnly = false,
  draft,
}: {
  home: HomeData;
  fixture: PaneFixture;
  /** Mount with the write gate refusing, which is what locks the composer and raises its banner. */
  readOnly?: boolean;
  /**
   * Seed the pane's composer draft, so a card can be looked at with text already in the box.
   *
   * Written into the real draft store rather than pushed in as a prop, because the composer has no
   * such prop and must not grow one for this page: it restores its own draft on mount
   * (`lib/drafts.ts`), so writing the store IS how a draft arrives in the app. This runs in the
   * `useState` initialiser above the composer's own, which is the ordering that makes it land.
   */
  draft?: string;
}) {
  const [router] = useState(() => {
    // Undefined scope: this harness hands `AgentChat` no `scope`, so the composer below reads the
    // solo key, and that is the key this must write.
    if (draft !== undefined) saveDraft(undefined, fixture.pane.paneId, draft);
    const data: HomeData = readOnly
      ? { ...home, device: { enforced: true, device: "kitchen-phone", authorized: false } }
      : home;
    return createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => data,
          element: (
            <CrewProvider
              servers={data.servers}
              sessions={data.sessions}
              ts={data.ts}
              pollMs={3_000}
            >
              <AppHeaderHost bridge={data.bridge} error={false}>
                <AgentChat
                  paneId={fixture.pane.paneId}
                  agent={fixture.pane}
                  agents={data.agents}
                  shellPanes={data.shellPanes}
                  tabs={data.tabs}
                  tabLabel={fixture.pane.tabLabel}
                  text={fixture.text}
                  requestedLines={400}
                  revision={fixture.revision}
                  device={data.device}
                  bridge={data.bridge}
                  error={false}
                  onBack={() => {}}
                  onSelect={() => {}}
                />
              </AppHeaderHost>
            </CrewProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );
  });
  return <RouterProvider router={router} />;
}

/**
 * The stack card's device gate, carried past the router rather than through it.
 *
 * `createMemoryRouter` is built once inside `useState`, so its loader data — including `device` — is
 * frozen at first render, and a control that flips the prop afterwards changes nothing. That was
 * fine while every notice on this card was static. It is not fine now: the ReadOnlyBanner's whole
 * point after the `ui/notice.tsx` conversion is the TRANSITION, which cannot be looked at in a tree
 * that can only be built already-refused. Context reaches the route element the ordinary React way,
 * because `RouterProvider` renders it as a descendant.
 */
const StackDeviceContext = createContext<DeviceAuth | null>(null);

/**
 * {@link PaneRouter}'s pane, PLUS the band RootLayout mounts above it — the real `<StripHost>` with
 * the real `<UpdateRibbon/>` and `<ConnectionBanner/>` registering into it — so the worst-case stack
 * (gap 4) can be judged as one screen instead of summed from cards measured apart. Same real
 * components, same nesting as `routes/root.tsx`: the host wraps the two features AND the header, so
 * the band arbitrates and the header knows whether it still owes the safe-area inset.
 *
 * BOTH FEATURES ARE MOUNTED AND ONE OF THEM SHOWS. That is not the harness being lazy — it is the
 * app's rule made visible: the band takes one strip at a time, and `AUTH` (the refusal below) beats
 * `UPDATE` (the offer). What this card is for is the height of the real worst case, which is one
 * strip plus the header, and never two strips plus the header.
 *
 * The red `ConnectionBanner` here is deliberately the AUTH-ERROR branch (`bridge=undefined,
 * authError`), not the trouble→lost escalation — that branch paints red off its props alone, with no
 * dependency on the shared connection-health clock. The escalation branch cannot be driven reliably
 * from a control on this page: `useConnectionClock`'s ticker mutates the shared store every second but
 * never calls the store's own `emit()` (a real gap in `lib/connection-health.ts` — see this file's
 * module comment above and the playground task notes), so a mounted card only repaints when a
 * consumer's OWN once-per-mount timer fires, ~4s/~15s after THAT card mounted, not after a control
 * flip. The auth-error branch sidesteps the bug entirely and is a genuine red `ConnectionBanner`
 * state in its own right (see the "refused (401/403)" card in Boot & connection).
 */
export function PaneStackRouter({
  home,
  fixture,
  device,
}: {
  home: HomeData;
  fixture: PaneFixture;
  /** The OTHER composer lock — the device gate, independent of the crew host gate the pane derives
   *  from `home.servers`. Both are driven at once so the stack shows every lock at the same time. */
  device: DeviceAuth;
}) {
  const [router] = useState(() => {
    const data: HomeData = { ...home, device };
    return createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => data,
          element: (
            <CrewProvider
              servers={data.servers}
              sessions={data.sessions}
              ts={data.ts}
              pollMs={3_000}
            >
              <div className="flex h-full flex-col">
                <StripHost>
                  <UpdateRibbon />
                  <ConnectionBanner bridge={undefined} error authError />
                  <AppHeaderHost bridge={data.bridge} error={false}>
                    <StackPane data={data} fixture={fixture} />
                  </AppHeaderHost>
                </StripHost>
              </div>
            </CrewProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );
  });
  return (
    <StackDeviceContext.Provider value={device}>
      <RouterProvider router={router} />
    </StackDeviceContext.Provider>
  );
}

/** The stack card's pane, reading the live gate off the context above rather than frozen loader data. */
function StackPane({ data, fixture }: { data: HomeData; fixture: PaneFixture }) {
  const device = useContext(StackDeviceContext) ?? data.device;
  return (
    <AgentChat
      paneId={fixture.pane.paneId}
      agent={fixture.pane}
      agents={data.agents}
      shellPanes={data.shellPanes}
      tabs={data.tabs}
      tabLabel={fixture.pane.tabLabel}
      text={fixture.text}
      requestedLines={400}
      revision={fixture.revision}
      device={device}
      bridge={data.bridge}
      error={false}
      onBack={() => {}}
      onSelect={() => {}}
    />
  );
}

// ── The whole app, on one memory router ──────────────────────────────────────
//
// Every harness above mounts ONE screen. This one mounts the app: the real `RootLayout` with the
// real route table under it, so a move between two screens runs everything a move runs in the app —
// the loaders, the route components, the header portals, the poll loop, the transition. It exists
// because a card built out of placeholder screens moves more smoothly than the app does, which made
// it useless for the one question a motion card is asked: does this stutter?
//
// WHAT IS REAL: the shell (`StripHost` → `UpdateRibbon` + `ConnectionBanner` → `AppHeaderHost` →
// `ScreenTransition` → `Outlet`), every route component, the route ids the app reads its data by,
// the loader RESULT SHAPES, and the `shouldRevalidate: false` history opts out with.
//
// WHAT IS NOT: the loaders themselves. They return fixtures rather than fetching, because the
// playground has no bridge behind it. The route table is otherwise the same shape as `router.tsx`,
// minus the `/pack` redirect, which is a rewrite rather than a screen and has nothing to show.

/** The fixtures {@link createFullAppRouter} hands each stubbed loader, in loader order. */
export interface FullAppFixtures {
  /** The root snapshot, as `rootLoader` returns it. */
  home: HomeData;
  /**
   * The mirror for the pane a `/pane/:paneId` address names. A FUNCTION, not one fixture with the
   * id swapped: every pane in the snapshot is openable, so every pane needs a screen, and a pane
   * view built out of another pane's id is the thing that made the walk bounce home.
   */
  screenFor: (paneId: string) => { text: string; revision: number };
  /** The census `/crew` renders. */
  crew: CrewData;
  /** The paired-device registry `/settings` renders. */
  devices: DevicesData;
  /** The transcript `/pane/:paneId/history` renders. */
  history: HistoryData;
}

/** The router {@link FullAppRouter} drives — built by the caller so a card can also navigate it. */
export type FullAppRouterInstance = ReturnType<typeof createMemoryRouter>;

/**
 * Build the app's own route table over fixture loaders. Call it once (a `useState` initialiser), so
 * the router keeps its location and history across the card's re-renders, exactly as the app's
 * module-scoped router does.
 */
export function createFullAppRouter(fixtures: FullAppFixtures): FullAppRouterInstance {
  const { home, screenFor, crew, devices, history } = fixtures;

  // THE SCOPE FOLLOWS THE URL, exactly as `rootLoader` makes it. A host or session switch is a
  // navigation to `/?h=…` / `/?s=…` and nothing else: everything downstream reads the machine and
  // the session off the SNAPSHOT's `scope`, so a stub that pinned `scope` to the fixture's own value
  // left the whole app addressing the lead while the URL said otherwise. The visible cost was a pane
  // on another machine failing its snapshot lookup and bouncing the operator to the dashboard.
  //
  // Memoised per scope, because the poll loop re-runs this loader every cadence tick and a fresh
  // object each time would re-render the whole tree on every poll.
  const homeByScope = new Map<string, HomeData>();
  const homeFor = (request: Request): HomeData => {
    const scope = internScope(scopeFromUrl(request.url));
    const key = scopeKey(scope);
    const cached = homeByScope.get(key);
    if (cached) return cached;
    const data: HomeData = { ...home, scope };
    homeByScope.set(key, data);
    return data;
  };

  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: ({ request }: { request: Request }) => homeFor(request),
        element: <RootLayout />,
        errorElement: <RootError />,
        HydrateFallback: BootSplash,
        children: [
          { index: true, element: <HomeRoute /> },
          { path: "space/:spaceId", element: <SpaceRoute /> },
          { path: "settings", loader: () => devices, element: <SettingsRoute /> },
          { path: "settings/updates", element: <UpdatesRoute /> },
          { path: "crew", loader: () => crew, element: <CrewRoute /> },
          {
            id: PANE_ROUTE_ID,
            path: "pane/:paneId",
            // Both halves of the address come off the URL — the pane id from the path, the machine
            // and session from the query — so `DetailRoute` looks the pane up in the snapshot the
            // same way the app does, and a pane opened on any machine in the roster is found.
            loader: ({
              params,
              request,
            }: {
              params: { paneId?: string };
              request: Request;
            }): PaneData => {
              const paneId = params.paneId ?? "";
              const screen = screenFor(paneId);
              return {
                paneId,
                scope: internScope(scopeFromUrl(request.url)),
                text: screen.text,
                truncated: false,
                requestedLines: 600,
                revision: screen.revision,
                error: false,
                authError: false,
              };
            },
            element: <DetailRoute />,
          },
          {
            path: "pane/:paneId/history",
            loader: ({
              params,
              request,
            }: {
              params: { paneId?: string };
              request: Request;
            }): HistoryData => ({
              ...history,
              paneId: params.paneId ?? history.paneId,
              scope: internScope(scopeFromUrl(request.url)),
            }),
            element: <HistoryRoute />,
            shouldRevalidate: () => false,
          },
        ],
      },
    ],
    { initialEntries: ["/"] },
  );
}

/** Mount a router from {@link createFullAppRouter}. */
export function FullAppRouter({ router }: { router: FullAppRouterInstance }) {
  return <RouterProvider router={router} />;
}

// ── Layout ───────────────────────────────────────────────────────────────────

/** One top-level section of the page, as both the nav and the body know it. */
export interface SectionDef {
  readonly id: string;
  readonly title: string;
  /** One line: what this section is for. Printed under the heading. */
  readonly intent: string;
}

export function Section({ def, children }: { def: SectionDef; children: ReactNode }) {
  return (
    <section id={def.id} className="scroll-mt-4">
      <h2 className="text-base font-semibold tracking-tight">{def.title}</h2>
      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{def.intent}</p>
      <div className="mt-4 space-y-8">{children}</div>
    </section>
  );
}

/**
 * One named group of cards within a section, replacing the single page-wide grid a section used to
 * render on its own. A section's body is a `space-y-8` column of these, ordered from the everyday
 * state to the rare one, so a tab with a dozen cards can be skimmed by its group titles instead of
 * scrolled blind. `.pg-grid` still wraps exactly the cards inside one group, so every card stays a
 * direct child of a `.pg-grid` — the selector `app.test.tsx` and `handles.spec.ts` both scope their
 * handle collection to.
 */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="pg-grid mt-2">{children}</div>
    </div>
  );
}

/**
 * One labelled state. `reach` is the line that keeps this page honest — it says how an operator
 * arrives at this state on a real collie, so a card is never just a pretty picture of a component.
 */
export function Card({
  state,
  label,
  reach,
  note,
  span = 1,
  children,
}: {
  /**
   * The card's stable handle, rendered as `data-state`. Flat kebab-case, naming what the card
   * SHOWS and not where it sits: `update-band-in-flight`, `host-stale-unreachable`. It is required
   * so the compiler finds a card without one, and `app.test.tsx` refuses a repeat. A browser case
   * addresses `[data-state="…"]` and reads roles and text inside it — the label is prose that gets
   * reworded, so it is not a key (two of them are identical already).
   */
  state: string;
  label: string;
  /** How you reach this state for real. Rendered after "reach it for real:". */
  reach: string;
  /** An honesty note — what is approximated here, or which control drives it. */
  note?: string;
  /** Two columns for anything route-sized. Collapses to one under the phone-width toggle. */
  span?: 1 | 2;
  children: ReactNode;
}) {
  return (
    <div data-state={state} className={cn("min-w-0", span === 2 && "pg-span-2")}>
      <p className="font-mono text-[11px] uppercase tracking-wide text-foreground">{label}</p>
      <p className="mb-2 mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
        <span className="text-status-idle">reach it for real:</span> {reach}
      </p>
      {note !== undefined && (
        <p className="mb-2 text-[11px] leading-relaxed text-status-working">{note}</p>
      )}
      {children}
    </div>
  );
}

/**
 * The box a component paints inside. `transform` on it makes it the containing block for any
 * `position: fixed` descendant, so the idle cover renders at its true size in a card rather than
 * over the whole page; `dvh` pulls a `h-[100dvh]` root down to the box (see playground.css).
 */
export function Stage({
  height,
  dvh = false,
  children,
}: {
  height?: number;
  dvh?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative isolate overflow-hidden rounded-xl border border-border bg-background",
        dvh && "pg-stage-dvh",
      )}
      style={{ height, transform: "translate(0)" }}
    >
      {children}
    </div>
  );
}

/**
 * A phone-shaped frame for a route-level mount: 390px of viewport (an iPhone 14's CSS width), a
 * fixed height, and its own internal scroll. Route components are written for a screen, not for a
 * card — given a card's width they read as a widget, and given the page's height they merge into the
 * page. The frame gives them back both, and its scrollbar is the component's own, not the page's.
 *
 * Same `transform` trick as `Stage`: a `position: fixed` header or sheet inside resolves against the
 * frame instead of escaping to the viewport.
 */
export function PhoneFrame({ height = 720, children }: { height?: number; children: ReactNode }) {
  return (
    <div
      className="relative isolate w-[390px] max-w-full overflow-hidden rounded-[1.75rem] border-[6px] border-zinc-800 bg-background shadow-xl dark:border-zinc-700"
      style={{ height, transform: "translate(0)" }}
    >
      <div className="pg-phone-scroll flex h-full flex-col overflow-y-auto">{children}</div>
    </div>
  );
}

/**
 * A segmented control. Plain buttons — the playground borrows no app chrome it isn't showing.
 *
 * `name` is what a browser case asks for when a card shows two states through this control rather
 * than through two cards: it makes the group itself addressable by an accessible name
 * (`getByRole("group", { name })`), so a case can pick the option it wants without matching the
 * card's prose label. Only the controls that switch a card's state need one.
 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name?: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div
      role={name === undefined ? undefined : "group"}
      aria-label={name}
      className="inline-flex overflow-hidden rounded-lg border border-border"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
          className={cn(
            "px-2 py-1 text-[11px] font-medium transition-colors",
            option.value === value
              ? "bg-foreground text-background"
              : "bg-transparent text-muted-foreground hover:bg-muted",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** What {@link useSelectedSection} returns. */
export interface SelectedSection {
  /** The id of the section currently on screen. */
  activeId: string;
  /** Select a section by id. Writes `localStorage` and the URL hash (via `replaceState`, so a tab
   *  click never grows browser history) unless a `forced` id was given to the hook. */
  selectTab: (id: string) => void;
  /** The card handle carried on the hash at the moment it was last read (`#pane/<handle>`), or
   *  `null`. Consumed by the page to scroll that card into view after the section mounts. */
  cardHandle: string | null;
}

const TAB_STORAGE_KEY = "collie.playground.tab";

function parseHash(hash: string) {
  const raw = hash.replace(/^#/, "");
  const [id = "", card = null] = raw.split("/", 2);
  return { id, card: card || null };
}

/**
 * Which tab is selected, and the one card the hash asked to be scrolled to.
 *
 * The selected tab lives in the URL hash: `#pane` selects the Pane tab, `#pane/<card-handle>`
 * selects it AND names a card to scroll into view once it mounts. Changing tabs through the UI
 * writes the hash with `history.replaceState` — a tab click is not a navigation, so it must not grow
 * browser history — and back/forward and hand-edited hashes are honoured via `hashchange`. With no
 * hash, the last remembered tab (`localStorage["collie.playground.tab"]`) is used; with neither, or
 * an id naming no section, the first section is used.
 *
 * `forced` is {@link PlaygroundApp}'s `tab` prop: when given, the hash and `localStorage` are never
 * read or written, so a test can pin a section without touching global state another test relies on.
 *
 * The playground has no server render, so `window` is read directly rather than probed — it is
 * always present, in the browser and under jsdom alike.
 */
export function useSelectedSection(sections: readonly SectionDef[], forced?: string): SelectedSection {
  const idSet = new Set(sections.map((s) => s.id));
  const firstId = sections[0]?.id ?? "";
  const resolve = (id: string): string => (idSet.has(id) ? id : firstId);

  // Read on every render rather than captured once, so the closures below (the `hashchange`
  // listener, `selectTab`) always resolve against the CURRENT section list without needing it as an
  // effect dependency — which would reattach the listener on every render, since `sections` is a
  // fresh array each time (`PlaygroundApp` builds it from `SECTIONS.map(...)`).
  const liveRef = useRef({ idSet, firstId, resolve });
  liveRef.current = { idSet, firstId, resolve };

  const [state, setState] = useState<{ id: string; card: string | null }>(() => {
    if (forced !== undefined) return { id: resolve(forced), card: null };
    const fromHash = parseHash(window.location.hash);
    if (fromHash.id && idSet.has(fromHash.id)) return fromHash;
    const stored = window.localStorage.getItem(TAB_STORAGE_KEY);
    return { id: resolve(stored ?? firstId), card: null };
  });

  useEffect(() => {
    if (forced !== undefined) return;
    const onHashChange = () => {
      const live = liveRef.current;
      const fromHash = parseHash(window.location.hash);
      const resolved = live.resolve(fromHash.id || live.firstId);
      setState({ id: resolved, card: fromHash.card });
      // A tab reached by editing the hash or by back/forward is a real visit to that tab, exactly
      // like a click — it should be the one `useSelectedSection` opens on next time too.
      window.localStorage.setItem(TAB_STORAGE_KEY, resolved);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [forced]);

  const selectTab = (id: string): void => {
    const resolved = resolve(id);
    setState({ id: resolved, card: null });
    if (forced === undefined) {
      window.localStorage.setItem(TAB_STORAGE_KEY, resolved);
      window.history.replaceState(null, "", `#${resolved}`);
    }
  };

  return { activeId: state.id, selectTab, cardHandle: state.card };
}
