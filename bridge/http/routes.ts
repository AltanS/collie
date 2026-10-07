// The bridge's HTTP route table. The map itself lives in `shared/routes.ts`, because the phone shell
// builds its API URLs from the same map. This file is the bridge's registration site: the router and
// the controllers import `routes` from here.
//
// `bridge/solo-baseline.test.ts` reads the map itself to prove that solo registers exactly the routes
// it always did, and that no `/crew` path is among them: the crew surface (`/crew/v1/*`) has its own
// admission and its own router (`bridge/crew/router.ts`), and is answered before this table is
// consulted (server.ts).

import { routes } from "../../shared/routes.ts";

export { routes };

/** The four families a crew lead reaches through `/crew/v1/*` as well as a browser does. */
export const sessionRoutes = {
  pane: routes.pane,
  tab: routes.tab,
  workspace: routes.workspace,
  launch: routes.launch,
};
