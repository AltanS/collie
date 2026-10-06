import { on, type Handle, type RemixNode } from "remix/component";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide";

import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { animateEntrance, toastEntrance } from "../lib/motion";
import { useLocale } from "../lib/i18n-store";
import { clearStatus, status, type StatusTone } from "../lib/status";
import { useStore } from "../lib/store";
import { Icon } from "./icon";

// Port of web/src/components/ui/toast-viewport.tsx: where a transient event floats, bottom dock,
// `z-40` (above chrome, below sheets and the idle lock), taps passing through. A toast holds no
// space in the flow (D §2).
//
// NOT PORTALLED. The React original portals to <body> so no ancestor with a transform or a
// backdrop-filter can capture its `fixed` box. remix/spa owns <body> as its top frame, so there is
// no free node to portal into; the shell keeps such ancestors off the route tree instead
// (shell.tsx). A caller that puts this under a transformed ancestor will see it clipped.
const SHARED = "pointer-events-none z-40 mx-auto w-full max-w-screen-sm px-4";

export function ToastViewport(handle: Handle<{ class?: string; children?: RemixNode }>) {
  return () => (
    <div class={cn(SHARED, "fixed inset-x-0 bottom-0 pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)]", handle.props.class)}>
      {handle.props.children}
    </div>
  );
}

const TONE = {
  info: "text-muted-foreground",
  success: "text-status-done",
  warn: "text-status-working",
  error: "text-status-blocked",
} satisfies Record<StatusTone, string>;

const TONE_ICON = { info: Info, success: CheckCircle2, warn: AlertTriangle, error: AlertCircle } as const;

/**
 * The status as a toast (web/src/components/status-area.tsx), for a screen whose header has no
 * title slot. Fades in over 200 ms on `ease` through `animateEntrance` (web's timing; none under reduced motion), has no
 * exit animation, and lives as long as the status model says: 2.5 s, errors until tapped.
 */
export function StatusToast(handle: Handle) {
  const read = useStore(handle, status);
  useLocale(handle);
  return () => {
    const message = read();
    if (message === null) return null;
    const error = message.tone === "error";
    return (
      <div
        key={message.id}
        data-testid="status-toast"
        class={cn("relative mx-auto w-fit max-w-full", error && "pointer-events-auto")}
        mix={animateEntrance(toastEntrance())}
      >
        <output
          aria-live="polite"
          class={cn(
            "flex items-center justify-center gap-1.5 rounded-full border bg-background/95 px-3 py-1 text-xs font-medium shadow-sm backdrop-blur",
            error ? "border-status-blocked/50" : "border-border/60",
            TONE[message.tone],
          )}
        >
          <Icon icon={TONE_ICON[message.tone]} class="size-3.5 shrink-0" />
          <span class="truncate">{message.text}</span>
          {error ? <Icon icon={X} class="size-3.5 shrink-0 opacity-70" /> : null}
        </output>
        {error ? (
          <button
            type="button"
            aria-label={t("status.dismissAria")}
            class="absolute inset-0 cursor-pointer rounded-md"
            mix={on("click", () => clearStatus())}
          />
        ) : null}
      </div>
    );
  };
}
