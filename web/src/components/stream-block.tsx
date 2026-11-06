import { Ellipsis, Pin } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { useLocale } from "@/hooks/use-locale";
import { useLongPress } from "@/hooks/use-long-press";
import type { ChatItem } from "@/lib/chat-items";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ONE BLOCK OF THE STREAM, with the two things M90 hangs on it: the way in to its actions and the mark of a pin.
//
// ── THE WAY IN IS THE ⋯, THE HOLD IS THE SHORTCUT ────────────────────────────
// A long press on text fights native selection on iOS and Android, so a block that can be pinned wears a small
// muted `⋯` at its top right, a real button with a 44px reach that opens the block's actions sheet. The hold
// and the right click open the same sheet as a second way. The hold is written so it never takes selection
// away: nothing here calls `preventDefault` on a touch or sets `user-select: none`; the hold waits longer than
// the browsers' own selection starts ({@link BLOCK_HOLD_MS}), so on text the browser's selection begins first
// and its pointer cancel ends the hold, and the hold fires where nothing selectable is under the finger. A right
// click with text selected in the block leaves the native menu alone, so Copy stays the browser's.
//
// ── THE HOLD IS SILENT UNTIL IT FIRES ────────────────────────────────────────
// `useLongPress` shows a hold in the making (`data-holding`: a tint and a 0.97 scale from 150ms). On a block of
// text that squeezes the message under a slow tap or the first moment of a selection, so a stream block turns the
// look off (`showHold: false`) and nothing changes on screen until the sheet opens.
//
// ── THE ⋯ OWNS A CORNER, AND THE TEXT STEPS AROUND IT ────────────────────────
// Both marks sit in the block's own padding corner, absolute, so a block gaining a pin or a way in changes no
// box (DESIGN.md §2). The `⋯` is drawn as a 14px glyph in a 20px button at `right-0.5`, as `CopyableBlock` places
// its copy button (ui/copyable-block.tsx): the block is `content-visibility: auto`, which paints no further than
// its padding box, so a button flush at `right-0` lost its focus ring and half its reach to the clip. The button
// covers the block's right 22px and the block's content starts 12px in, so the first 20px of height is held by a
// `float-right` spacer 16px wide ({@link MORE_SPACER}): the first lines of a text wrap around it and a card (a
// block formatting context) stands beside it, and no text and no control (a tool card's toggle) is under the button.
// The spacer is there whenever the button is, so a block's lines do not move when the button comes or goes.

/** How long the hold waits. Past the 500ms where a phone's browser starts a selection, so selection wins on text. */
export const BLOCK_HOLD_MS = 650;

/** The float that keeps the first 20px of height, 16px of width, of a block's content clear of the `⋯`. */
export const MORE_SPACER = "float-right h-5 w-4";

/** The mark of a pinned block, in the corner of the block's own padding. A glyph of the padding's width. */
export function PinnedMark() {
  useLocale();
  return (
    <span role="img" aria-label={t("pins.mark")} data-slot="pin-mark" className="pointer-events-none absolute top-0 right-0 grid size-3 place-items-center text-muted-foreground">
      <Pin aria-hidden className="size-2.5" />
    </span>
  );
}

interface StreamBlockProps {
  /** How many items the block holds (`data-n`). */
  n: number;
  /** The one item the block draws, when it is one that can be pinned; `null` for a folded run. */
  item: ChatItem | null;
  /** The item is pinned. */
  pinned: boolean;
  /** Opens the block's actions. `undefined` is "no way in here": a closed gate, or a block that cannot be pinned. */
  onActions: ((item: ChatItem) => void) | undefined;
  className: string;
  children: ReactNode;
}

/** Whether the person has text selected inside `block`: a right click then belongs to the browser's own menu. */
function selectingIn(block: HTMLElement): boolean {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.anchorNode === null) return false;
  return block.contains(selection.anchorNode);
}

export function StreamBlock({ n, item, pinned, onActions, className, children }: StreamBlockProps) {
  useLocale();
  const open = item !== null && onActions !== undefined ? () => onActions(item) : undefined;
  const hold = useLongPress(open, { delayMs: BLOCK_HOLD_MS, showHold: false });
  const { onContextMenu, ...handlers } = hold;
  const onRightClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (selectingIn(event.currentTarget)) return;
    onContextMenu(event);
  };
  return (
    <div data-block data-n={n} {...handlers} onContextMenu={onRightClick} className={cn(className, (pinned || open !== undefined) && "relative")}>
      {open === undefined ? (
        children
      ) : (
        <div data-slot="block-body" className="flow-root min-w-0">
          <span aria-hidden data-slot="block-more-spacer" className={MORE_SPACER} />
          {children}
        </div>
      )}
      {pinned && <PinnedMark />}
      {open !== undefined && (
        <button
          type="button"
          data-slot="block-more"
          aria-label={t("pins.action.more")}
          onClick={open}
          className="absolute top-3 right-0.5 grid size-5 place-items-center rounded-sm text-muted-foreground/70 before:absolute before:-inset-3 before:content-[''] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
        >
          <Ellipsis aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}
