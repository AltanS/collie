// Inner scroll memory, per URL (REMIX3.md, "Scroll"). The Shell is `h-(--app-h) overflow-hidden`, so
// every route scrolls an inner element, and the runtime restores nothing there: it only resets or
// restores WINDOW scroll. So each route scroller wears `scrollMemory()`: it records `scrollTop` per
// URL as the reader scrolls, and puts it back in a `queueTask` after the first commit (the DOM the
// offset refers to exists by then). The terminal keeps its own, finer memory (`screen/follow.ts`).
//
// In memory for the page's life, bounded. A cold open starts at the top, as web/ does.
import { createMixin } from "remix/component";

import { basePath } from "@web/lib/base-path";

const MAX_SPOTS = 64;
const spots = new Map<string, number>();

/** This document's URL as the routes read it: mount off, path and query. */
export function currentScrollKey(): string {
  const base = basePath();
  let path = window.location.pathname;
  if (base !== "/" && path.startsWith(base)) path = `/${path.slice(base.length)}`;
  return `${path}${window.location.search}`;
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

const scrollMemoryMixin = createMixin<HTMLElement, [key: string | undefined]>((handle) => {
  let key = "";
  let node: HTMLElement | null = null;
  let bound: AbortController | null = null;
  const restore = (el: HTMLElement): void => {
    const top = recallScroll(key);
    el.scrollTop = top ?? 0;
  };
  handle.addEventListener("insert", (event) => {
    node = event.node;
    bound?.abort();
    bound = new AbortController();
    const el = event.node;
    el.addEventListener("scroll", () => rememberScroll(key, el.scrollTop), { passive: true, signal: bound.signal });
    handle.queueTask((target) => restore(target));
  });
  handle.addEventListener("remove", () => {
    bound?.abort();
    bound = null;
    node = null;
  });
  return (explicit) => {
    const next = explicit ?? currentScrollKey();
    if (next === key) return;
    const changed = key !== "";
    key = next;
    // The same scroller now shows another URL (a keyed route would have remounted instead).
    if (changed && node !== null) handle.queueTask((target) => restore(target));
  };
});

/** Remember and restore this scroller's offset per URL (or per `key`, when one URL has several). */
export function scrollMemory(key?: string) {
  return scrollMemoryMixin(key);
}
