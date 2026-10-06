import { on, ref, TypedEventTarget, type Handle, type RemixNode } from "remix/component";
import { X } from "lucide";

import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { peekContinueTransition, reducedMotion, snapBackTransition } from "../lib/motion";
import { scheduleUpdate } from "../lib/store";
import { Button } from "./button";
import { Icon } from "./icon";

// Port of web/src/components/ui/sheet.tsx: the bottom sheet and the side sheet. Same classes, the
// same dialog semantics (focus moves into the panel on open and back on close, Escape closes, the
// backdrop dismisses only when the pointer also went DOWN on it), and no history entry: a sheet is
// state, never a URL (D §12, REMIX3.md rule 9).
//
// THE BOTTOM SHEET MOVES AS web/'s DOES:
//   - open: backdrop fade 200 ms, panel slide from the bottom 200 ms (tw-animate classes);
//   - drag-dismiss: from the top of its scroll, the panel follows the finger (`style.transform`,
//     written by native non-passive listeners in `ref`, never by a re-render); released past 90 px it
//     closes, short of it it snaps back over 200 ms, `ease-out` (web's `transform 0.2s ease-out`; the
//     `snappy` spring settles in 350 ms, so it is NOT used here, see lib/motion.ts);
//   - peek-to-open: a `SheetPeek` (fed by the `pull` gesture) mounts the panel following the finger
//     up from its anchor, with no entrance and no focus; when `open` flips true the panel continues
//     from where the finger left it over 180 ms.
// Reduced motion: the classes drop their animation, the snap-back and the continuation are instant.

/**
 * Focus bookkeeping across `open` flips: on the opening render, focus the panel after the commit
 * and remember what had focus; on the closing render, give focus back.
 */
function dialogFocus(handle: Handle<{ open: boolean }>) {
  let wasOpen = false;
  let previous: HTMLElement | null = null;
  let panel: HTMLElement | null = null;
  const track = (open: boolean): void => {
    if (open && !wasOpen) {
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      handle.queueTask(() => panel?.focus());
    }
    if (!open && wasOpen) {
      const back = previous;
      previous = null;
      handle.queueTask(() => back?.focus());
    }
    wasOpen = open;
  };
  const setPanel = (node: HTMLElement): void => {
    panel = node;
  };
  return { track, setPanel };
}

function escapeCloses(handle: Handle<{ open: boolean; onClose: () => void }>): void {
  handle.queueTask(() => {
    window.addEventListener(
      "keydown",
      (event) => {
        if (handle.props.open && event.key === "Escape") handle.props.onClose();
      },
      { signal: handle.signal },
    );
  });
}

/**
 * The live half of a peek-to-open, written per pointer move by the owner of the `pull` gesture and
 * read by the sheet straight into its panel's transform. It never causes a render per move: the
 * sheet re-renders once when a peek starts (to mount the panel) and once when it ends.
 */
export class SheetPeek extends TypedEventTarget<{ start: Event; move: Event; end: Event }> {
  pull = 0;
  /** The pulled element's distance from the viewport bottom; the panel's top starts there. */
  anchor = 0;
  active = false;

  move(pull: number, anchor: number): void {
    this.pull = pull;
    this.anchor = anchor;
    if (!this.active) {
      this.active = true;
      this.dispatchEvent(new Event("start"));
    }
    this.dispatchEvent(new Event("move"));
  }

  /** The finger lifted. If the owner opens the sheet in the same turn, the panel continues. */
  end(): void {
    if (!this.active) return;
    this.active = false;
    this.dispatchEvent(new Event("end"));
  }
}

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: RemixNode;
  children?: RemixNode;
  class?: string;
  /** Peek-to-open: the panel follows this while the sheet is not open yet. */
  peek?: SheetPeek;
}

const SLOP = 6;
/** Released past this many px of pull-down, the sheet closes; short of it, it snaps back. */
export const SHEET_CLOSE_PX = 90;
const SNAP_BACK = (): string => (reducedMotion() ? "none" : snapBackTransition());

export function BottomSheet(handle: Handle<BottomSheetProps>) {
  const titleId = `sheet-${handle.id}`;
  const focus = dialogFocus(handle);
  escapeCloses(handle);
  let backdropArmed = false;
  let drag = { startY: 0, atTop: false, engaged: false, dy: 0 };
  let panel: HTMLDivElement | null = null;
  let backdrop: HTMLButtonElement | null = null;
  /** A peek is on screen (mounted by a peek, not by `open`). */
  let peeking = false;
  /** The sheet opened out of a peek: no entrance classes, continue the transform instead. */
  let fromPeek = false;

  const paintPeek = (): void => {
    const peek = handle.props.peek;
    if (!peek || !panel || handle.props.open) return;
    panel.style.transition = "none";
    panel.style.transform = `translateY(max(0px, calc(100% - ${String(peek.anchor + peek.pull)}px)))`;
    if (backdrop) backdrop.style.opacity = String(Math.min(1, peek.pull / 120) * 0.5);
  };

  // The peek's events, wired once for whichever SheetPeek the props carry at mount.
  handle.queueTask(() => {
    const peek = handle.props.peek;
    if (!peek) return;
    peek.addEventListener(
      "start",
      () => {
        if (handle.props.open) return;
        peeking = true;
        scheduleUpdate(handle);
      },
      { signal: handle.signal },
    );
    peek.addEventListener("move", paintPeek, { signal: handle.signal });
    peek.addEventListener(
      "end",
      () => {
        // Let the owner decide in this turn; a peek that did not open goes away on the next frame.
        queueMicrotask(() => {
          if (handle.props.open) return;
          peeking = false;
          scheduleUpdate(handle);
        });
      },
      { signal: handle.signal },
    );
  });

  const wireBackdrop = (node: HTMLButtonElement): void => {
    backdrop = node;
  };

  const wirePanel = (node: HTMLDivElement, signal: AbortSignal): void => {
    panel = node;
    focus.setPanel(node);
    signal.addEventListener("abort", () => {
      if (panel === node) panel = null;
    });
    if (peeking && !handle.props.open) paintPeek();
    node.addEventListener(
      "touchstart",
      (e) => {
        const touch = e.touches[0];
        if (touch && handle.props.open) drag = { startY: touch.clientY, atTop: node.scrollTop <= 0, engaged: false, dy: 0 };
      },
      { signal, passive: true },
    );
    node.addEventListener(
      "touchmove",
      (e) => {
        const touch = e.touches[0];
        if (!drag.atTop || !touch) return;
        const dy = touch.clientY - drag.startY;
        if (!drag.engaged && dy > SLOP) drag.engaged = true;
        if (!drag.engaged) return;
        e.preventDefault();
        drag.dy = Math.max(0, dy);
        node.style.transition = "none";
        node.style.transform = `translateY(${String(drag.dy)}px)`;
      },
      { signal, passive: false },
    );
    const end = (): void => {
      if (!drag.engaged) return;
      const off = drag.dy;
      drag = { startY: 0, atTop: false, engaged: false, dy: 0 };
      if (off > SHEET_CLOSE_PX) {
        handle.props.onClose();
        return;
      }
      node.style.transition = SNAP_BACK();
      node.style.transform = "";
    };
    node.addEventListener("touchend", end, { signal, passive: true });
    node.addEventListener("touchcancel", end, { signal, passive: true });
  };

  let wasOpen = handle.props.open;

  return () => {
    const { open, title, children } = handle.props;
    focus.track(open);
    if (open && !wasOpen) {
      fromPeek = peeking;
      peeking = false;
      backdropArmed = false;
      if (fromPeek) {
        // Continue from wherever the finger left the panel, after this render commits.
        handle.queueTask(() => {
          if (!panel) return;
          panel.style.transition = reducedMotion() ? "none" : peekContinueTransition();
          panel.style.transform = "translateY(0)";
          if (backdrop) backdrop.style.opacity = "";
        });
      }
    }
    if (!open && wasOpen) fromPeek = false;
    wasOpen = open;
    const peekOnly = !open && peeking;
    if (!open && !peekOnly) return null;
    const entrance = !peekOnly && !fromPeek;
    return (
      <div
        class="fixed inset-x-0 top-0 z-50 flex h-(--app-h) flex-col justify-end"
        role={peekOnly ? undefined : "dialog"}
        aria-modal={peekOnly ? undefined : "true"}
        aria-labelledby={!peekOnly && title ? titleId : undefined}
        aria-hidden={peekOnly ? "true" : undefined}
        data-testid="bottom-sheet"
        data-state={peekOnly ? "peek" : "open"}
        style={peekOnly ? { pointerEvents: "none" } : undefined}
      >
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          class={cn("absolute inset-0 bg-black/50", entrance && "duration-200 animate-in fade-in")}
          mix={[
            ref(wireBackdrop),
            on("pointerdown", () => {
              backdropArmed = true;
            }),
            on("click", () => {
              if (!backdropArmed) return;
              backdropArmed = false;
              handle.props.onClose();
            }),
          ]}
        />
        <div
          tabIndex={peekOnly ? undefined : -1}
          data-slot="sheet-panel"
          mix={ref(wirePanel)}
          class={cn(
            "relative z-10 mx-auto max-h-[82dvh] w-full max-w-screen-sm overflow-y-auto overscroll-contain rounded-t-md border-t border-rule bg-card shadow-2xl",
            entrance && "duration-200 animate-in slide-in-from-bottom",
            "pb-[calc(env(safe-area-inset-bottom)_+_1rem)]",
            handle.props.class,
          )}
        >
          <div class="sticky top-0 z-10 border-b border-rule bg-card/95 backdrop-blur-md">
            <div class="flex justify-center pt-2 pb-1">
              <span class="h-1 w-9 rounded-md bg-muted-foreground/40" />
            </div>
            <div data-slot="sheet-title-row" class="flex items-center justify-between px-4 pb-3">
              <span id={title ? titleId : undefined} data-slot="sheet-title" class="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-semibold">
                {title}
              </span>
              <Button
                variant="ghost"
                size="icon"
                class="size-8 shrink-0"
                aria-label={t("common.closeAria")}
                mix={on("click", () => handle.props.onClose())}
              >
                <Icon icon={X} class="size-4" />
              </Button>
            </div>
          </div>
          <div class="px-4 py-3">{children}</div>
        </div>
      </div>
    );
  };
}

export interface SideSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  headerAction?: RemixNode;
  children?: RemixNode;
  footer?: RemixNode;
  class?: string;
}

export function SideSheet(handle: Handle<SideSheetProps>) {
  const titleId = `side-sheet-${handle.id}`;
  const focus = dialogFocus(handle);
  escapeCloses(handle);
  let backdropArmed = false;
  return () => {
    const { open, title, headerAction, children, footer } = handle.props;
    focus.track(open);
    if (!open) return null;
    return (
      <div class="fixed inset-x-0 top-0 z-50 flex h-(--app-h)" role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined}>
        <div
          tabIndex={-1}
          mix={ref((node: HTMLDivElement) => focus.setPanel(node))}
          class={cn(
            "relative z-10 flex h-full w-[86%] max-w-sm flex-col border-r border-rule bg-card shadow-2xl duration-200 animate-in slide-in-from-left",
            handle.props.class,
          )}
        >
          <div class="flex shrink-0 items-center justify-between border-b border-rule bg-card/95 px-4 py-3 backdrop-blur-md [padding-top:calc(env(safe-area-inset-top)_+_0.75rem)]">
            <span id={title ? titleId : undefined} class="text-sm font-semibold">
              {title}
            </span>
            <div class="flex items-center gap-1">
              {headerAction}
              <Button variant="ghost" size="icon" class="size-8" aria-label={t("common.closeAria")} mix={on("click", () => handle.props.onClose())}>
                <Icon icon={X} class="size-4" />
              </Button>
            </div>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
          {footer && (
            <div class="shrink-0 border-t border-rule px-3 py-2 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]">{footer}</div>
          )}
        </div>
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          class="flex-1 bg-black/50 duration-200 animate-in fade-in"
          mix={[
            on("pointerdown", () => {
              backdropArmed = true;
            }),
            on("click", () => {
              if (!backdropArmed) return;
              backdropArmed = false;
              handle.props.onClose();
            }),
          ]}
        />
      </div>
    );
  };
}
