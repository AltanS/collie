import { useEffect } from "react";
import { useLocation } from "react-router";

import { rememberSlotPane } from "@/lib/slots";

/** Keep this tab's slot on the pane it shows (lib/slots.ts). Called once, in the root layout. */
export function useSlotMemory(): void {
  const { pathname, search } = useLocation();
  useEffect(() => {
    rememberSlotPane(pathname, search);
  }, [pathname, search]);
}
