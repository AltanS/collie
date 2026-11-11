import { useEffect, useRef, useState } from "react";

import { fetchHillCrewState, setHillCrewState, tellHillSessions } from "@/lib/api";
import { noteHillCrewState, readHillNow, useHillCrewState } from "@/lib/hill/store";
import type { HillCrewState, HillCrewStateView } from "@/lib/hill/wire";
import { mutate } from "@/lib/mutate";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import { isReadOnly } from "@/lib/types";

// THE CREW STATE, ON THE PHONE (1.29.0, bridge/hill/crew-state.ts). The lead owns the value; the Hill's
// list carries it, and a change moves the hill's number, so every phone reads it as it reads a new card.
// The route also reads `GET /api/hill/state` once when it opens: a lead that never had a Decision sends
// no number, and a member answers no state at all, so its Hill shows no control.
//
// A tap writes `POST /api/hill/state`, holds the new value while the call runs, and takes the lead's
// answer. A refused write puts the control back and says so in a line under it (ack-manifest
// `setHillCrewState`). "Tell all sessions now" sends `{ at }` of the change it was offered for, so a tap
// that meets a newer change does nothing; once told, the lead keeps the count and the button reads done.

export interface HillCrewStateControl {
  /** The lead's value, or null when this bridge serves none: the route then draws no control. */
  view: HillCrewStateView | null;
  /** The value the control shows: the one a tap asked for while its call runs, else the lead's. */
  value: HillCrewState;
  /** A write is in flight: a second tap does nothing. */
  busy: boolean;
  /** This device may move it: it is paired with the write right. */
  canWrite: boolean;
  /** The last write was refused or failed. */
  failed: boolean;
  set: (next: HillCrewState) => Promise<void>;
  /** "Tell all sessions now": in flight, failed, and the count this phone got back before the next list. */
  telling: boolean;
  tellFailed: boolean;
  tell: () => Promise<void>;
}

export function useHillCrewStateControl(): HillCrewStateControl {
  const root = useOptionalRootData();
  const { refused } = usePairing();
  const canWrite = !isReadOnly(root?.device) && !refused;
  const view = useHillCrewState();
  const [held, setHeld] = useState<HillCrewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [telling, setTelling] = useState(false);
  const [tellFailed, setTellFailed] = useState(false);
  const inFlight = useRef(false);

  // Once per opening of the route: the lead's own value, for a Hill whose list has not come yet.
  useEffect(() => {
    const abort = new AbortController();
    fetchHillCrewState(abort.signal).then(noteHillCrewState, () => undefined);
    return () => abort.abort();
  }, []);

  // A new change (here, or another phone) clears a failed tell's line: it was for the change before.
  const at = view?.at ?? null;
  useEffect(() => setTellFailed(false), [at]);

  async function set(next: HillCrewState): Promise<void> {
    if (inFlight.current || next === (view?.state ?? "here")) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    setHeld(next);
    const res = await mutate(() => setHillCrewState(next), { ownError: true });
    if (res.ok) {
      noteHillCrewState(res.value);
      readHillNow();
    } else setFailed(true);
    setHeld(null);
    inFlight.current = false;
    setBusy(false);
  }

  async function tell(): Promise<void> {
    if (inFlight.current || view === null || view.at === null || view.told !== null) return;
    inFlight.current = true;
    setTelling(true);
    setTellFailed(false);
    const told = view;
    const res = await mutate(() => tellHillSessions(told.at ?? 0), { ownError: true });
    if (res.ok) {
      noteHillCrewState({ ...told, told: res.value });
      readHillNow();
    } else {
      setTellFailed(true);
      // A refusal may be "told already" from another phone: the next list says so on the button.
      readHillNow();
    }
    inFlight.current = false;
    setTelling(false);
  }

  return { view, value: held ?? view?.state ?? "here", busy, canWrite, failed, set, telling, tellFailed, tell };
}
