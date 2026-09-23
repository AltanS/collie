import { createBrowserRouter, replace } from "react-router";

import { basePath } from "@/lib/base-path";
import { listenForInAppOpen, markBooted, openPendingTarget, probeStandalone, seedColdEntry, type OpenGate } from "@/lib/nav-entry";
import { isReloadInFlight } from "@/lib/pwa";
import { UPDATE_MODE_HOLD, isReloadHeldBy, subscribeReloadHeld } from "@/lib/reload-guard";

import { BootSplash, RootError, RootLayout } from "@/routes/root";
import { HomeRoute } from "@/routes/home";
import { SpaceRoute } from "@/routes/space";
import { DetailRoute } from "@/routes/detail";
import { HistoryRoute } from "@/routes/history";
import { ChangesRoute } from "@/routes/changes";
import { SettingsRoute } from "@/routes/settings";
import { CrewRoute } from "@/routes/crew";
import { UpdatesRoute } from "@/routes/updates";
import {
  devicesLoader,
  historyLoader,
  crewLoader,
  rootLoader,
  paneLoader,
  PANE_ROUTE_ID,
  ROOT_ROUTE_ID,
} from "@/lib/loaders";

// We don't use React Router's view transitions (the glides start their own, by hand, and never
// touch this map: lib/glide.ts). React Router persists an "applied view transitions" map to
// sessionStorage ("remix-router-transitions") and replays a phantom same-location transition on every
// revalidation for any path it once saw a `viewTransition: true` navigation from. A device that ran an
// older Collie build (which did use them) can carry a stale entry that fires
// document.startViewTransition on every poll. Clear it on boot — our code never repopulates it. The
// `:root { view-transition-name: none }` in index.css is the belt to this: even a stray transition
// then captures nothing, so there's no visible flicker regardless of this key's name.
try {
  sessionStorage.removeItem("remix-router-transitions");
} catch {
  // sessionStorage access can throw in locked-down / private contexts — ignore.
}

// A cold deep link gets its parents put behind it BEFORE the router reads the entry it boots on, so
// the phone's first edge swipe goes up one level instead of doing nothing (ADR 0067, lib/nav-entry).
seedColdEntry({
  location: window.location,
  history: window.history,
  sessionStorage: safeSessionStorage(),
  standalone: probeStandalone,
});

function safeSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

// Created once at module scope so the idle-lock in App can unmount/remount RouterProvider without
// losing the current location (the router instance retains it; loaders re-run fresh on remount).
export const router = createBrowserRouter([
  {
    id: ROOT_ROUTE_ID,
    path: "/",
    loader: rootLoader,
    element: <RootLayout />,
    // Catches render-phase errors and loader throws (e.g. a missing :paneId) so a component bug
    // shows a recoverable screen instead of React Router's blank default.
    errorElement: <RootError />,
    HydrateFallback: BootSplash,
    children: [
      { index: true, element: <HomeRoute /> },
      { path: "space/:spaceId", element: <SpaceRoute /> },
      // Settings carries the paired-device registry, so it gets its own loader — a revoke or a pair
      // is then the app's standard mutation shape (api call → revalidate), with no second data path.
      { path: "settings", loader: devicesLoader, element: <SettingsRoute /> },
      // The Updates page, a sibling of settings and crew. No loader of its own: everything on it is
      // either the snapshot (root loader) or the card's own read of /api/update/check. It is
      // deliberately ON the poll loop for `crew`'s stated reason — a run in progress and a member
      // going quiet are exactly what this page exists to show without a reload.
      { path: "settings/updates", element: <UpdatesRoute /> },
      // The crew census, likewise on its own loader — and deliberately ON the poll loop: the payload
      // is one small object per machine, and the whole point of the page is that a member going
      // quiet shows up here without the operator reloading. (History opts out; this one wants in.)
      { path: "crew", loader: crewLoader, element: <CrewRoute /> },
      // The path was `crew` until 1.7.0 (M24 renamed the word a person reads). The service worker
      // caches the app shell, so a client sitting on /crew when the new bundle arrives, a bookmark
      // and an installed PWA's start URL all still ask for the old spelling. `replace` rather than
      // a push, so Back does not bounce the operator between the two names. The query string rides
      // along, because the scope (`?h=`) is what makes "back" return to the right machine.
      {
        path: "pack",
        loader: ({ request }) => replace(`/crew${new URL(request.url).search}`),
      },
      // Named, so RootLayout can ask for THIS route's data by id (react-router hands back undefined
      // whenever it isn't the active route) — see the "last seen" note there.
      { id: PANE_ROUTE_ID, path: "pane/:paneId", loader: paneLoader, element: <DetailRoute /> },
      {
        path: "pane/:paneId/history",
        loader: historyLoader,
        element: <HistoryRoute />,
        // Opt OUT of the poll loop. revalidate() re-runs every active loader, and a transcript can be
        // hundreds of turns — re-pulling it every 1.5s would be pure waste, and it would fight the
        // view's own "load older" paging by resetting the page under it. History is fetched on
        // navigation; the view pages back through it with direct api calls.
        shouldRevalidate: () => false,
      },
      {
        // The Changes view (ADR 0065). No loader: the view reads the list and an open file's diff
        // itself, on open, on its own 5 s beat while visible and on its refresh button, so the poll
        // loop's revalidate() fetches nothing for it. `shouldRevalidate` states the same opt-out as
        // History's, should a loader ever be added.
        // `/*` so the commit view below the list (`changes/commit`, ADR 0065) is the same route
        // and the same mounted component: the list keeps its state under the commit.
        path: "pane/:paneId/changes/*",
        element: <ChangesRoute />,
        shouldRevalidate: () => false,
      },
      {
        // The same view asked by workspace: every pane of a space shows one list (ADR 0065), and
        // this form lets a dashboard entry open it without naming a pane. Host-aware through the
        // scope query like every other route.
        path: "space/:spaceId/changes/*",
        element: <ChangesRoute />,
        shouldRevalidate: () => false,
      },
    ],
  },
], {
  // The mount the bridge served this document under (ADR 0052): `/` at the root, `/collie/` behind
  // a proxy that gives Collie a path. Every route path above stays root-relative; the router puts
  // the mount in front of them and takes it off what it reads from the address bar.
  basename: basePath(),
});

// This tab has booted: a later fresh entry in it is a reload (iOS evicting the installed app drops
// `history.state`), never a cold start to seed (ADR 0067).
markBooted(safeSessionStorage());

// A notification tapped while the app is on screen opens its pane in THIS router, as a push from
// wherever the operator was (ADR 0067). The service worker asks and waits for the answer; an app
// that does not answer gets the old full-document navigate. While update mode holds the reload, or
// a reload is already on its way, the target waits in sessionStorage for the fresh page, which opens
// it right here at boot.
const openGate: OpenGate = {
  busy: () => isReloadHeldBy(UPDATE_MODE_HOLD) || isReloadInFlight(),
  subscribe: subscribeReloadHeld,
  storage: safeSessionStorage(),
};
openPendingTarget(router, openGate);
listenForInAppOpen(router, openGate);
