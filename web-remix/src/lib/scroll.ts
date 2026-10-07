// Inner scroll memory, per history entry (REMIX3.md, "Scroll"; P5 Q8). The Shell is
// `h-(--app-h) overflow-hidden`, so every route scrolls an inner element, and the runtime restores
// nothing there: it only restores WINDOW scroll (the Navigation API). So each route scroller wears
// `scrollMemory()`: it records `scrollTop` as the reader scrolls, under the key of the history entry
// it was drawn for (`navigation.currentEntry.key`), and puts it back after the commit with
// `queueTask` PAIRED WITH `update()` (a task alone never runs; P5 Q1).
//
// Keyed by entry, not URL: back and forward land where the reader left, a fresh push to the same URL
// starts at the top (P5 Q8, measured in both engines). Without the Navigation API the URL is the key.
// The terminal keeps its own, finer memory (`screen/follow.ts`). In memory for the page's life, bounded.
//
// NO LAYOUT READ OR WRITE WITHOUT A REASON (REMIX3.md, "Layout in insert callbacks"). The restore runs
// inside the runtime's flush, so writing `scrollTop` there forces a full layout of the screen that
// was just inserted: 36 ms of the 93 ms back flush at 4x CPU, even with nothing to put back
// (research note 05, rank 2). A freshly inserted scroller already sits at the top, so it is written
// only when a stored spot below the top exists; the same scroller re-keyed to another entry is
// written only when its spot differs from the one it last restored or recorded. It never reads.
//
// LATE CONTENT (lib/scroll-restore.ts): a spot the scroller is too short to reach yet is kept, not
// forgotten. After a write that could not land, a ResizeObserver on the scroller and its children
// (its numbers are free: they come after the frame's layout) retries on each growth for 3 s, and the
// browser's clamped offsets in between are not recorded over the real spot. The reader's wheel,
// touch, key or pointer ends it at once.
import { createMixin } from "remix/component";

import { basePath } from "@web/lib/base-path";

import { createScrollRestore, RESTORE_WINDOW_MS } from "./scroll-restore";

const MAX_SPOTS = 64;
const spots = new Map<string, number>();

/** This document's URL as the routes read it: mount off, path and query. */
export function currentScrollUrl(): string {
  const base = basePath();
  let path = window.location.pathname;
  if (base !== "/" && path.startsWith(base)) path = `/${path.slice(base.length)}`;
  return `${path}${window.location.search}`;
}

/** The history entry on screen now: its Navigation API key, else its URL. */
export function currentScrollKey(): string {
  const entry = window.navigation?.currentEntry;
  return entry ? `entry:${entry.key}` : `url:${currentScrollUrl()}`;
}

export function rememberScroll(key: string, top: number): void {
  spots.delete(key);
  spots.set(key, top);
  if (spots.size > MAX_SPOTS) {
    const oldest = spots.keys().next().value;
    if (oldest !== undefined) spots.delete(oldest);
  }
}

export function recallScroll(key: string): number | undefined {
  return spots.get(key);
}

/** What the reader does to take a scroller over: the restore never fights it. */
const READER_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

const scrollMemoryMixin = createMixin<HTMLElement, [slot: string | undefined]>((handle) => {
  let key = "";
  let url = "";
  let bound: AbortController | null = null;
  /** Where this element's scroll offset is known to be: 0 on insert, else the last write or scroll. */
  let known = 0;
  const restore = createScrollRestore();
  let watching: AbortController | null = null;

  /** Stop waiting for content: no observers, no timer, no reader listeners. */
  const unwatch = (): void => {
    watching?.abort();
    watching = null;
  };

  /**
   * After a write that may have clamped: watch the scroller for growth and retry. A ResizeObserver
   * callback runs after the frame's layout, so `scrollHeight` and `scrollTop` cost nothing there.
   */
  const watch = (el: HTMLElement): void => {
    unwatch();
    const mine = new AbortController();
    watching = mine;
    const retry = (): void => {
      if (mine.signal.aborted) return;
      const step = restore.step({ at: el.scrollTop, max: el.scrollHeight - el.clientHeight }, performance.now());
      if (step.kind === "wait") return;
      if (step.kind === "write") {
        el.scrollTop = step.top;
        known = step.top;
      }
      if (watching === mine) unwatch();
    };
    const sizes = new ResizeObserver(retry);
    const watchChild = (node: Node): void => {
      if (node instanceof Element) sizes.observe(node);
    };
    sizes.observe(el);
    for (const child of el.children) watchChild(child);
    // A child that arrives later (the rows replacing a skeleton) is content growing too.
    const arrivals = new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach(watchChild);
    });
    arrivals.observe(el, { childList: true });
    // The reader taking over ends it: their scroll, not ours, from here on.
    const stop = (): void => {
      restore.cancel();
      unwatch();
    };
    for (const type of READER_EVENTS) el.addEventListener(type, stop, { passive: true, once: true, signal: mine.signal });
    // A timer, because the observers fire only on growth. It ends with the window, hidden or not, and on `mine`.
    const timer = setTimeout(() => {
      restore.cancel();
      if (watching === mine) unwatch();
    }, RESTORE_WINDOW_MS);
    mine.signal.addEventListener(
      "abort",
      () => {
        sizes.disconnect();
        arrivals.disconnect();
        clearTimeout(timer);
      },
      { once: true },
    );
  };

  const restoreAfterCommit = (): void => {
    const top = recallScroll(key) ?? 0;
    if (top === known) {
      restore.cancel();
      unwatch();
      return;
    }
    handle.queueTask((el) => {
      el.scrollTop = top;
      // Just written, so the layout is current and this read is free. A clamped write reads short.
      known = el.scrollTop;
      restore.arm(top, performance.now());
      if (known < top) watch(el);
      else {
        restore.cancel();
        unwatch();
      }
    });
    void handle.update();
  };
  const rekey = (slot: string | undefined): void => {
    url = currentScrollUrl();
    key = slot === undefined ? currentScrollKey() : `${currentScrollKey()}#${slot}`;
  };
  let slotNow: string | undefined;
  handle.addEventListener("insert", (event) => {
    bound?.abort();
    bound = new AbortController();
    const el = event.node;
    rekey(slotNow);
    known = 0;
    restore.cancel();
    unwatch();
    el.addEventListener(
      "scroll",
      () => {
        known = el.scrollTop;
        // While a taller spot is being waited for, the browser's clamp is not where the reader is.
        if (!restore.holds(known)) rememberScroll(key, known);
      },
      { passive: true, signal: bound.signal },
    );
    restoreAfterCommit();
  });
  handle.addEventListener("remove", () => {
    bound?.abort();
    bound = null;
    restore.cancel();
    unwatch();
  });
  return (slot) => {
    slotNow = slot;
    // The same scroller now shows another entry (a keyed route would have remounted instead).
    if (bound !== null && currentScrollUrl() !== url) {
      rekey(slot);
      restoreAfterCommit();
    }
  };
});

/**
 * Remember and restore this scroller's offset per history entry. `slot` tells several scrollers on
 * one screen apart.
 */
export function scrollMemory(slot?: string) {
  return scrollMemoryMixin(slot);
}
