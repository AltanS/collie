// ADR 0067 for the routes of wave 4: back goes UP one level, and up is never a push.
//
// The level tree and the rule are web's (`ancestorsOf`, `resolveUp`, `resolveUpToExact` in
// web/src/lib/nav.ts, read-only). This module only reads the entry behind this one from the
// Navigation API (the Remix runtime navigates with it), takes the ADR 0052 mount off both paths
// before asking, and performs the move. `pane/back.ts` does the same for the pane; it is the pane
// route's file, so this one stands beside it until both lift into one `lib/nav.ts`.

import { basePath } from "@web/lib/base-path";
import { pathOnly, resolveUp, resolveUpToExact, type UpMove } from "@web/lib/nav";

import { navigate } from "../../lib/navigate";
import { href } from "../../routes";

/** A same-origin URL's path and query with the mount taken off: the form web's nav rules read. */
export function unmountedPath(url: URL): string {
  const base = basePath();
  let path = url.pathname;
  if (base !== "/" && path.startsWith(base)) path = `/${path.slice(base.length)}`;
  return `${path}${url.search}`;
}

/** The entry behind this one, unmounted, or undefined on a cold open (nothing behind us). */
export function previousEntry(): string | undefined {
  const nav = window.navigation;
  const current = nav?.currentEntry;
  if (!nav || !current || current.index <= 0) return undefined;
  const behind = nav.entries()[current.index - 1]?.url;
  if (!behind) return undefined;
  const url = new URL(behind);
  return url.origin === window.location.origin ? unmountedPath(url) : undefined;
}

/** This document's path, mount and query off: what `ancestorsOf` is asked about. */
export function hereNow(): string {
  return pathOnly(unmountedPath(new URL(window.location.href)));
}

function perform(move: UpMove): void {
  if (move.kind === "back") {
    window.history.back();
    return;
  }
  void navigate(href(move.to), { history: "replace" });
}

/**
 * Up from this route: back when the entry behind is a legitimate parent, else replace this entry
 * with `fallback` (the structural parent, scope included). Never a push.
 */
export function goUp(fallback: string): void {
  const from = previousEntry();
  perform(resolveUp(hereNow(), from, fallback, from !== undefined));
}

/**
 * Up to one exact LOCATION, pathname and query: the Files tree, where every folder shares one
 * pathname and only `?dir=` tells them apart (ADR 0083).
 */
export function goUpExact(target: string): void {
  const from = previousEntry();
  perform(resolveUpToExact(from, target, from !== undefined));
}

/** Down: one level deeper is a push (ADR 0067). */
export function goDown(path: string): void {
  void navigate(href(path));
}

/** Sideways: a sibling at the same level replaces, so the level's way up survives (ADR 0067). */
export function goSide(path: string): void {
  void navigate(href(path), { history: "replace" });
}
