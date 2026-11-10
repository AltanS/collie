import { useEffect, useState } from "react";
import { useRevalidator } from "react-router";

import { setHillSwitch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { mutate } from "@/lib/mutate";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import { setStatus } from "@/lib/status";
import { isReadOnly } from "@/lib/types";

// THE HILL'S SWITCH, ON THE PHONE (bridge/hill/switch.ts). The bridge owns the value and the snapshot
// carries it (`hillOff`, root data), so every place that shows it reads the same thing on every phone.
// A tap writes `POST /api/hill/switch`, holds the new position until the snapshot agrees, and
// revalidates so it agrees at once. A refused write puts the switch back and says so on the status line.
// Settings → Alerts and the Hill's own off state are the two callers.

export interface HillSwitchState {
  /** Whether the Hill is on, as the bridge says, or as the last tap asked while the snapshot catches up. */
  on: boolean;
  /** A write is in flight: a second tap does nothing. */
  busy: boolean;
  /** This device may move it: it is paired with the write right. */
  canWrite: boolean;
  set: (on: boolean) => Promise<void>;
}

export function useHillSwitch(): HillSwitchState {
  const root = useOptionalRootData();
  const revalidator = useRevalidator();
  const { refused } = usePairing();
  const canWrite = !isReadOnly(root?.device) && !refused;
  const fromBridge = root?.hillOff !== true;
  const [held, setHeld] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  // The snapshot caught up with the position a tap holds: the bridge speaks again.
  useEffect(() => {
    if (held !== null && held === fromBridge) setHeld(null);
  }, [held, fromBridge]);

  async function set(next: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    setHeld(next);
    const res = await mutate(() => setHillSwitch(next), { ownError: true });
    if (res.ok) {
      setHeld(res.value);
      revalidator.revalidate();
    } else {
      setHeld(null);
      setStatus(t("settings.hill.switchFailed"), "error");
    }
    setBusy(false);
  }

  return { on: held ?? fromBridge, busy, canWrite, set };
}
