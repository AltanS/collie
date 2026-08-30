// Route path helpers. Pane ids contain a colon (e.g. "wE:p2"), so they must be URL-encoded in the
// path; React Router decodes them back in useParams. The active scope — which machine, which named
// session — rides along in the query (`?h=` / `?s=`, see lib/scope.ts) so a navigation stays pointed
// at the pane you were actually looking at. Lead + primary emits nothing, so a solo install's paths
// are byte-identical to what shipped before the host dimension existed.
//
// The host stays in the QUERY, never in the path: a `/host/:h/pane/:paneId` shape would fork every
// route, break every existing deep link, and force the loaders' isPaneUrl() to grow a parser.
import { scopeSearch, type Scope } from "./scope";

export function panePath(paneId: string, scope?: Scope): string {
  return `/pane/${encodeURIComponent(paneId)}${scopeSearch(scope)}`;
}

/**
 * A pane's conversation history — the agent's own transcript, which is the only scrollback a Claude
 * pane can have (its terminal runs on the alternate screen and retains nothing). A child path of the
 * pane so "back" lands on the live mirror.
 */
export function historyPath(paneId: string, scope?: Scope): string {
  return `/pane/${encodeURIComponent(paneId)}/history${scopeSearch(scope)}`;
}

/** A space's detail route (its tabs + panes). Deep-linkable; carries the scope like panePath. */
export function spacePath(spaceId: string, scope?: Scope): string {
  return `/space/${encodeURIComponent(spaceId)}${scopeSearch(scope)}`;
}

/** The dashboard path, carrying the current scope so "go home" doesn't drop you back to the lead. */
export function homePath(scope?: Scope, opts?: { all?: boolean }): string {
  return `/${scopeSearch(scope, opts)}`;
}

/** The settings route, carrying the current scope like the other path helpers. */
export function settingsPath(scope?: Scope): string {
  return `/settings${scopeSearch(scope)}`;
}

/**
 * The pack overview — the read-only census of every machine in the pack. Carries the scope like the
 * others so "back" returns you to the machine you were looking at, not to the lead.
 */
export function packPath(scope?: Scope): string {
  return `/pack${scopeSearch(scope)}`;
}
