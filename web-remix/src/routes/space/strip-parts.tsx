// Parts shared by the space strip and the tab strip (web/src/components/ui/add-button.tsx, and
// web/src/hooks/use-reveal-active.ts). They live here because the shell kit has no copy of either,
// and this directory is where the space screen may add files.
import { on, type Handle } from "remix/component";
import { LoaderCircle, Plus } from "lucide";

import { cn } from "@web/lib/utils";

import { Icon } from "../../ui/icon";

export type AddButtonSize = "sm" | "md";

const FACE = { sm: "size-7", md: "size-8" } as const satisfies Record<AddButtonSize, string>;

export interface StripAddProps {
  /** The accessible name: what the "+" makes. */
  label: string;
  onClick: () => void;
  /** A create is in flight: the button disables and swaps its glyph for a spinner, in the same box. */
  busy?: boolean;
  /** 28 px for the 30 px tab row, 32 px for the 34 px space chips. */
  size: AddButtonSize;
  /** The hit area, a transparent `::before` recipe the call site owns (it carries `relative`). */
  reach: string;
  testId?: string;
}

/** One look for "new" in a row: a dashed circle with a "+" (D §1). It owns the look and the busy swap. */
export function StripAdd(handle: Handle<StripAddProps>) {
  return () => {
    const { label, busy = false, size, reach, testId } = handle.props;
    return (
      <button
        type="button"
        data-testid={testId}
        disabled={busy}
        aria-label={label}
        aria-busy={busy}
        mix={on("click", () => handle.props.onClick())}
        class={cn(
          reach,
          FACE[size],
          "flex shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent active:scale-95 disabled:opacity-100",
        )}
      >
        {busy ? <Icon icon={LoaderCircle} class="size-4 animate-spin" /> : <Icon icon={Plus} class="size-4" />}
      </button>
    );
  };
}

// ── Keeping the active chip or tab in view ───────────────────────────────────────────────────────

const REVEAL_MARGIN = 12;

function reducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Scroll the element carrying `aria-current="true"` to the nearest edge of the scroller's visible
 * range, if it is not already inside it (web/'s `useRevealActive`). Never centres, and never moves an
 * ancestor: only the one scroller scrolls. The first run is instant, later ones smooth.
 */
function revealActive(scroller: HTMLElement | null, first: boolean): void {
  if (scroller === null || scroller.clientWidth === 0) return;
  const active = scroller.querySelector<HTMLElement>('[aria-current="true"]');
  if (active === null) return;
  const box = scroller.getBoundingClientRect();
  const at = active.getBoundingClientRect();
  const left = box.left + REVEAL_MARGIN;
  const right = box.right - REVEAL_MARGIN;
  if (at.left >= left && at.right <= right) return;
  const target =
    at.left < left ? scroller.scrollLeft + (at.left - box.left) - REVEAL_MARGIN : scroller.scrollLeft + (at.right - box.right) + REVEAL_MARGIN;
  scroller.scrollTo({ left: Math.max(0, target), behavior: first || reducedMotion() ? "auto" : "smooth" });
}

/**
 * One row's reveal, as a setup object. `bind` is the `ref` callback for the scroller; `after(key)` is
 * called from render and queues the reveal when the active key changed. Nothing here touches the DOM
 * during render.
 */
export function revealer(handle: { queueTask(task: () => void): void }) {
  let node: HTMLElement | null = null;
  let seen: string | null | undefined;
  let revealed = false;
  return {
    bind: (el: Element): void => {
      node = el instanceof HTMLElement ? el : null;
    },
    after(key: string | null): void {
      if (key === seen) return;
      seen = key;
      handle.queueTask(() => {
        revealActive(node, !revealed);
        revealed = true;
      });
    },
  };
}
