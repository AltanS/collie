import { createBrowserRouter } from "react-router";

import { BootSplash, RootError, RootLayout } from "@/routes/root";
import { HomeRoute } from "@/routes/home";
import { DetailRoute } from "@/routes/detail";
import { SettingsRoute } from "@/routes/settings";
import { rootLoader, paneLoader, ROOT_ROUTE_ID } from "@/lib/loaders";

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
      { path: "settings", element: <SettingsRoute /> },
      { path: "pane/:paneId", loader: paneLoader, element: <DetailRoute /> },
    ],
  },
]);
