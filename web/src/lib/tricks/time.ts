// A `time` node's words (M94 slice 02): "3 min ago", "in 2 h", or a date and a clock time past a day.
//
// PURE: the clock is `now`, epoch ms on the BRIDGE's clock (lib/server-clock.ts), because `at` and a
// part's `asOf` are times the bridge's machine wrote. The phone ticks the clock itself
// (lib/cache-clock.ts), so "3 min ago" needs no run of the trick per second. The unit words are the
// compact, untranslated convention `lib/format.ts` `timeLeft` uses; the sentence around them is
// translated.

import { clockTime } from "../format";
import { getLocaleSnapshot, t } from "../i18n";
import { isEpochMs, type Clock } from "./schema";

/**
 * How a moment reads, for the part frame's age line and the settings card (an ISO `asOf`). A tree
 * `chip` or `run` with `at` (epoch ms as digits) and `clock` reads through {@link clockText}.
 */
export type TimeStyle = "ago" | "until" | "clock" | "date";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A length of time, rounded down: "40 s", "3 min", "2 h". Under a day; past it, a caller writes a date. */
export function spanText(ms: number): string {
  const span = Math.max(0, ms);
  if (span < MINUTE) return `${Math.floor(span / 1000)} s`;
  if (span < HOUR) return `${Math.floor(span / MINUTE)} min`;
  return `${Math.floor(span / HOUR)} h`;
}

/** A day and a month in the app's language: "8 Nov". */
export function dayText(ts: number): string {
  const date = new Date(ts);
  // An instant past the schema's bound is an invalid date, and `format` throws a RangeError on one.
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(getLocaleSnapshot().locale, { day: "numeric", month: "short" }).format(date);
}

/** A day, a month and a clock time: "8 Nov, 09:38". For a moment more than a day away. */
export function momentText(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(getLocaleSnapshot().locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

/** How long ago `at` was, or how long until it, in words. A moment more than a day away is a date. */
function relativeText(at: number, now: number): string {
  const diff = now - at;
  if (Math.abs(diff) >= DAY) return momentText(at);
  if (diff >= 0 && diff < MINUTE) return t("time.justNow");
  if (diff >= 0) return t("tricks.time.ago", { time: spanText(diff) });
  return t("tricks.time.in", { time: spanText(-diff) });
}

/**
 * The words of a `time` node. `ago` and `until` both say the side the moment is on, so an `until` that
 * has passed reads "3 min ago" rather than a negative count; `until` counts seconds in its last minute,
 * `ago` says "just now". `clock` is the clock time, `date` the day. `null` for an instant that does not
 * parse (the bridge checked it; a crew member on another version may not have).
 */
export function trickTimeText(at: string, style: TimeStyle | undefined, now: number): string | null {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  if (style === "clock") return clockTime(ms);
  if (style === "date") return dayText(ms);
  if (style === "until" && ms > now && ms - now < MINUTE) return t("tricks.time.in", { time: spanText(ms - now) });
  return relativeText(ms, now);
}

/** A count of seconds as `m:ss`, or `h:mm:ss` from an hour on. Never negative. */
export function stopwatchText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * The words of a tree clock (VOCABULARY.md 2.14): `at` is epoch milliseconds as digits, `now` the
 * bridge's clock. `ago` is a relative time ("3 min ago", a date past a day), `elapsed` counts `m:ss`
 * up from `at`, `left` counts down to it and holds `0:00` at zero (it waits for the bridge), `time`
 * is the time of day in the app's language. `null` for an `at` that is not digits (the bridge checked
 * it; a crew member on another version may not have).
 */
export function clockText(at: string, clock: Clock, now: number): string | null {
  // `isEpochMs` holds the schema's bound (8.64e15 ms), past which `Date` throws a RangeError.
  if (!isEpochMs(at)) return null;
  const ms = Number(at);
  switch (clock) {
    case "ago":
      return relativeText(ms, now);
    case "elapsed":
      return stopwatchText(now - ms);
    case "left":
      return stopwatchText(ms - now);
    case "time":
      return clockTime(ms);
  }
}
