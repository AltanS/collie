import { RouterProvider } from "react-router";

import { router } from "./router";
import { BusyBar } from "@/components/busy-bar";
import { IdleLock } from "@/components/idle-lock";
import { useIdleLock } from "@/hooks/use-idle-lock";

// The idle lock COVERS the app rather than replacing it. It used to render instead of the router,
// which unmounted the whole route tree — and with it every piece of local component state, including
// an in-progress reply draft (composer.tsx keeps its draft, upload and sheets entirely local). Coming
// back from a pause silently ate what you'd typed. Now the router stays mounted and polling is what
// pauses (use-polling's tick reads lib/idle), so resuming restores the exact screen, draft and scroll.
//
// `inert` on a display:contents wrapper takes the covered app out of focus and the a11y tree without
// generating a box, so it can't change layout — the cover already blocks pointers, this closes the
// keyboard path behind it.
export function App() {
  const { locked, unlock } = useIdleLock();
  // BusyBar overlays every route (fixed, top of viewport) — a mutation anywhere shows the strip.
  return (
    <>
      <div style={{ display: "contents" }} inert={locked}>
        <BusyBar />
        <RouterProvider router={router} />
      </div>
      {locked && <IdleLock onUnlock={unlock} />}
    </>
  );
}
