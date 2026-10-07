// The HTTP route table: every path and method the front door answers, in one typed map.
//
// SHARED. The bridge router (`bridge/http/router.ts`, through `bridge/http/routes.ts`) and the Remix
// phone shell (`web-remix/src/lib/urls.ts`, through the `@shared/*` alias) import THIS file, so a path
// or a param renamed here fails `typecheck` on both sides. Keep it free of anything that is not
// browser-safe: no `bridge/` import, no `node:` or `bun:` module. Only `remix/routes` comes in.
//
// The bridge's registration site is `bridge/http/routes.ts`, which re-exports this map.
// `bridge/solo-baseline.test.ts` reads the map itself to prove that solo registers exactly the routes
// it always did, and that no `/crew` path is among them: the crew surface (`/crew/v1/*`) has its own
// admission and its own router (`bridge/crew/router.ts`), and is answered before this table is
// consulted (server.ts).
//
// HOW A PATTERN READS HERE, because three things differ from a plain path:
//
// - The matcher sees the RAW path (router.ts `rawPathMatcher`): a param is the undecoded segment, as
//   the old `([^/]+)` regexes captured it, and the handler decodes it exactly as before. So a bad
//   percent-escape still reaches the handler that refuses it, instead of matching nothing.
// - Inside that raw path every `.` is percent-encoded, so `:paneId` takes `w1.p1` whole (route-pattern
//   reads a raw dot as a delimiter). A static path with a dot in it is therefore written encoded,
//   through {@link dotted}.
// - A plain string route answers EVERY method. Those are the paths whose old handler took any method
//   and answered a wrong one itself (`/api/health`, the pane family, prefs, cache-watch, machines), or
//   took any method at all (`/api/snapshot`, `/api/config`). A `get()` or `post()` route answers its
//   method only; any other method falls through to the app shell, as the old dispatch did
//   (router.ts `methodParity` keeps HEAD on that path too).

import { get, post, route } from "remix/routes";

/**
 * The one path the mark is served from, spelled once.
 *
 * A CONSTANT rather than a literal at each end, because the bridge both routes it and publishes it
 * in `MuxConfig.logoUrl` (bridge/types.ts); two spellings of one path is one release away from a broken image.
 * It is deliberately not per-multiplexer — a collie drives exactly one, so the path names the
 * question ("this bridge's mux") and the answer changes with the bridge, never with the URL.
 */
export const MUX_LOGO_PATH = "/api/mux/logo.svg";

/**
 * Where an operator's own font files are served — one file per request, appended:
 * `/api/fonts/<basename>`.
 *
 * A CONSTANT for the reason {@link MUX_LOGO_PATH} is one, and a PREFIX rather than a whole path
 * because the last segment is the only variable the surface has. It carries a basename the bridge
 * already declared in `BridgeConfig.operatorFonts` (bridge/types.ts) and nothing else — the client builds the
 * URL, the bridge looks the name up, and no path is built from either (ADR 0033).
 *
 * It lives under `/api/` deliberately: the service worker registers no runtime route there, so
 * these files are never precached and never swept, unlike the shipped faces under `/fonts/`.
 */
export const OPERATOR_FONTS_PATH = "/api/fonts/";


/** A static path that carries a `.`, spelled the way the raw-path matcher sees it. */
function dotted(path: string): string {
  return path.replaceAll(".", "%2E");
}

export const routes = route({
  // ── Ungated: the detached updater's probe (M15/04) ──
  health: "/api/health",

  // ── Live state, polled by the client ──
  snapshot: "/api/snapshot",

  // ── Session-scoped: the same handlers answer a browser and a crew lead (CREW_PROTOCOL.md §5) ──
  pane: {
    refresh: post("/api/refresh"),
    blob: get("/api/blobs/:hash"),
    read: "/api/pane/:paneId",
    reply: "/api/pane/:paneId/reply",
    keys: "/api/pane/:paneId/keys",
    upload: "/api/pane/:paneId/upload",
    close: "/api/pane/:paneId/close",
    rename: "/api/pane/:paneId/rename",
    history: "/api/pane/:paneId/history",
    chat: "/api/pane/:paneId/chat",
    changes: "/api/pane/:paneId/changes",
    files: "/api/pane/:paneId/files",
    focus: "/api/pane/:paneId/focus",
  },
  tab: {
    create: post("/api/tab"),
    rename: post("/api/tab/:tabId/rename"),
    close: post("/api/tab/:tabId/close"),
  },
  workspace: {
    create: post("/api/workspace"),
    changes: get("/api/workspace/:workspaceId/changes"),
    files: get("/api/workspace/:workspaceId/files"),
    worktrees: get("/api/workspace/:workspaceId/worktrees"),
    worktree: post("/api/workspace/:workspaceId/worktree"),
    worktreeOpen: post("/api/workspace/:workspaceId/worktree/open"),
    folders: get("/api/folders"),
    folderStar: post("/api/folders/star"),
  },
  launch: {
    launch: post("/api/launch"),
    launchers: get("/api/launchers"),
  },

  // ── This collie's own configuration and the files it publishes ──
  config: {
    cacheRules: get("/api/cache-rules"),
    config: "/api/config",
    muxLogo: get(dotted(MUX_LOGO_PATH)),
    font: get(`${OPERATOR_FONTS_PATH}*name`),
  },

  // ── Notifications: push, snooze, prefs, the per-pane cache warning (ADR 0042) ──
  notifications: {
    subscribe: post("/api/subscribe"),
    snooze: post("/api/notifications/snooze"),
    prefs: "/api/notifications/prefs",
    cacheWatch: "/api/notifications/cache-watch",
    cacheWatchList: get("/api/notifications/cache-watch/list"),
    cacheWatchForget: post("/api/notifications/cache-watch/forget"),
  },

  // ── Updates (M15, M16, M17/08) ──
  update: {
    check: post("/api/update/check"),
    snooze: post("/api/update/snooze"),
    dismiss: post("/api/update/dismiss"),
    status: get("/api/update/check"),
    start: post("/api/update"),
  },

  // ── Speech-to-text (bridge/stt/) ──
  stt: post("/api/stt"),

  // ── Device pairing (bridge/pairing.ts) ──
  pairing: {
    pair: post("/api/pair"),
    devices: get("/api/devices"),
    revoke: post("/api/devices/revoke"),
  },

  // ── The crew overview and every machine's load (ADR 0084): front-door routes, never forwarded ──
  crew: {
    status: get("/api/crew"),
    machines: "/api/machines",
    machineHistory: "/api/machines/:machineId/history",
    machineAlerts: "/api/machines/:machineId/alerts",
  },

  // ── The app: the reserved front-door path, then the PWA with its SPA fallback ──
  app: {
    auth: "/auth",
    authBelow: "/auth/*path",
    shell: "/*path",
  },
});
