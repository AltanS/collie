import { Ellipsis, Pin } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";

import { useLocale } from "@/hooks/use-locale";
import { useLongPress } from "@/hooks/use-long-press";
import { endSelectText, useSelectable } from "@/lib/block-select";
import type { ChatItem } from "@/lib/chat-items";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ONE BLOCK OF THE STREAM, with the two things M90 hangs on it: the way in to its actions and the mark of a pin.
//
// ── AT REST A BLOCK SHOWS NOTHING. A TAP SHOWS ITS ⋯, A HOLD OPENS ITS SHEET ──────────────────────
// The first cut wore a muted `⋯` on every pinnable block all the time, with a float that made the first line wrap
// around it. On a phone that was a column of dots down the right edge of the thread (Altan, 2026-11-06). So the `⋯`
// waits: a tap on the block REVEALS it on that block, and the `⋯` opens the block actions sheet. A tap that only
// meant to read covers nothing. The hold ({@link BLOCK_HOLD_MS}) opens the sheet at once, as a right click with a
// mouse does; a mouse hovering the block shows the `⋯` too (Tailwind's `hover:` only matches a device that can
// hover). The `⋯` is in the DOM at rest, transparent and deaf to the pointer, so Tab still reaches it and it shows
// while it has the focus; no block takes the focus for this.
//
// ── WHAT A TAP IS ─────────────────────────────────────────────────────────────────────────────────
// `useLongPress` owns the movement gate: its `onTap` fires on a lift that did not hold and did not move more than
// 8px, so a scroll that starts on a block reveals nothing. A tap reveals only on the block's own ground: never on a
// link, a button (a code block's copy, a tool card's toggle, the `⋯` itself), a field, a picture
// ({@link NOT_A_REVEAL}), and never while the person has text selected in the block.
//
// ── A TAP THAT REVEALS ENDS THERE ─────────────────────────────────────────────────────────────────
// The pane's reading area turns a tap on plain text into Tap to type (`focusFromMirror`, agent-chat.tsx), and a
// chat block is plain text to it, so the tap that showed the chip also focused the composer and raised the
// keyboard over the thread (Altan's phone, 2026-11-06). So the tap that reveals arms a one-shot flag, and the click
// that follows it is stopped at the block in the capture phase, the pattern `useLongPress` uses for the click after
// a hold. A press starts every gesture clean. A tap the block does not take (a link, a button, the ground between
// blocks, a block that cannot reveal) and every tap on the mirror keep Tap to type.
//
// ── ON A TOUCH SCREEN A BLOCK TAKES NO SELECTION, UNTIL SELECT TEXT ASKS FOR IT ──────────────────
// A phone's browser starts a text selection at about 500ms of a long press and cancels the pointer, which ended the
// hold; revealing from Android's `contextmenu` after that hung on its timing, and on Altan's Android phone a hold did
// nothing at all (2026-11-06). So under `pointer: coarse` a pinnable block (`data-pinnable`) takes no selection and
// raises no callout at rest (index.css). No selection starts, no pointer is cancelled, and the hold's timer fires
// every time, on iOS too, which raises no `contextmenu` at all. The `contextmenu` path stays as a fallback: a touch
// one collapses any selection, takes the native menu away and opens the sheet. A mouse and a desk keep selection as
// ever, and a right click with text selected in the block leaves the native menu to the browser.
//
// THE LIFT AFTER A HOLD TAPS NOTHING. The hold opens the sheet while the finger is still down, so its rows can come up
// under the finger, and the lift's click landed on whichever row was there: in Chromium the hold pinned the block
// (pins.spec.ts, 2026-11-06). The sheet is not inside the block, so `useLongPress`'s own click guard never sees that
// click. So the hold swallows the next click anywhere on the page ({@link swallowNextClick}), and the next press
// clears that, so a browser that sends no click after a hold costs the next tap nothing.
//
// Text is one row away: the sheet's Select text (lib/block-select.ts) marks this block `data-selectable`, which
// gives its text back to the native selection. While it is, the block's own hold, tap and `contextmenu` stand down
// and a tap in it never reaches Tap to type, so the press is the selection's. The mode ends on a press outside the
// block, when the sheet opens again, or when the block leaves the stream. One block at a time.
//
// ── ONE BLOCK AT A TIME, AND IT GOES AWAY BY ITSELF ───────────────────────────────────────────────
// One module store holds which block shows its `⋯`, so a reveal on one block hides the one before. It hides on a
// press outside the block, on the sheet opening, and after {@link REVEAL_MS} without a press on the block (a press
// inside starts the wait again). A SCROLL DOES NOT HIDE IT. The stream follows new output on its own while an agent
// works, so a hide on scroll took the chip away at once on a working session, the moment a person wants to pin a
// reply. The chip is absolute to its block and scrolls with it, so a scroll does it no harm; a touch scroll that
// starts outside the block is a press elsewhere anyway.
//
// ── THE HOLD IS SILENT UNTIL IT FIRES ────────────────────────────────────────────────────────────
// `useLongPress` shows a hold in the making (`data-holding`: a tint and a 0.97 scale from 150ms). On a block of
// text that squeezes the message under a slow tap or the first moment of a selection, so a stream block turns the
// look off (`showHold: false`) and nothing changes on screen until the `⋯` shows.
//
// ── THE ⋯ IS AN OVERLAY. IT MOVES NOTHING AND COVERS NO CONTROL ─────────────────────────────────
// Both marks are absolute, so a block gaining a pin or showing its `⋯` changes no box (DESIGN.md §2), and there is
// no spacer: the text runs to the edge and the chip lies over it. The chip is a 20px button with a hairline on the
// chrome ground, so it reads over text, at `top-3 right-0.5` as `CopyableBlock` places its copy button
// (ui/copyable-block.tsx): the block is `content-visibility: auto`, which paints no further than its padding box,
// so a button flush at `right-0` lost its focus ring and half its reach to the clip. Its top is the content's top,
// so it sits under the pin mark, which holds the padding corner above it. Where that spot holds a control of the
// block (a reply that opens with a code block and its copy button, a tool card's chevron) or a status badge, the
// chip steps left of it ({@link chipShift}), measured when it shows. A user message, a thinking block, a notice and
// a tool card's head hold nothing there (measured 2026-11-06 in the playground's cards 2 and 3).

/** How long the hold waits before it opens the sheet. Long enough that a slow tap is still a tap. */
export const BLOCK_HOLD_MS = 650;

/** How long a shown `⋯` waits for a press on its block before it hides again. */
export const REVEAL_MS = 4000;

/** What a tap may land on without revealing: it is the target's own tap. */
export const NOT_A_REVEAL =
  "a, button, input, textarea, select, label, summary, img, video, audio, [role='button'], [role='link'], [role='checkbox'], [role='switch'], [contenteditable]";

/** A control of the block that the chip must not cover. A wider one is a row, and only its glyphs are checked. */
const CORNER_CONTROL = "a[href], button, input, select, textarea, summary, [role='button']";

/** A control this many px or less on both sides is a corner control; a wider one is a row (a fold, a card's toggle). */
const SMALL_CONTROL_PX = 48;

/** The air between the chip and a control it stepped left of. */
const CHIP_GAP_PX = 4;

/** A box on screen, as `getBoundingClientRect` gives it. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * How far left the chip moves so that it covers none of `controls`: 0 where its place is clear, else the distance
 * that puts its right edge {@link CHIP_GAP_PX} left of the leftmost control it would cover, again until it is clear.
 * Never further than `room`, the distance to the block's own left edge.
 */
export function chipShift(chip: Box, controls: readonly Box[], room: number): number {
  let shift = 0;
  for (let round = 0; round <= controls.length; round++) {
    const at = { ...chip, left: chip.left - shift, right: chip.right - shift };
    const hit = controls.filter((c) => overlaps(at, c));
    if (hit.length === 0) return shift;
    shift = Math.min(room, chip.right - Math.min(...hit.map((c) => c.left)) + CHIP_GAP_PX);
  }
  return shift;
}

/** A status the chip must not cover either: a tool card's "failed" badge. One a `OneOf` holds back is `inert`. */
const STATUS_BADGE = "[data-slot='badge']";

/** The boxes the chip could cover: a small control whole, a row by its glyphs, a status badge that shows. */
function controlsIn(block: HTMLElement, chip: HTMLElement): Box[] {
  const out: Box[] = [];
  for (const el of block.querySelectorAll(CORNER_CONTROL)) {
    if (el === chip) continue;
    const box = el.getBoundingClientRect();
    if (box.width <= SMALL_CONTROL_PX && box.height <= SMALL_CONTROL_PX) out.push(box);
    else for (const glyph of el.querySelectorAll("svg")) out.push(glyph.getBoundingClientRect());
  }
  for (const badge of block.querySelectorAll(STATUS_BADGE)) {
    if (badge.closest("[inert]") === null) out.push(badge.getBoundingClientRect());
  }
  return out;
}

// ── THE ONE SHOWN BLOCK ──────────────────────────────────────────────────────────────────────────

let shown: string | null = null;
let lapse: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function setShown(next: string | null) {
  if (shown === next) return;
  shown = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Show the `⋯` of block `id`, hiding any other, and start (or restart) its {@link REVEAL_MS} wait. */
function reveal(id: string) {
  clearTimeout(lapse);
  lapse = setTimeout(() => setShown(null), REVEAL_MS);
  setShown(id);
}

/** Hide the `⋯` of block `id`, if it is the one shown. */
function conceal(id: string) {
  if (shown !== id) return;
  clearTimeout(lapse);
  setShown(null);
}

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
  /**
   * The `⋯` shows without a tap and stays shown: no lapse, no press, no scroll hides it. The states playground's card
   * of the shown chip passes it, so the card still shows the chip after the 4 s a tap buys. The app never does.
   */
  held?: boolean;
}

/** Whether the person has text selected inside `block`: a tap then is about the selection, a right click the browser's. */
function selectingIn(block: Element): boolean {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.anchorNode === null) return false;
  return block.contains(selection.anchorNode);
}

/**
 * Stop the next click anywhere on the page, once: the lift of the hold that just opened a sheet over the finger. The
 * next press clears it unused, so a browser that sends no click after a hold loses nothing.
 */
function swallowNextClick(): void {
  const stop = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    done();
  };
  const done = () => {
    document.removeEventListener("click", stop, true);
    document.removeEventListener("pointerdown", done, true);
  };
  document.addEventListener("click", stop, true);
  document.addEventListener("pointerdown", done, true);
}

export function StreamBlock({ n, item, pinned, onActions, className, children, held = false }: StreamBlockProps) {
  useLocale();
  const id = useId();
  const blockRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const lastPointer = useRef<string | null>(null);
  // The tap that revealed the chip owns the click that follows it (A TAP THAT REVEALS ENDS THERE, above).
  const swallow = useRef(false);
  const [shift, setShift] = useState(0);
  const tapped = useSyncExternalStore(subscribe, () => shown === id);
  const itemId = item !== null && onActions !== undefined ? item.id : null;
  // The sheet's Select text gave this block's text back to the native selection: its own gestures stand down.
  const selectable = useSelectable(itemId);
  const open =
    item !== null && onActions !== undefined
      ? () => {
          conceal(id);
          endSelectText();
          onActions(item);
        }
      : undefined;
  const revealed = open !== undefined && (tapped || held);

  const onTap = (event: ReactPointerEvent) => {
    if (event.target instanceof Element && event.target.closest(NOT_A_REVEAL) !== null) return;
    if (selectingIn(event.currentTarget)) return;
    swallow.current = true;
    reveal(id);
  };
  const onHold =
    open === undefined || selectable
      ? undefined
      : () => {
          swallowNextClick();
          open();
        };
  const hold = useLongPress(onHold, { delayMs: BLOCK_HOLD_MS, showHold: false, onTap });
  const { onContextMenu, onPointerDown, onClickCapture: afterHold, ...handlers } = hold;

  const onPress = (event: ReactPointerEvent<HTMLElement>) => {
    lastPointer.current = event.pointerType;
    swallow.current = false;
    onPointerDown(event);
  };
  // Capture phase, so the reading area's Tap to type under the block never sees the click of a revealing tap.
  // A click on a control (the chip itself, by a key) is never the revealing tap's, so it passes whatever the flag says.
  // In the select mode no tap in the block is Tap to type either: it ends or moves the selection.
  const onClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    const onControl = event.target instanceof Element && event.target.closest(NOT_A_REVEAL) !== null;
    if (selectable && !onControl) {
      event.stopPropagation();
      return;
    }
    if (!swallow.current || onControl) {
      afterHold(event);
      return;
    }
    swallow.current = false;
    event.stopPropagation();
  };
  const onRightClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (open === undefined || selectable) return;
    // A touch hold that ends in `contextmenu` (Android) is a hold: it opens the sheet, over a selection it started too.
    // A mouse, or a menu key, opens the sheet, unless text is selected in the block: then the menu is the browser's.
    if (lastPointer.current === "touch" || lastPointer.current === "pen") {
      window.getSelection()?.removeAllRanges();
      onContextMenu(event);
      return;
    }
    if (selectingIn(event.currentTarget)) return;
    event.preventDefault();
    open();
  };

  // Where the chip stands, measured against the block's controls whenever it is about to show. Its home spot comes off
  // its offsets, which a `translate` does not move, so a second measure starts from the same place as the first.
  const place = useCallback(() => {
    const block = blockRef.current;
    const chip = chipRef.current;
    if (block === null || chip === null) return;
    const ground = block.getBoundingClientRect();
    const left = ground.left + chip.offsetLeft;
    const top = ground.top + chip.offsetTop;
    const home = { left, top, right: left + chip.offsetWidth, bottom: top + chip.offsetHeight };
    setShift(chipShift(home, controlsIn(block, chip), Math.max(0, chip.offsetLeft)));
  }, []);

  useLayoutEffect(() => {
    if (revealed) place();
  }, [revealed, place]);

  // While shown: a press elsewhere hides it, and a press on the block renews its wait. No scroll hides it (above).
  useEffect(() => {
    const block = blockRef.current;
    if (!tapped || block === null) return;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && block.contains(event.target)) reveal(id);
      else conceal(id);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [tapped, id]);

  // While its text is selectable: a press outside the block ends the select mode.
  useEffect(() => {
    const block = blockRef.current;
    if (!selectable || block === null || itemId === null) return;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && block.contains(event.target)) return;
      endSelectText(itemId);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [selectable, itemId]);

  // A block that leaves the stream takes its `⋯` and its select mode with it.
  useEffect(() => () => conceal(id), [id]);
  useEffect(() => {
    if (itemId === null) return;
    return () => endSelectText(itemId);
  }, [itemId]);

  return (
    <div
      ref={blockRef}
      data-block
      data-n={n}
      data-revealed={revealed ? "" : undefined}
      data-pinnable={open !== undefined ? "" : undefined}
      data-selectable={selectable ? "" : undefined}
      {...handlers}
      onPointerDown={onPress}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse" && open !== undefined) place();
      }}
      onContextMenu={onRightClick}
      onClickCapture={onClickCapture}
      className={cn(className, (pinned || open !== undefined) && "relative", open !== undefined && "group/block")}
    >
      {children}
      {pinned && <PinnedMark />}
      {open !== undefined && (
        <button
          ref={chipRef}
          type="button"
          data-slot="block-more"
          aria-label={t("pins.action.more")}
          onClick={open}
          onFocus={place}
          style={shift === 0 ? undefined : { translate: `-${shift}px 0` }}
          className={cn(
            // At rest: in the DOM for Tab, but clear and deaf to the pointer. Shown on the reveal, on a mouse's hover
            // and on a keyboard focus. Opacity only, so showing it repaints and lays nothing out (DESIGN.md §2).
            "pointer-events-none absolute top-3 right-0.5 z-[2] grid size-5 place-items-center rounded-sm border border-border bg-chrome text-muted-foreground opacity-0 transition-opacity before:absolute before:-inset-3 before:content-[''] hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring group-hover/block:pointer-events-auto group-hover/block:opacity-100",
            revealed && "pointer-events-auto opacity-100",
          )}
        >
          <Ellipsis aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}
