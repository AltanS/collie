// `virtual:collie-mark` OFF the browser bundle: on Bun, for the bridge's server render (S1) and the
// unit tests. In the browser build the `collie-mark-data` Vite plugin (vite.config.ts) answers that
// specifier first, with the real data read out of web/src/components/collie-mark.tsx, which is
// generated in collie-brand and never hand-edited (DESIGN.md §8). tsconfig.json's `paths` points the
// specifier here for everything that is not Vite: tsc, `bun test` and `bun build --compile`.
//
// The server never draws the mark. `CollieMark` paints its drawing in a `ref` (shell/collie-mark.tsx),
// and a ref never runs in a server render, so the server markup holds the mark's empty host and the
// browser paints it on hydration. Nothing here is drawn; the values only have the plugin's shapes.
// `ssr/render.test.tsx` holds that a server document carries no part of the drawing.

/** The one document-scoped stylesheet: the `cm-*` keyframes and the rules that run them. */
export const STYLE = "";
/** The header drawing (the only one this shell draws); `__cmid__` is replaced per instance so gradient ids never collide. */
export const BODY = { header: "" };
export const VIEW = { header: "0 0 1 1" };
/** Seconds per turn: at rest, and while loading. */
export const TURN = { rest: 1, live: 1 };
