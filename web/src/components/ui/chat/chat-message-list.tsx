import * as React from "react";
import { Icon } from "@/components/icons/icon";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { BAND_INSET_CLASS, useBandInset } from "@/components/ui/strip-host";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

/**
 * THE ROOM, IN PX, A FLOATING TAG TAKES FROM THE BOTTOM OF A SCROLLER (#759). The model tag floats on the
 * mirror box's bottom-right corner and takes no layout (components/model-tag.tsx), so a scroller under it
 * has to keep that room clear below its last line, or the newest line ends under the tag. The box that
 * draws the tag provides the number while a tag shows; 0 is the default, for every list with no tag over it.
 * The list publishes it as `--tail-room` on its scroller and a caller's bottom padding reads that
 * (`pb-[max(0.75rem,var(--tail-room,0px))]`), so the padding never drops under what the caller asked for.
 * A list following the tail re-pins when the room changes, so the line stays in view as the tag arrives.
 */
export const TailRoomContext = React.createContext(0);

/**
 * The air, in px, between the last line and a floating card, the 12px the scrollers' `pb-3` has always
 * kept above the composer (ADR 0151, rule 10).
 */
const CARD_AIR = 12;

/**
 * THE ONE ROOM A LIST KEEPS CLEAR BELOW ITS LAST LINE, in px: the model tag's (`tagRoom`, from
 * {@link TailRoomContext}) or the floating cards' (`clearBottom`, the slot's measured height), the LARGER,
 * never the sum. Both float over the same bottom edge of the same box, and the slot is full width and
 * above the tag in z-order (agent-chat.tsx), so a card covers the tag's corner instead of stacking on it:
 * what is on screen is one covered strip as tall as the taller of the two. The cards get {@link CARD_AIR}
 * on top of their height, the tag's room already has its own air (`MODEL_TAG_ROOM`). With neither,
 * 0: the list ends as it always did. A caller's `holdRoom` is a third part of the same room: the place a row that just
 * left the tail held, kept so the tail does not drop (M104, components/session-stream.tsx).
 */
export function bottomRoom(tagRoom: number, clearBottom: number, holdRoom = 0): number {
  return Math.max(tagRoom, cardsRoom(clearBottom), holdRoom);
}

/** What the floating cards alone take from the tail, air included; 0 with no card. */
function cardsRoom(clearBottom: number): number {
  return clearBottom > 0 ? clearBottom + CARD_AIR : 0;
}

/** The `--tail-room` custom property for a scroller, or none while no tag floats over it. */
export function tailRoomStyle(room: number): React.CSSProperties | undefined {
  // SAFETY: `CSSProperties` has no index signature for custom properties, and React has accepted them on
  // `style` since 18. The value is a string built here, so the assertion widens the key name only.
  return room > 0 ? ({ "--tail-room": `${room}px` } as React.CSSProperties) : undefined;
}

export interface ChatMessageListHandle {
  /** Imperatively jump to the latest output (e.g. after sending a reply). */
  scrollToBottom: () => void;
  /** The scroll container itself — lets the parent measure/anchor (e.g. "Load older" scrollback). */
  getScrollElement: () => HTMLElement | null;
  /** Bring a child's top edge to the top of the scrollport and stop following the tail. `force` moves
   *  even a reader who had scrolled away — for a control they pressed, not for content that arrived
   *  (useAutoScroll § scrollToChild). False when it declined. */
  scrollToChild: (child: HTMLElement | null, force?: boolean) => boolean;
}

interface ChatMessageListProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Changing this value re-pins the list to the bottom (pass your message count / latest text). */
  dep?: unknown;
  /** Fires when the user reaches / leaves the bottom — lets the parent follow or freeze content. */
  onAtBottomChange?: (atBottom: boolean) => void;
  /** Dot the "jump to latest" button when newer output arrived while you were scrolled up. */
  hasNew?: boolean;
  /**
   * The list's own top padding in px, which asks it to keep its first row clear of the system strip
   * band (`useBandInset`): the band covers the top of the route, and the top of the list is where
   * "Saved copy from", "Load older" and "Start of the conversation" are read. Leave it out and the
   * list does nothing about the band. State the number the className gives the top, because the
   * padding that results replaces it.
   */
  clearBand?: number;
  /**
   * Drawn OVER the top of the scrollport, below the strip band when {@link clearBand} is set. It
   * takes no room in the list, so showing or hiding it moves nothing the reader is on. Its wrapper
   * ignores the pointer; a control inside opts back in with `pointer-events-auto`.
   */
  overlay?: React.ReactNode;
  /** Merged over the overlay wrapper's classes, so a caller can give it the scroller's own side gutter (`px-4` for a 16px gutter). */
  overlayClassName?: string;
  /** Style of the overlay wrapper. The overlay sits beside the scrollport, not in it, so custom properties set on the scrollport (the chat font size tokens) do not reach it unless they are passed here. */
  overlayStyle?: React.CSSProperties;
  /**
   * The height in px of what floats over the bottom of the scrollport (the composer's floating cards,
   * ADR 0151). It joins the model tag's room in ONE value ({@link bottomRoom}), published as
   * `--tail-room` like the tag's, so the caller's `pb-[max(0.75rem,var(--tail-room,0px))]` ends the list
   * above the cards, and "jump to latest" sits over them. A caller that passes it keeps that padding class.
   */
  clearBottom?: number;
  /**
   * Room in px the caller holds below the last line for a moment (M104): a row at the tail went, and the room it
   * took stays until the next row or the reader's own scroll, so the tail does not drop. It is a third part of the
   * one tail room ({@link bottomRoom}), never a spacer of its own. 0, the default, holds nothing.
   */
  holdRoom?: number;
}

// Scrollable conversation container that auto-follows new messages and shows a "jump to latest"
// affordance once the user scrolls up. Exposes `scrollToBottom` via ref so the parent can re-follow
// after an action, and reports at-bottom changes so the parent can freeze content while you read.
const ChatMessageList = React.forwardRef<ChatMessageListHandle, ChatMessageListProps>(
  function ChatMessageList(
    { className, children, dep, onAtBottomChange, hasNew, clearBand, overlay, overlayClassName, overlayStyle, clearBottom = 0, holdRoom = 0, style, ...props },
    ref,
  ) {
    useLocale();
    const room = bottomRoom(React.useContext(TailRoomContext), clearBottom, holdRoom);
    const { scrollRef, isAtBottom, scrollToBottom, scrollToChild, onScroll } =
      useAutoScroll<HTMLDivElement>({
        dep,
        reserve: room,
        onAtBottomChange,
      });

    const bandStyle = useBandInset(scrollRef, clearBand ?? 0);

    React.useImperativeHandle(
      ref,
      () => ({
        scrollToBottom: () => scrollToBottom(),
        getScrollElement: () => scrollRef.current,
        scrollToChild: (child: HTMLElement | null, force?: boolean) => scrollToChild(child, force),
      }),
      [scrollToBottom, scrollToChild, scrollRef],
    );

    return (
      <div className="relative h-full min-w-0 w-full">
        {/* Block scrollport (not flex-col): flex children with overflow-x-auto can shrink and steal
            vertical scrolling from this container — see ansi-output preClass. */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className={cn(
            "h-full min-w-0 w-full overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-4",
            clearBand !== undefined && bandStyle !== undefined && BAND_INSET_CLASS,
            className,
          )}
          style={{ ...(clearBand !== undefined ? { ...style, ...bandStyle } : style), ...tailRoomStyle(room) }}
          {...props}
        >
          {children}
        </div>

        {overlay !== undefined && overlay !== null && (
          <div
            className={cn("pointer-events-none absolute inset-x-0 top-0 z-10 px-3 pt-1", overlayClassName)}
            style={clearBand !== undefined ? { ...overlayStyle, top: bandStyle?.paddingTop } : overlayStyle}
          >
            {overlay}
          </div>
        )}

        {!isAtBottom && (
          <Button
            onClick={() => scrollToBottom()}
            size="icon"
            variant="outline"
            className="absolute bottom-3 left-1/2 z-10 size-9 -translate-x-1/2 rounded-full shadow-md"
            style={clearBottom > 0 ? { bottom: cardsRoom(clearBottom) } : undefined}
            aria-label={t("common.scrollToLatestAria")}
          >
            <Icon name="scroll-to-latest" className="size-4" />
            {hasNew && (
              <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-status-blocked ring-2 ring-background" />
            )}
          </Button>
        )}
      </div>
    );
  },
);

export { ChatMessageList };
