// The URL contract, root-relative. The mount (ADR 0052) is not part of a pattern: router.tsx takes
// it off every URL before the router matches, and `href()` puts it back on every link.
import { get, route } from "remix/routes";

import { mounted } from "@web/lib/base-path";

export const routes = route({
  home: get("/"),
  space: get("/space/:spaceId"),
  pane: get("/pane/:paneId"),
  settings: get("/settings"),
  settingsDevice: get("/settings/device"),
  settingsUpdates: get("/settings/updates"),
  settingsSection: get("/settings/:section"),
});

/** A root-relative app path as the mounted origin serves it, query included. */
export function href(path: string): string {
  return mounted(path);
}
