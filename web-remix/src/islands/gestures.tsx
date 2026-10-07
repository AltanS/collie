// THE GESTURES ISLAND (S3): the listeners an islands page needs on server HTML, all of them delegated
// from the document, so the rows and the header need no island of their own. It draws nothing.
//
//   - PREFETCH: a `pointerdown` on a link marked `data-prefetch` (a dashboard row) fetches that page's
//     document into the prefetch cache (islands/prefetch.ts); the resolver serves the tap from it. A
//     `pointercancel` (a scroll took the finger) drops it. A pane page warms its way back up: about 1.5 s
//     after it settles, the page Up leads to is fetched with a longer life.
//   - THE GLIDE: a row tap that can glide (lib/glide.ts `canGlide`) is taken from the runtime's link
//     handling and navigated inside the glide, at once when the prefetch has landed, else once it lands
//     or after READY_WAIT_MS. Any other link tap is the runtime's (a soft navigation through the
//     resolver), and with no Navigation API it is a plain document load.
//   - ACTS: a click on `[data-act]` and a long press on `[data-hold-act]` do what islands/act-table.ts
//     says (lib/acts.ts). The long press is lib/gestures.ts's own controller, bound to the element on
//     its first press.
//   - SCROLL MEMORY: each `[data-scroll-memory]` scroller's offset per history entry, put back after a
//     Back or Forward lands (lib/scroll.ts holds the offsets).
//   - FOCUS: a soft navigation leaves focus where the page says (`[data-focus-landing]`), never on the
//     body (the focus reset itself is turned off in islands/boot.ts).
import { clientEntry, type Handle } from "remix/component";

import { actArgs } from "../lib/acts";
import { address } from "../lib/data";
import { attachLongPress, LONG_PRESS_EVENT, type GestureNode } from "../lib/gestures";
import { bindGlideFrame, canGlide, glideForwardWhenReady, noteGlideLocation } from "../lib/glide";
import { navigate } from "../lib/navigate";
import { onServer } from "../lib/server-render";
import { currentScrollKey, recallScroll, rememberScroll } from "../lib/scroll";
import { upPath } from "../routes/pane/back";
import { href } from "../routes";
import { runAct } from "./act-table";
import { ISLAND } from "./ids";
import { warmPaneModules } from "./registry";
import { cancelPrefetch, prefetchDocument, prefetchSettled, WARM_TTL_MS } from "./prefetch";

/** How long after a pane page settles its way back up is fetched. */
/** A pane page's path, mount and all: its press also warms the pane's modules. */
const PANE_LINK = /\/pane\/[^/]+\/?$/u;
const WARM_UP_MS = 1500;

function elementOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function scrollSlot(el: HTMLElement): string {
  return `${currentScrollKey()}:${el.dataset.scrollMemory ?? ""}`;
}

/** Put every remembered scroller back (after a traverse lands). */
function restoreScroll(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-scroll-memory]")) {
    const top = recallScroll(scrollSlot(el));
    if (top === undefined) continue;
    el.scrollTop = top;
    // The list may still be short of its height for one frame (a frame resolving): once more.
    if (Math.abs(el.scrollTop - top) > 1) requestAnimationFrame(() => (el.scrollTop = top));
  }
}

/** Focus the page's landing when a navigation left it on the body. */
function landFocus(): void {
  if (document.activeElement !== null && document.activeElement !== document.body) return;
  const landing = document.querySelector<HTMLElement>("[data-focus-landing]");
  landing?.focus({ preventScroll: true });
}

export const Gestures = clientEntry(ISLAND.gestures, function Gestures(handle: Handle) {
  if (onServer()) return () => null;
  const signal = handle.signal;
  const top = handle.frames.top;
  bindGlideFrame(top, signal);

  // ── Prefetch and the glide ─────────────────────────────────────────────────────────────────────────
  document.addEventListener(
    "pointerdown",
    (event) => {
      const el = elementOf(event.target);
      const link = el?.closest<HTMLAnchorElement>("a[data-prefetch]");
      if (link != null && event.button === 0) {
        prefetchDocument(link.href);
        if (PANE_LINK.test(new URL(link.href).pathname)) warmPaneModules();
      }
      // A hold target binds its controller on its first press; the controller hears this same press.
      const hold = el?.closest<HTMLElement>("[data-hold-act]");
      if (hold != null && !held.has(hold)) bindHold(hold);
    },
    { capture: true, signal },
  );
  document.addEventListener(
    "pointercancel",
    (event) => {
      const link = elementOf(event.target)?.closest<HTMLAnchorElement>("a[data-prefetch]");
      if (link != null) cancelPrefetch(link.href);
    },
    { capture: true, signal },
  );
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || !plainClick(event)) return;
      const el = elementOf(event.target);
      const acting = el?.closest<HTMLElement>("[data-act]");
      if (acting != null) {
        const name = acting.dataset.act ?? "";
        if (runAct(name, actArgs(acting, "a"), acting)) event.preventDefault();
        return;
      }
      const row = el?.closest<HTMLAnchorElement>("a[data-glide-origin]");
      if (row == null || !canGlide()) return;
      const key = row.dataset.glideKey ?? "";
      const id = row.dataset.glideOrigin === "pane" ? "pane" : null;
      if (id === null) return;
      event.preventDefault();
      const target = row.href;
      glideForwardWhenReady(id, key, prefetchSettled(target), () => void navigate(target), row);
    },
    { signal },
  );

  // ── Long press ─────────────────────────────────────────────────────────────────────────────────────
  const held = new WeakSet<HTMLElement>();
  const bindHold = (node: HTMLElement): void => {
    held.add(node);
    node.style.setProperty("-webkit-touch-callout", "none");
    node.style.setProperty("user-select", "none");
    node.style.setProperty("-webkit-user-select", "none");
    const gesture: GestureNode = node;
    attachLongPress(gesture, () => ({}), signal);
    node.addEventListener(
      LONG_PRESS_EVENT,
      () => {
        const name = node.dataset.holdAct ?? "";
        runAct(name, actArgs(node, "h"), node);
      },
      { signal },
    );
  };

  // ── Scroll memory ──────────────────────────────────────────────────────────────────────────────────
  document.addEventListener(
    "scroll",
    (event) => {
      const el = event.target;
      if (el instanceof HTMLElement && el.dataset.scrollMemory !== undefined) rememberScroll(scrollSlot(el), el.scrollTop);
    },
    { capture: true, passive: true, signal },
  );

  // ── After each navigation ──────────────────────────────────────────────────────────────────────────
  let traversing = false;
  let warm: ReturnType<typeof setTimeout> | undefined;
  const settle = (first = false): void => {
    noteGlideLocation(window.location.pathname);
    if (traversing) restoreScroll();
    traversing = false;
    if (!first) landFocus();
    clearTimeout(warm);
    // A pane page warms the page Up goes to, so Back lands on a document already here.
    if (document.querySelector("[data-testid=pane-view]") !== null) {
      warm = setTimeout(() => prefetchDocument(new URL(href(upPath(address.get().scope)), window.location.href).href, WARM_TTL_MS), WARM_UP_MS);
    }
  };
  if ("navigation" in window) {
    window.navigation.addEventListener("navigate", (event) => (traversing = event.navigationType === "traverse"), { signal });
  }
  top.addEventListener("reloadComplete", () => settle(), { signal });
  signal.addEventListener("abort", () => clearTimeout(warm), { once: true });
  handle.queueTask(() => settle(true));

  return () => null;
});
