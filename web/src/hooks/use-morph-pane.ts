import { useCallback, useMemo, useState } from "react";

import { postMorphSwitch } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { t } from "@/lib/i18n";
import { noteMorphSwitch, useMorphAvailable, useMorphSession } from "@/lib/morph/store";
import { livePrefixes, picksAfter, picksFor, requestAfter, type MorphPicks, type MorphRequest, type MorphRequestNote } from "@/lib/morph/reader";
import type { MorphDrawing, MorphView } from "@/lib/morph/wire";
import type { PaneView } from "@/lib/pane-view";
import { onBridgeClock } from "@/lib/server-clock";

// ONE SESSION'S MORPH, for the session screen (components/agent-chat.tsx): whether it is on, whether its
// body is on screen, its hint and its screen, the switch, and the way back to Chat or the terminal.
//
// THE WAY BACK IS A LOOK, NOT A SWITCH. With Morph on, the View control offers Morph beside Terminal and
// Chat. Picking Terminal or Chat shows that body for this session (`aside`) and leaves Morph on; picking
// Morph shows it again. The choice lives in this component's state, for the session it was made on: a
// new session, a reload or turning Morph off forgets it. No device preference is written.
//
// THE REQUEST AND THE PICKS LIVE HERE TOO, so a look at Terminal and back loses neither. The composer
// tells the hook when a send that carried the hint starts and how it ended (`noteRequest`), per session;
// the Morph body shows the text at once and the status under it. A tap the bridge confirmed is a pick
// (`notePressed`): its button stays marked while its block holds the same content (lib/morph/reader.ts,
// "controls, keyed by block"), and a pick in the same bar moves the mark.

export interface MorphPane {
  /** The bridge has Morph and this session may use it. */
  available: boolean;
  /** The session's Morph is on. */
  on: boolean;
  /** The Morph body is on screen: on, and no look aside at Terminal or Chat. */
  showing: boolean;
  /** The head a send carries in front of its text while the Morph body shows, or undefined (an older bridge, or no Morph body). */
  head: string | undefined;
  /** The tail a send carries behind its text while the Morph body shows, or undefined. */
  hint: string | undefined;
  /** The agent's `morph start`, or undefined. */
  drawing: MorphDrawing | undefined;
  /** The latest send of this session that carried the hint, as the composer told it, or undefined (a reload). */
  request: MorphRequest | undefined;
  /** The composer's word on a send that carried the hint. Pass it to the composer. */
  noteRequest: (note: MorphRequestNote) => void;
  /** The control paths of the buttons the operator picked on the screen now. */
  pressed: readonly string[];
  /** A tap the bridge confirmed: mark that button, and clear the mark of its siblings in the same bar. */
  notePressed: (control: string) => void;
  /** The screen the agent drew last. */
  view: MorphView | undefined;
  /** The body the operator looks at instead of Morph, or null. */
  aside: PaneView | null;
  /** Look at Terminal or Chat instead (`null` returns to Morph). */
  setAside: (view: PaneView | null) => void;
  /** Turn the session's Morph on or off. The words of the failure, or null when it took. */
  setOn: (on: boolean) => Promise<string | null>;
}

export function useMorphPane({
  address,
  eligible,
  onChanged,
}: {
  /** The session's walky address (lib/walky.ts `paneAddress`). */
  address: string;
  /** A real agent session with a screen: not a shell, not a durable conversation. */
  eligible: boolean;
  /** After a switch took, so the snapshot (and with it the Morph list) is read again. */
  onChanged: () => void;
}): MorphPane {
  const bridgeHasMorph = useMorphAvailable();
  const session = useMorphSession(address);
  const [asideHeld, setAsideHeld] = useState<{ address: string; view: PaneView } | null>(null);
  const [requests, setRequests] = useState<Readonly<Record<string, MorphRequest>>>({});
  const [picks, setPicks] = useState<MorphPicks | null>(null);
  const available = bridgeHasMorph && eligible;
  const on = available && session?.on === true;
  const aside = on && asideHeld?.address === address ? asideHeld.view : null;
  const showing = on && aside === null;
  // The head names the session; the tail rides only while the bridge does not know the session holds the rules.
  const head = showing && session !== null && session.head !== undefined && session.head !== "" ? session.head : undefined;
  const hint = showing && session !== null && session.hint !== undefined && session.hint !== "" ? session.hint : undefined;
  const shown = on ? session?.view : undefined;
  const live = useMemo(() => livePrefixes(shown), [shown]);
  const pressed = picksFor(picks, { address, live });

  const setAside = useCallback(
    (view: PaneView | null) => setAsideHeld(view === null ? null : { address, view }),
    [address],
  );

  const noteRequest = useCallback(
    (note: MorphRequestNote) =>
      setRequests((held) => ({ ...held, [address]: requestAfter(held[address], note, onBridgeClock(Date.now())) })),
    [address],
  );

  const notePressed = useCallback(
    (control: string) => {
      if (shown === undefined) return;
      setPicks((held) => picksAfter(held, { address, live, control }));
    },
    [address, live, shown],
  );

  const setOn = useCallback(
    async (next: boolean): Promise<string | null> => {
      try {
        const answered = await postMorphSwitch({ session: address, on: next });
        noteMorphSwitch(address, next, answered);
        setAsideHeld(null);
        onChanged();
        return null;
      } catch (thrown) {
        return t("morph.switch.failed", { error: describeThrownError(thrown) });
      }
    },
    [address, onChanged],
  );

  return {
    available,
    on,
    showing,
    head,
    hint,
    drawing: on ? session?.drawing : undefined,
    request: requests[address],
    noteRequest,
    pressed,
    notePressed,
    view: shown,
    aside,
    setAside,
    setOn,
  };
}
