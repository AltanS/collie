import { render } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { TricksSettingsCard, type TricksSettingsCardProps } from "@/components/tricks-settings-card";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import type { TricksStore } from "@/lib/tricks/store";
import { SettingsTrickRoute, type SettingsTrickRouteProps } from "@/routes/settings-trick";
import { withHeaderHost } from "@/test/header-host";

/**
 * Settings, Tricks and the Hill and a trick's details page under one router, as the app mounts them: the list at
 * `/settings/tricks`, the page at `/settings/tricks/:key`, both under the root route (its loader is the root data
 * the two read: the device, `tricksOff`) and the one header host. A tap on a row's name goes to the page; the
 * page's Back comes up to the list. The two share the store; each takes its own calls, as in the app.
 */
export function renderTricksPages({
  store,
  card = {},
  page = {},
  loader,
  entries = ["/settings/tricks"],
}: {
  store: TricksStore;
  card?: Omit<TricksSettingsCardProps, "store">;
  page?: Omit<SettingsTrickRouteProps, "store">;
  loader?: () => object;
  entries?: string[];
}) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader,
        element: withHeaderHost(<Outlet />),
        children: [
          { path: "settings/tricks", element: <TricksSettingsCard store={store} {...card} /> },
          { path: "settings/tricks/:key", element: <SettingsTrickRoute store={store} {...page} /> },
          { path: "settings/experiments", element: <div data-testid="experiments" /> },
          { path: "trick/:paneId", element: <div data-testid="trick-page" /> },
        ],
      },
    ],
    { initialEntries: entries, initialIndex: entries.length - 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}
