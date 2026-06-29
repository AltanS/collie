import { RouterProvider } from "react-router-dom";

import { router } from "./router";
import { IdleLock } from "@/components/idle-lock";
import { useIdleLock } from "@/hooks/use-idle-lock";

// The idle lock gates the whole app: while locked we render the lock screen instead of the router,
// which unmounts the route tree and so pauses all polling. The router instance lives at module
// scope (see router.tsx), so unlocking restores the same location and re-runs loaders for fresh data.
export function App() {
  const { locked, unlock } = useIdleLock();
  if (locked) return <IdleLock onUnlock={unlock} />;
  return <RouterProvider router={router} />;
}
