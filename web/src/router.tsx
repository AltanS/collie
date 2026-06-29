import { createBrowserRouter } from "react-router-dom";

import { BootSplash, RootLayout } from "@/routes/root";
import { HomeRoute } from "@/routes/home";
import { DetailRoute } from "@/routes/detail";
import { rootLoader, paneLoader } from "@/lib/loaders";

// Created once at module scope so the idle-lock in App can unmount/remount RouterProvider without
// losing the current location (the router instance retains it; loaders re-run fresh on remount).
export const router = createBrowserRouter([
  {
    id: "root",
    path: "/",
    loader: rootLoader,
    element: <RootLayout />,
    HydrateFallback: BootSplash,
    children: [
      { index: true, element: <HomeRoute /> },
      { path: "pane/:paneId", loader: paneLoader, element: <DetailRoute /> },
    ],
  },
]);
