// The build comparison, pure: is the bridge serving a different app than the one running here?
//
// The bridge stamps the build it serves from disk on every snapshot answer (`X-Collie-Build`, read in
// lib/api.ts into the `serverBuild` store) and this bundle carries its own id (`__BUILD_INFO__.id`,
// baked in by vite.config.ts). When they differ, the phone runs an old app.
//
// The rules are web/'s, so the two shells agree on when an app is stale:
//   * `isStaleBuild` is web/src/lib/build.ts word for word: a missing or `unknown` server id is never
//     stale, so an older bridge (no header) or one that cannot read build-info.json never nags.
//   * `observeBuild` is web/src/lib/self-update.ts's hysteresis: a stale id must be seen on TWO
//     consecutive polls before it counts, so a header that flips for one poll during an atomic dist
//     swap never opens the sheet. A different stale id restarts the count.
// No clock, no storage, no DOM: lib/../update/self-update.ts owns the side effects.

/** True when the bridge serves a different build than the one this bundle came from. */
export function isStaleBuild(bundleId: string, serverBuild: string | undefined): boolean {
  return Boolean(serverBuild) && serverBuild !== "unknown" && serverBuild !== bundleId;
}

export interface BuildWatch {
  /** A stale id seen once, waiting for a second sighting. */
  readonly pending: string | undefined;
  /** A stale id seen twice in a row: the sheet's trigger. */
  readonly confirmed: string | undefined;
}

export const FRESH: BuildWatch = { pending: undefined, confirmed: undefined };

/** Fold one observation of the server build into the watch. */
export function observeBuild(watch: BuildWatch, bundleId: string, server: string | undefined): BuildWatch {
  if (!isStaleBuild(bundleId, server)) return FRESH;
  // SAFETY: `isStaleBuild` is true only for a defined id that is neither "unknown" nor ours.
  const id = server as string;
  if (id === watch.confirmed) return watch;
  if (id === watch.pending) return { pending: undefined, confirmed: id };
  return { pending: id, confirmed: undefined };
}
