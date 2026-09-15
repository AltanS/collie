import type { StyledLine } from "../../blocks";

// Muse's palette, observed from live PTY captures (issue #220), per background answer:
//
//   no answer (Herdr: it answers neither OSC 10 nor OSC 11) — body rgb(111,114,122),
//     secondary rgb(94,97,104), hints rgb(75,77,82)
//   dark — body rgb(117,120,129), secondary rgb(100,103,110), hints rgb(82,84,90)
//   light — body rgb(56,58,66), secondary rgb(121,122,128), hints rgb(175,176,180)
//
// Every tone but near-white sits at relative luminance 0.44 or below, while near-white starts
// at 0.85 — so a 0.6 threshold splits the observed corpus with margin on both sides. The
// luminance is WCAG relative (gamma-correct), not a channel average: rgb(175,176,180) averages
// 0.69 but resolves to 0.44, and averaging would mis-mark Muse's own hints as bright.
const BRIGHT_FG_LUMINANCE = 0.6;

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

const RGB = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;

/** Presentation-only pass over Muse's raw lines: mark bright foregrounds the native light mirror
 *  must render dark. Everything else — dark and mid-tone spans, bare spans, explicit fg+bg pairs —
 *  renders raw on the light ground, exactly as a light terminal shows the same bytes (.adr/0046).
 *  Not one byte of visible text changes. The input array is returned as-is when nothing matched,
 *  so a screen without a bright foreground stays identical, object for object.
 *
 *  Truecolor only, deliberately: Muse emits no indexed foregrounds in the observed corpus, and the
 *  indexed slots live in index.css where this module cannot resolve them without duplicating the
 *  palette. A bright `38;5` cube/ramp colour still routes here — the parser emits those as `rgb()`.
 */
export function decorateMuseDisplay(lines: StyledLine[]): StyledLine[] {
  let changedLines = false;
  const decorated = lines.map((line) => {
    let changedSegments = false;
    const segments = line.segments.map((segment) => {
      if (segment.lightDarkFg || segment.muted || segment.bg !== undefined) return segment;
      const fg = segment.fg;
      if (fg === undefined) return segment;
      const m = RGB.exec(fg);
      if (m === null) return segment;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (luminance(r, g, b) <= BRIGHT_FG_LUMINANCE) return segment;
      changedSegments = true;
      return { ...segment, lightDarkFg: true as const };
    });

    if (!changedSegments) return line;
    changedLines = true;
    return { ...line, segments };
  });

  return changedLines ? decorated : lines;
}
