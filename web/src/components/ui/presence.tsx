import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { usePrefersReducedMotion } from "@/components/ui/collapse";
import { hasResizeObserver } from "@/lib/env";
import { cn } from "@/lib/utils";

// PRESENCE: ITEMS THAT ARRIVE AND LEAVE A LIST, AND ONE BAND WHOSE CONTENT IS REPLACED, WITHOUT A JUMP.
//
// `Collapse` (ui/collapse.tsx) is the sanctioned way ONE surface appears or disappears in flow. A list
// needs two things more, and the Hill was the first place to need both (2026-11-10, the owner on the
// phone: "the animation and layout shift when I hit dismiss needs to be smoother"):
//
//  1. **`PresenceList`**: keyed items that come and go. An item whose key leaves the children is KEPT,
//     in its old place, showing the last thing it drew, while it collapses (height and opacity, and a
//     2 percent scale toward its top edge), and leaves the tree after. A key that arrives grows from
//     nothing the same way. The items below glide up or down with it because the leaving item's own
//     height is what animates: one element, no measuring, no FLIP, and it works whatever the list's
//     length. The list's GAP leaves with the item too (see `gap`), so nothing jumps when the item
//     finally unmounts. A group whose last item leaves is just an item of an outer list: it leaves
//     with that item inside it, as one motion, because what it holds is its last drawing.
//  2. **`HeightSwap`**: one band, several contents, exactly one shown, and the band's height eases
//     between theirs. Unlike `OneOf` (which reserves the biggest, so nothing ever resizes) and
//     `CollapseSwap` (which needs the stand-in to be the shorter), either side may be the taller: the
//     band is measured at the swap, eased from the old height to the new one, and handed back to
//     `auto` after. The leaving content fades out on top while the arriving one fades in.
//
// Both hold their last drawing through the exit, as `Collapse` does, and both take what leaves out of
// reach at once (`inert`), so a tap that lands during the 240 ms cannot press a control on its way out.
//
// MOTION. 240 ms (`PRESENCE_MS`), the app's move speed, on one decelerating curve (`PRESENCE_EASE`,
// cubic-bezier(0.4, 0, 0.2, 1), the standard curve: a gentle start, so nothing leaps in the first frame, and a long soft landing, no overshoot). Only `grid-template-
// rows` or `height` on the moving element, `opacity`, and `transform`; never a shadow, never a blur.
//
// REDUCED MOTION (`prefers-reduced-motion: reduce`): no height animation and no transform. An item
// that leaves or arrives only fades, over `PRESENCE_REDUCED_MS`, and the layout settles in one step
// at the end of the fade (leaving) or at its start (arriving). A swap fades the new content in over
// the same short time; the band takes its new height at once.

/** The duration of every presence motion, in ms. One number in CSS and in the timers (the test reads both). */
export const PRESENCE_MS = 240;
/** The opacity-only change that stands in for the motion under reduced motion, in ms. */
export const PRESENCE_REDUCED_MS = 120;
/** The curve of every presence motion, as a Tailwind class. Exported so a sibling fold (the view's Show all) moves on the same curve. */
export const PRESENCE_EASE = "ease-[cubic-bezier(0.4,0,0.2,1)]";
/** The literal that must match {@link PRESENCE_MS}. Tailwind reads class names from the source text. */
export const PRESENCE_DURATION = "duration-[240ms]";
const REDUCED_DURATION = "duration-[120ms]";

// ── PresenceList ───────────────────────────────────────────────────────────────────────────────────

/**
 * The order the list draws in: the next keys in their order, and every key that left kept right after
 * the key it followed before, so a leaving item collapses where it stood. Exported for its test.
 */
export function mergeKeys(prev: readonly string[], next: readonly string[]): string[] {
  const nextSet = new Set(next);
  const out: string[] = [];
  const placed = new Set<string>();
  let cursor = 0;
  const place = (key: string) => {
    if (placed.has(key)) return;
    placed.add(key);
    out.push(key);
  };
  for (const key of prev) {
    if (!nextSet.has(key)) {
      out.push(key);
      continue;
    }
    if (placed.has(key)) continue;
    // Every next key up to this one goes first: those are the arrivals that sit above it.
    while (cursor < next.length) {
      const k = next[cursor]!;
      cursor += 1;
      place(k);
      if (k === key) break;
    }
  }
  for (; cursor < next.length; cursor += 1) place(next[cursor]!);
  return out;
}

/** The children as (key, node) pairs. A child without a key of its own gets its place as one, which a caller should not rely on. */
function keyed(children: ReactNode): { key: string; node: ReactNode }[] {
  return Children.toArray(children).map((child, i) => ({ key: isValidElement(child) && child.key !== null ? String(child.key) : `#${i}`, node: child }));
}

export interface PresenceListProps {
  /**
   * The items, each a KEYED element: the key is the item's identity, so an item whose key is gone
   * leaves (collapsing in its old place, drawing what it drew last) and a new key arrives. Items that
   * are there at the first paint are part of that frame and do not animate in.
   */
  children: ReactNode;
  /**
   * The caller's gap between items, in px: the container's own `gap-3` is 12. A leaving item pulls
   * that gap in with it (a negative bottom margin that eases to minus the gap as its height eases to
   * zero), so the item below lands where it will stay and nothing moves when the item unmounts, and
   * the leaving item's own top does not move. 0 for a list whose rows touch (a `ListGroup`).
   */
  gap?: number;
  /** The element each item is wrapped in: `li` inside a `ul` (the wrapper is then the list item), `div` elsewhere. */
  itemAs?: "div" | "li";
  /** Classes on every item wrapper. */
  itemClassName?: string;
}

/**
 * Keyed items that arrive and leave with an eased collapse; see the header. Renders the item wrappers
 * only, no container: the caller's container keeps its own flex column and gap (`gap` says which).
 */
export function PresenceList({ children, gap = 0, itemAs = "div", itemClassName }: PresenceListProps) {
  const items = keyed(children);
  const keys = items.map((item) => item.key);
  const sig = keys.join("\u0000");

  // The keys drawn, leaving ones included, re-merged only when the children's keys change (the
  // documented "state from props" pattern: a set during render, guarded by the signature).
  const [track, setTrack] = useState<{ sig: string; order: string[] }>({ sig, order: keys });
  let order = track.order;
  if (track.sig !== sig) {
    order = mergeKeys(track.order, keys);
    setTrack({ sig, order });
  }

  // What each item drew last while it was present: a leaving item draws this, never the caller's
  // current render (which no longer has it). Written in an effect, read in render, as Collapse's hold.
  const held = useRef(new Map<string, ReactNode>());
  useEffect(() => {
    for (const item of items) held.current.set(item.key, item.node);
  });

  // Items present at the first paint are part of it; anything after arrives with the motion.
  const ready = useRef(false);
  useEffect(() => {
    ready.current = true;
  }, []);

  const remove = useCallback((key: string) => {
    held.current.delete(key);
    setTrack((t) => (t.order.includes(key) ? { ...t, order: t.order.filter((k) => k !== key) } : t));
  }, []);

  const present = new Map(items.map((item) => [item.key, item.node]));
  return (
    <>
      {order.map((key) => {
        const node = present.has(key) ? present.get(key) : held.current.get(key);
        return (
          <PresenceItem key={key} id={key} present={present.has(key)} appear={ready.current} gap={gap} as={itemAs} className={itemClassName} onGone={remove}>
            {node}
          </PresenceItem>
        );
      })}
    </>
  );
}

function PresenceItem({
  id,
  present,
  appear,
  gap,
  as: Tag,
  className,
  onGone,
  children,
}: {
  id: string;
  present: boolean;
  appear: boolean;
  gap: number;
  as: "div" | "li";
  className?: string;
  onGone: (key: string) => void;
  children: ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const ms = reduced ? PRESENCE_REDUCED_MS : PRESENCE_MS;
  // `shown`: which end of the motion the item heads for. `settled`: the enter is over, so the clip
  // comes off (an open item must not clip a child's focus ring or tap extension, Collapse's reason).
  // Read once, at mount: an item drawn in the list's first paint is born open and never animates in.
  const [born] = useState(present && !appear);
  const [shown, setShown] = useState(born);
  const [settled, setSettled] = useState(born);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      if (born) return;
    }
    if (present) {
      setSettled(false);
      // Two painted frames, Collapse's reason: the closed end must be on screen before the open one
      // is asked for, or there is no start value and the item pops in.
      let second = 0;
      const one = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setShown(true));
      });
      const done = window.setTimeout(() => setSettled(true), ms + 16);
      return () => {
        cancelAnimationFrame(one);
        cancelAnimationFrame(second);
        clearTimeout(done);
      };
    }
    setShown(false);
    setSettled(false);
    const leave = window.setTimeout(() => onGone(id), ms);
    return () => clearTimeout(leave);
  }, [present, ms, id, onGone, born]);

  // Reduced motion keeps the height and the margin where they rest and moves only the opacity.
  const collapsed = !shown && !reduced;
  // The gap leaves with the item as a negative BOTTOM margin, so the item's own top stays where it is
  // while it collapses (a top margin would drift it up by the gap). A row of a touching list (gap 0)
  // drops the top margin a theme's row gap gives it, and its rule.
  const style: CSSProperties | undefined = collapsed ? (gap > 0 ? { marginBottom: -gap, borderBottomWidth: 0 } : { marginTop: 0, borderBottomWidth: 0 }) : undefined;
  return (
    <Tag
      data-slot="presence-item"
      data-state={shown ? "open" : "closed"}
      inert={!present}
      aria-hidden={present ? undefined : true}
      style={style}
      className={cn(
        "grid min-w-0",
        reduced ? cn("transition-opacity", REDUCED_DURATION) : cn("transition-[grid-template-rows,opacity,margin,border-width]", PRESENCE_DURATION, PRESENCE_EASE),
        collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        shown ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      <div
        className={cn(
          "min-h-0 min-w-0 origin-top",
          // While it moves the clip is on, widened by 4px on every side (and paid back by the margin)
          // so a card's own shadow is not cut off at the start of the motion.
          !settled && "-m-1 overflow-hidden p-1",
          !reduced && cn("transition-transform", PRESENCE_DURATION, PRESENCE_EASE),
          collapsed && "scale-[0.98]",
        )}
      >
        {children}
      </div>
    </Tag>
  );
}

// ── HeightSwap ─────────────────────────────────────────────────────────────────────────────────────

export interface HeightSwapProps {
  /** Which option is shown. A change starts the swap. */
  active: string;
  /** Every content this band can show. Only the shown one (and, for one swap, the leaving one) is drawn. */
  options: ReadonlyArray<{ key: string; node: ReactNode }>;
  className?: string;
  "data-slot"?: string;
}

/**
 * One band, one content at a time, and the band's height eased between them; see the header. The
 * band is drawn at the first paint with no motion. The leaving content draws what it drew last.
 */
export function HeightSwap({ active, options, className, "data-slot": slot }: HeightSwapProps) {
  const reduced = usePrefersReducedMotion();
  const ms = reduced ? PRESENCE_REDUCED_MS : PRESENCE_MS;
  const band = useRef<HTMLDivElement>(null);
  const layers = useRef(new Map<string, HTMLDivElement>());
  const held = useRef(new Map<string, ReactNode>());
  const restHeight = useRef(0);
  const timer = useRef(0);

  // `turn` counts swaps so a late timer from an earlier one cannot end a later one. `back` is the key
  // that was leaving when this swap began: a swap back to it reverses a fade already under way.
  const [swap, setSwap] = useState<{ shown: string; leaving: string | null; back: string | null; turn: number }>({ shown: active, leaving: null, back: null, turn: 0 });
  if (swap.shown !== active) setSwap({ shown: active, leaving: swap.shown, back: swap.leaving, turn: swap.turn + 1 });

  useEffect(() => {
    held.current.set(swap.shown, options.find((o) => o.key === swap.shown)?.node);
  });

  // The band's height at rest, kept current by the browser so the swap knows where it starts from.
  useEffect(() => {
    const el = band.current;
    if (el === null || !hasResizeObserver()) return;
    const ro = new ResizeObserver(() => {
      if (el.style.height === "") restHeight.current = el.getBoundingClientRect().height;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    const el = band.current;
    if (el === null || swap.leaving === null) return;
    clearTimeout(timer.current);
    // Mid-swap the band has an eased height of its own: start from where it is now.
    const from = el.style.height !== "" ? el.getBoundingClientRect().height : restHeight.current;
    el.style.transition = "none";
    el.style.height = "";
    el.style.overflow = "hidden";
    const to = el.getBoundingClientRect().height;
    if (!reduced && from > 0 && Math.abs(from - to) > 0.5) {
      el.style.height = `${from}px`;
      void el.offsetHeight;
      el.style.transition = "";
      el.style.height = `${to}px`;
    } else el.style.transition = "";
    // A content that just mounted fades in from nothing; one coming back mid-fade carries on from where it is.
    const incoming = layers.current.get(swap.shown);
    if (incoming !== undefined && swap.back !== swap.shown) {
      incoming.style.transition = "none";
      incoming.style.opacity = "0";
      void incoming.offsetHeight;
      incoming.style.transition = "";
      incoming.style.opacity = "";
    }
    const turn = swap.turn;
    timer.current = window.setTimeout(() => {
      el.style.height = "";
      el.style.overflow = "";
      restHeight.current = el.getBoundingClientRect().height;
      setSwap((s) => (s.turn === turn ? { ...s, leaving: null, back: null } : s));
    }, ms);
  }, [swap, reduced, ms]);

  const shownNode = options.find((o) => o.key === swap.shown)?.node;
  const keysDrawn = swap.leaving === null ? [swap.shown] : [swap.shown, swap.leaving];
  return (
    <div
      ref={band}
      data-slot={slot}
      data-swap={swap.leaving === null ? undefined : ""}
      className={cn("relative min-w-0", !reduced && cn("transition-[height]", PRESENCE_DURATION, PRESENCE_EASE), className)}
    >
      {/* One keyed layer per content, so the element of a content survives the change from shown to
          leaving (and back), and its opacity transition starts from the value it has. */}
      {keysDrawn.map((key) => {
        const leaving = key !== swap.shown;
        return (
          <div
            key={key}
            ref={(el) => {
              if (el === null) layers.current.delete(key);
              else layers.current.set(key, el);
            }}
            data-swap-layer={key}
            data-active={leaving ? undefined : ""}
            inert={leaving}
            aria-hidden={leaving ? true : undefined}
            className={cn(
              "min-w-0 transition-opacity",
              // The leaving one fades out fast, the arriving one over the whole motion: a cross-fade
              // that never shows both at half strength.
              leaving ? cn("pointer-events-none absolute inset-x-0 top-0 opacity-0", reduced ? "duration-0" : "duration-[120ms]") : cn("opacity-100", reduced ? REDUCED_DURATION : PRESENCE_DURATION),
              "ease-out",
            )}
          >
            {leaving ? held.current.get(key) : shownNode}
          </div>
        );
      })}
    </div>
  );
}
