import { createBrowserRouter, replace } from "react-router";

import { BootSplash, RootError, RootLayout } from "@/routes/root";
import { HomeRoute } from "@/routes/home";
import { SpaceRoute } from "@/routes/space";
import { DetailRoute } from "@/routes/detail";
import { HistoryRoute } from "@/routes/history";
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

// We don't use view transitions. React Router persists an "applied view transitions" map to
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
    ],
  },
]);
