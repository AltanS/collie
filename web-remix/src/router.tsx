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
import { createRouter, type RouterContext } from "remix/router";
import { render, type Router } from "remix/spa";

import { basePath } from "@web/lib/base-path";

import { noteAddress } from "./lib/data";
import { homeAction } from "./routes/home/action";
import { paneAction } from "./routes/pane/action";
import { settingsAction, settingsDeviceAction, settingsSectionAction, settingsUpdatesAction } from "./routes/settings/action";
import { spaceAction } from "./routes/space/action";
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

router.map(routes.home, homeAction);
router.map(routes.space, spaceAction);
router.map(routes.pane, paneAction);
router.map(routes.settings, settingsAction);
router.map(routes.settingsDevice, settingsDeviceAction);
router.map(routes.settingsUpdates, settingsUpdatesAction);
router.map(routes.settingsSection, settingsSectionAction);

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
