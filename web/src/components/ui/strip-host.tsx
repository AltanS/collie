import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";

import { Collapse } from "@/components/ui/collapse";
import { OneOf } from "@/components/ui/one-of";
import { hasResizeObserver } from "@/lib/env";
import { cn } from "@/lib/utils";

/**
 * The ribbon band, and the rule that there is only ever ONE strip in it.
 *
 * Four strips can be true at once — connection amber, connection red, the auth
 * refusal, the update offer — and none of them excludes another. Two of them at once cost ~66px of
 * a 390×844 phone and double the number of times the page moves, and every pair of them has a
 * strict "which of these matters more" answer anyway: amber behind red is strictly less information
 * than red alone. So the band arbitrates. The losing fact is not lost — the update offer keeps its
 * footer line and its settings control — it is only not shouted over a worse one.
 *
 * The four registered here through `StripSlot` all at once, because the band is indivisible: while
 * one of them still drew its own row it went on reserving the safe-area inset beside this one, and
 * an iPhone paid for the notch twice. `routes/root.tsx` mounts the one host.
 *
 * WHERE IT PAINTS: OVER the top of the route, as an overlay hung from the header's bottom edge
 * (2026-10-07). The host renders a zero-height anchor and then its `children`, and `routes/root.tsx`
 * mounts it INSIDE `AppHeaderHost`, so the anchor is the header's next sibling in the column and
 * sits exactly on the bar's bottom edge. The band is absolutely positioned from that anchor, so it
 * reserves no space: the pane strip on a pane page, the filter row on the dashboard, whatever is
 * directly under the header, is COVERED while a strip shows, and nothing moves. The operator's
 * report that decided it: an outage shoved the tab and pane rows down, and a layout shift under a
 * thumb is worse than a row hidden for the length of an outage.
 *
 * Two earlier homes, both in flow. Above the header until the morning of 2026-10-07, which made it
 * the first thing on the screen while open: it had to take the notch from the header and give it
 * back, and the whole page, bar included, jumped. Then under the header, in flow, which kept the
 * bar still but still pushed the route down by the band's height. The overlay moves neither.
 *
 * THE STACKING RUNG: `z-30`. Every in-flow surface in the app tops out at `z-20` (the sticky header,
 * the composer dock, the Changes file bar, the agent-chat docks), so the band covers all of them.
 * `z-40` is the toasts and the anchored menu's dismiss surface, `z-50` the sheets, the update screen
 * and the idle lock, so all of those cover the band. The anchor is `relative` and in the root
 * column's own stacking context, which is what lets the number compare against the route's.
 *
 * THE SURFACE. The band paints the page colour (`bg-background`) under the Notice's translucent
 * tint, so the row it covers does not show through, and a `shadow-md` under its bottom edge, so it
 * reads as floating over that row rather than as a row of its own. Both sit on the `Collapse`
 * itself, which only exists while a strip is rendered, so an empty band casts no shadow.
 *
 * Arbitration does not move the band either: every strip sits on the same `min-h-[33px]` floor
 * stated in `ui/notice.tsx`, so a replacement usually repaints the band at the same height, and a
 * taller one covers a few more pixels of the row beneath. The band's height animates on APPEAR and
 * on LEAVE through `Collapse`, which on an overlay moves nothing but the band's own bottom edge.
 *
 * WHAT THE BAND COVERS, AND WHO KEEPS CLEAR OF IT (2026-10-08). Covering the strips under the header
 * is the design; covering the FIRST ROW OF CONTENT is a fault. A saved copy is red at once, its strip
 * can run to ~57px on a phone, and the strips under the header on a one-pane tab are ~35px, so the
 * band hid the "Saved copy from" line until the strip was dismissed. The same overlap hid the first
 * card of every route with no strip under the header. So the band publishes the height it WILL have
 * (the content's own, not the animated box's, so a consumer is not re-laid-out on every frame of the
 * slide) through {@link useBandInset}, and a scroller that holds content at its top asks the hook how
 * far the band reaches INTO it: the band's bottom edge minus the scroller's top edge, which already
 * counts the strips between them. Zero when the strips are as tall as the band, and so nothing moves
 * for the common strip. The scroller turns the number into top padding on its own motion (the same
 * 240ms as the band), which is the one place content is allowed to move for a state.
 *
 * The host is domain-blind and tone-blind. It does not know what a connection is, it styles
 * nothing, and it announces nothing — the Notice inside carries its own `announce`. Priorities
 * reach it as plain numbers; the TABLE that names them belongs on the feature side, so that
 * "AUTH beats OUTAGE beats DEGRADED beats UPDATE" is a fact about this app rather than a fact
 * about `ui/`.
 */

interface Registration {
  priority: number;
  node: ReactNode;
}

type Register = (id: string, entry: Registration | null) => void;

const StripRegistry = createContext<Register | null>(null);

interface BandValue {
  /** The height the open band will have, or 0 with nothing showing (and always 0 for a flow band). */
  height: number;
  /** The zero-height anchor on the header's bottom edge: the band's top. */
  anchorRef: RefObject<HTMLElement | null>;
}

const BandContext = createContext<BandValue | null>(null);

/**
 * How far an overlay band reaching down from `anchorTop` for `bandHeight` px runs INTO an element
 * whose top edge is at `elTop`. Pure, so the arithmetic is tested without a layout engine. Never
 * negative: an element that starts below the band is not covered by it.
 */
export function bandOverlap(anchorTop: number, bandHeight: number, elTop: number): number {
  return Math.max(0, Math.round(anchorTop + bandHeight - elTop));
}

/**
 * Add to a scroller that takes {@link useBandInset}'s style: the band's own slide speed
 * (`COLLAPSE_MS` in `collapse.tsx`, which this literal must match).
 */
export const BAND_INSET_CLASS =
  "transition-[padding-top] ease-out motion-reduce:transition-none duration-[240ms]";

/**
 * Keeps the top of a scroller clear of the strip band.
 *
 * `ref` is the scroller (the element whose content starts at its top) and `base` is the top padding
 * it has on its own, in px. The result is the `style` that sets `padding-top` to whichever is larger,
 * `base` or the overlap between the band and the scroller's top edge, so a scroller whose own padding
 * already clears the band is left exactly as it was (the common strip, the common phone) and one
 * that does not is pushed down by the shortfall and no more. `undefined` outside a host (a unit test,
 * a playground card), where there is no band to keep clear of.
 *
 * The overlap is measured, not assumed, because what sits between the header and a scroller is
 * different on every route: the pane's tab and pane strips, the dashboard's filter row, nothing.
 * Re-read after every commit of the caller (a strip above it may have changed height) and on window
 * resize; a state that does not change the number bails out.
 */
export function useBandInset(ref: RefObject<HTMLElement | null>, base = 0): CSSProperties | undefined {
  const band = useContext(BandContext);
  const [inset, setInset] = useState(0);
  const height = band?.height ?? 0;
  const anchorRef = band?.anchorRef;
  const measure = useCallback(() => {
    const el = ref.current;
    const anchor = anchorRef?.current;
    if (!el || !anchor || height === 0) return setInset(0);
    setInset(bandOverlap(anchor.getBoundingClientRect().top, height, el.getBoundingClientRect().top));
  }, [ref, anchorRef, height]);
  useLayoutEffect(measure);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);
  if (!band) return undefined;
  return { paddingTop: Math.max(base, inset) };
}

/**
 * A route's `<main>` scroller that keeps its first row clear of the band: {@link useBandInset} with
 * its own ref, for the pages whose content starts at the top (Settings, Crew, Machines, Updates).
 * `base` is the top padding the className gives it, in px.
 */
export function BandMain({
  base,
  className,
  style,
  ...props
}: HTMLAttributes<HTMLElement> & { base: number }) {
  const ref = useRef<HTMLElement>(null);
  const inset = useBandInset(ref, base);
  return <main ref={ref} className={cn(inset && BAND_INSET_CLASS, className)} style={{ ...style, ...inset }} {...props} />;
}

/** How long a replacement takes to dissolve. The app's "tap" speed — see COLLAPSE_MS on the tokens. */
const SWAP_CLASS = "duration-[120ms]";

export function StripHost({
  children,
  className,
  flow = false,
}: {
  children: ReactNode;
  className?: string;
  /**
   * Paint the band IN FLOW instead of over what follows it. The app never sets this. It is for a
   * stage that shows a strip on its own, the playground's single-strip cards: with no route under
   * the band there is nothing for it to cover, and an overlay on a zero-height anchor would hang
   * outside the card's clipped box and show nothing at all.
   */
  flow?: boolean;
}) {
  const [slots, setSlots] = useState<ReadonlyMap<string, Registration>>(() => new Map());
  const anchorRef = useRef<HTMLDivElement>(null);
  // A state-held node, not a ref object: the Collapse mounts its content a render AFTER the slot
  // registers (it is rendered only once it has opened), so the node arrives late and the measuring
  // effect has to run when it does.
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null);
  const [contentHeight, setContentHeight] = useState(0);

  // Identity-checked, so a feature re-rendering with the same copy does not churn the host. There
  // is no render loop here even though the host renders `children`: the host's own setState
  // re-renders the host, but `props.children` is the same element object the PARENT created, so
  // React bails out of that subtree and the slots do not re-register. Only a real change upstream
  // produces a new node, which is exactly when the band should repaint.
  const register = useCallback<Register>((id, entry) => {
    setSlots((prev) => {
      const current = prev.get(id);
      if (!entry) {
        if (!current) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      }
      if (current && current.priority === entry.priority && current.node === entry.node) return prev;
      const next = new Map(prev);
      next.set(id, entry);
      return next;
    });
  }, []);

  // Strict `>` and insertion order: two slots claiming the same priority resolve to whichever
  // registered first, deterministically, rather than flickering between them.
  let winner: string | null = null;
  let best = Number.NEGATIVE_INFINITY;
  for (const [id, entry] of slots) {
    if (entry.priority > best) {
      best = entry.priority;
      winner = id;
    }
  }

  // The band keeps painting its last strip while it collapses. Without this the content vanishes
  // the instant the condition clears and the Collapse animates an empty box — the exit reads as a
  // blink followed by a slide, instead of the strip sliding away. Keyed by the slot's id, so React
  // reconciles the ghost as the same element it was already showing and nothing remounts.
  const last = useRef<{ id: string; node: ReactNode } | null>(null);
  if (winner) last.current = { id: winner, node: slots.get(winner)?.node ?? null };
  const ghost = slots.size === 0 ? last.current : null;

  const open = winner !== null;
  // The band's own content height, measured where it is NATURAL: inside the Collapse's clip, whose
  // outer box is the animated one. Read after layout and on every resize of the content (a strip
  // that wraps to a second line when the phone turns), so the number leads the slide by one frame
  // and never trails it.
  useLayoutEffect(() => {
    const node = contentNode;
    if (!node) return setContentHeight(0);
    const read = () => setContentHeight(Math.round(node.getBoundingClientRect().height));
    read();
    if (!hasResizeObserver()) return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [contentNode, winner, ghost]);
  // A flow band reserves its own space, so it covers nothing; a closed one covers nothing either.
  const covered = flow || !open ? 0 : contentHeight;
  const band = useMemo<BandValue>(() => ({ height: covered, anchorRef }), [covered]);

  const layers: Array<{ key: string; node: ReactNode }> = ghost
    ? [{ key: ghost.id, node: ghost.node }]
    : [...slots].map(([id, entry]) => ({ key: id, node: entry.node }));

  return (
    <StripRegistry.Provider value={register}>
      <BandContext.Provider value={band}>
      {/*
        Two live regions that exist BEFORE anything has to be announced, and never unmount.
        A live region has to be in the document before its contents change or the change is not
        reliably announced — mounting a `role="alert"` and its text in the same commit is the
        classic way to ship a banner that no screen reader ever reads. These two are the band's
        permanent anchors: the host itself never unmounts, so a Notice appearing inside it is a
        change WITHIN a region that was already there, not the arrival of a new one.
        A role and nothing else — no `aria-live` beside it. `role="status"` already means polite
        and `role="alert"` already means assertive; writing both asks for two answers to one
        question, which is the contradiction ui/notice.tsx exists to make unwritable.
      */}
      <div className="sr-only" role="status" data-slot="strip-live-polite" />
      <div className="sr-only" role="alert" data-slot="strip-live-assertive" />

      {/*
        The anchor: in flow, zero high, so it costs the column nothing and lands on the header's
        bottom edge. The band hangs from its top. See "WHERE IT PAINTS" above for the rung.
      */}
      <div
        ref={anchorRef}
        data-slot="strip-anchor"
        data-placement={flow ? "flow" : "overlay"}
        className={flow ? undefined : "relative z-30 h-0 shrink-0"}
      >
        <Collapse
          open={winner !== null}
          className={cn(!flow && "absolute inset-x-0 top-0 bg-background shadow-md", className)}
        >
          {/*
            No safe-area inset here, and none on any strip: the band hangs under the header, and the
            header owns the notch in every state (`app-header.tsx`).

            All layers share ONE grid cell, so the band is as tall as the tallest of them and a swap
            cannot change its height even for a frame. The winner is opaque, the losers fade out under
            it — a dissolve inside the already-open Collapse, with no second height animation. The
            stacking itself is `ui/one-of.tsx`, which is where the same idiom now serves the composer's
            status slot; what stays here is what the band alone knows — which slot wins, how long the
            dissolve takes, and the ghost that keeps painting through the exit.
          */}
          <div ref={setContentNode} data-slot="strip-band-content">
            <OneOf
              active={ghost ? ghost.id : winner}
              options={layers}
              layerClassName={cn("transition-opacity ease-out motion-reduce:transition-none", SWAP_CLASS)}
            />
          </div>
        </Collapse>
      </div>

      {children}
      </BandContext.Provider>
    </StripRegistry.Provider>
  );
}

/**
 * Registers a strip with the nearest {@link StripHost} and renders NOTHING where it sits.
 *
 * That is the point: the feature component stays where it belongs in the tree, next to the state
 * machine that decides whether its condition holds, while the pixels appear in the one band that
 * arbitrates them. A feature never has to know which other strips exist — only how loud its own
 * fact is, as a number.
 *
 * Outside a host it registers nowhere and paints nothing, rather than throwing: a strip is chrome,
 * and a route that forgot the host should be missing a banner, not blank.
 */
export function StripSlot({ priority, children }: { priority: number; children: ReactNode }): null {
  const id = useId();
  const register = useContext(StripRegistry);
  // Two effects, not one with a cleanup. A single effect would deregister and re-register on every
  // copy change, and re-inserting into the registry moves the slot to the back of the insertion
  // order — which is the host's tie-break. Updating in place keeps a slot's rank stable for as
  // long as it is mounted.
  useEffect(() => {
    register?.(id, { priority, node: children });
  }, [register, id, priority, children]);
  useEffect(() => () => register?.(id, null), [register, id]);
  return null;
}
