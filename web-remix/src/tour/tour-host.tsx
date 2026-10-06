import type { Handle } from "remix/component";

import { hostName, leadHost, paneScope } from "@web/lib/hosts";
import { homePath, pairedDevicesPath, panePath } from "@web/lib/nav";
import { triage } from "@web/lib/triage";
import { isReadOnly, type AgentView } from "@web/lib/types";

import { address, config, snapshot } from "../lib/data";
import { useLocale } from "../lib/i18n-store";
import { scheduleUpdate, useStore } from "../lib/store";
import { goDown, goSide } from "../routes/frame/up";
import { NewSpaceSheet } from "../routes/home/new-space-sheet";
import { enablePush, getPushState, pushState, type EnableResult } from "../routes/settings/push";
import { installOffered, promptInstall } from "../routes/settings/install";
import { markTourSeen, readTourSeen, shouldShowTour } from "./store";
import { TourSheet, type TourExit } from "./tour-sheet";

// THE FIRST-RUN GATE, port of web/src/components/tour-sheet.tsx (`TourHost`, `FirstRunLive`), mounted
// ONCE from the Shell (shell.tsx) at module scope and never remounted (REMIX3.md rule 6). It opens the
// sheet on the first render where the screen is unseen AND the snapshot on screen is real (a poll that
// failed is not a first launch worth narrating), and marks it seen the moment it opens, never on close:
// a phone that loses the tab half way down is not shown it again on its own, and the Settings row is the
// whole recovery path (it writes "0" and navigates; the navigation re-renders the Shell, this host asks
// storage again, and the screen opens).
//
// A READ-ONLY DEVICE SEES IT. Two rows branch their copy instead, and the first "Do this next" card
// becomes the repair.
//
// THE HOST SUBSCRIBES to the snapshot (what it gates on and counts), the config (the multiplexer's
// name), the address (the scope its exits navigate in), the push state and the install offer. A Shell
// update re-renders it too, which is what makes the reset above work.
//
// Differences from web/: "New space" closes the sheet and opens the new-space sheet from here (web's
// host unmounts the very component that holds that sheet, in the same batch, so the sheet it opens
// never shows). No push-setup race to arbitrate: this shell has no boot-time push prompt.
export function TourHost(handle: Handle) {
  useLocale(handle);
  const readSnapshot = useStore(handle, snapshot);
  const readConfig = useStore(handle, config);
  const readPush = useStore(handle, pushState);
  const readOffered = useStore(handle, installOffered);

  let open = false;
  let spaceOpen = false;
  let pushBusy = false;

  const decide = (): void => {
    if (open || spaceOpen) return;
    const loaded = snapshot.get();
    // Not a live snapshot: nothing came yet, or the last poll failed (an auth refusal included).
    if (loaded.data === undefined || loaded.error !== undefined) return;
    if (!shouldShowTour(readTourSeen())) return;
    // Marked seen HERE, before the screen paints. Nothing in the close path writes the key.
    markTourSeen();
    open = true;
    void getPushState();
    scheduleUpdate(handle);
  };

  const setPushEnabled = async (): Promise<EnableResult> => {
    pushBusy = true;
    scheduleUpdate(handle);
    try {
      return await enablePush();
    } finally {
      try {
        await getPushState();
      } finally {
        pushBusy = false;
        if (!handle.signal.aborted) scheduleUpdate(handle);
      }
    }
  };

  const exit = (reason: TourExit): void => {
    open = false;
    scheduleUpdate(handle);
    const body = snapshot.get().data;
    const scope = address.get().scope;
    const servers = body?.servers;
    if (reason === "pair") {
      goDown(pairedDevicesPath(scope));
      return;
    }
    if (reason === "space") {
      spaceOpen = true;
      return;
    }
    if (reason === "pane") {
      // The blocked panes in the dashboard's own order (lib/triage.ts): the first section is "needs
      // you", so this button and the list under it never disagree about which pane is the urgent one.
      const blocked: AgentView | undefined = triage(body?.agents ?? [])[0]?.agents[0];
      if (blocked) {
        goDown(panePath(blocked.paneId, paneScope(scope, blocked, servers, body?.sessions)));
        return;
      }
    }
    // The dashboard the tour sits on: a sideways replace, never a second dashboard entry (ADR 0067).
    if (reason === "dashboard" || reason === "pane") goSide(homePath(scope));
  };

  const closeSpace = (): void => {
    spaceOpen = false;
    scheduleUpdate(handle);
  };

  return () => {
    // The gate asks after each commit: storage can change under it (the Settings reset), and a render
    // may not write a store, so the question is a task, not a branch.
    handle.queueTask(decide);
    const body = readSnapshot().data;
    const servers = body?.servers;
    const agents = body?.agents ?? [];
    const needs = triage(agents)[0]?.agents ?? [];
    return (
      <>
        <TourSheet
          open={open}
          onClose={exit}
          mux={readConfig().data?.mux?.name ?? ""}
          host={hostName(servers, leadHost(servers))}
          panes={agents.length}
          needsYou={needs.length}
          machines={servers?.length ?? 0}
          readOnly={isReadOnly(body?.device)}
          pushState={readPush()}
          pushBusy={pushBusy}
          onEnablePush={setPushEnabled}
          installOffer={readOffered()}
          onInstall={() => void promptInstall()}
        />
        {/* The "Nothing is running yet" card's remedy, mounted HERE: the gate is not always opened over
            the dashboard. It is mounted only while it is wanted, so the Shell does not carry its
            subscriptions the rest of the time. The card only appears when nothing is running, so there
            is no open space to branch a worktree from. */}
        {spaceOpen && <NewSpaceSheet open onClose={closeSpace} />}
      </>
    );
  };
}
