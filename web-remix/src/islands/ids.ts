// The islands of the S3 document (`experiments/remix-v3/ACTION-PLAN.md` B, "S3 design, decided"), by
// id. An id is `<moduleUrl>#<exportName>`, explicit and never `import.meta.url` (under `bun build
// --compile` that is no file URL; research note 08, trap 10.4). The browser maps the module half to a
// dynamic `import()` (islands/registry.ts), which Vite turns into one chunk per island; the bridge maps
// it to that chunk's file through Vite's manifest, to preload it (ssr/islands-document.tsx).
//
// Kept free of imports: the bridge, the boot and the tests all read it.

export const ISLAND = {
  /** Polling, the frame reloads, the connection strip, the busy bar, the toasts, the idle cover. One per page. */
  live: "collie:live#Live",
  /** Delegated listeners on the document: the glide, the prefetch, long press, scroll memory, acts. */
  gestures: "collie:gestures#Gestures",
  /** The bottom and side sheets; each sheet's code loads on its first open. */
  sheets: "collie:sheets#Sheets",
  /** The header's right cluster (and the find bar, which takes the header row over on a pane). */
  headerActions: "collie:header-actions#HeaderActions",
  /** The dashboard's Launch and Spaces sections: each reads and filters on its own. */
  homeTail: "collie:home-tail#HomeTail",
  /** The pane's screen: the strips, the notice, the Terminal (with its server frame), the card. */
  screen: "collie:screen#PaneScreenIsland",
  /** The pane's bottom: the composer, the keys tray, the belt. Keyed by pane. */
  composer: "collie:composer#PaneComposerIsland",
} as const;

export type IslandName = keyof typeof ISLAND;

/** The source file of each island module, as Vite's manifest keys it (relative to `web-remix/`). */
export const ISLAND_SOURCES = {
  "collie:live": "src/islands/live.tsx",
  "collie:gestures": "src/islands/gestures.tsx",
  "collie:sheets": "src/islands/sheets.tsx",
  "collie:header-actions": "src/islands/header-actions.tsx",
  "collie:home-tail": "src/islands/home-tail.tsx",
  "collie:screen": "src/islands/screen.tsx",
  "collie:composer": "src/islands/composer.tsx",
} as const satisfies Record<string, string>;

/** The module half of an island id. */
export function islandModule(id: string): string {
  const at = id.indexOf("#");
  return at === -1 ? id : id.slice(0, at);
}
