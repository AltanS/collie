import { useCallback } from "react";
import { useRevalidator } from "react-router";
import { RefreshCw } from "lucide-react";

import { useLocale } from "@/hooks/use-locale";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { refreshNow } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Scope } from "@/lib/scope";

import type { ReactNode } from "react";

// The scroll container of a list screen, with the pull gesture on it.
//
// A COMPONENT RATHER THAN A HOOK AT EACH SITE, because the indicator is the gesture: a screen that
// wired the handlers and forgot the row would open a gap and say nothing, which reads as a layout
// bug. Home and space share one shell for the same reason they share `AppHeader`.
//
// It is deliberately NOT on the pane view. A pane's screen is already re-read every 1.5 s from the
// multiplexer's own live grid, and the scroller there is the terminal mirror — a pull at the top of
// it is how you reach older output, which is a different question with a different answer
// ("Load older"). Refreshing is a question about the HERD.

export function PullToRefresh({
  scope,
  className,
  children,
}: {
  /** Which machine and session to refresh — the one on screen, never the ambient one. */
  scope?: Scope;
  className?: string;
  children: ReactNode;
}) {
  useLocale();
  const revalidator = useRevalidator();
  // Ask the bridge to look now, THEN re-read it. Awaited in that order on purpose: unlike the
  // foreground path (which must not make the operator wait to see anything at all), a pull is an
  // explicit request whose whole feedback is the indicator staying open until the answer is in.
  const refresh = useCallback(async () => {
    await refreshNow(scope);
    await revalidator.revalidate();
  }, [revalidator, scope]);
  const { distance, phase, handlers } = usePullToRefresh(refresh);

  return (
    // `relative` is load-bearing, not decoration: it makes this scroller the containing block for
    // its absolutely-positioned descendants. Tailwind's `sr-only` is `position: absolute`, so every
    // status label in the list would otherwise resolve against the initial containing block, escape
    // this scroller's clip, and stretch the DOCUMENT's scrollable area to the last row — a second,
    // whole-page scrollbar beside this one. Same reason the row status dots sit in a `relative` box.
    <div className={cn("relative", className)} {...handlers}>
      {/* The indicator is an IN-FLOW row that grows from zero, not an overlay: it pushes the list
          down exactly as the finger pulls, so the gesture moves the thing it is about. At rest it
          has no height and no content, so a screen nobody pulled is byte-for-byte what it was. */}
      <div
        className="flex shrink-0 items-center justify-center overflow-hidden text-xs text-muted-foreground"
        style={{ height: `${String(distance)}px` }}
        aria-hidden={phase === "idle"}
      >
        {phase !== "idle" && (
          <span className="flex items-center gap-2">
            <RefreshCw className={`size-3.5 ${phase === "refreshing" ? "animate-spin" : ""}`} />
            {phase === "refreshing"
              ? t("sync.pull.busy")
              : phase === "ready"
                ? t("sync.pull.release")
                : t("sync.pull.hint")}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
