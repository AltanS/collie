// Deciding whether the newest reply in the agent's journal is the one on the mirror, and whether the
// mirror is showing all of it.
//
// WHY THIS EXISTS. A Claude pane runs on the terminal's alternate screen, which keeps no scrollback
// ring, so `pane.read` can only ever hand back the visible viewport — a reply longer than the pane is
// tall has its opening simply gone, and the only copy that still exists is the agent's own session log
// (bridge/journal/, GET /api/pane/:id/history). Reaching it used to mean leaving the pane for the
// history route. locateReply lets the pane view put the full message back in place instead —
// including WHERE the clipped rows end, so the card replaces them rather than printing them twice.
//
// This is NOT a step toward rendering the terminal from the journal, and it must not become one: the
// mirror stays the mirror (ADR 0008), and nothing here synthesises scrollback. All it answers is "is
// the start of the message on screen, and if not, is this even the message on screen".
//
// THE NORMALISATION IS THE WHOLE TRICK. Both sides describe the same prose in different notations:
// the journal holds Markdown source (`**bold**`, `- bullet`, one logical line per paragraph), while
// the mirror holds what Claude's renderer painted (emphasis turned into SGR runs, bullets possibly
// re-glyphed, an `⏺` prefix, and every paragraph hard-wrapped at the pane width with indentation on
// the continuation rows). Folding both to LETTERS AND DIGITS ONLY — dropping whitespace along with
// punctuation — collapses every one of those differences at once. Wrapping is the case that makes it
// necessary rather than merely convenient: the mirror breaks a paragraph wherever the pane width
// falls, the journal breaks it nowhere, and only deleting the spaces makes the two comparable
// (`hello\n  world` and `hello world` both fold to `helloworld`).
//
// Escapes must go BEFORE the fold: `\x1b[38;5;1m` is mostly digits, and digits survive folding, so an
// un-stripped SGR run would inject garbage into the middle of a probe. parseAnsi is the repo's one
// place that knows escape shapes — use it rather than a second regex that can drift from it.

import { parseAnsi } from "./ansi";
import { BOX_CROSS_GLYPH_CLASS, BOX_VERTICAL_GLYPH_CLASS } from "./rule-glyphs";
import type { TranscriptEntry } from "./types";

/**
 * How much of the reply each probe compares, in folded characters.
 *
 * Long enough that a coincidental match is not a real risk (48 letters of prose is a sentence), short
 * enough to sit inside the first and last rendered lines of a message.
 */
export const PROBE_CHARS = 48;

/** Where the newest reply sits relative to what the mirror is showing. */
export type ReplyFit =
  /** Its tail is on screen but its opening has scrolled off — the case worth surfacing. */
  | "clipped"
  /** All of it is on screen (or it is too short to be worth the machinery). */
  | "whole"
  /** Not the message the mirror is showing at all — see the note on {@link locateReply}. */
  | "off-screen";

/** Keep letters and digits, lose everything else. Unicode-aware, so a non-Latin reply still folds to
 *  its own content rather than to nothing. */
export function fold(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Plain text of a mirror read: the ANSI parse, reassembled. Newlines live inside the segments, so
 *  joining with "" reproduces the screen exactly — and the fold then removes them anyway. */
function plain(mirrorText: string): string {
  return parseAnsi(mirrorText)
    .map((segment) => segment.text)
    .join("");
}

const BOX_VERTICAL = new RegExp(`[${BOX_VERTICAL_GLYPH_CLASS}]`);
const BOX_VERTICALS = new RegExp(`[${BOX_VERTICAL_GLYPH_CLASS}]`, "g");
const BOX_CROSSES = new RegExp(`[${BOX_CROSS_GLYPH_CLASS}]`, "g");
// A frame row: box-drawing glyphs and spaces only.
const BOX_FRAME = /^[─-╿\s]+$/;
// Grok's scrollbar: one block-element cell at the right edge of every row, frame rows included, once a
// reply outgrows the pane (harness/grok/chrome.ts). Left on a frame row, it hides the row's frame and
// the table's last row stays interleaved, which is the reply's tail.
const TRAILING_RAIL = /[▁-█]\s*$/;
// A table's lid and floor: the corners and outward tees of its top and bottom border.
const BOX_LID = /[┌┐╭╮┏┓╔╗┬┳╤╦]/;
const BOX_FLOOR = /[└┘╰╯┗┛╚╝┴┻╧╩]/;

/**
 * The mirror's rows with every wrapped box-table row put back in SOURCE order.
 *
 * A renderer that wraps a table cell paints the row line by line across the columns, so the screen
 * reads cell 1's first line, cell 2's first line, then cell 1's second line. The journal holds each
 * cell whole. Without this, a probe that reaches into such a row misses and the reply reads as
 * off-screen. A logical row is the run of content rows between two frame rows; its cells are joined
 * column by column onto its LAST painted row, and the rows above it become empty. The row count never
 * changes, so an `endLine` found here still indexes the mirror as painted.
 *
 * The table is found by COUNT, not by `table-run.ts`'s column offsets: those are string indices, so a
 * cell holding double-width text (any CJK reply) misaligns them and no run is found. The anchor is a
 * frame row carrying a cross, as there; rows join while they are frame rows or carry that many
 * verticals (with or without outer borders, and inside a box drawn round the whole message). A blank
 * row ends the table, and so does its own lid or floor: a frame row with a top corner or tee is the
 * last row taken going up, one with a bottom corner or tee the last going down, so a line of prose
 * under the table that happens to hold a `│` is never pulled into its last row. A logical row whose
 * painted lines disagree on their vertical count is not one row of this table, and is left as painted
 * rather than joined, which would drop or shuffle its extra text. This only reorders the
 * text the probes compare; what the mirror draws is untouched.
 */
export function sourceOrderRows(rows: readonly string[]): string[] {
  const out = [...rows];
  const verticals = (row: string) => row.match(BOX_VERTICALS)?.length ?? 0;
  const isFrame = (row: string) => {
    const bare = row.replace(TRAILING_RAIL, "");
    return bare.trim() !== "" && BOX_FRAME.test(bare);
  };
  let floor = 0;
  for (let anchor = 0; anchor < rows.length; anchor++) {
    if (anchor < floor || !isFrame(rows[anchor]!)) continue;
    const crosses = rows[anchor]!.match(BOX_CROSSES)?.length ?? 0;
    if (crosses === 0) continue;
    // A content row carries one vertical per crossing, plus two for the table's own outer border,
    // plus two more when the renderer boxes the whole message (Grok highlighting a message).
    const member = (row: string) =>
      isFrame(row) || [crosses, crosses + 2, crosses + 4].includes(verticals(row));
    let start = anchor;
    while (start > floor && !BOX_LID.test(rows[start]!) && member(rows[start - 1]!)) start--;
    let end = anchor;
    while (end + 1 < rows.length && !BOX_FLOOR.test(rows[end]!) && member(rows[end + 1]!)) end++;
    floor = end + 1;

    let group: number[] = [];
    const flush = () => {
      if (group.length > 1 && group.every((i) => verticals(rows[i]!) === verticals(rows[group[0]!]!))) {
        const cells = group.map((i) => rows[i]!.split(BOX_VERTICAL));
        const joined = cells[0]!.map((_, col) => cells.map((c) => c[col] ?? "").join(" "));
        for (const i of group) out[i] = "";
        out[group.at(-1)!] = joined.join(" ");
      }
      group = [];
    };
    for (let i = start; i <= end; i++) {
      if (isFrame(rows[i]!)) flush();
      else group.push(i);
    }
    flush();
  }
  return out;
}

/** A turn's prose — its `text` parts only. Thinking is not the reply, and a tool call is not speech. */
export function replyProse(entry: TranscriptEntry): string {
  return entry.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** True when the bridge capped one of those parts (MAX_TEXT_CHARS), so what we hold is not the end. */
function proseTruncated(entry: TranscriptEntry): boolean {
  return entry.parts.some((part) => part.kind === "text" && part.truncated === true);
}

/** The newest turn that is the agent SPEAKING — the last assistant entry carrying prose. */
export function newestReply(entries: TranscriptEntry[]): TranscriptEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    // A turn the agent rewound past is not the reply on screen, and the identity check downstream
    // would reject it anyway; skipping it here means the walk keeps looking instead of stopping on a
    // turn that can never pass.
    if (entry?.abandoned === true) continue;
    if (entry && entry.role === "assistant" && replyProse(entry) !== "") return entry;
  }
  return null;
}

/** Where a turn sits on the mirror, and — when it is clipped — which row it ends on. */
export interface ReplyPlacement {
  fit: ReplyFit;
  /** Index of the last mirror row the reply occupies. Only meaningful when `fit` is `clipped`. */
  endLine: number;
}

/** A verdict with no rows to replace — every fit but `clipped` ends here. */
const elsewhere = (fit: ReplyFit): ReplyPlacement => ({ fit, endLine: -1 });

/**
 * The painted spelling is built only for a reply up to this long. Its patterns run on every poll on the
 * phone, so a hostile or merely huge reply must not cost seconds of main-thread time whatever the
 * regexes do. Past the cap only the raw spelling is tried, as before the painted one existed.
 */
const PAINTED_SPELLING_MAX_CHARS = 65_536;

/**
 * Locate a journal turn on the mirror.
 *
 * Two probes, and the ORDER OF THE VERDICTS matters more than either of them:
 *
 * - The **tail** probe is the identity check. The journal's newest reply is not necessarily the one
 *   on screen — the log lags a message that is still streaming, the operator may have frozen the
 *   mirror by scrolling, and a >20 000-character part reaches us clamped so its real ending never
 *   arrives. When the tail is missing we answer `off-screen` and the caller shows NOTHING. Presenting
 *   an older message as "the reply you are looking at" is the one failure this must not have.
 * - The **head** probe then answers the actual question: is its opening still on the screen.
 *
 * A reply shorter than two probes is `whole` by construction — it cannot be meaningfully clipped, and
 * overlapping probes would compare a string against itself.
 *
 * `endLine` exists so the caller can REPLACE those rows with the full message rather than print it
 * twice. Folding erases the row boundaries, so the row that the reply ends on is recovered by keeping
 * each row's cumulative folded length and finding the first that reaches the tail probe's end.
 */
export function locateReply(mirrorText: string, entry: TranscriptEntry): ReplyPlacement {
  const prose = replyProse(entry);
  if (fold(prose).length < PROBE_CHARS * 2) return elsewhere("whole");
  if (proseTruncated(entry)) return elsewhere("off-screen");

  const rows = sourceOrderRows(plain(mirrorText).split("\n"));
  // Folding each row and concatenating is the same string as folding the whole screen — the fold
  // drops the separators either way — so these offsets index into one folded mirror.
  const rowEnds: number[] = [];
  let mirror = "";
  for (const row of rows) {
    mirror += fold(row);
    rowEnds.push(mirror.length);
  }

  // Both spellings are this same reply. The painted one is tried first and only when it still holds
  // two whole probes: what it drops (a link's target, a tag) can leave too little to tell one reply
  // from another, and the short-reply rule above judged the raw text, not this.
  const painted = prose.length > PAINTED_SPELLING_MAX_CHARS ? "" : fold(paintedSpelling(prose));
  const spellings = painted.length >= PROBE_CHARS * 2 ? [painted, fold(prose)] : [fold(prose)];
  for (const reply of new Set(spellings)) {
    const tail = reply.slice(-PROBE_CHARS);
    const at = mirror.indexOf(tail);
    if (at === -1) continue;
    if (mirror.includes(reply.slice(0, PROBE_CHARS))) return elsewhere("whole");

    const end = at + tail.length;
    const endLine = rowEnds.findIndex((rowEnd) => rowEnd >= end);
    return { fit: "clipped", endLine: endLine === -1 ? rows.length - 1 : endLine };
  }
  return elsewhere("off-screen");
}

// `[label](target)` and `![alt](target)`, with an optional `"title"`. The label may hold single-backtick
// code spans and no `[`: a run of backticks must not split more than one way, or a line of many spans
// and no `](` backtracks for minutes, and a nested `[` simply is no link (the mirror decides then).
// The tail runs in linear time on purpose: the target cannot hold whitespace, `<`, `>`, `[` or `)`, and
// no whitespace sits inside the parentheses, so no two quantifiers overlap and a scan from one `[a](`
// cannot run on to the end of the text. A link this does not match, such as `[a]( url )` or
// `http://[::1]/`, is deliberately left alone: the painted spelling keeps its source, and the raw
// spelling, which {@link locateReply} tries second, still matches the screen. Linear time on a 100 KB
// reply beats painting a rare form.
const MARKDOWN_LINK_SOURCE = String.raw`!?\[((?:\x60[^\x60\n]*\x60|[^\][\x60\n])*)\]\(<?[^)\s<>\[]*>?(?:[ \t]+"[^"\n]*")?\)`;
// An inline code span, kept whole: Claude paints what is inside it exactly as written.
const CODE_SPAN_SOURCE = String.raw`(\x60+)[^\x60\n]*?\x60+`;
// One inline token: a code span (group 1 is its opening run) or a link (group 2 is its label).
// The leftmost wins, so a link whose label is a code span is a link, and a span holding `[a](b)` is code.
const INLINE = new RegExp(`${CODE_SPAN_SOURCE}|${MARKDOWN_LINK_SOURCE}`, "g");
// `<https://…>` and `<mailto:…>`: the terminal prints the address itself, so it is text, not a tag.
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/g;
// An HTML tag: a name, then whitespace, `/` or `>`. A scheme's colon is never part of a tag name.
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>\n]*)?\/?>/g;
const HTML_ENTITY = /&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g;
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

const NAMED_ENTITIES = new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", " "]]);

function decodeEntity(entity: string): string {
  const body = entity.slice(1, -1);
  if (!body.startsWith("#")) return NAMED_ENTITIES.get(body) ?? entity;
  const code = body.startsWith("#x") ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
  // fromCodePoint throws past U+10FFFF, and this runs during render: a reply that merely mentions
  // such a reference must not take the pane view down with it.
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
}

/** Text outside code and links, as Claude paints it. */
function paintedText(text: string): string {
  return text.replace(AUTOLINK, "$1").replace(HTML_TAG, "").replace(HTML_ENTITY, decodeEntity);
}

function paintedLine(line: string): string {
  let out = "";
  let at = 0;
  for (const m of line.matchAll(INLINE)) {
    out += paintedText(line.slice(at, m.index));
    out += m[1] === undefined ? (m[2] ?? "") : m[0];
    at = m.index + m[0].length;
  }
  return out + paintedText(line.slice(at));
}

/**
 * The reply spelled the way Claude paints it, 2026-09-27 on Herdr's grid. Each rule drops or rewrites
 * source that never reaches the screen as written: a link keeps only its label (the terminal takes
 * hyperlinks, so the target is not printed), an autolink keeps its URL, a fence loses its language
 * tag, an HTML tag is dropped and an entity decoded. Code is left alone, a fenced block's body and an
 * inline span alike, because Claude prints those verbatim. A fence closes only on a fence of its own
 * character at least as long with nothing after it, as in CommonMark, so a fence shown inside a
 * longer one stays code. A link whose label is a code span is still a link. A renderer that differs is still matched by the raw spelling, which
 * {@link locateReply} tries second.
 */
function paintedSpelling(prose: string): string {
  let open: { char: string; length: number } | null = null;
  return prose
    .split("\n")
    .map((line) => {
      const fence = FENCE.exec(line);
      if (open === null) {
        // An opening fence: its info string (the language tag) is not painted.
        if (fence && !(fence[2]!.startsWith("`") && fence[3]!.includes("`"))) {
          open = { char: fence[2]![0]!, length: fence[2]!.length };
          return `${fence[1]}${fence[2]}`;
        }
        return paintedLine(line);
      }
      const closes =
        fence !== null && fence[2]![0] === open.char && fence[2]!.length >= open.length && fence[3]!.trim() === "";
      if (closes) open = null;
      return line;
    })
    .join("\n");
}
