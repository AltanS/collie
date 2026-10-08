// The router harnesses the playground needs to mount REAL components in a
// state the page cannot otherwise reach. DEV-ONLY (see `playground.html`).
//
// Copy is plain English and does not go through `t()`. That is the one deliberate departure from the
// repo rule, and it is bounded: none of this text ships — the file is unreachable from the app entry
// and absent from `dist`. The components it mounts do their own translating, so switching the app's
// locale still repaints every state below.

import { createContext, useContext, useState, type ReactNode } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { AgentChat } from "@/components/agent-chat";
import { AppHeaderHost } from "@/components/app-header";
import { ConnectionBanner } from "@/components/connection-banner";
import { CrewProvider } from "@/components/crew-provider";
import { StripHost } from "@/components/ui/strip-host";
import { UpdateRibbon } from "@/components/update-ribbon";
import type { MachineHistoryState } from "@/hooks/use-machine-history";
import { __resetConnectionHealth } from "@/lib/connection-health";
import { saveDraft } from "@/lib/drafts";
import {
  PANE_ROUTE_ID,
  ROOT_ROUTE_ID,
  type DevicesData,
  type HistoryData,
  type HomeData,
  type CrewData,
  type MachinesData,
  type PaneData,
} from "@/lib/loaders";
import { internScope, scopeFromUrl, scopeKey } from "@/lib/scope";
import type { DeviceAuth } from "@/lib/types";
import { CrewRoute } from "@/routes/crew";
import { DetailRoute } from "@/routes/detail";
import { HistoryRoute } from "@/routes/history";
import { HomeRoute } from "@/routes/home";
import { MachineRoute } from "@/routes/machine";
import { MachinesRoute } from "@/routes/machines";
import { BootSplash, RootError, RootLayout } from "@/routes/root";
import { SettingsRoute } from "@/routes/settings";
import { SpaceRoute } from "@/routes/space";
import { UpdatesRoute } from "@/routes/updates";
import type { PaneFixture } from "./fixtures";

// The light half (layout, the tab and sub-page routes, the connection clock) lives in ./layout.tsx so
// the page chrome and a section with no router never load the app's routes. Re-exported here for
// the importers that predate the split (the website's app screens import the routers from here).
export * from "./layout";

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
 * to no height, and a header inside it reserves the safe-area inset itself, as it always does.
 *
 * IN FLOW, NOT AN OVERLAY (`flow`). The app hangs the band over the top of the route since
 * 2026-10-07, but most cards here mount a strip and nothing else, so there is no route for it to
 * cover: an overlay on a zero-height anchor would hang outside the Stage's clipped box and the card
 * would show nothing. So this router paints the band as a plain row ABOVE the card's content, a
 * header included, which is not the app's composition. {@link PaneStackRouter} and
 * {@link createFullAppRouter} carry the app's composition, overlay and all.
 */
export function RootRouter({ data, children }: { data: HomeData; children: ReactNode }) {
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => data,
          element: <StripHost flow>{children}</StripHost>,
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
 * The Machines list, or one machine's page, on a memory router whose loader hands the census in: the
 * same `MachinesData` shape `machinesLoader` returns, so the page renders its real cards. `start` is
 * `/machines` or `/machines/<id>`.
 *
 * `history` is the detail page's one escape from the network: a page that stubs nothing cannot fetch a
 * day of points, so the card hands the answer in and the live read is switched off (`MachineRoute`'s
 * `history` prop says why it exists). The alert card still posts for real, and with no bridge behind
 * the page that shows its "could not save" line, which is a state worth seeing.
 */
export function MachinesRouter({
  home,
  machines,
  start,
  history,
}: {
  home: HomeData;
  machines: MachinesData;
  start: string;
  history?: MachineHistoryState;
}) {
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => home,
          element: (
            <CrewProvider servers={home.servers} sessions={home.sessions} ts={home.ts} pollMs={3_000}>
              <AppHeaderHost bridge={home.bridge} error={false}>
                <Outlet />
              </AppHeaderHost>
            </CrewProvider>
          ),
          children: [
            { index: true, element: <div className="p-4 text-sm text-muted-foreground">home</div> },
            { path: "machines", loader: () => machines, element: <MachinesRoute /> },
            { path: "machines/:id", loader: () => machines, element: <MachineRoute history={history} /> },
          ],
        },
      ],
      { initialEntries: [start] },
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
 * {@link PaneRouter}'s pane, PLUS the band RootLayout hangs under the header, the real `<StripHost>`
 * with the real `<UpdateRibbon/>` and `<ConnectionBanner/>` registering into it, so the worst-case
 * stack (gap 4) can be judged as one screen instead of summed from cards measured apart. Same real
 * components, same nesting as `routes/root.tsx`: the header host wraps the band host, which wraps the
 * two features AND the pane, so the bar comes first, the band's zero-height anchor second and the
 * pane last. The band is the app's OVERLAY here (no `flow`): it covers the top of the pane, the tab
 * and pane strips, and the pane below it starts at the same pixel with or without a strip.
 *
 * BOTH FEATURES ARE MOUNTED AND ONE OF THEM SHOWS. That is not the harness being lazy: it is the
 * app's rule made visible. The band takes one strip at a time, and `AUTH` (the refusal below) beats
 * `UPDATE` (the offer). The worst case at the top of this app is the header plus ONE strip floating
 * over the pane's first rows, never two strips, and never a pane pushed down.
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
                <AppHeaderHost bridge={data.bridge} error={false}>
                  <StripHost>
                    <UpdateRibbon />
                    <ConnectionBanner bridge={undefined} error authError />
                    <StackPane data={data} fixture={fixture} />
                  </StripHost>
                </AppHeaderHost>
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
// WHAT IS REAL: the shell (`AppHeaderHost` → `StripHost` → `UpdateRibbon` + `ConnectionBanner` +
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

