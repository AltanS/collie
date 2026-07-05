import { RouterProvider } from "react-router";

import { router } from "./router";
import { BusyBar } from "@/components/busy-bar";
import { IdleLock } from "@/components/idle-lock";
import { useIdleLock } from "@/hooks/use-idle-lock";

// The idle lock gates the whole app: while locked we render the lock screen instead of the router,
// which unmounts the route tree and so pauses all polling. The router instance lives at module
// scope (see router.tsx), so unlocking restores the same location and re-runs loaders for fresh data.
export function App() {
  const { locked, unlock } = useIdleLock();
  if (locked) return <IdleLock onUnlock={unlock} />;
  // BusyBar overlays every route (fixed, top of viewport) — a mutation anywhere shows the strip.
  return (
    <>
      <BusyBar />
      <RouterProvider router={router} />
    </>
  );
}
