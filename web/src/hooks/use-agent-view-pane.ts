import { useCallback, useMemo, useState } from "react";

import { postTrickViewSwitch } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { t } from "@/lib/i18n";
import { livePrefixes, picksAfter, picksFor, requestAfter, shownTrickName, type ViewPicks, type ViewRequest, type ViewRequestNote } from "@/lib/agent-view/reader";
import { noteAgentViewSwitch, refetchAgentViews, useAgentViewsAvailable, useAgentViewsOf, useShowAgentViews, viewKey } from "@/lib/agent-view/store";
import type { TrickViewSession, ViewDrawing, ViewScreen, ViewSent } from "@/lib/agent-view/wire";
import type { PaneView } from "@/lib/pane-view";
import { onBridgeClock } from "@/lib/server-clock";
import { useTricksState } from "@/lib/tricks/store";

// ONE SESSION'S AGENT VIEWS, for the session screen (components/agent-chat.tsx): which views it may have,
// which one is on, whether its body is on screen, its screen, the switches, and the way back to Chat or the
// terminal.
//
// WHICH VIEWS EXIST. A trick that is switched on and lists the place `agent-view` (the tricks list the
// phone already holds) gives each session one switch row, named by the trick's `name`; the bridge's views
// of this session (`GET /api/trick-views`) say which one is on. A view the bridge holds for a trick the
// list does not name yet still gets its row, by its id, so it can be switched off. At most one view is on
// per session: switching one on switches the others off, and the bridge's answer is what the rows show.
//
// THE WAY BACK IS A LOOK, NOT A SWITCH. With a view on, the View control offers it beside Terminal and
// Chat. Picking Terminal or Chat shows that body for this session (`aside`) and leaves the view on;
// picking the view shows it again. The choice lives in this component's state, for the session it was
// made on: a new session, a reload or turning the view off forgets it. No device preference is written.
//
// THE REQUEST AND THE PICKS LIVE HERE TOO, so a look at Terminal and back loses neither. The composer
// tells the hook when a send from the view starts and how it ended (`noteRequest`), per view; a tap the
// bridge confirmed is a pick (`notePressed`), kept while its block holds the same content. A tap the
// bridge refused as `stale_view` reads the screen again and leaves one quiet line (`noteChanged`): the
// tap is never sent again on its own.

/** One switch row of the session's sheet: a trick that may draw a view of this session. */
export interface AgentViewRow {
  /** The trick id the switch names. */
  trick: string;
  /** The trick's name, cut for the row ({@link shownTrickName}). */
  label: string;
  /** Its view of this session is on. */
  on: boolean;
}

export interface AgentViewPane {
  /** The bridge has agent views, this session may have one, and some trick offers one. */
  available: boolean;
  /** One switch row per trick that offers a view, in the tricks' order. */
  rows: readonly AgentViewRow[];
  /** The view that is on, or null. */
  active: TrickViewSession | null;
  /** The active trick's name, cut for the View choice and the way back; undefined with none on. */
  label: string | undefined;
  /** The active trick's whole name, for the band above the screen; undefined with none on. */
  name: string | undefined;
  /** A view of this session is on. */
  on: boolean;
  /** The view is on screen: on, and no look aside at Terminal or Chat. */
  showing: boolean;
  /** The screen the agent drew last. */
  view: ViewScreen | undefined;
  /** The screen was drawn in an earlier conversation: no live buttons. */
  stale: boolean;
  /** A question, a dialog or an answer box shows in the session: buttons wait, typing answers it. */
  question: boolean;
  /** The agent's `start`, or undefined. */
  drawing: ViewDrawing | undefined;
  /** The lines the bridge typed for this view, newest last. */
  sent: readonly ViewSent[];
  /** The latest send from this view, as the composer told it, or undefined (a reload). */
  request: ViewRequest | undefined;
  /** The composer's word on a send from the view. Pass it to the composer. */
  noteRequest: (note: ViewRequestNote) => void;
  /** The control paths of the buttons the operator picked on the screen now. */
  pressed: readonly string[];
  /** A tap the bridge confirmed: mark that button, and clear the mark of its siblings in the same bar. */
  notePressed: (control: string) => void;
  /** The bridge refused a tap as `stale_view`, until the next tap: the view says the screen changed. */
  changed: boolean;
  /** A tap was refused `stale_view`: read the screen again and say so. Never sends the tap again. */
  noteChanged: () => void;
  /** Where a send from the view goes while the view shows and no question waits: `{ trick, session }`. */
  target: { readonly trick: string; readonly session: string } | undefined;
  /** The body the operator looks at instead of the view, or null. */
  aside: PaneView | null;
  /** Look at Terminal or Chat instead (`null` returns to the view). */
  setAside: (view: PaneView | null) => void;
  /** Turn one trick's view of this session on or off. The words of the failure, or null when it took. */
  setOn: (trick: string, on: boolean) => Promise<string | null>;
}

const NO_SENT: readonly ViewSent[] = [];

export function useAgentViewPane({
  address,
  eligible,
  onChanged,
}: {
  /** The session's walky address (lib/walky.ts `paneAddress`). */
  address: string;
  /** A real agent session with a screen, on the lead: not a shell, not a durable conversation. */
  eligible: boolean;
  /** After a switch took, so the snapshot (and with it the views) is read again. */
  onChanged: () => void;
}): AgentViewPane {
  useShowAgentViews(address, eligible);
  const bridgeHasViews = useAgentViewsAvailable();
  const views = useAgentViewsOf(address);
  const { tricks } = useTricksState();
  const [asideHeld, setAsideHeld] = useState<{ address: string; view: PaneView } | null>(null);
  const [requests, setRequests] = useState<Readonly<Record<string, ViewRequest>>>({});
  const [picks, setPicks] = useState<ViewPicks | null>(null);
  const [changedHeld, setChangedHeld] = useState<string | null>(null);

  const offered = useMemo(() => {
    const names = new Map<string, string>();
    for (const trick of tricks) if (trick.agentView === true && trick.on && !names.has(trick.id)) names.set(trick.id, trick.name);
    for (const view of views) if (!names.has(view.trick)) names.set(view.trick, view.trick);
    return names;
  }, [tricks, views]);
  const rows = useMemo(
    (): AgentViewRow[] => [...offered].map(([trick, name]) => ({ trick, label: shownTrickName(name), on: views.some((view) => view.trick === trick && view.on) })),
    [offered, views],
  );

  const available = bridgeHasViews && eligible && rows.length > 0;
  const active = available ? (views.find((view) => view.on) ?? null) : null;
  const key = active === null ? "" : viewKey(active.trick, active.session);
  const on = active !== null;
  const aside = on && asideHeld?.address === address ? asideHeld.view : null;
  const showing = on && aside === null;
  const shown = active?.view;
  const live = useMemo(() => livePrefixes(shown), [shown]);
  const pressed = picksFor(picks, { key, live });
  const name = active === null ? undefined : (offered.get(active.trick) ?? active.trick);
  const question = active?.question === true;

  const setAside = useCallback((view: PaneView | null) => setAsideHeld(view === null ? null : { address, view }), [address]);

  const noteRequest = useCallback(
    (note: ViewRequestNote) => {
      if (key === "") return;
      // A new send answers the last "the screen changed" line.
      if (note.phase === "sending") setChangedHeld(null);
      setRequests((held) => ({ ...held, [key]: requestAfter(held[key], note, onBridgeClock(Date.now())) }));
    },
    [key],
  );

  const notePressed = useCallback(
    (control: string) => {
      if (shown === undefined || key === "") return;
      setPicks((held) => picksAfter(held, { key, live, control }));
    },
    [key, live, shown],
  );

  const noteChanged = useCallback(() => {
    if (key === "") return;
    setChangedHeld(key);
    void refetchAgentViews();
  }, [key]);

  const setOn = useCallback(
    async (trick: string, next: boolean): Promise<string | null> => {
      try {
        const answered = await postTrickViewSwitch({ trick, session: active?.trick === trick ? active.session : address, on: next });
        if (answered !== null) noteAgentViewSwitch(answered);
        setAsideHeld(null);
        onChanged();
        return null;
      } catch (thrown) {
        return t("view.switch.failed", { error: describeThrownError(thrown) });
      }
    },
    [active, address, onChanged],
  );

  return {
    available,
    rows,
    active,
    label: name === undefined ? undefined : shownTrickName(name),
    name,
    on,
    showing,
    view: shown,
    stale: active?.stale === true,
    question,
    drawing: active?.drawing,
    sent: active?.sent ?? NO_SENT,
    request: key === "" ? undefined : requests[key],
    noteRequest,
    pressed,
    notePressed,
    changed: key !== "" && changedHeld === key,
    noteChanged,
    target: showing && active !== null && !question ? { trick: active.trick, session: active.session } : undefined,
    aside,
    setAside,
    setOn,
  };
}
