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

/**
 * The two views of one machine's page: `status` (the numbers now and the charts) and `alerts` (its
 * rules). Status is the default and has no parameter, so every link that predates the views, a push
 * tap included, still opens Status.
 */
export type MachineTab = "status" | "alerts";

/** The query key the view rides in. */
const TAB_PARAM = "tab";

/**
 * One machine's page, a child of Machines. With `tab: "alerts"` it opens on the Alerts view
 * (`?tab=alerts`, after the scope). Status is the page without the parameter.
 */
export function machinePath(id: string, scope?: Scope, tab: MachineTab = "status"): string {
  const base = `/machines/${encodeURIComponent(id)}${scopeSearch(scope)}`;
  if (tab === "status") return base;
  return `${base}${base.includes("?") ? "&" : "?"}${TAB_PARAM}=${tab}`;
}

/** The view a machine page's query names. Anything but `alerts` is Status: an unknown value is not an error. */
export function machineTabOf(search: string): MachineTab {
  return new URLSearchParams(search).get(TAB_PARAM) === "alerts" ? "alerts" : "status";
}
