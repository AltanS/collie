import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { NewTabSheet, type NewTabBeside } from "@/components/new-tab-sheet";
import type { StartAsk, StartOutcome } from "@/hooks/use-spaces";
import { hostKey } from "@/lib/hosts";
import { launchersKey, useLaunchers } from "@/lib/launchers";
import { hasSheetRows, launchersLoaded, sheetRows } from "@/lib/new-tab-sheet";
import type { Scope } from "@/lib/scope";
import type { AgentView } from "@/lib/types";

// THE "+" THAT OFFERS YOUR AGENTS (M91 spec 02, ADR 0131). Every "+" that opens a tab, the tab row's on
// the space view and in the pane view and a dashboard heading's, asks this hook instead of `newTab`. It
// decides, one tap at a time:
//
//   1. The create gates first (`refuseCreate`): a device that may not write, or a saved copy on screen,
//      gets the refusal `newTab` gives, and no sheet opens.
//   2. A workspace whose pane is not in hand (a dashboard group that holds only a linked worktree's
//      panes) gets the plain create: a start beside some other space's pane would open the tab there.
//   3. A machine whose answer is in and offers nothing beyond the shell gets the shell at once, as the
//      "+" always did (decision 4). The bridge lists every agent Collie knows, installed or not, so
//      "nothing" is "nothing that can start".
//   4. Everything else opens the New tab sheet for that workspace.
//
// ONE SHEET PER CALLER, keyed on the chosen workspace. The list is read for one machine at a time: the
// ambient one from the start, so a solo install and a space view decide on the first tap, and the
// heading's own machine once a crew member's heading is tapped. A tap before that answer is in opens
// the sheet, which says it is reading and lists no other machine's rows; when the answer then holds
// nothing to offer, the sheet steps aside for the shell. Every opening reads the list again, so a row
// added to `launchers.toml` shows on the next "+", and so does a row taken away.

export interface NewTabTarget {
  workspaceId: string;
  /** The workspace's name, for the sheet's title. */
  label: string;
  /** The workspace's machine and session. Absent: the ambient scope, as `newTab` reads it. */
  at?: Scope;
  /** A pane of that workspace, to open the tab beside. Absent: the plain create. */
  beside?: NewTabBeside;
}

export interface NewTabActions {
  newTab: (workspaceId: string, at?: Scope) => Promise<void>;
  start: (ask: StartAsk, at?: Scope) => Promise<StartOutcome>;
  refuseCreate: () => boolean;
}

/** The first pane of `workspaceId` on `host`, as the sheet's `beside`; `undefined` when none is listed. */
export function besideOf(panes: readonly AgentView[], workspaceId: string, host: string | undefined): NewTabBeside | undefined {
  // Matched on the machine as the tab strip counts it: a crew's machines number their spaces from `w1`
  // each, and a solo snapshot's panes carry no host at all.
  const pane = panes.find((p) => p.workspaceId === workspaceId && hostKey(p) === (host ?? ""));
  return pane === undefined ? undefined : { paneId: pane.paneId, workspaceId: pane.workspaceId, cwd: pane.cwd };
}

/** What a "+" caller gets: the tap, and the sheet to render once (it is `null` while none is open). */
export interface NewTabOrSheet {
  request: (target: NewTabTarget) => void;
  sheet: ReactNode;
}

export function useNewTabOrSheet(actions: NewTabActions, ambient: Scope | undefined): NewTabOrSheet {
  // The machine whose list is read: the ambient one until a tap names another.
  const [listAt, setListAt] = useState<Scope | undefined>(ambient);
  const [target, setTarget] = useState<NewTabTarget | null>(null);
  const launchers = useLaunchers(listAt);
  const { newTab, start, refuseCreate } = actions;
  const { reload } = launchers;

  // Back to the ambient machine while no sheet is open, so the next tap on this view decides at once.
  const ambientKey = launchersKey(ambient);
  const ambientRef = useRef(ambient);
  ambientRef.current = ambient;
  useEffect(() => {
    if (target === null) setListAt((was) => (launchersKey(was) === ambientKey ? was : ambientRef.current));
  }, [ambientKey, target]);

  const request = useCallback(
    (asked: NewTabTarget) => {
      if (refuseCreate()) return;
      if (asked.beside === undefined) {
        void newTab(asked.workspaceId, asked.at);
        return;
      }
      const at = asked.at ?? ambient;
      if (launchersLoaded(launchers, at) && !hasSheetRows(sheetRows(launchers, at))) {
        // Read again behind the shell, so a row added since shows on the next "+".
        reload();
        void newTab(asked.workspaceId, asked.at);
        return;
      }
      if (launchersKey(at) === launchersKey(listAt)) reload();
      else setListAt(at);
      setTarget(asked);
    },
    [refuseCreate, newTab, ambient, launchers, listAt, reload],
  );

  // The answer came in while the sheet was open, and it offers nothing beyond the shell: the shell, as
  // the "+" always made it. The sheet never shows one row plus a shell for nothing.
  const at = target?.at ?? ambient;
  const empty = target !== null && launchersLoaded(launchers, at) && !hasSheetRows(sheetRows(launchers, at));
  useEffect(() => {
    if (!empty || target === null) return;
    setTarget(null);
    void newTab(target.workspaceId, target.at);
  }, [empty, target, newTab]);

  const close = useCallback(() => setTarget(null), []);
  const sheet =
    target === null || target.beside === undefined ? null : (
      <NewTabSheet
        key={`${launchersKey(at)}\u0000${target.workspaceId}`}
        open={!empty}
        onClose={close}
        label={target.label}
        beside={target.beside}
        scope={at}
        launchers={launchers}
        start={start}
      />
    );
  return { request, sheet };
}
