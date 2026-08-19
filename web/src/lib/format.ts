// Small presentational helpers.

/** Collapse $HOME to `~` — handles /home/<user>, /Users/<user> (macOS), /var/home/<user> (Fedora). */
export function tildeHome(cwd: string): string {
  return cwd.replace(/^\/(?:var\/)?home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~");
}

/**
 * Collapse $HOME and keep the tail of a long path so it fits a phone row.
 *
 * Drops WHOLE SEGMENTS, not characters: cutting mid-segment produced `…ropbox/dev/…`, which reads
 * as a rendering fault rather than an abbreviation. The last segment is always kept even when it
 * alone exceeds the budget — it's the part that identifies the directory.
 */
export function shortCwd(cwd: string, max = 32): string {
  const p = tildeHome(cwd);
  if (p.length <= max) return p;

  const segments = p.split("/").filter(Boolean);
  const last = segments.pop();
  if (last === undefined) return p;

  const kept = [last];
  let len = last.length + 1; // + the leading "…/"
  for (const seg of segments.toReversed()) {
    if (len + seg.length + 1 > max) break;
    kept.unshift(seg);
    len += seg.length + 1;
  }
  return `…/${kept.join("/")}`;
}

/** The last path segment (the directory's own name), with any trailing slash ignored. */
export function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Two-letter avatar fallback from an agent name (e.g. "claude" → "CL"). */
export function initials(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, "");
  return (clean.slice(0, 2) || "AI").toUpperCase();
}

/**
 * Compact "time ago" for a past epoch-ms timestamp — "just now" under a minute, then "5m"/"2h"/"3d"
 * ago. A future or now timestamp reads "just now". Deliberately coarse: it's a footnote, not a clock.
 */
/**
 * The same age with the word "ago" dropped — for a right-aligned column of them, where every entry
 * would repeat it and the column's meaning is already established. Worth ~25px a row, which is the
 * difference between `interview-con…` and `interview-consistency`.
 */
export function timeAgoShort(ts: number, now: number = Date.now()): string {
  const full = timeAgo(ts, now);
  return full === "just now" ? "now" : full.replace(/ ago$/, "");
}

export function timeAgo(ts: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Wall-clock "HH:MM" in the phone's own locale and timezone — for "last seen 14:32" on a disconnected
 * render. A clock time, not an age, because that is the question being answered: an age has to be
 * recomputed to stay true, and a screen showing cached data may sit there for minutes without a
 * re-render. `14:32` is still `14:32` an hour later.
 */
export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
