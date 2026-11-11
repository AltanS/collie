import { useRef, useState } from "react";
import { useRevalidator } from "react-router";

import { clearHillClosed, clearHillSpoken } from "@/lib/api";
import { clearClosedLocally, readHillNow } from "@/lib/hill/store";
import { t } from "@/lib/i18n";
import { mutate } from "@/lib/mutate";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import { setStatus } from "@/lib/status";
import { isReadOnly } from "@/lib/types";

// CLEAR, ON THE PHONE (the Answered group's button). One tap-pair removes every closed Decision: the rows
// leave the list AT ONCE (the optimistic part), `POST /api/hill/clear` runs, and on a refusal the rows come
// back and the status line says "Could not clear. Try again." The bridge moves the hill's number when it
// clears, so every phone reads the new list from the snapshot; the revalidate here only makes this phone
// read it now. A device that may not write sees the button disabled, as the Hill's switch is.

export interface HillClearState {
  /** A clear is in flight: a second tap does nothing. */
  busy: boolean;
  /** This device may clear: it is paired with the write right. */
  canWrite: boolean;
  clear: () => Promise<void>;
  /** The second Clear (1.29.0): the open cards answered in the session. Nothing is typed. */
  clearSpoken: () => Promise<void>;
}

export function useHillClear(): HillClearState {
  const root = useOptionalRootData();
  const revalidator = useRevalidator();
  const { refused } = usePairing();
  const canWrite = !isReadOnly(root?.device) && !refused;
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  async function clear(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const putBack = clearClosedLocally();
    const res = await mutate(() => clearHillClosed(), { ownError: true });
    if (res.ok) revalidator.revalidate();
    else {
      putBack();
      setStatus(t("hill.clear.failed"), "error");
    }
    inFlight.current = false;
    setBusy(false);
  }

  async function clearSpoken(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    // Not optimistic: the cards are open, and an open card that left and came back would be a jump.
    const res = await mutate(() => clearHillSpoken(), { ownError: true });
    if (res.ok) {
      readHillNow();
      revalidator.revalidate();
    } else setStatus(t("hill.clear.failed"), "error");
    inFlight.current = false;
    setBusy(false);
  }

  return { busy, canWrite, clear, clearSpoken };
}
