// The Machines route paths, apart from nav.ts because the service worker needs them and nav.ts
// reads `window` (tsconfig.worker.json has no DOM). A notification tap for a machine alert builds
// its URL with these (lib/push-decision.ts). nav.ts re-exports both, so the app asks nav.ts as ever.
import { scopeSearch, type Scope } from "./scope";

/**
 * The machines list: every machine's load now, one card each. Opened from the Settings index; a
 * CHILD of Settings. Carries the scope like the others, so "back" returns to the machine you were
 * looking at.
 */
export function machinesPath(scope?: Scope): string {
  return `/machines${scopeSearch(scope)}`;
}

/** One machine's page: the numbers, the last hour and day, and its alert rules. A child of Machines. */
export function machinePath(id: string, scope?: Scope): string {
  return `/machines/${encodeURIComponent(id)}${scopeSearch(scope)}`;
}
