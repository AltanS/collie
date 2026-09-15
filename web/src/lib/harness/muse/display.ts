import type { StyledLine } from "../../blocks";

/** Agents whose panes render natively — no light-theme inversion (.adr/0047). This is the "one
 *  bit" ADR 0002 reserves for per-harness knowledge, and the single spelling of it: the block
 *  pipeline, the mirror ground, and the raw-terminal escape hatch all consume this predicate,
 *  so a second agent joins by adding one row here. Exact strings, like the registry. */
const NATIVE_MIRROR_AGENTS: ReadonlySet<string> = new Set(["muse"]);

export function rendersNativeMirror(agent?: string): boolean {
  return agent !== undefined && NATIVE_MIRROR_AGENTS.has(agent);
}

// Muse's palette, observed from live PTY captures (issue #220), per background answer:
//
//   light — body rgb(56,58,66), secondary rgb(121,122,128), hints rgb(175,176,180).
//     This is the live row: Herdr 0.9.0 answers OSC 10/11 from its theme (write_pty is
//     wired), so a light Herdr theme yields the light palette — confirmed by pane.read.
//   dark — body rgb(117,120,129), secondary rgb(100,103,110), hints rgb(82,84,90).
//   none — body rgb(111,114,122), secondary rgb(94,97,104), hints rgb(75,77,82).
//     Older Herdr answered neither query (HERDR_API.md's 2026-07-29 probe predates the
//     write_pty wiring); its panes carry this dark fallback instead.
//

// Every tone but near-white sits at relative luminance 0.44 or below, while near-white starts
// at 0.85 — so a 0.6 threshold splits the observed corpus with margin on both sides. The
// luminance is WCAG relative (gamma-correct), not a channel average: rgb(175,176,180) averages
// 0.69 but resolves to 0.44, and averaging would mis-mark Muse's own hints as bright.
export const BRIGHT_FG_LUMINANCE = 0.6;

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance. Exported so the slot-pinning test resolves the stylesheet's palette
 *  through the same function the decorator branches on, not a copy of it. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

const RGB = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
const INDEXED = /^var\(--ansi-(\d{1,2})\)$/;

// Indexed slots above the same luminance line, resolved against index.css: 3 and 11 are the two
// yellows, 7 and 15 the two whites. The VALUES still live in exactly one place — display.test.ts
// re-resolves every slot from the stylesheet and fails loudly if a retune moves the bright set,
// so this list can neither drift nor silently widen.
const BRIGHT_INDEXED_SLOTS: ReadonlySet<number> = new Set([3, 7, 11, 15]);

function isBrightFg(fg: string): boolean {
  const rgb = RGB.exec(fg);
  if (rgb !== null) {
    return (
      luminance(Number(rgb[1]), Number(rgb[2]), Number(rgb[3])) > BRIGHT_FG_LUMINANCE
    );
  }
  const slot = INDEXED.exec(fg);
  return slot !== null && BRIGHT_INDEXED_SLOTS.has(Number(slot[1]));
}

/** Presentation-only pass over Muse's raw lines: mark bright foregrounds the native light mirror
 *  must render dark. Everything else — dark and mid-tone spans, bare spans, explicit fg+bg pairs —
 *  renders raw on the light ground, exactly as a light terminal shows the same bytes (.adr/0047).
 *  Not one byte of visible text changes. The input array is returned as-is when nothing matched,
 *  so a screen without a bright foreground stays identical, object for object.
 *
 *  A bright `38;5` cube/ramp colour routes through the same rule — the parser emits those as
 *  `rgb()`. Palette-indexed spellings (`37m`, `97m`, `38;5;15`) arrive as `var(--ansi-N)` and are
 *  covered by the pinned slot set above.
 */
export function decorateMuseDisplay(lines: StyledLine[]): StyledLine[] {
  let changedLines = false;
  const decorated = lines.map((line) => {
    let changedSegments = false;
    const segments = line.segments.map((segment) => {
      if (segment.lightDarkFg || segment.muted || segment.bg !== undefined) return segment;
      const fg = segment.fg;
      if (fg === undefined || !isBrightFg(fg)) return segment;
      changedSegments = true;
      return { ...segment, lightDarkFg: true as const };
    });

    if (!changedSegments) return line;
    changedLines = true;
    return { ...line, segments };
  });

  return changedLines ? decorated : lines;
}
