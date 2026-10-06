// The everyday move, animated (web/src/components/screen-transition.tsx): dashboard → pane slides
// the arriving screen in from the right, pane → dashboard from the left, 240 ms ease-out. Every
// other navigation (a scope change, pane to pane, settings) arrives with no animation, and so does a
// POP, unless the POP is the in-app back arrow (`noteInAppBack`, set by the header's up controls):
// the phone's own edge swipe plays the phone's own animation (D §12).
//
// Only the ARRIVING screen moves: the wrapper is keyed by a counter that bumps on a qualifying move,
// so the new route mounts inside a fresh wrapper whose entrance classes run once. The header, the
// mark and the strip band sit outside this wrapper and never move. A glide that owns the move
// (`lib/glide.ts`) stands the slide down. Reduced motion: `motion-reduce:animate-none`.
import type { Handle, RemixNode } from "remix/component";

import { homePath, panePath } from "@web/lib/nav";
import { cn } from "@web/lib/utils";

import { glideOwnsMove, noteGlideLocation } from "../lib/glide";

export type ScreenMove = "forward" | "back" | "none";

const DASHBOARD = homePath();
const PANE_PREFIX = panePath("");

function isPane(pathname: string): boolean {
  if (!pathname.startsWith(PANE_PREFIX)) return false;
  const rest = pathname.slice(PANE_PREFIX.length);
  return rest.length > 0 && !rest.includes("/");
}

/** Which way the screen moves between two root-relative pathnames (web/'s `classifyMove`). */
export function classifyMove(prev: string | null, next: string): ScreenMove {
  if (prev === null || prev === next) return "none";
  if (prev === DASHBOARD && isPane(next)) return "forward";
  if (isPane(prev) && next === DASHBOARD) return "back";
  return "none";
}

// ── What kind of navigation is running ───────────────────────────────────────────────────────────

let lastType: string | null = null;
let inAppBack = false;
let tracking = false;

/**
 * Record each navigation's type from the Navigation API's `navigate` event, which fires before the
 * runtime re-renders the Shell. Started once from main.tsx.
 */
export function startNavTracking(): void {
  if (tracking || !window.navigation) return;
  tracking = true;
  window.navigation.addEventListener("navigate", (event) => {
    lastType = event.navigationType;
  });
}

/** The next navigation comes from an in-app back control, so a POP still animates. */
export function noteInAppBack(): void {
  inAppBack = true;
}

/** Consumed once per screen change: true when this change is the browser's own back or forward. */
function takePop(): boolean {
  const pop = lastType === "traverse" && !inAppBack;
  lastType = null;
  inAppBack = false;
  return pop;
}

const ENTER = {
  forward: "duration-[240ms] ease-out animate-in slide-in-from-right fill-mode-forwards motion-reduce:animate-none",
  back: "duration-[240ms] ease-out animate-in slide-in-from-left fill-mode-forwards motion-reduce:animate-none",
  none: "",
} satisfies Record<ScreenMove, string>;

export function ScreenTransition(handle: Handle<{ pathname: string; children?: RemixNode }>) {
  let pathname: string | null = null;
  let move: ScreenMove = "none";
  let mounts = 0;
  return () => {
    const next = handle.props.pathname;
    if (next !== pathname) {
      const pop = takePop();
      move = pop || glideOwnsMove(next) ? "none" : classifyMove(pathname, next);
      if (move !== "none") mounts++;
      pathname = next;
      handle.queueTask(() => noteGlideLocation(next));
    }
    return (
      <div key={mounts} data-slot="screen-transition" data-move={move} class={cn("flex min-h-0 flex-1 flex-col", ENTER[move])}>
        {handle.props.children}
      </div>
    );
  };
}
