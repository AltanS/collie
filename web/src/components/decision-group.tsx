import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { DecisionView } from "@/components/decision-view";
import type { HillMediaSource } from "@/components/hill-media";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { t, tn } from "@/lib/i18n";
import type { HillGroup, HillMedia } from "@/lib/hill/wire";
import type { View } from "@/lib/tricks/schema";

// A GROUP OF CARDS ON A DECISION (crew slice 8). Collie's own Decision whose code does not fit one card
// carries 2 to 8 cards: card 1 the facts, the rest every line of the code. The Decision card shows one
// card at a time in its view's place, with "Card 2 of 4" above it and Back and Next under it, 44px each.
// The ends stop: Back is off on card 1 and Next on the last. No swipe: the app's pager (ui/pager-sheet.tsx)
// has none, so this has none. No motion of its own: the card's view swaps in place, so reduced motion
// has nothing to calm. Which card shows is the caller's state and always starts at card 1.
//
// A CARD IS OPENED WHEN ITS END WAS ON SCREEN (review 7 R1). A card of a group never folds (its whole code
// shows), and it counts as opened only once the mark after its last line has been inside the screen, however
// short the card is: a scroll box around it can hide part of it, so there is no height shortcut.
// Paging past a long card does not open it. `onOpened` gets the card's number, from 1. A single card of
// Collie's own that carries code is held to the same rule (`DecisionWholeView`, lib/hill/code-card.ts).

/** The quiet chip on a group's Decision: "4 cards". */
export function GroupCount({ count }: { count: number }) {
  return (
    <span data-slot="decision-group-count" className="shrink-0 rounded-sm border border-border px-1.5 text-[11px] leading-4 text-muted-foreground tabular-nums">
      {tn("hill.group.count", count)}
    </span>
  );
}

/** The box a card scrolls inside, or null when only the window scrolls: a box marked `data-scroll-root`, or one that clips its height. */
export function scrollBoxOf(el: Element): HTMLElement | null {
  for (let node = el.parentElement; node !== null && node !== document.body; node = node.parentElement) {
    if (node.hasAttribute("data-scroll-root")) return node;
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return node;
  }
  return null;
}

/** Whether the mark lies inside the window and, where it sits in a scroll box, inside that box. */
function inView(el: Element, box: Element | null): boolean {
  const mark = el.getBoundingClientRect();
  if (!(mark.bottom > 0 && mark.top < window.innerHeight)) return false;
  if (box === null) return true;
  const frame = box.getBoundingClientRect();
  return mark.bottom > frame.top && mark.top < frame.bottom;
}

/**
 * Calls `seen` once the mark after the card's last line (`end`) has been on screen. There is no shortcut
 * for a card that is no taller than the window: a scroll box around the card (the chat's trick card is
 * boxed at 60dvh) can hide part of a short card, so the mark is always watched, with the scroll box as
 * the observer's root where there is one (security read of package I, 2026-11-17, point 1). Where there is
 * no IntersectionObserver, every scroll and resize looks again.
 */
function useEndSeen(card: RefObject<HTMLElement | null>, end: RefObject<HTMLElement | null>, page: number, seen: (page: number) => void): void {
  const call = useRef(seen);
  useLayoutEffect(() => {
    call.current = seen;
  });
  useEffect(() => {
    const tail = end.current;
    if (card.current === null || tail === null) return;
    const done = () => call.current(page);
    const box = scrollBoxOf(tail);
    if (globalThis.IntersectionObserver !== undefined) {
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer.disconnect();
          done();
        },
        box === null ? undefined : { root: box },
      );
      observer.observe(tail);
      return () => observer.disconnect();
    }
    const look = () => {
      if (!inView(tail, box)) return;
      window.removeEventListener("scroll", look, true);
      window.removeEventListener("resize", look);
      done();
    };
    window.addEventListener("scroll", look, true);
    window.addEventListener("resize", look);
    look();
    return () => {
      window.removeEventListener("scroll", look, true);
      window.removeEventListener("resize", look);
    };
  }, [card, end, page]);
}

/**
 * A single card of code (lib/hill/code-card.ts), held to a group card's rule: it never folds, and
 * `onOpened(1)` fires once its end was on screen.
 */
export function DecisionWholeView({
  decisionId,
  view,
  sender,
  media,
  mediaSource,
  onOpened,
}: {
  decisionId: string;
  view: View;
  sender: string;
  media: readonly HillMedia[];
  mediaSource?: HillMediaSource;
  onOpened: (card: number) => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useEndSeen(card, end, 0, () => onOpened(1));
  return (
    <div ref={card} data-slot="decision-code-card" className="flex min-w-0 flex-col">
      <DecisionView decisionId={decisionId} view={view} sender={sender} media={media} mediaSource={mediaSource} folds={false} endRef={end} />
    </div>
  );
}

/** The card on screen, its position, and Back and Next. `page` counts from 0. */
export function DecisionGroupPager({
  decisionId,
  group,
  page,
  onPage,
  onOpened,
  sender,
  mediaSource,
}: {
  decisionId: string;
  group: HillGroup;
  page: number;
  onPage: (page: number) => void;
  /** A card's end was on screen: its number, from 1. */
  onOpened: (card: number) => void;
  sender: string;
  mediaSource?: HillMediaSource;
}) {
  const head = useRef<HTMLParagraphElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useEndSeen(card, end, page, (at) => onOpened(at + 1));
  const count = group.parts.length;
  const part = group.parts[page] ?? group.parts[0];
  // A move to another card (Next at the foot of a long card, or a "Card 3" tap under the options) brings
  // its head into sight; never a smooth scroll. Not on the first draw: the list owns where it opens.
  const shown = useRef(page);
  useEffect(() => {
    if (shown.current === page) return;
    shown.current = page;
    head.current?.scrollIntoView?.({ block: "nearest" });
  }, [page]);
  return (
    <div data-slot="decision-group" data-page={page + 1} className="flex min-w-0 flex-col gap-2">
      <p ref={head} data-slot="decision-group-position" aria-live="polite" className="scroll-mt-4 text-xs font-medium text-muted-foreground tabular-nums">
        {t("hill.group.position", { index: page + 1, count })}
      </p>
      {part !== undefined && (
        <div ref={card} data-slot="decision-group-card" className="flex min-w-0 flex-col">
          <DecisionView key={page} decisionId={decisionId} view={part.view} sender={sender} mediaSource={mediaSource} folds={false} endRef={end} />
        </div>
      )}
      <div data-slot="decision-group-nav" className="flex items-center justify-between gap-3">
        <Button type="button" variant="outline" data-slot="decision-group-back" className="h-11 min-w-11 px-3" disabled={page <= 0} onClick={() => onPage(page - 1)}>
          <Icon name="image-prev" aria-hidden className="size-4" />
          {t("hill.group.back")}
        </Button>
        <Button type="button" variant="outline" data-slot="decision-group-next" className="h-11 min-w-11 px-3" disabled={page >= count - 1} onClick={() => onPage(page + 1)}>
          {t("hill.group.next")}
          <Icon name="image-next" aria-hidden className="size-4" />
        </Button>
      </div>
    </div>
  );
}
