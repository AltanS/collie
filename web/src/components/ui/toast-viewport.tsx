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
  /**
   * `"bottom"` — fixed to the viewport bottom, column-centred, clearing the home indicator. The
   * dashboard and space screens, which have no composer to collide with.
   *
   * `"top"` — absolute at the top of the nearest positioned ancestor, which on the pane screen is
   * the content region below the sticky header. Deliberately NOT fixed: covering the tab and pane
   * strips for two seconds is the cheapest real estate on that screen, while covering the terminal
   * tail — the newest output, the reason the screen is open — was tried on this very screen and
   * reverted (agent-chat.tsx:777-781). Being absolute inside the content region also puts it below
   * the header by geometry rather than by measuring the header's height, which nothing has to
   * maintain.
   */
  dock: "bottom" | "top";
  children: ReactNode;
  className?: string;
}

export function ToastViewport({ dock, children, className }: ToastViewportProps) {
  if (dock === "top") {
    // No portal, and that is the point: `absolute` resolves against the route's own positioned
    // content region, so it needs to stay in that subtree. Nothing here is `fixed`, so the
    // containing-block hazard below cannot apply.
    return <div className={cn(SHARED, "absolute inset-x-0 top-0 pt-3", className)}>{children}</div>;
  }

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
