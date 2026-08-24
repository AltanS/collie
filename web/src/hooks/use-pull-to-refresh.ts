import { useCallback, useRef, useState } from "react";

import type { TouchEvent } from "react";

// PULL TO REFRESH — the gesture every phone user already knows, and the one affordance that says
// "ask again NOW" without teaching anybody a new control.
//
// It exists because polling alone cannot answer the operator's actual question. The snapshot is
// re-read on a cadence, and under a multiplexer that censuses for topology the bridge behind that
// snapshot is itself on a cadence (ADR 0031) — so "is this really what my terminal looks like?" had
// no answer but waiting. `POST /api/refresh` is that answer, and this is how a thumb asks for it.
//
// ── WHAT IT DELIBERATELY IS NOT ──────────────────────────────────────────────────────────────────
//
// Not a library. A pull-to-refresh is a threshold, a clamp and a callback; the dependency that
// wraps those also wraps a scroll container, a spring animation and a resize observer, and Collie's
// bundle is served to a phone over a tailnet.
//
// Not a `preventDefault`. React registers touch listeners passively, and fighting the browser's own
// overscroll to hide it would mean escaping React's event system for a native non-passive listener
// on every scroller. The native rubber-band and this indicator move together, which reads as one
// gesture rather than two.
//
// Not a scroll-position guess. The gesture only ever ARMS when the scroller is already at its top,
// read off the element at touch-start, and it disarms the moment the scroller moves — so a pull in
// the middle of a long herd list scrolls, exactly as it always did.

/** How far the finger must travel before the release counts as a refresh. */
export const PULL_TRIGGER_PX = 64;

/** How far the indicator will ever open, however hard the pull. Past this the gesture is just held. */
export const PULL_MAX_PX = 96;

/**
 * How far the indicator opens for a finger that has travelled `dy`.
 *
 * Halved and clamped: the resistance is what makes a pull feel deliberate rather than accidental,
 * and it is why {@link PULL_TRIGGER_PX} is reached by a finger that moved twice as far. A downward
 * pull only — an upward drag from the top is a scroll that has nowhere to go and must open nothing.
 *
 * Pure + exported: the whole feel of the gesture is these two numbers and this line.
 */
export function pullOffset(dy: number): number {
  return dy <= 0 ? 0 : Math.min(dy / 2, PULL_MAX_PX);
}

/** What the indicator should say right now. */
export type PullPhase = "idle" | "pulling" | "ready" | "refreshing";

/** The gesture's state, and the handlers that drive it. Spread the handlers onto the scroller. */
export interface PullToRefresh {
  /** How far the indicator is open, in px. */
  readonly distance: number;
  readonly phase: PullPhase;
  readonly handlers: {
    onTouchStart(event: TouchEvent<HTMLElement>): void;
    onTouchMove(event: TouchEvent<HTMLElement>): void;
    onTouchEnd(): void;
  };
}

/**
 * Wire a scroll container for pull-to-refresh.
 *
 * `onRefresh` is awaited, so the indicator stays open for as long as the ask actually takes — which
 * is the whole feedback the gesture gives. A rejection still closes it: the operator asked for a
 * fresh look, and a look that failed leaves the screen exactly as it was, which the connection
 * banner is already reporting.
 */
export function usePullToRefresh(onRefresh: () => Promise<void>): PullToRefresh {
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // The Y the gesture started at, or null when no gesture is armed. A ref, not state: it changes on
  // every touch move and must not re-render.
  const startY = useRef<number | null>(null);

  const onTouchStart = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      // Armed ONLY at the very top, and never while a refresh is already open — a second pull onto
      // an in-flight one would reopen the indicator under the first one's close.
      if (refreshing || event.currentTarget.scrollTop > 0) {
        startY.current = null;
        return;
      }
      startY.current = event.touches[0]?.clientY ?? null;
    },
    [refreshing],
  );

  const onTouchMove = useCallback((event: TouchEvent<HTMLElement>) => {
    const from = startY.current;
    if (from === null) return;
    // The scroller moved under the finger: this is a scroll, not a pull. Disarm rather than clamp,
    // so the gesture cannot re-open when the finger comes back up past the top.
    if (event.currentTarget.scrollTop > 0) {
      startY.current = null;
      setDistance(0);
      return;
    }
    const y = event.touches[0]?.clientY;
    if (y === undefined) return;
    setDistance(pullOffset(y - from));
  }, []);

  const onTouchEnd = useCallback(() => {
    const pulled = startY.current !== null && distance >= PULL_TRIGGER_PX;
    startY.current = null;
    if (!pulled) {
      setDistance(0);
      return;
    }
    setRefreshing(true);
    setDistance(PULL_TRIGGER_PX);
    void onRefresh().finally(() => {
      setRefreshing(false);
      setDistance(0);
    });
  }, [distance, onRefresh]);

  const phase: PullPhase = refreshing
    ? "refreshing"
    : distance >= PULL_TRIGGER_PX
      ? "ready"
      : distance > 0
        ? "pulling"
        : "idle";

  return { distance, phase, handlers: { onTouchStart, onTouchMove, onTouchEnd } };
}
