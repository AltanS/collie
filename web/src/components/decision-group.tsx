import { useEffect, useRef } from "react";

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
// A card of a group never folds: its whole code shows. A single card of Collie's own that carries code never
// folds either (`DecisionWholeView`, lib/hill/code-card.ts). Since ADR 0156 no card has to be opened or read
// to its end before the yes, which is a hold of 1.5 seconds (components/hold-to-approve.tsx).

/** The quiet chip on a group's Decision: "4 cards". */
export function GroupCount({ count }: { count: number }) {
  return (
    <span data-slot="decision-group-count" className="shrink-0 rounded-sm border border-border px-1.5 text-[11px] leading-4 text-muted-foreground tabular-nums">
      {tn("hill.group.count", count)}
    </span>
  );
}

/** A single card of code (lib/hill/code-card.ts), drawn as a group's card is: it never folds. */
export function DecisionWholeView({ decisionId, view, sender, media, mediaSource }: { decisionId: string; view: View; sender: string; media: readonly HillMedia[]; mediaSource?: HillMediaSource }) {
  return (
    <div data-slot="decision-code-card" className="flex min-w-0 flex-col">
      <DecisionView decisionId={decisionId} view={view} sender={sender} media={media} mediaSource={mediaSource} folds={false} />
    </div>
  );
}

/** The card on screen, its position, and Back and Next. `page` counts from 0. */
export function DecisionGroupPager({
  decisionId,
  group,
  page,
  onPage,
  sender,
  mediaSource,
}: {
  decisionId: string;
  group: HillGroup;
  page: number;
  onPage: (page: number) => void;
  sender: string;
  mediaSource?: HillMediaSource;
}) {
  const head = useRef<HTMLParagraphElement>(null);
  const count = group.parts.length;
  const part = group.parts[page] ?? group.parts[0];
  // A move to another card (Next at the foot of a long card) brings
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
        <div data-slot="decision-group-card" className="flex min-w-0 flex-col">
          <DecisionView key={page} decisionId={decisionId} view={part.view} sender={sender} mediaSource={mediaSource} folds={false} />
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
