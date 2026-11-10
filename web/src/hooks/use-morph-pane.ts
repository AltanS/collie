import { useCallback, useState } from "react";

import { postMorphSwitch } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { t } from "@/lib/i18n";
import { noteMorphSwitch, useMorphAvailable, useMorphSession } from "@/lib/morph/store";
import type { MorphView } from "@/lib/morph/wire";
import type { PaneView } from "@/lib/pane-view";

// ONE SESSION'S MORPH, for the session screen (components/agent-chat.tsx): whether it is on, whether its
// body is on screen, its hint and its screen, the switch, and the way back to Chat or the terminal.
//
// THE WAY BACK IS A LOOK, NOT A SWITCH. With Morph on, the View control offers Morph beside Terminal and
// Chat. Picking Terminal or Chat shows that body for this session (`aside`) and leaves Morph on; picking
// Morph shows it again. The choice lives in this component's state, for the session it was made on: a
// new session, a reload or turning Morph off forgets it. No device preference is written.

export interface MorphPane {
  /** The bridge has Morph and this session may use it. */
  available: boolean;
  /** The session's Morph is on. */
  on: boolean;
  /** The Morph body is on screen: on, and no look aside at Terminal or Chat. */
  showing: boolean;
  /** The hint a send carries while the Morph body shows, or undefined. */
  hint: string | undefined;
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
  const available = bridgeHasMorph && eligible;
  const on = available && session?.on === true;
  const aside = on && asideHeld?.address === address ? asideHeld.view : null;
  const showing = on && aside === null;
  const hint = showing && session !== null && session.hint !== "" ? session.hint : undefined;

  const setAside = useCallback(
    (view: PaneView | null) => setAsideHeld(view === null ? null : { address, view }),
    [address],
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

  return { available, on, showing, hint, view: on ? session?.view : undefined, aside, setAside, setOn };
}
