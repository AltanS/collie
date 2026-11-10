import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { hillMediaSource, viewPictures, type HillMediaSource } from "@/components/hill-media";
import { MoreToggle } from "@/components/ui/fold-toggle";
import { hasResizeObserver } from "@/lib/env";
import { isWebLink, linkHost } from "@/lib/hill/reader";
import type { HillMedia } from "@/lib/hill/wire";
import { t } from "@/lib/i18n";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { renderView, type LinkTarget, type RenderCtx } from "@/lib/tricks/render";
import type { View } from "@/lib/tricks/schema";
import { cn } from "@/lib/utils";

// A DECISION'S VIEW, ON ITS CARD (M96).
//
// The poster's facts under the summary (and under the images, when there are some): a strip of seven
// gates, a few rows with their proof, a hunk of a diff, a table, a trend, a before and after. Display
// only: the bridge refused every button, card and acting attribute before it stored the view
// (`parseDecisionView`), and the phone read it again with the same rules. The options below the view
// are the taps. A picture the view places (`image`, `compare`) is one of the Decision's own images,
// drawn through `viewPictures`; a tap on it opens the picture sheet, the one thing besides a link that
// opens anything.
//
// It is drawn with the trick renderer (`renderView`), with no tap handler: a link is the one thing that
// opens anything, a web page in a new tab, and it shows its host beside the poster's words. A bar wraps
// instead of clipping, so a strip of seven gates keeps its words on a phone, and every leaf's words take
// another line instead of being cut (`wrap`: the view sits in no fixed band). The frame is
// quiet (a thin border on all four sides) and captioned with who drew it, so the facts never read as the
// app's own. Past VIEW_CAP_PX the frame is clipped with a fade and a "Show all" toggle opens it in
// place: the card scrolls with the hill, never inside itself.
//
// THE FOLD CUTS BETWEEN ROWS (2026-11-10). The clip ends at the bottom of the last whole node or row
// that fits under the cap (`foldCut`), never through the middle of a row (a list's, a table's, or a
// line of a diff), and the toggle sits under a rule of its own, so it reads as the frame's control and
// not as the list's next row.
//
// A view that throws while it draws takes only itself: the boundary draws the placeholder, and the
// question and its options stay.

/** The tallest a view draws before it folds, in CSS pixels. */
export const VIEW_CAP_PX = 240;

/** The fold never cuts higher than this share of the cap: a short first node and a tall second one cut at the cap. */
const FOLD_MIN_SHARE = 0.5;

/** The boxes a fold may end under: each node of the view, each row of a list or a table, each line of a diff. */
const FOLD_STOPS = '[data-trick-view] > *, [data-slot="trick-row"], [data-slot="mini-table"] tr, [data-diff-line]';

/**
 * Where a folded view is cut, in px from its top: the lowest bottom edge of a node or a row that still
 * fits under the cap (and is past half of it), so no row is cut through; the cap when none is.
 */
export function foldCut(bottoms: readonly number[], cap: number = VIEW_CAP_PX): number {
  const fits = bottoms.filter((bottom) => bottom <= cap && bottom >= cap * FOLD_MIN_SHARE);
  return fits.length === 0 ? cap : Math.max(...fits);
}

/** A Decision with no images: one list, so the pictures are not made again on every draw. */
const NO_MEDIA: readonly HillMedia[] = [];

/** A no-op: a Decision's view has no button, so nothing in it can tap. */
const NO_TAP = (): void => undefined;

/** A link in a view opens a web page in a new tab; anything else (the bridge refused it) opens nothing. */
function openViewLink(target: LinkTarget): void {
  if (target.url === undefined || !isWebLink(target.url)) return;
  window.open(target.url, "_blank", "noopener,noreferrer");
}

/** Whether the content inside `ref` is taller than the cap, and where its fold cuts: read on mount and whenever it changes size. */
function useTallerThanCap<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [tall, setTall] = useState(false);
  const [cut, setCut] = useState(VIEW_CAP_PX);
  const measure = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    const isTall = el.scrollHeight > VIEW_CAP_PX + 1;
    setTall(isTall);
    if (!isTall) return;
    const top = el.getBoundingClientRect().top;
    setCut(foldCut([...el.querySelectorAll(FOLD_STOPS)].map((stop) => Math.round(stop.getBoundingClientRect().bottom - top))));
  }, []);
  useLayoutEffect(measure);
  // A font finishing, the viewport turning. Guarded for jsdom.
  useEffect(() => {
    const el = ref.current;
    if (el === null || !hasResizeObserver()) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The rows rise in as they arrive (a transform no resize reports): read the fold again once they land.
    el.addEventListener("animationend", measure);
    return () => {
      ro.disconnect();
      el.removeEventListener("animationend", measure);
    };
  }, [measure]);
  return { ref, tall, cut };
}

export function DecisionView({
  decisionId,
  view,
  sender,
  media = NO_MEDIA,
  mediaSource = hillMediaSource,
}: {
  decisionId: string;
  view: View;
  sender: string;
  /** The Decision's images, which an `image` or a `compare` names by `ref`. */
  media?: readonly HillMedia[];
  mediaSource?: HillMediaSource;
}) {
  const [open, setOpen] = useState(false);
  const { ref, tall, cut } = useTallerThanCap<HTMLDivElement>();
  const bodyId = useId();
  const clipped = tall && !open;
  const pictures = useMemo(() => viewPictures(decisionId, media, mediaSource), [decisionId, media, mediaSource]);
  const ctx: RenderCtx = { partKey: `hill/${decisionId}`, stale: false, onTap: NO_TAP, onLink: openViewLink, hostOf: linkHost, wrap: true, pictures };
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
        style={clipped ? { maxHeight: cut } : undefined}
      >
        <div ref={ref} className="font-content min-w-0">
          <TrickBoundary fallback="placeholder" resetKey={decisionId}>
            {renderView(view, ctx)}
          </TrickBoundary>
        </div>
        {clipped && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent" />}
      </div>
      {tall && (
        // Under a rule of its own, the frame's control: never the list's next row.
        <div data-slot="decision-view-fold" className="-mx-3.5 -mb-3 flex border-t border-border px-0.5">
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
