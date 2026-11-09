import { useEffect } from "react";
import { useLocation } from "react-router";

import { useOptionalRootData } from "@/lib/route-data";
import { liveSpaceOf, rememberSlotPane } from "@/lib/slots";

/** Keep this tab's slot on the pane it shows (lib/slots.ts). Called once, in the root layout. */
export function useSlotMemory(): void {
  const { pathname, search } = useLocation();
  const root = useOptionalRootData();
  // A herd kept from before the bridge went away says nothing about where the pane sits now.
  const space = root === undefined || root.error ? undefined : liveSpaceOf(`${pathname}${search}`, root);
  useEffect(() => {
    rememberSlotPane(pathname, search, undefined, undefined, space);
  }, [pathname, search, space]);
}
