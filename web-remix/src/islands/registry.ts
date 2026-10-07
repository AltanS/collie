// `loadModule` for the islands runtime: one dynamic `import()` per island module (research note 10, 3.7).
// The build gathers what the start islands import into a few chunks (vite.config.ts
// `startChunksPlugin`), so an island's own chunk is a small facade over those. The runtime
// memoises a load per `moduleUrl#exportName` for its life (C/src/runtime/frame.ts `moduleCache`), so a
// soft navigation that brings an island already seen costs nothing here.
//
// An id this table does not know is not ours: the load throws and the runtime reports it.
import type { LoadModule } from "remix/component";

import { afterFirstPaint } from "../lib/first-paint";
import { ISLAND } from "./ids";
import { loadPaneModules } from "./seed";

type IslandComponent = Awaited<ReturnType<LoadModule>>;

/** Each island id (islands/ids.ts) and the loader of its component. */
const LOADERS = {
  [ISLAND.live]: async () => (await import("./live")).Live,
  [ISLAND.gestures]: async () => (await import("./gestures")).Gestures,
  [ISLAND.sheets]: async () => (await import("./sheets")).Sheets,
  [ISLAND.headerActions]: async () => (await import("./header-actions")).HeaderActions,
  [ISLAND.homeTail]: async () => (await import("./home-tail")).HomeTail,
  [ISLAND.screen]: async () => (await import("./screen")).PaneScreenIsland,
  // THE TWO-STEP MOUNT (REMIX3.md): the composer hydrates after the first paint of the page that
  // brought it, never inside the soft navigation's commit task. The chunk loads meanwhile.
  [ISLAND.composer]: async () => (await Promise.all([import("./composer"), afterFirstPaint()]))[0].PaneComposerIsland,
} satisfies Record<string, () => Promise<IslandComponent>>;

function isIslandId(id: string): id is keyof typeof LOADERS {
  return Object.hasOwn(LOADERS, id);
}

/**
 * Warm what a pane page needs that the dashboard does not load: its two islands and the pane modules
 * the seed reads (islands/seed.ts). Called on the press of a row (islands/gestures.tsx), beside the
 * document's prefetch, so the tap diffs the pane in with no module fetch inside the commit.
 */
export function warmPaneModules(): void {
  void Promise.all([import("./screen"), import("./composer"), loadPaneModules()]).catch(() => undefined);
}

export const loadIsland: LoadModule = async (moduleUrl, exportName) => {
  const id = `${moduleUrl}#${exportName}`;
  if (!isIslandId(id)) throw new Error(`Collie: no island ${id}`);
  return LOADERS[id]();
};
