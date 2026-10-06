// The router: one `remix/spa` fetch router, created ONCE at module scope so the runtime can be
// disposed and started again (main.tsx) without losing it.
//
// Every route action renders a component; the component registers the reads it needs with the
// polling scheduler for as long as it is mounted (lib/polling.ts). An action does no fetching of
// its own, so a navigation never waits on the network: the screen paints from the stores at once
// and fills in as the reads land.
//
// Adding a route: add its pattern to routes.ts and one `router.map` line below. Keep edits here
// additive; the route's own code lives under routes/<area>/.
import { createAction, createRouter, type RouterContext } from "remix/router";
import { render, type Router } from "remix/spa";

import { basePath } from "@web/lib/base-path";
import { paneScopeKey } from "@web/lib/scope";

import { address, noteAddress } from "./lib/data";
import { homeAction } from "./routes/home/action";
import { PaneRoute } from "./routes/pane/pane";
import { settingsAction, settingsDeviceAction, settingsSectionAction, settingsUpdatesAction } from "./routes/settings/action";
import { SpaceRoute } from "./routes/space/space";
import { routes } from "./routes";
import { NotFound, Shell } from "./shell";

export const router = createRouter({
  middleware: [
    async (context, next) => {
      noteAddress(context.url);
      return next();
    },
    render((content, { url }) => <Shell url={url}>{content}</Shell>),
  ],
  defaultHandler({ render: draw, url }) {
    return draw(<NotFound url={url} />, { status: 404 });
  },
});

export type AppContext = RouterContext<typeof router>;

declare module "remix" {
  interface RouterTypes {
    context: AppContext;
  }
}

// A route whose state belongs to one entity renders keyed by that entity (REMIX3.md rule 3): a
// sideways move from one pane to another, or to the same pane id on another machine (`?h=`), is a
// new instance with its own setup, never the old one with a stale `paneId` and scope. The scope is
// the one `noteAddress` just read off this URL, in the middleware above.
const paneAction = createAction(routes.pane, ({ render: draw, params }) =>
  draw(<PaneRoute key={paneScopeKey(address.get().scope, params.paneId)} paneId={params.paneId} />),
);
const spaceAction = createAction(routes.space, ({ render: draw, params }) =>
  draw(<SpaceRoute key={`space:${paneScopeKey(address.get().scope, params.spaceId)}`} spaceId={params.spaceId} />),
);

router.map(routes.home, homeAction);
router.map(routes.space, spaceAction);
router.map(routes.pane, paneAction);
router.map(routes.settings, settingsAction);
router.map(routes.settingsDevice, settingsDeviceAction);
router.map(routes.settingsUpdates, settingsUpdatesAction);
router.map(routes.settingsSection, settingsSectionAction);
// Wave 4: Crew, Machines, History, Changes and Files, mapped in one call (routes/frame/map.tsx).
import { mapWave4 } from "./routes/frame/map";
mapWave4(router);

/**
 * The router as the runtime sees it, with the mount taken off (ADR 0052). The bridge serves this
 * document under `/` or under a path a proxy gave it, read once from `<meta name="collie-base">`;
 * route patterns are root-relative, so every URL the runtime resolves loses the mount here first.
 */
export const mountedRouter: Router = {
  fetch(input, init) {
    const base = basePath();
    if (base === "/") return router.fetch(input, init);
    const url = new URL(input instanceof Request ? input.url : input.toString(), window.location.href);
    if (url.pathname.startsWith(base)) url.pathname = `/${url.pathname.slice(base.length)}`;
    else if (`${url.pathname}/` === base) url.pathname = "/";
    return router.fetch(url, init);
  },
};
