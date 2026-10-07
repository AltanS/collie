// Identity guard for the stores a server document seeds (research note 09, D2.3).
//
// The island's props are the stores' seed: the snapshot, the config and the path, read once at boot
// (main.tsx). A store-backed island keeps its SETUP when its props change, so if the same `AppRoot`
// instance is handed the props of ANOTHER pane (a soft navigation to a different pane under the same
// island, a frame reload that re-sends it) the stores would still hold the first pane's identity: the
// address, and a snapshot drawn for another scope. remix-store's islands re-seeded on an id change for
// this reason; this is the same guard.
//
// THE IDENTITY is what the stores are keyed by: the pane id inside its scope (`paneScopeKey`), or the
// scope alone for the dashboard. Two props with the same identity are the same page and are NOT
// seeded again, because the polls have moved the stores on since the server drew them. A different
// identity seeds, and returns true so the caller can ask for a render.
//
// `createIdentitySeed` is pure and takes the seeding as a function, so the rule is tested without a
// browser; `seedStores` is the real seeding (the one main.tsx used to do inline).
import { markLive } from "@web/lib/connection-health";
import { internScope, paneScopeKey, scopeFromUrl, scopeKey } from "@web/lib/scope";

import type { AppRootProps } from "../app-root";
import { config, noteAddress, snapshot, snapshotAt } from "./data";

/** A path with no pane id in it is the dashboard. */
const PANE_PATH = /^\/pane\/([^/?#]+)/u;

/** What the stores are keyed by for a page: `pane:<scope>:<id>` or `home:<scope>`. `origin` only resolves the path. */
export function identityOf(path: string, origin = "http://identity.invalid"): string {
  const url = new URL(path, origin);
  const scope = internScope(scopeFromUrl(url.href));
  const pane = PANE_PATH.exec(url.pathname)?.[1];
  if (pane === undefined) return `home:${scopeKey(scope)}`;
  return `pane:${paneScopeKey(scope, decodeURIComponent(pane))}`;
}

export interface IdentitySeed<P extends { path: string }> {
  /** Seed from `props` unless the stores already hold this page's identity. True when it seeded. */
  ensure(props: P): boolean;
  /** The identity the stores hold, or null before the first seed. */
  held(): string | null;
}

export function createIdentitySeed<P extends { path: string }>(apply: (props: P) => void, origin?: string): IdentitySeed<P> {
  let held: string | null = null;
  return {
    ensure(props) {
      const next = identityOf(props.path, origin);
      if (next === held) return false;
      held = next;
      apply(props);
      return true;
    },
    held: () => held,
  };
}

/** Give the stores what the server rendered from. Never moves freshness backwards. */
export function seedStores(props: AppRootProps): void {
  noteAddress(new URL(props.path, window.location.origin));
  // The props of a soft navigation may be older than a poll that has landed since: freshness only moves forward.
  if (props.snapshotAt >= snapshotAt.get()) {
    snapshot.set({ data: props.snapshot, error: undefined, status: undefined });
    snapshotAt.set(props.snapshotAt);
  }
  config.set({ data: props.config, error: undefined, status: undefined });
  // The snapshot is a live answer from the bridge, as a poll's would be.
  if (props.snapshot.bridge !== "disconnected") markLive();
}

/** The one seeding for this page: main.tsx seeds at boot, `AppRoot` checks it on every render. */
export const documentSeed: IdentitySeed<AppRootProps> = createIdentitySeed(seedStores);
