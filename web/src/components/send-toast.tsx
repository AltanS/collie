import { useEffect, useState } from "react";

import { Icon } from "@/components/icons/icon";
import { usePrefersReducedMotion } from "@/components/ui/collapse";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * How long a send may stay unechoed before the toast says so (M104 follow-up). The tap starts the clock: a send
 * the pane echoes within this time shows nothing at all, and a slower one shows "You sent: ..." from then on.
 */
export const SEND_SLOW_MS = 2000;

/** The fade out, in ms. Reduced motion has none: the toast is gone in the frame its condition lifts. */
export const SEND_TOAST_FADE_MS = 200;

export interface HeldThroughExit<T> {
  held: T | null;
  open: boolean;
}

/**
 * A value held through its exit: `held` keeps the last non-null value for `ms` after `value` goes null, and `open`
 * flips first, so a caller can fade on `open` and unmount on `held`. A new value shows in the next frame.
 */
export function useHeldThroughExit<T>(value: T | null, ms: number): HeldThroughExit<T> {
  const [held, setHeld] = useState<T | null>(value);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (value !== null) {
      setHeld(value);
      const frame = requestAnimationFrame(() => setOpen(true));
      return () => cancelAnimationFrame(frame);
    }
    setOpen(false);
    if (ms === 0) {
      setHeld(null);
      return;
    }
    const timer = setTimeout(() => setHeld(null), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return { held, open };
}

/**
 * The word for a send that went out and that the pane has not echoed back (the spinner and the text). It is a
 * toast: it floats in the composer's floating column over the mirror's last rows and holds no space (DESIGN.md
 * §2), so it moves neither the belt, the box nor the mirror when it comes or goes. It has no control, so a touch on
 * it reaches what is under it. It leaves by opacity.
 */
export function SendToast({ text, open }: { text: string; open: boolean }) {
  useLocale();
  return (
    <div
      data-slot="send-toast"
      data-open={open ? "" : undefined}
      role="status"
      className={cn(
        "pointer-events-none flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-md transition-opacity ease-out motion-reduce:transition-none",
        open ? "opacity-100" : "opacity-0",
      )}
      style={{ transitionDuration: `${String(SEND_TOAST_FADE_MS)}ms` }}
    >
      <Icon name="busy" className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
      <span className="truncate">
        <span className="font-medium">{t("composer.sentPreview.label")}</span> {text}
      </span>
    </div>
  );
}

/** The fade's length as the composer reads it: none under reduced motion. */
export function useSendToastFade(): number {
  return usePrefersReducedMotion() ? 0 : SEND_TOAST_FADE_MS;
}
