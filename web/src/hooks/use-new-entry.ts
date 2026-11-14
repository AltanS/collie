import { useNav } from "@/hooks/use-nav";
import { t } from "@/lib/i18n";
import { useMuxCapability } from "@/lib/mux-capability";
import { newPath } from "@/lib/nav";
import type { Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";

// THE ONE NEW ENTRY (M48 spec 01). The dashboard's floating New button and the Switch pane sheet's New
// button both ask this hook, so the two never disagree about WHEN a create entry is drawn or WHERE it
// goes. It answers the two things a button needs and nothing about how the button looks.
//
//   `offered`  a device that may write, on a machine that can open a space at all (which every start on
//              the New page does), or that has launcher rows to run, or that has no screen (the durable
//              home: the New page lists the program's starters there). The caller adds the part only it
//              knows: the dashboard draws the button on its Dashboard tab only.
//   `open`     the New page on the machine this view shows, as a child of the screen it was opened from
//              (`nav.down`, so Back returns). A saved copy keeps the button drawn and refuses on the tap
//              with the line `workspace-new-tab.tsx` gives: a control that comes and goes moves what is
//              around it.
export interface NewEntryInput {
  /** The machine and session this view shows. */
  scope: Scope | undefined;
  /** The herd on screen is the saved copy (`HomeData.stale`): nothing is created from it. */
  saved: boolean;
  /** This device may not write: a read-only device or one that is not paired. */
  readOnly: boolean;
  /** How many launcher rows that machine offers (`useLaunchers(scope).launchers.length`). */
  launcherCount: number;
}

export interface NewEntry {
  offered: boolean;
  open: () => void;
}

export function useNewEntry({ scope, saved, readOnly, launcherCount }: NewEntryInput): NewEntry {
  const nav = useNav();
  const canCreateSpace = useMuxCapability("createSpace", scope).capable;
  const screenless = !useMuxCapability("paneGrid", scope).capable;
  const offered = !readOnly && (canCreateSpace || launcherCount > 0 || screenless);
  const open = () => {
    if (saved) return setStatus(t("space.readOnly.savedCopy"), "error");
    nav.down(newPath({ machine: scope?.host, session: scope?.session }));
  };
  return { offered, open };
}
