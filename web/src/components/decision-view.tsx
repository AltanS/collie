import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { MoreToggle } from "@/components/ui/fold-toggle";
import { hasResizeObserver } from "@/lib/env";
import { isWebLink, linkHost } from "@/lib/hill/reader";
import { t } from "@/lib/i18n";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { renderView, type LinkTarget, type RenderCtx } from "@/lib/tricks/render";
import type { View } from "@/lib/tricks/schema";
import { cn } from "@/lib/utils";

// A DECISION'S VIEW, ON ITS CARD (M96).
//
// The poster's facts under the summary (and under the images, when there are some): a strip of seven
// gates, a few rows with their proof, a hunk of a diff. Display only: the bridge refused every button,
// card, image and acting attribute before it stored the view (`parseDecisionView`), and the phone read
// it again with the same rules. The options below the view are the taps.
//
// It is drawn with the trick renderer (`renderView`), with no tap handler: a link is the one thing that
// opens anything, a web page in a new tab, and it shows its host beside the poster's words. A bar wraps
// instead of clipping, so a strip of seven gates keeps its words on a phone. The frame is
// quiet (a thin border on all four sides) and captioned with who drew it, so the facts never read as the
// app's own. Past VIEW_CAP_PX the frame is clipped with a fade and a "Show all" toggle opens it in
// place: the card scrolls with the hill, never inside itself.
//
// A view that throws while it draws takes only itself: the boundary draws the placeholder, and the
// question and its options stay.

/** The tallest a view draws before it folds, in CSS pixels. */
export const VIEW_CAP_PX = 240;

/** A no-op: a Decision's view has no button, so nothing in it can tap. */
const NO_TAP = (): void => undefined;

/** A link in a view opens a web page in a new tab; anything else (the bridge refused it) opens nothing. */
function openViewLink(target: LinkTarget): void {
  if (target.url === undefined || !isWebLink(target.url)) return;
  window.open(target.url, "_blank", "noopener,noreferrer");
}

/** Whether the content inside `ref` is taller than the cap: read on mount and whenever it changes size. */
function useTallerThanCap<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [tall, setTall] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    setTall(el.scrollHeight > VIEW_CAP_PX + 1);
  }, []);
  useLayoutEffect(measure);
  // A font finishing, the viewport turning. Guarded for jsdom.
  useEffect(() => {
    const el = ref.current;
    if (el === null || !hasResizeObserver()) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  return { ref, tall };
}

export function DecisionView({ decisionId, view, sender }: { decisionId: string; view: View; sender: string }) {
  const [open, setOpen] = useState(false);
  const { ref, tall } = useTallerThanCap<HTMLDivElement>();
  const bodyId = useId();
  const clipped = tall && !open;
  const ctx: RenderCtx = { partKey: `hill/${decisionId}`, stale: false, onTap: NO_TAP, onLink: openViewLink, hostOf: linkHost, wrapBars: true };
  return (
    <figure data-slot="decision-view" className="flex min-w-0 flex-col gap-2 rounded-lg border border-border px-3.5 pt-2.5 pb-3">
      <figcaption data-slot="decision-view-from" className="truncate text-xs text-muted-foreground">
        {t("hill.view.from", { sender })}
      </figcaption>
      <div
        id={bodyId}
        data-slot="decision-view-body"
        data-clipped={clipped ? "" : undefined}
        className={cn("relative min-w-0", clipped && "overflow-hidden")}
        style={clipped ? { maxHeight: VIEW_CAP_PX } : undefined}
      >
        <div ref={ref} className="font-content min-w-0">
          <TrickBoundary fallback="placeholder" resetKey={decisionId}>
            {renderView(view, ctx)}
          </TrickBoundary>
        </div>
        {clipped && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" />}
      </div>
      {tall && (
        <div className="-mx-3 -mb-2 flex">
          <MoreToggle
            data-slot="decision-view-more"
            open={open}
            onToggle={() => setOpen((was) => !was)}
            controls={bodyId}
            more={t("hill.view.more")}
            less={t("hill.view.less")}
          />
        </div>
      )}
    </figure>
  );
}
