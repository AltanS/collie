// The terminal screen model: styled lines (web/src/lib/blocks.ts, parsed by web/src/lib/ansi.ts and
// read-only here) flattened into keyed rows of styled spans for the Remix screen component.
//
// Nothing here parses. The parser and the line splitter are web/'s; this module only adapts their
// output to what Remix renders:
//
//  1. THE STYLE ADAPTER (spike/remix/shared/ansi-rows.ts, extended). The parser types its styles as
//     React `CSSProperties`; Remix's `style` prop wants its own StyleProps, which has a string index
//     signature, so each declaration is copied into a plain record. The mirror's three presentation
//     hints ride along exactly as web/src/components/mirror-space.ts applies them: a `muted` segment
//     (decorative rule glyphs) loses the ANSI dim and takes the muted ink, `mobileTransparentBg`
//     moves its fill into a custom property the phone CSS can drop, and `lightDarkFg` puts its colour
//     behind the variable the light native mirror overrides.
//  2. THE ROW KEY. A row's key is a hash of what it shows plus its occurrence count, not its index.
//     A terminal scrolls: when one line enters at the bottom every row moves up one index, and an
//     index key would rewrite every row. A content key lets Remix keep each row's node and move it.
//     The occurrence count keeps two identical rows (blank lines, rules) distinct.
//  3. ROW REUSE. A row whose key was already on screen is handed back as the SAME object, so the
//     styles are not rebuilt and the renderer sees an unchanged row.
import type { AnsiSegment } from "@web/lib/ansi";
import type { StyledLine } from "@web/lib/blocks";
import { cellPieces, type CellPiece } from "@web/lib/cell-glyphs";

/**
 * One inline style, as Remix's `style` prop accepts it: the declarations the parser sets, plus the
 * mirror's custom property. A type alias, not an interface, so it stays assignable to the prop's
 * index-signature type.
 */
export type CellStyle = {
  color?: string;
  backgroundColor?: string;
  fontWeight?: string | number;
  fontStyle?: string;
  opacity?: string | number;
  textDecoration?: string | number;
  "--terminal-seg-bg"?: string;
};

export interface Span {
  text: string;
  style: CellStyle;
  /** The light-gated marker classes (mirror-space.ts `segmentClassName`), or undefined. */
  class: string | undefined;
  /** Block and Powerline glyphs painted as boxes (lib/cell-glyphs.ts), or null for a plain run. */
  pieces: CellPiece[] | null;
}

export interface Row {
  /** Content hash plus occurrence: stable while the row's content is on screen, wherever it moves. */
  key: string;
  /** The exact text and styling the key was hashed from, so a hash collision cannot reuse a row. */
  sig: string;
  spans: Span[];
  /** A terminal-width border or framed row: clipped to one visual line rather than wrapped. */
  noWrap: boolean;
}

/** The muted ink for decorative rule glyphs: --muted-foreground's dark half, the mirror being dark space. */
const MUTED_INK = "var(--terminal-muted-fg, #a1a1a1)";

/** Copy the parser's React-typed style into a plain record, applying the mirror's three hints. */
export function cellStyle(seg: AnsiSegment): CellStyle {
  const source = seg.style;
  const style: CellStyle = {};
  if (source.color !== undefined) style.color = source.color;
  if (source.backgroundColor !== undefined) style.backgroundColor = source.backgroundColor;
  if (source.fontWeight !== undefined) style.fontWeight = source.fontWeight;
  if (source.fontStyle !== undefined) style.fontStyle = source.fontStyle;
  if (source.opacity !== undefined) style.opacity = source.opacity;
  if (source.textDecoration !== undefined) style.textDecoration = source.textDecoration;
  if (seg.muted) {
    style.color = MUTED_INK;
    style.fontWeight = 400;
    style.opacity = 1;
  }
  if (seg.mobileTransparentBg && style.backgroundColor !== undefined) {
    style["--terminal-seg-bg"] = style.backgroundColor;
    delete style.backgroundColor;
  }
  if (seg.lightDarkFg && seg.fg !== undefined) style.color = `var(--terminal-light-dark-fg, ${seg.fg})`;
  return style;
}

/** mirror-space.ts `segmentClassName`: the marker classes the light theme keys its overrides on. */
function segmentClass(seg: AnsiSegment): string | undefined {
  let out = "";
  if (seg.mobileTransparentBg) out += "terminal-mobile-transparent-bg ";
  if (seg.lightDarkFg) out += "terminal-light-dark-fg ";
  if (seg.muted) out += "terminal-muted ";
  return out === "" ? undefined : out.trimEnd();
}

/** Everything that changes how a segment paints, flattened into one comparable string. */
function segmentSig(seg: AnsiSegment): string {
  const flags =
    (seg.bold ? "b" : "") +
    (seg.dim ? "d" : "") +
    (seg.italic ? "i" : "") +
    (seg.underline ? "u" : "") +
    (seg.strike ? "s" : "") +
    (seg.muted ? "m" : "") +
    (seg.mobileTransparentBg ? "t" : "") +
    (seg.lightDarkFg ? "l" : "");
  return `${seg.fg ?? ""}\u0001${seg.bg ?? ""}\u0001${flags}\u0001${seg.text}`;
}

/** The row's signature: its segments in order, plus whether it is clipped. */
export function lineSig(line: StyledLine): string {
  let sig = line.noWrap ? "n" : "w";
  for (const seg of line.segments) sig += `\u0002${segmentSig(seg)}`;
  return sig;
}

/** FNV-1a, 32 bit, as base 36: short keys, and the full signature guards against a collision. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Keys for a list of row signatures: the content hash and how many times it was seen before. */
export function rowKeys(sigs: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return sigs.map((sig) => {
    const base = hash(sig);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}.${String(n)}`;
  });
}

function buildRow(line: StyledLine, key: string, sig: string): Row {
  return {
    key,
    sig,
    noWrap: line.noWrap === true,
    spans: line.segments.map((seg) => ({
      text: seg.text,
      style: cellStyle(seg),
      class: segmentClass(seg),
      pieces: cellPieces(seg.text),
    })),
  };
}

/**
 * Flatten styled lines into keyed rows. A row whose key and signature were in `prev` comes back as
 * the same object, so an unchanged row costs nothing past its signature.
 */
export function toRows(lines: readonly StyledLine[], prev: readonly Row[] = []): Row[] {
  const sigs = lines.map(lineSig);
  const keys = rowKeys(sigs);
  const before = new Map<string, Row>();
  for (const row of prev) before.set(row.key, row);
  return lines.map((line, i) => {
    const key = keys[i]!;
    const sig = sigs[i]!;
    const held = before.get(key);
    return held !== undefined && held.sig === sig ? held : buildRow(line, key, sig);
  });
}

/** How many rows of `next` are the very objects of `prev`: the diff the renderer is spared. */
export function reusedRows(prev: readonly Row[], next: readonly Row[]): number {
  const held = new Set(prev);
  return next.filter((row) => held.has(row)).length;
}

