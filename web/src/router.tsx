import { createBrowserRouter } from "react-router";

import { BootSplash, RootError, RootLayout } from "@/routes/root";
import { HomeRoute } from "@/routes/home";
import { SpaceRoute } from "@/routes/space";
import { DetailRoute } from "@/routes/detail";
import { SettingsRoute } from "@/routes/settings";
import { rootLoader, paneLoader, ROOT_ROUTE_ID } from "@/lib/loaders";

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
      { path: "settings", element: <SettingsRoute /> },
      { path: "pane/:paneId", loader: paneLoader, element: <DetailRoute /> },
    ],
  },
]);
