import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

/**
 * Where a transient event floats. The overlay half of the alert system.
 *
 * The line the whole design turns on: a notice that will outlive the operator's next interaction
 * HOLDS SPACE; anything shorter floats. A standing condition costs space because it costs
 * capability — "you are read-only" gates the composer, and an overlay carrying that either sits
 * over the content for minutes or fades and leaves the operator with an inexplicably dead
 * composer. An event is the opposite: it passes on its own, so holding space for it means the
 * page moves twice for something that was true for two seconds. This component is for the second
 * kind, and it is the only layer in the app that is allowed to cover content.
 *
 * It owns POSITION and nothing else. What floats in it — the status line, its ground, its
 * dismissal — belongs to the feature that renders inside it.
 *
 * ONE DOCK NOW, NOT TWO. This used to also offer `dock="top"` — absolute at the top of a route's
 * own content region — for the pane screen, whose composer sits at the bottom. That dock covered
 * the tab strip and the pane strip instead, which read as the cheapest real estate on that screen
 * until an operator tapped the tab strip's own "+" (new tab) and watched the toast it earned
 * ("Tab ready") land on the control they had just pressed. The strip was never free real estate;
 * it is where the control you just tapped lives. The pane screen's status now rides in its
 * header's own title slot instead (`components/header-status.tsx`), which is text nobody is
 * reading for the two seconds a status shows, and the controls beside it never move — so nothing
 * on the pane screen needs a `dock="top"` docked over its own content anymore. Every remaining
 * caller wants the bottom dock, so that is the only shape left here.
 */

/**
 * `pointer-events-none` on the wrapper, `pointer-events-auto` re-enabled by whatever inside is
 * actually meant to be tapped (today: the dismiss affordance on a persisting error). This is the
 * existing, correct pattern from `routes/home.tsx:121-123`, kept verbatim: an overlay that eats
 * taps over content it is only visiting is worse than the layout shift it replaced.
 *
 * `z-40` is the unclaimed rung of the ladder — above the `z-20` sticky header and everything else
 * in the app's chrome, below the `z-50` sheets and the idle lock. That places a toast where it
 * should be: visible over any chrome, occluded by a modal. A sheet is a focused task; a transient
 * toast may be missed during one, and an error that actually persists is still in the channel and
 * still showing when the sheet closes.
 */
const SHARED = "pointer-events-none z-40 mx-auto w-full max-w-screen-sm px-4";

export interface ToastViewportProps {
  children: ReactNode;
  className?: string;
}

export function ToastViewport({ children, className }: ToastViewportProps) {
  // Portalled to <body>, and NOT as a formality. A `fixed` element is positioned against the
  // viewport only while no ancestor has created a containing block — and `backdrop-filter`,
  // `filter`, `transform`, `perspective` and `contain` all create one, on any ancestor, at any
  // depth. The app has already been bitten: `server-switcher.tsx:103-104` portals for exactly this
  // reason, because a backdrop-filter on the header would clip a `fixed inset-0` sheet to the
  // header band. A viewport-anchored layer must not assume a clean ancestor chain, because the
  // chain is written by whoever mounts it and the failure is silent.
  return createPortal(
    <div
      className={cn(
        SHARED,
        "fixed inset-x-0 bottom-0 pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)]",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
