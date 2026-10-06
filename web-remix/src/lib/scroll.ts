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
  const restore = (el: HTMLElement): void => {
    el.scrollTop = recallScroll(key) ?? 0;
  };
  const restoreAfterCommit = (): void => {
    handle.queueTask((el) => restore(el));
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
    el.addEventListener("scroll", () => rememberScroll(key, el.scrollTop), { passive: true, signal: bound.signal });
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
