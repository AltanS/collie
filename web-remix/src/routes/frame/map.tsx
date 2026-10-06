// The wave-4 routes' actions, mapped in ONE call so router.tsx takes one additive hunk. Each action
// renders a component and fetches nothing: the screen paints from stores at once and the route
// registers its own reads with the polling scheduler while mounted (lib/polling.ts).
//
// KEYS (REMIX3.md rule 3). A route whose state belongs to one entity renders keyed by it: a machine
// by its id, History by the pane, Changes by target and id. The Changes key leaves the LEVEL out, so
// the list, the commit under it and the tree under it are one instance and the list keeps its state.
import { createAction } from "remix/router";

import { paneScopeKey } from "@web/lib/scope";

import { address } from "../../lib/data";
import { routes } from "../../routes";
import type { router as AppRouter } from "../../router";
import { ChangesRoute, type ChangesLevel } from "../changes/changes";
import { CrewRoute } from "../crew/crew";
import { HistoryRoute } from "../history/history";
import { MachineRoute } from "../machines/machine";
import { MachinesRoute } from "../machines/machines";

const scoped = (id: string): string => paneScopeKey(address.get().scope, id);

function paneChanges(paneId: string, level: ChangesLevel) {
  return <ChangesRoute key={`changes:pane:${scoped(paneId)}`} target={{ kind: "pane", paneId }} level={level} />;
}

function spaceChanges(spaceId: string, level: ChangesLevel) {
  return <ChangesRoute key={`changes:space:${scoped(spaceId)}`} target={{ kind: "space", spaceId }} level={level} />;
}

export function mapWave4(router: typeof AppRouter): void {
  router.map(routes.crew, createAction(routes.crew, ({ render }) => render(<CrewRoute />)));
  router.map(routes.machines, createAction(routes.machines, ({ render }) => render(<MachinesRoute />)));
  router.map(
    routes.machine,
    createAction(routes.machine, ({ render, params }) => render(<MachineRoute key={`machine:${params.machineId}`} machineId={params.machineId} />)),
  );
  router.map(
    routes.history,
    createAction(routes.history, ({ render, params }) => render(<HistoryRoute key={`history:${scoped(params.paneId)}`} paneId={params.paneId} />)),
  );
  router.map(routes.paneChanges, createAction(routes.paneChanges, ({ render, params }) => render(paneChanges(params.paneId, "list"))));
  router.map(routes.paneChangesCommit, createAction(routes.paneChangesCommit, ({ render, params }) => render(paneChanges(params.paneId, "commit"))));
  router.map(routes.paneChangesFiles, createAction(routes.paneChangesFiles, ({ render, params }) => render(paneChanges(params.paneId, "files"))));
  router.map(routes.spaceChanges, createAction(routes.spaceChanges, ({ render, params }) => render(spaceChanges(params.spaceId, "list"))));
  router.map(routes.spaceChangesCommit, createAction(routes.spaceChangesCommit, ({ render, params }) => render(spaceChanges(params.spaceId, "commit"))));
  router.map(routes.spaceChangesFiles, createAction(routes.spaceChangesFiles, ({ render, params }) => render(spaceChanges(params.spaceId, "files"))));
}
