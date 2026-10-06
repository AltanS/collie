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
import { createMixin } from "remix/component";

import { basePath } from "@web/lib/base-path";

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

const scrollMemoryMixin = createMixin<HTMLElement, [slot: string | undefined]>((handle) => {
  let key = "";
  let url = "";
  let bound: AbortController | null = null;
  /** Where this element's scroll offset is known to be, without reading it: 0 on insert. */
  let known = 0;
  const restoreAfterCommit = (): void => {
    const top = recallScroll(key) ?? 0;
    if (top === known) return;
    handle.queueTask((el) => {
      el.scrollTop = top;
      known = top;
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
    el.addEventListener(
      "scroll",
      () => {
        known = el.scrollTop;
        rememberScroll(key, known);
      },
      { passive: true, signal: bound.signal },
    );
    restoreAfterCommit();
  });
  handle.addEventListener("remove", () => {
    bound?.abort();
    bound = null;
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
