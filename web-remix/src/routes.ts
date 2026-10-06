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
  crew: get("/crew"),
  machines: get("/machines"),
  machine: get("/machines/:machineId"),
  history: get("/pane/:paneId/history"),
  // Changes (ADR 0065, 0083): the list, the commit under it and the folder tree under it, for a
  // pane and for a space. One component serves all three levels of each, see routes/changes.
  paneChanges: get("/pane/:paneId/changes"),
  paneChangesCommit: get("/pane/:paneId/changes/commit"),
  paneChangesFiles: get("/pane/:paneId/changes/files"),
  spaceChanges: get("/space/:spaceId/changes"),
  spaceChangesCommit: get("/space/:spaceId/changes/commit"),
  spaceChangesFiles: get("/space/:spaceId/changes/files"),
});

/** A root-relative app path as the mounted origin serves it, query included. */
export function href(path: string): string {
  return mounted(path);
}
