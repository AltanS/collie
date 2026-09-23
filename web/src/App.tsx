import { RouterProvider } from "react-router";

import { router } from "./router";
import { BusyBar } from "@/components/busy-bar";
import { IdleLock } from "@/components/idle-lock";
import { UpdateScreen } from "@/components/update-screen";
import { UpdateScreenProvider, useUpdateScreenValue } from "@/components/update-screen-provider";
import { useIdleLock } from "@/hooks/use-idle-lock";
import { useCatchingUp } from "@/lib/idle";

// THE PROVIDER IS OUTERMOST, and it has to be: the reading is owned out here, beside the sheet,
// and it is also needed INSIDE the router, where the band lives. One hook call, handed to both.
// See `components/update-screen-provider.tsx` for why the badge moved into the band at all.
export function App() {
  return (
    <UpdateScreenProvider>
      <AppShell />
    </UpdateScreenProvider>
  );
}

// The idle lock COVERS the app rather than replacing it. It used to render instead of the router,
// which unmounted the whole route tree — and with it every piece of local component state, including
// an in-progress reply draft (composer.tsx keeps its draft, upload and sheets entirely local). Coming
// back from a pause silently ate what you'd typed. Now the router stays mounted and polling is what
// pauses (use-polling's tick reads lib/idle), so resuming restores the exact screen, draft and scroll.
//
// `inert` on a display:contents wrapper takes the covered app out of focus and the a11y tree without
// generating a box, so it can't change layout — the cover already blocks pointers, this closes the
// keyboard path behind it.
function AppShell() {
  const { locked, unlock } = useIdleLock();
  // The cover outlives the lock by one beat: resuming refetches, and dropping the cover the instant
  // you tap would hand you back the same stale screen it just told you was frozen (see lib/idle).
  const catchingUp = useCatchingUp();
  const covered = locked || catchingUp;
  // THE UPDATE SCREEN IS THE IDLE LOCK'S SECOND COUSIN, and it is mounted the same way: a sibling of
  // the wrapper it makes inert, never inside it, because a node cannot be both inert and the host of
  // the dialog that made it inert. The reading decides whether it shows at all: update mode's panel
  // is up on the device that started the run, and a device that did not start it gets a strip in the
  // band and keeps its app (lib/update-screen.ts, ADR 0064). Whenever the panel is up, the app behind
  // its veil is inert.
  //
  // The wrapper's `inert` is the OR of the two facts, and each of them keeps its own reason: the idle
  // lock pauses a screen nobody is touching, and this blocks a screen whose machine is being rebuilt
  // under it.
  const screen = useUpdateScreenValue();
  // BusyBar overlays every route (fixed, top of viewport) — a mutation anywhere shows the strip.
  return (
    <>
      <div style={{ display: "contents" }} inert={covered || screen.blocking}>
        <BusyBar />
        <RouterProvider router={router} />
      </div>
      {covered && <IdleLock onUnlock={unlock} catchingUp={catchingUp} />}
      <UpdateScreen screen={screen} />
    </>
  );
}
