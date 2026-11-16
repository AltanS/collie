// "Stop icon", the round for the look: the Belt's Stop pill wears the outline square (icon key `stop`,
// lucide `Square`), and the operator says it reads like a checkbox. Four other glyphs, side by side, on
// the real components. A pick round is a proposal in the workspace's design app
// (`design propose <worktree> stop-icon`), never a design reference entry.
//
// The icon system has no seam to swap one key for a subtree, and the app must stay as it is, so the
// seam lives HERE: `SwapStopIcon` finds every `svg[data-icon="stop"]` the real components draw below it,
// hides it, and draws the option's glyph in the same place, with the same classes (size, colour). The
// pills, the belt, the buttons and their states are the real ones; only the glyph differs.
//
// The mic button in the composer (the recording state) needs a live recorder and the whole `Composer`,
// which no fixture mounts. Its case draws the real `Button` and the real `Icon name="stop"` with the
// classes the composer gives them, so the swap reaches it the same way.
//
// 1 Filled square: the same key, with `fill-current`, the way the recording mic already draws it.
// 2 Circle with square: lucide `CircleStop`. 3 Octagon stop sign: lucide `OctagonX`; the plain `Octagon`
// reads as an empty circle at 16 px. 4 Raised hand: lucide `Hand`.
//
// After the pick: change the `stop` key in `components/icons/keys.ts` (and its phosphor and iconoir
// columns, then `bun scripts/glyph-keys.ts`), delete this file and its line in ../rounds.ts.

import { CircleStop, Hand, OctagonX, type LucideIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ActionsRow } from "@/components/actions-row";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { TOOLBAR_TAP_TARGET } from "@/components/ui/tap-target";
import { DURABLE_BAR } from "@/lib/harness-bar";
import { cn } from "@/lib/utils";

import { took, useRoomyActions } from "@/playground/sections/shared";

import type { PickCase, PickOption, PickRoundDef } from "../types";

const CASES: readonly PickCase[] = [
  { id: "running", label: "Turn running" },
  { id: "idle", label: "No turn" },
  { id: "others", label: "Other places" },
];

/** What an option draws in place of the `stop` glyph, given the classes the app gave the original. */
type Draw = (className: string) => ReactNode;

/** A stroke glyph never takes `fill-current`: the recording mic's fill would paint over the inside of a circle. */
function unfilled(className: string): string {
  return className
    .split(/\s+/u)
    .filter((c) => c !== "" && c !== "fill-current")
    .join(" ");
}

const drawLucide =
  (Glyph: LucideIcon): Draw =>
  (className) => <Glyph className={unfilled(className)} aria-hidden="true" />;

/** The shipped key, filled: the glyph the recording mic already wears. */
const drawFilled: Draw = (className) => <Icon name="stop" className={cn(unfilled(className), "fill-current")} />;

interface Swap {
  readonly slot: HTMLSpanElement;
  readonly root: Root;
}

/**
 * Draws `draw` in place of every `stop` glyph the real components below it render, and keeps doing so
 * while they re-render (the pill turns to a spinner and back, the arm look changes).
 */
function SwapStopIcon({ draw, children }: { draw: Draw; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (el === null) return;
    const swaps = new Map<SVGElement, Swap>();
    const drop = (svg: SVGElement, swap: Swap) => {
      swaps.delete(svg);
      swap.slot.remove();
      // Unmount after the current commit, never inside it.
      queueMicrotask(() => swap.root.unmount());
    };
    const sync = () => {
      for (const [svg, swap] of swaps) if (!svg.isConnected) drop(svg, swap);
      for (const svg of el.querySelectorAll<SVGElement>('svg[data-icon="stop"]')) {
        if (swaps.has(svg) || svg.closest("[data-stop-swap]") !== null) continue;
        const slot = document.createElement("span");
        slot.dataset.stopSwap = "";
        slot.style.display = "contents";
        svg.style.display = "none";
        svg.after(slot);
        const root = createRoot(slot);
        root.render(draw(svg.getAttribute("class") ?? ""));
        swaps.set(svg, { slot, root });
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(el, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const [svg, swap] of swaps) {
        svg.style.display = "";
        drop(svg, swap);
      }
    };
  }, [draw]);
  return (
    <div ref={host} className="contents">
      {children}
    </div>
  );
}

/** The belt block of a pane, the way the composer's chrome block holds it. */
function Block({ children }: { children: ReactNode }) {
  return (
    <div data-slot="chrome-block" className="relative border-t border-rule bg-chrome px-3">
      {children}
    </div>
  );
}

/** The Belt of a pane with a screen: the real `ActionsRow`, with the real `ScreenStop` first in it. */
function ScreenBelt({ running }: { running: boolean }) {
  const general = useRoomyActions();
  return (
    <Block>
      <ActionsRow general={general} agent="claude" onRun={took} stop={{ onStop: async () => {}, paneId: "pick-stop", running }} />
    </Block>
  );
}

/** The belt of a durable program with a turn running: the real `DurableBar`, Steer and Stop. */
function ProgramBelt() {
  const [steer, setSteer] = useState(false);
  return (
    <Block>
      <ActionsRow
        general={[]}
        agent={undefined}
        onRun={took}
        durable={{
          items: DURABLE_BAR,
          state: {
            steer: { pressed: steer, offered: true, onPressedChange: setSteer },
            stop: { offered: true, busy: false, onStop: () => undefined },
          },
        }}
      />
    </Block>
  );
}

/** The mic button of the composer while a clip records, drawn with the composer's own classes. */
function RecordingMic() {
  return (
    <Block>
      <div className="flex items-center justify-end gap-3 py-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-slot="composer-mic-expanded"
          className={cn(TOOLBAR_TAP_TARGET, "size-9 shrink-0 rounded-full bg-secondary text-foreground")}
          aria-pressed
          aria-label="Stop recording"
        >
          <Icon name="stop" className="size-4 fill-current" />
        </Button>
      </div>
    </Block>
  );
}

function Frame({ caseId }: { caseId: string }) {
  if (caseId === "others")
    return (
      <>
        <div className="flex-1" />
        <ProgramBelt />
        <div className="h-8" />
        <RecordingMic />
      </>
    );
  return (
    <>
      <div className="flex-1" />
      <ScreenBelt running={caseId === "running"} />
    </>
  );
}

function render(draw: Draw) {
  return (caseId: string): ReactNode => (
    <div className="flex min-h-full flex-col bg-background">
      <SwapStopIcon draw={draw}>
        <Frame caseId={caseId} />
      </SwapStopIcon>
    </div>
  );
}

const OPTIONS: readonly PickOption[] = [
  { n: 1, label: "Filled square", state: "Square, filled", render: render(drawFilled) },
  { n: 2, label: "Circle with square", state: "CircleStop", render: render(drawLucide(CircleStop)) },
  { n: 3, label: "Octagon stop sign", state: "OctagonX", render: render(drawLucide(OctagonX)) },
  { n: 4, label: "Raised hand", state: "Hand", render: render(drawLucide(Hand)) },
];

const ROUND: PickRoundDef = { title: "Stop icon: the look", options: OPTIONS, cases: CASES, frameHeight: 260 };

export default ROUND;
