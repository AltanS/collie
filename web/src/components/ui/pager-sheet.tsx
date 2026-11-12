import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { PICTURE_SHEET } from "@/components/ui/zoom-picture";

// PICTURES AT FULL SIZE, ONE AT A TIME, IN THE APP'S SHEET (2026-11-10). `ImageSheet` opens one picture;
// this opens a set of them on one (a Decision view's before and after) and steps through the set with
// Previous and Next under the picture, 44px each, the position between them ("1 of 2"). The ends stop:
// Previous is off on the first picture and Next on the last, so a tap never jumps round to the start.
// One picture draws no pager row at all.
//
// The sheet is portalled to <body>, as `ImageSheet`'s is: a view sits in a card that may carry a
// transform, which would otherwise become the containing block of the sheet's `fixed` layer. Owns no
// words and no loading: the caller names the buttons and the position, and hands in the picture of the
// current page (`children`).
//
// THE PICTURE ZOOMS IN PLACE (2026-11-11): the caller draws it as a `ZoomPicture`. The page holds no
// zoom from one picture to the next: the picture is keyed by its page, so Previous or Next draws the
// new one fitted, and closing the sheet drops the zoom with it. The panel takes no page zoom from a
// pinch anywhere on it (`PICTURE_SHEET`), and the pager row is outside the picture, so a pan of a
// zoomed picture never pages.

export function PagerSheet({
  open,
  onClose,
  title,
  index,
  count,
  onIndex,
  prevLabel,
  nextLabel,
  position,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** The current picture's words, the sheet's title. */
  title: string;
  /** The current page, from 0. */
  index: number;
  count: number;
  onIndex: (index: number) => void;
  prevLabel: string;
  nextLabel: string;
  /** The position in words, "1 of 2". */
  position: string;
  /** The current page's picture. */
  children: ReactNode;
}) {
  if (!open) return null;
  return createPortal(
    <BottomSheet open onClose={onClose} title={title} className={PICTURE_SHEET}>
      <div data-slot="pager-sheet" className="flex flex-col gap-3">
        <div key={index} className="flex min-w-0 justify-center">
          {children}
        </div>
        {count > 1 && (
          <div data-slot="pager-sheet-nav" className="flex items-center justify-between gap-3">
            <Button type="button" variant="outline" className="size-11 p-0" aria-label={prevLabel} title={prevLabel} disabled={index <= 0} onClick={() => onIndex(index - 1)}>
              <Icon name="image-prev" aria-hidden className="size-4" />
            </Button>
            <span aria-live="polite" className="text-sm text-muted-foreground tabular-nums">
              {position}
            </span>
            <Button
              type="button"
              variant="outline"
              className="size-11 p-0"
              aria-label={nextLabel}
              title={nextLabel}
              disabled={index >= count - 1}
              onClick={() => onIndex(index + 1)}
            >
              <Icon name="image-next" aria-hidden className="size-4" />
            </Button>
          </div>
        )}
      </div>
    </BottomSheet>,
    document.body,
  );
}
