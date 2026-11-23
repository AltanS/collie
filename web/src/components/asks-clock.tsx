import { cacheBarPercent, cacheClockWords, type CacheClock } from "@/lib/hill/asks-board";
import { cn } from "@/lib/utils";

// THE CACHE CLOCK (Asks build 6, 2026-11-23): how long a session's prompt cache lasts, in words and as a bar. Used by
// the Next up card and by each session card, so one session reads the same in both places. The words carry the meaning
// ("12 min left", "cold"); the bar is a picture of them and is hidden from a screen reader. Warm is `--status-info`,
// the blue of a fact that is no warning (lib/status.ts): the words in semibold, the bar filled by the minutes left out
// of 60. Cold is no colour, because there is nothing to win: the word is muted and the bar is an empty dashed one. The
// bar's box is the same in both, so a clock that turns cold moves nothing. A session with no reading draws nothing.

export function CacheClockView({ clock, className }: { clock: CacheClock; className?: string }) {
  const words = cacheClockWords(clock);
  if (words === null) return null;
  const warm = clock.kind === "warm";
  const left = clock.kind === "warm" ? clock.msLeft : undefined;
  return (
    <span data-slot="asks-clock" data-clock={clock.kind} className={cn("inline-flex items-center gap-2 whitespace-nowrap text-xs leading-4", className)}>
      <span data-slot="asks-clock-words" className={cn("tabular-nums", warm ? "font-semibold text-status-info" : "text-muted-foreground")}>
        {words}
      </span>
      <span
        aria-hidden
        data-slot="asks-clock-bar"
        className={cn("relative block w-14 shrink-0 overflow-hidden rounded-sm max-[480px]:w-10", warm ? "h-1 bg-muted" : "h-1.5 border border-dashed border-border")}
      >
        {left !== undefined && <i data-slot="asks-clock-fill" className="absolute inset-y-0 left-0 block bg-status-info" style={{ width: `${cacheBarPercent(left)}%` }} />}
      </span>
    </span>
  );
}
