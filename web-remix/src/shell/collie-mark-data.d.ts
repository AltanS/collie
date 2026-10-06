// `virtual:collie-mark`: the generated mark's data, read out of web/src/components/collie-mark.tsx at
// build time by the `collie-mark-data` plugin in vite.config.ts. Never hand-edited (DESIGN.md §8).
declare module "virtual:collie-mark" {
  /** The one document-scoped stylesheet: the `cm-*` keyframes and the rules that run them. */
  export const STYLE: string;
  /** The two drawings; `__cmid__` is replaced per instance so gradient ids never collide. */
  export const BODY: { full: string; header: string };
  export const VIEW: { full: string; header: string };
  /** Seconds per turn: at rest, and while loading. */
  export const TURN: { rest: number; live: number };
}
