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
