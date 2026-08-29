import type { ReactNode } from "react";

import { AppHeaderHost } from "@/components/app-header";

/**
 * Mount a route the way the app mounts it: under the ONE header host.
 *
 * The header is no longer part of any route — `RootLayout` renders `<AppHeaderHost>` around
 * `<Outlet/>` so the Collie mark survives a navigation (app-header.tsx says why). A route's own
 * `<RouteHeader/>` portals into that host and throws without it, deliberately: a route mounted with
 * no header above it is a phone screen with no way home, and a silent fallback would hide exactly
 * that. So a test that renders a route standalone has to supply the host, and this is it.
 *
 * `connected` / `error: false` is the calm case — the mark is at rest and nothing about the header
 * is asserted from these inputs. A case that cares about the dog drives it through
 * `app-header.test.tsx`, which mounts the host itself with the connection state it wants.
 */
export function withHeaderHost(ui: ReactNode) {
  return (
    <AppHeaderHost bridge="connected" error={false}>
      {ui}
    </AppHeaderHost>
  );
}
