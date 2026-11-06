import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router";

import { fetchSnapshot } from "@/lib/api";
import { homePath } from "@/lib/nav";
import { scopeFromUrl } from "@/lib/scope";
import { enterSlot, liveSpaceOf, slotSpace } from "@/lib/slots";

/**
 * The stored address, unless its id now sits in another workspace: then that scope's home, since
 * the pane there would take the operator's words for someone else's. A bridge that cannot answer
 * leaves the address to the pane route, as does a pane it no longer lists.
 */
async function landing(address: string, space: string | undefined, signal: AbortSignal): Promise<string> {
  if (space === undefined) return address;
  const scope = scopeFromUrl(new URL(address, location.origin).href);
  try {
    const live = liveSpaceOf(address, await fetchSnapshot(scope, signal));
    return live !== undefined && live !== space ? homePath(scope) : address;
  } catch {
    return address;
  }
}

/** `/slot/<n>`: draws nothing and replaces itself with the slot's last pane (lib/slots.ts). */
export function SlotRoute() {
  const { slot } = useParams();
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const go = async () => {
      const target = await landing(enterSlot(slot), slotSpace(slot), controller.signal);
      if (!controller.signal.aborted) setTo(target);
    };
    void go();
    return () => controller.abort();
  }, [slot]);
  return to === null ? null : <Navigate to={to} replace />;
}
