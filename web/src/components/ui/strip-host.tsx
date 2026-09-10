import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Collapse } from "@/components/ui/collapse";
import { OneOf } from "@/components/ui/one-of";
import { cn } from "@/lib/utils";

/**
 * The top band, and the rule that there is only ever ONE strip in it.
 *
 * Four strips can be true above the header at once — connection amber, connection red, the auth
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
 * Arbitration here is height-invariant BY CONSTRUCTION, not by luck: every strip sits on the same
 * `min-h-[33px]` floor stated in `ui/notice.tsx`, so a replacement repaints the band and never
 * moves it. The band's height animates on APPEAR and on LEAVE, and at no other time.
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

/**
 * Whether the band currently HAS a winner, published to everything below the host.
 *
 * It exists for exactly one reader — the sticky header directly under the band — and for exactly
 * one reason: the safe-area inset must be reserved ONCE. The header used to reserve it
 * unconditionally, on the (then true) assumption that it was the first thing on the screen. It is
 * not first any more, so while the band is showing something the header must reserve nothing, or
 * the notch is paid for twice and the operator sees a dead strip above the notice.
 *
 * `false` outside a host, deliberately, and it is the same posture as `StripSlot`'s: a tree with no
 * band has nothing above the header, so the header goes on owning the inset. That is what keeps the
 * playground's bare-header cards, and every test that renders a header alone, correct.
 */
const StripBandOpen = createContext(false);

/** True while the band is showing a strip. See {@link StripBandOpen}. */
export function useStripBandOpen(): boolean {
  return useContext(StripBandOpen);
}

/** How long a replacement takes to dissolve. The app's "tap" speed — see COLLAPSE_MS on the tokens. */
const SWAP_CLASS = "duration-[120ms]";

export function StripHost({ children, className }: { children: ReactNode; className?: string }) {
  const [slots, setSlots] = useState<ReadonlyMap<string, Registration>>(() => new Map());

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

  const layers: Array<{ key: string; node: ReactNode }> = ghost
    ? [{ key: ghost.id, node: ghost.node }]
    : [...slots].map(([id, entry]) => ({ key: id, node: entry.node }));

  return (
    <StripRegistry.Provider value={register}>
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

      <Collapse open={winner !== null} className={className}>
        {/*
          The safe-area inset lives HERE while the band is open, and nowhere else. Three of the four
          strips this replaced set `env(safe-area-inset-top)` themselves and one did not, so which
          strip you were looking at decided whether the band cleared the notch — and the header
          under them reserved it a second time regardless, which is the reported iOS bug. One owner,
          one answer, and it is the row rather than the Notice because it is a fact about the band's
          position in the viewport. The header takes it back whenever the band is empty, through
          `useStripBandOpen()`; between the two of them the notch is reserved exactly once, in every
          state and during the handover.

          All layers share ONE grid cell, so the band is as tall as the tallest of them and a swap
          cannot change its height even for a frame. The winner is opaque, the losers fade out under
          it — a dissolve inside the already-open Collapse, with no second height animation. The
          stacking itself is `ui/one-of.tsx`, which is where the same idiom now serves the composer's
          status slot; what stays here is what the band alone knows — which slot wins, how long the
          dissolve takes, and the ghost that keeps painting through the exit.
        */}
        <OneOf
          active={ghost ? ghost.id : winner}
          options={layers}
          className="[padding-top:env(safe-area-inset-top)]"
          layerClassName={cn("transition-opacity ease-out motion-reduce:transition-none", SWAP_CLASS)}
        />
      </Collapse>

      {/*
        The band's height and the header's inset are ONE reservation, split across two elements, so
        the boolean has to reach the header for the pair to stay at one notch's worth between them.
        Published on its own context rather than folded into the registry, so a slot registering
        does not re-render every consumer of the flag and the header does not re-render on a copy
        change that leaves the band open either way.
      */}
      <StripBandOpen.Provider value={winner !== null}>{children}</StripBandOpen.Provider>
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
