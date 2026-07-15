// Small presentational helpers.

/** Collapse $HOME and keep the tail of a long path so it fits a phone row. */
export function shortCwd(cwd: string, max = 32): string {
  // Handles /home/<user>, /Users/<user> (macOS), and /var/home/<user> (Fedora Atomic / Silverblue).
  let p = cwd.replace(/^\/(?:var\/)?home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~");
  if (p.length > max) p = "…" + p.slice(p.length - max + 1);
  return p;
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
export function timeAgo(ts: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
