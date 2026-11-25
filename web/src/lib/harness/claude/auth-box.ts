// The AUTHENTICATION BOX — the rounded box Claude Code draws over its input box while the
// `awsAuthRefresh` command runs (titled "Sign-in" from 2.1.328). It holds its title alone until the command prints, and lifts then as a
// waiting card; once filled it holds that command's output (a login URL and a device code) or, when
// another process already runs it, a one-sentence lock message:
//
//     ╭────────────────────────────╮
//     │ Authentication             │      ← title row: "Authentication", "Sign-in" from 2.1.328, a label (below)
//     │                            │      ← a blank row
//     │ Browser will not be …      │      ← content rows, one padding cell inside each border
//     ╰────────────────────────────╯
//                                         ← blank rows, and at most one turn-spinner row
//     <the live input box>
//
// The box's content width is its own edges' inner width less the padding, never the pane's: a 61-wide
// box on a 61-column pane holds 57 cells, a 113-wide box on a 120-column pane holds 109. Rows are cut
// by that width from the left edge, so the padding is dropped whether the terminal drew it as its own
// styled run or inside the text run, and every other space the row holds stays.
//
// It lifts as a card of its own kind, `box-text`, which prints no key and holds none. Every other card
// above the live box is a `menu` defined by the keys its rows print (ADR 0109), and this box prints
// none. A `menu` with zero actions would be a dialog card, so the composer's "Answer the dialog" would
// point at it while the box under it still takes a message; teaching surface/notice.ts a keyless shape
// would hand the Surface and the bridge's send gate a notice with nothing to bind. So the card has no
// row in harness/dialog-contract.ts, and the composer and the send path stay exactly as they are on
// the same screen without it.
//
// It lifts only while the input box under it is live and its tail reads as Claude's statusline, so a
// completion popup or rows the input frame cannot classify leave the screen as it is. That is the one
// rule, and it is not ADR 0109's: a notice must also keep its binding region inside the bridge's tail
// window, and a card that sends nothing binds nothing. Under a live frame, output rows cannot be told
// from status rows, so the residue is accepted: rows under an exited frame that still walk as a
// statusline tail (up to eight status rows, or those plus a blank-separated footer of up to eight more)
// keep a stale card on screen, whose link at worst opens an expired login page. No keystroke is ever
// at stake.
//
// THE BOX IS KNOWN BY ITS SHAPE AND ITS PLACE, AND ITS TITLE IS A LABEL (ADR 0159). Claude Code renamed
// the title once (issue 816), and a list of titles hid the sign-in link from Chat until Collie learned
// the new word. A known title ("Authentication", "Sign-in") lifts as it always did, the waiting card
// included. Any other title lifts the same card, headed by the title the box prints, only when the box
// has Claude's plainest shape: a top edge of `─` alone, the title alone on the first row as one short
// run of words, a blank row under it, and at least one https link in the rows. A box with any other
// title and no link lifts nothing, so Claude's own welcome box (a titled top edge, a blank first row)
// and any keyless notice without a link stay in the mirror. A box with an unknown title whose title or
// rows print a key or an option (`Esc to cancel`, `1. Yes`, a `❯` pointer) lifts nothing: a box with keys
// is a dialog, never this card. A known title keeps exactly the guards it always had (the statusline tail,
// the gap rule, the strong cue), because the box holds the output of the person's own `awsAuthRefresh`
// command, which may well print "1. Open the address" or "Press Enter after you signed in".
//
// THE LINK IS AN ADDRESS A PERSON CAN READ. A run is a link only when it is `https:` to any host, or
// `http:` to a loopback host (`localhost`, `127.0.0.1`, `[::1]`, any port: a login's local shortcut,
// which a desktop browser on the same machine opens and a phone fails on harmlessly); printable ASCII
// from end to end (no space, no control, no bidi or other format character, no look-alike letter); and
// with no user name or password, so the host the card shows is the host the link opens. Anything else
// stays plain text in the card, as it is on the terminal.
//
// Pure functions over parsed line text.

import { lineText, type StyledLine } from "../../blocks";
import { findLinks } from "../../links";
import { readCuesFor } from "../../surface/cues";
import { findInputFrame } from "../../surface/frame";
import type { BoxTextModel, BoxTextRun } from "../box-text-model";
import { joinBrokenUrls } from "../box-url-join";
import { namesAMenuKey } from "../menu-hints";
import { inputBoxTail } from "./chrome";
import { CLAUDE_IDLE, isBlank } from "./markers";

// The titles Claude Code has printed. Claude Code 2.1.328 renamed the box from "Authentication" to
// "Sign-in" and changed nothing else about it (issue 816). A known title lifts the waiting card too; any
// other title lifts only a filled box that holds a link (see the header and `labelledLikeTheBox`).
const KNOWN_TITLES: ReadonlySet<string> = new Set(["Authentication", "Sign-in"]);
/** An unknown title: at most four words of letters and digits, joined by one space or one hyphen, led by a letter. */
const TITLE_WORDS = /^\p{L}[\p{L}\p{N}]*(?:[ -][\p{L}\p{N}]+){0,3}$/u;
/** The longest unknown title that lifts. "Authentication" is 14. */
const TITLE_MAX = 32;
/** A top edge with nothing drawn into it, as the box has always printed it. */
const PLAIN_TOP_EDGE = /^╭─+╮$/u;
/** A row that prints an option: a numbered choice, or a `❯`/`›` pointer at its start. */
const OPTION_ROW = /^\s*(?:[❯›]\s*)?\d+[.)]\s|^\s*[❯›]\s/u;
/** A whole address a card may link: http(s), then printable ASCII only. Which scheme for which host is `linkableAddress`. */
const LINKABLE = /^https?:\/\/[\x21-\x7e]+$/u;
/** The hosts a plain-http link may name, as `URL.hostname` spells them. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The border and its one padding cell, on each side of a row. */
const EDGE_CELLS = 2;

/** A box found above the input box: its rows, `startLine` to `endLine` inclusive, and its card. */
export interface AuthBoxRegion {
  startLine: number;
  endLine: number;
  model: BoxTextModel;
}

/**
 * Whether the card may link `address`: https to any host or http to a loopback host, printable ASCII only,
 * and no user name or password, so the host a person reads is the host the link opens. The scanner
 * (lib/links.ts) already holds it to http(s).
 */
export function linkableAddress(address: string): boolean {
  if (!LINKABLE.test(address)) return false;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || url.hostname === "") return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

function pushPlain(runs: BoxTextRun[], text: string): void {
  if (text === "") return;
  const last = runs.at(-1);
  if (last?.kind === "plain") runs[runs.length - 1] = { kind: "plain", text: last.text + text };
  else runs.push({ kind: "plain", text });
}

function runsOf(content: string): BoxTextRun[] {
  const runs: BoxTextRun[] = [];
  let at = 0;
  for (const link of findLinks(content)) {
    pushPlain(runs, content.slice(at, link.start));
    const text = content.slice(link.start, link.end);
    if (linkableAddress(link.href)) runs.push({ kind: "link", text, href: link.href });
    else pushPlain(runs, text);
    at = link.end;
  }
  pushPlain(runs, content.slice(at));
  return runs;
}

// A message sent while the box is up starts a turn, and Claude Code (2.1.310) draws that turn's spinner
// in the gap under the box while it waits for the login, which is how a prompt that triggers the refresh
// meets the box. The row belongs to the turn, not to a dialog, so the card stays keyless. A macOS
// capture of 2.1.328 draws the frame `✳` where the earlier captures draw `*` (issue 816).
const TURN_SPINNER_ROW = /^[·*✢✳✶✻✽] [^\s…]+…(?: · tool use)?(?: ?\(.*)?$/;

// When the credentials expire mid-session, the turn's API call fails first, and Claude Code (2.1.318)
// draws its retry row in the spinner's place while the refresh runs. Its lead is "API error" on the
// first attempts and the error's own text or "Usage limit reached" after, so the row is matched by
// its retry word and attempt count. The retry word takes three forms: "Retrying in 3s" (2.1.318),
// "retrying in 3s", and "retrying…" once the countdown reaches zero (both from 2.1.330 at the latest,
// issue 862). A row with the word and no countdown and no ellipsis is not one of them.
const API_RETRY_ROW = /^✻ .+ · (?:[Rr]etrying in \d+[dhms](?: \d+[dhms])*(?: \(.*\))?|retrying…) · attempt \d+\/\d+$/;

function skipBlankRows(texts: readonly string[], from: number): number {
  let row = from;
  while (row >= 0 && isBlank(texts[row]!)) row--;
  return row;
}

/**
 * The matched rounded-corner box whose bottom edge is the last non-blank row above `before`, or null.
 * One turn-spinner or API retry row may stand between the box and `before`.
 */
function boxAbove(texts: readonly string[], before: number): { top: number; bottom: number; width: number } | null {
  let bottom = skipBlankRows(texts, before - 1);
  if (bottom < 0) return null;
  const gapRow = texts[bottom]!.trimEnd();
  if (TURN_SPINNER_ROW.test(gapRow) || API_RETRY_ROW.test(gapRow)) bottom = skipBlankRows(texts, bottom - 1);
  if (bottom < 0) return null;
  const bottomEdge = texts[bottom]!.trimEnd();
  if (!bottomEdge.startsWith("╰") || !bottomEdge.endsWith("╯")) return null;
  const width = bottomEdge.length;
  for (let row = bottom - 1; row >= 0; row--) {
    const text = texts[row]!.trimEnd();
    if (text.startsWith("╭")) return text.endsWith("╮") && text.length === width ? { top: row, bottom, width } : null;
    if (!text.startsWith("│") || !text.endsWith("│") || text.length !== width) return null;
  }
  return null;
}

/** Whether a row of the box prints a key (`Esc to cancel`) or an option (`1. Yes`, a `❯` pointer). */
function printsKeys(row: string): boolean {
  return namesAMenuKey(row) || OPTION_ROW.test(row);
}

/**
 * Whether a box whose title is not a known one has the box's own shape: a plain top edge, a title of
 * one short run of words that names no key, and a blank row under the title row.
 */
function labelledLikeTheBox(texts: readonly string[], box: { top: number; bottom: number; width: number }, title: string): boolean {
  if (!PLAIN_TOP_EDGE.test(texts[box.top]!.trimEnd())) return false;
  if (title.length > TITLE_MAX || !TITLE_WORDS.test(title) || namesAMenuKey(title)) return false;
  const under = box.top + 2;
  return under < box.bottom && isBlank(texts[under]!.trimEnd().slice(1, box.width - 1));
}

/**
 * The Authentication box over Claude's live input box, or null. The card's rows are the box's content
 * rows under the title row, blank rows included; a box with a known title holding its title alone, or
 * the title and blank rows, lifts as a waiting card with no rows. A box with another title lifts only
 * filled, with a link.
 */
export function detectAuthBox(lines: StyledLine[]): AuthBoxRegion | null {
  if (inputBoxTail(lines) !== "statusline") return null;
  const frame = findInputFrame(lines, CLAUDE_IDLE);
  if (frame === null) return null;
  // A strong cue means a dialog holds the keys. Every screen this refuses is already refused by the
  // statusline tail or by the gap under the box, blank but for one turn-spinner row; it stays as the
  // guard of last resort, so loosening either rule never lifts a card over a dialog.
  if (readCuesFor(lines, frame, CLAUDE_IDLE).strength === "strong") return null;
  const texts = lines.map(lineText);
  const box = boxAbove(texts, frame.top);
  if (box === null) return null;
  const titleRow = box.top + 1;
  if (titleRow === box.bottom) return null;
  // The title row is read up to the right border, so a title that spills into the padding cell is not the title.
  const title = texts[titleRow]!.trimEnd().slice(EDGE_CELLS, box.width - 1).trim();
  if (title === "") return null;
  const known = KNOWN_TITLES.has(title);
  if (!known && !labelledLikeTheBox(texts, box, title)) return null;
  const contentWidth = box.width - 2 * EDGE_CELLS;
  const rows = texts.slice(titleRow + 1, box.bottom).map((text) => text.trimEnd().slice(EDGE_CELLS, EDGE_CELLS + contentWidth));
  if (!known && (printsKeys(title) || rows.some(printsKeys))) return null;
  if (rows.every(isBlank)) return known ? { startLine: box.top, endLine: box.bottom, model: { title, phase: "waiting", text: [] } } : null;
  const text = joinBrokenUrls(rows, contentWidth).map(runsOf);
  if (!known && !text.some((row) => row.some((run) => run.kind === "link"))) return null;
  return { startLine: box.top, endLine: box.bottom, model: { title, phase: "filled", text } };
}
