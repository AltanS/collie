import { createContext, useContext, type ReactNode } from "react";

import { useUpdateScreen, type UpdateScreen } from "@/hooks/use-update-screen";

// ── ONE READING OF THE UPDATE SCREEN, FOR BOTH SIDES OF THE ROUTER ──────────────────────────────
//
// `hooks/use-update-screen.ts` holds four pieces of state that are about THIS DOCUMENT rather than
// about the run: the two ways out the operator has taken, whether a badge was opened by hand, and
// whether the end has been announced. Calling the hook twice would be two copies of those, which is
// two opinions about one screen — so it is called exactly once, here, and handed out.
//
// ── WHY THAT MATTERS NOW (2026-09-20) ───────────────────────────────────────
// The sheet is mounted in `App.tsx`, OUTSIDE the router, because a node cannot be both `inert` and
// the host of the dialog that made it inert. The collapsed badge used to be mounted there too, as a
// `fixed inset-x-0 bottom-0` bar — and on a pane screen that bar lies exactly on the composer's
// input row. The badge shows on a device that did not start the run, and after "keep using the app"
// on a stalled download; the second of those hands the app back and then parks a bar on the one
// control you were handed it for.
//
// A badge is a persistent one-line fact, and this app has ONE place for those: the band above the
// header (`ui/strip-host.tsx`), which lives inside the router. So the badge moved there
// (`components/update-run-strip.tsx`) and this context is what reaches across the boundary. The
// sheet keeps the screen; the band keeps the line.

const UpdateScreenContext = createContext<UpdateScreen | null>(null);

/**
 * The reading, or `null` outside a provider.
 *
 * `null` rather than a throw, and for the same reason `CrewProvider` defaults to solo: half the
 * consumers are unit-tested bare, and "no provider ⇒ no update on screen" is the correct answer for
 * a tree that has no App above it.
 */
export function useOptionalUpdateScreen(): UpdateScreen | null {
  return useContext(UpdateScreenContext);
}

/** The reading, for a consumer that is only ever mounted under the provider (`App.tsx`'s own shell). */
export function useUpdateScreenValue(): UpdateScreen {
  const value = useContext(UpdateScreenContext);
  if (value === null) throw new Error("useUpdateScreenValue outside <UpdateScreenProvider>");
  return value;
}

export function UpdateScreenProvider({ children }: { children: ReactNode }) {
  const screen = useUpdateScreen();
  return <UpdateScreenContext.Provider value={screen}>{children}</UpdateScreenContext.Provider>;
}
