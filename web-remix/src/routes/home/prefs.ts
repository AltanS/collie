// The dashboard's per-device view choices: which tab is open, and the workspace filter (one
// workspace isolated, others hidden). In memory for now: web/'s use-dash-prefs.ts persists them
// under its own storage key through a React hook, and sharing that key needs its reader ported
// first, so a reload starts from the defaults here.
import type { DashView } from "@web/lib/dash-view";

import { createStore } from "../../lib/store";

export interface DashPrefs {
  dashView: DashView;
  isolated: string | null;
  hidden: readonly string[];
}

export const dashPrefs = createStore<DashPrefs>({ dashView: "dashboard", isolated: null, hidden: [] });

export function setIsolated(key: string | null): void {
  dashPrefs.update((p) => ({ ...p, isolated: key }));
}

export function toggleHidden(key: string): void {
  dashPrefs.update((p) => ({ ...p, hidden: p.hidden.includes(key) ? p.hidden.filter((k) => k !== key) : [...p.hidden, key] }));
}

export function setDashView(view: DashView): void {
  dashPrefs.update((p) => ({ ...p, dashView: view }));
}
