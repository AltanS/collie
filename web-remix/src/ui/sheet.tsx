import { on, ref, type Handle, type RemixNode } from "remix/component";
import { X } from "lucide";

import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { Button } from "./button";
import { Icon } from "./icon";

// Port of web/src/components/ui/sheet.tsx: the bottom sheet and the side sheet. Same classes, the
// same dialog semantics (focus moves into the panel on open and back on close, Escape closes, the
// backdrop dismisses only when the pointer also went DOWN on it), and the bottom sheet's
// pull-down-to-close. Not ported yet: the bottom sheet's peek (`pull`/`pullFrom`), which only the
// pane screen's composer drives; it lands with that screen.

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

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: RemixNode;
  children?: RemixNode;
  class?: string;
}

const SLOP = 6;
const CLOSE = 90;

export function BottomSheet(handle: Handle<BottomSheetProps>) {
  const titleId = `sheet-${handle.id}`;
  const focus = dialogFocus(handle);
  escapeCloses(handle);
  let backdropArmed = false;
  let dragY = 0;
  let drag = { startY: 0, atTop: false, engaged: false };

  const wireDrag = (panel: HTMLDivElement, signal: AbortSignal): void => {
    focus.setPanel(panel);
    const opts = { signal, passive: true };
    panel.addEventListener(
      "touchstart",
      (e) => {
        const touch = e.touches[0];
        if (touch) drag = { startY: touch.clientY, atTop: panel.scrollTop <= 0, engaged: false };
      },
      opts,
    );
    panel.addEventListener(
      "touchmove",
      (e) => {
        const touch = e.touches[0];
        if (!drag.atTop || !touch) return;
        const dy = touch.clientY - drag.startY;
        if (!drag.engaged && dy > SLOP) drag.engaged = true;
        if (!drag.engaged) return;
        e.preventDefault();
        dragY = Math.max(0, dy);
        panel.style.transform = `translateY(${String(dragY)}px)`;
        panel.style.transition = "none";
      },
      { signal, passive: false },
    );
    const end = (): void => {
      const off = dragY;
      drag = { startY: 0, atTop: false, engaged: false };
      dragY = 0;
      panel.style.transition = "transform 0.2s ease-out";
      panel.style.transform = "";
      if (off > CLOSE) handle.props.onClose();
    };
    panel.addEventListener("touchend", end, opts);
    panel.addEventListener("touchcancel", end, opts);
  };

  return () => {
    const { open, title, children } = handle.props;
    focus.track(open);
    if (!open) return null;
    return (
      <div
        class="fixed inset-x-0 top-0 z-50 flex h-(--app-h) flex-col justify-end"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
      >
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          class="absolute inset-0 bg-black/50 duration-200 animate-in fade-in"
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
        <div
          tabIndex={-1}
          mix={ref(wireDrag)}
          class={cn(
            "relative z-10 mx-auto max-h-[82dvh] w-full max-w-screen-sm overflow-y-auto overscroll-contain rounded-t-md border-t border-rule bg-card shadow-2xl",
            "duration-200 animate-in slide-in-from-bottom",
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
