// ADR 0067: back goes UP one level, and up is never a push.
//
// The pane is level 2; its parents are a space (`/space/:id`) and the dashboard (`/`). Up steps back
// in history when the entry behind is one of those parents, and otherwise REPLACES this entry with
// the dashboard, so the pane never stays behind its parent. The level tree and the rule are web's
// (`ancestorsOf` and `resolveUp` in web/src/lib/nav.ts, read-only); this module only reads the entry
// behind from the Navigation API, which the Remix runtime navigates with, and takes the ADR 0052
// mount off both paths before asking.

import { basePath } from "@web/lib/base-path";
import { homePath, resolveUp, upTarget } from "@web/lib/nav";
import type { Scope } from "@web/lib/scope";

import { navigate } from "../../lib/navigate";
import { href } from "../../routes";

/** A same-origin URL's path and query with the mount taken off: the form web's nav rules read. */
export function unmounted(url: URL): string {
  const base = basePath();
  let path = url.pathname;
  if (base !== "/" && path.startsWith(base)) path = `/${path.slice(base.length)}`;
  return `${path}${url.search}`;
}

/** The entry behind this one, unmounted, or undefined when there is none (a cold open). */
function previousEntry(): string | undefined {
  const nav = window.navigation;
  const current = nav?.currentEntry;
  if (!nav || !current || current.index <= 0) return undefined;
  const behind = nav.entries()[current.index - 1]?.url;
  if (!behind) return undefined;
  const url = new URL(behind);
  return url.origin === window.location.origin ? unmounted(url) : undefined;
}

function here(): string {
  return unmounted(new URL(window.location.href)).replace(/\?.*$/, "");
}

/** Where up lands from this pane: the parent behind it, else the dashboard. */
export function upPath(scope: Scope): string {
  const from = previousEntry();
  return upTarget(here(), from, homePath(scope), from !== undefined);
}

/** Go up one level: back onto a parent that is behind us, else replace with the dashboard. */
export function goUp(scope: Scope): void {
  const from = previousEntry();
  const move = resolveUp(here(), from, homePath(scope), from !== undefined);
  if (move.kind === "back") {
    window.history.back();
    return;
  }
  void navigate(href(move.to), { history: "replace" });
}
