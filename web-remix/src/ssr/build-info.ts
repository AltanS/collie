// `__BUILD_INFO__` on Bun. Vite bakes it into the browser bundle (`define`, vite.config.ts); web's
// lib/build.ts reads it AT MODULE EVALUATION. On the bridge there is no define, so this module, which
// ssr/render.tsx imports FIRST, makes sure one is on `globalThis` before anything reads it: the
// bridge puts the stamp from `web/dist/build-info.json` there before it loads the renderer
// (bridge/http/controllers/document.ts), and this fills a placeholder in when nobody did (unit tests). The footer's build label is drawn from it, so the
// server and the hydrating bundle draw the same stamp while the bundle on disk is the one that
// started the process. A live rebuild without a restart keeps the old stamp on the server until the
// next start (`make remix-deploy` restarts).

type BuildInfo = typeof __BUILD_INFO__;

const PLACEHOLDER: BuildInfo = { version: "0.0.0", sha: "nogit", time: "", id: "unknown", channel: "dev" };

if (!("__BUILD_INFO__" in globalThis)) Object.assign(globalThis, { __BUILD_INFO__: PLACEHOLDER });
