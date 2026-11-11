// The wire of agent views: a view of an agent session beside Terminal and Chat that the session's own
// agent draws, added by a trick whose manifest lists the place `agent-view` (contract 2). The agent
// answers a request by drawing ONE screen (`collie trick view <id> show <file.json>`), in the trick node
// vocabulary. The bridge, the CLI and the web app all import this file by relative path, so it holds
// types, constants and small pure, total readers only. No I/O, no React, no runtime dependency, no `@/`.
//
// A VIEW IS KEYED BY (TRICK, SESSION). The trick is the trick id whose manifest lists `agent-view`; the
// session is the walky address of the pane, the way the hill names a session (`about`, the poster's
// `from.address`). The bridge fills the session from the local socket for the CLI, never from the request.
//
// A SCREEN IS A TRICK PART'S VIEW. `parseAgentView` reads it with the trick parser's full part
// vocabulary (buttons allowed, the `VIEW_LIMITS` caps, a part's byte cap), not the display-only
// Decision reader, and holds it strictly: a node or an attribute the parser would only drop or ignore
// is refused here, so what the agent drew is what the phone draws. An agent view is held tighter than a
// trick part in three places (agent views SECURITY S1, N2): a button carries no `value` (the tap words
// are its label and group, all of them on screen), no `does` (no copy to the phone's clipboard), and its
// label and group are one line of shown characters.
//
// PICTURES ARE THE HILL'S. A screen may carry up to four pictures (`show --image`), kept by the bridge in
// a second instance of the hill's media store and named by an opaque set id of the hill's decision id
// shape. The view places one with `image` and a `ref` (the index into the pictures), or two with
// `compare`, exactly as a Decision's view does. The trick part parser refuses a `ref` and the Decision
// parser refuses a button, so `parseAgentView` reads every picture subtree with the Decision parser and
// the rest with the part parser, the pictures swapped for a neutral `spacer` (see there).
//
// THE DECISION BLOCK. Beside its view a screen may carry one `choice`: a question and one to five
// options, drawn under the view. Its caps are the hill's option caps. An option carries no `value`: a
// pick sends its label.
//
// A SCREEN IS A LIST OF BLOCKS. A block is one top-level node of the view plus a stable id, so an agent
// changes one block (`set <id>`) instead of redrawing the screen. In a `show` file a top-level node may
// carry `"id"`; the schema refuses `id` on a node, so `parseAgentView` strips the top-level ids before it
// validates and answers them beside the view. The wire carries them in `ViewScreen.blocks`, same length
// and order as `view`, each with the time it was last set, kept or shown (`at`): the phone calls a block
// older than the operator's latest request STALE. A pending block (`pending`) holds a `spacer` in the
// view, so every index stays aligned, and its label in `blocks`.
//
// A TAP IS SENT BY THE BRIDGE. The phone posts `view: { trick, session, rev, control }` on its send; the
// bridge builds the line from ITS stored screen ({@link viewTapWords}) behind Collie's head
// ({@link isViewHeadLine}), and no other door may type that head (the Send Protocol's `textRefusal` and the doors that neutralise).

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, type JsonObject, type JsonValue } from "../json";
import {
  HILL_ID_RE,
  HILL_MEDIA_CAPTION_MAX,
  HILL_MEDIA_ID_RE,
  HILL_MEDIA_MIMES,
  HILL_OPTION_CONFIRM_MAX,
  HILL_OPTION_DETAIL_MAX,
  HILL_OPTION_LABEL_MAX,
  HILL_OPTIONS_MAX,
  HILL_TITLE_MAX,
  HILL_WHY_MAX,
  type HillMedia,
} from "../hill/wire";
import { hasHiddenChar, isHiddenChar } from "../hidden-chars";
import { DOCUMENT_VERSION, isTrickId, isTrickUrl, PART_MAX_BYTES, parseDecisionView, parseTrickDocument, VIEW_LIMITS, type Refusal, type View, type ViewNode } from "../tricks/schema";

/** A screen's title, in characters. */
export const VIEW_TITLE_MAX = 80;
/**
 * The tail a send from a view carries while the session is not known to hold the rules:
 * `[rules: <bin> trick view <id> help --session <addr>]`, naming the binary's absolute path, the trick id
 * and the session's own address. The lane path (58 characters) with an id of 32 and an address of 30 is
 * about 150, so the cap leaves room for a quoted path.
 */
export const VIEW_HINT_MAX = 200;
/**
 * The head of a send from a view, `[view:<id> <address>] from operator:`, in characters. The bridge owns
 * the words, and falls back to `[view:<id>] from operator:` past this cap.
 */
export const VIEW_HEAD_MAX = 160;
/** A `start` note, in characters: what the agent does, one line. */
export const VIEW_NOTE_MAX = 80;
/** How long a `start` counts as drawing, in ms. The bridge stops serving an older one; the phone ignores it too. */
export const VIEW_DRAWING_MAX_MS = 10 * 60 * 1000;
/** The longest session key the wire carries. */
export const VIEW_SESSION_MAX = 256;
/** The read route. `?since=<rev>` answers only the views that moved since. */
export const TRICK_VIEWS_ROUTE = "/api/trick-views";
/** The switch route, a paired device's write: `{ trick, session, on }`. */
export const TRICK_VIEWS_SWITCH_ROUTE = "/api/trick-views/switch";

/** Pictures one screen carries, in all: a show's and every later block's together. */
export const VIEW_MEDIA_MAX = 4;
/** The largest picture a view keeps, in bytes actually read. Checked before and after the read. */
export const VIEW_MEDIA_BYTES_MAX = 2 * 1024 * 1024;
/** The bytes one view's picture set may hold on disk. */
export const VIEW_SET_BYTES_MAX = 8 * 1024 * 1024;
/** A picture's caption, in characters: the hill's. */
export const VIEW_CAPTION_MAX = HILL_MEDIA_CAPTION_MAX;
/** A picture set's id: the hill's decision id shape (`dc_` and 12 random characters), minted by the bridge per set. */
export const VIEW_SET_RE = HILL_ID_RE;
/** A picture's id: the hill's media id shape, minted by the bridge. */
export const VIEW_MEDIA_ID_RE = HILL_MEDIA_ID_RE;
/** Where the phone reads a picture's bytes: `${TRICK_VIEWS_MEDIA_ROUTE}<set id>/<media id>`. */
export const TRICK_VIEWS_MEDIA_ROUTE = "/api/trick-views/media/";

/** One picture of a screen, as the bridge kept it: the hill's media shape. */
export type ViewMedia = HillMedia;

/** The route a picture's bytes are read at. Both ids are checked by the bridge before any path is built. */
export function viewMediaPath(set: string, mediaId: string): string {
  return `${TRICK_VIEWS_MEDIA_ROUTE}${encodeURIComponent(set)}/${encodeURIComponent(mediaId)}`;
}

/** The longest label a tap sends, in characters (agent views SECURITY 5.3). */
export const VIEW_TAP_LABEL_MAX = 60;
/** The longest group label a tap sends, in characters. */
export const VIEW_TAP_GROUP_MAX = 40;

/** Agent writes one (trick, session) may make in a minute; one more is refused `rate` (SECURITY rule 12). */
export const VIEW_WRITES_PER_MINUTE = 120;
/** View sends one session may make in a minute; one more is refused `rate`. One is in flight at a time. */
export const VIEW_SENDS_PER_MINUTE = 20;

/**
 * Line breaks of every kind a door or a terminal may honour: CR LF, CR, LF, VT, FF, NEL, LS and PS. A
 * head is looked for after each one, wider than `sendLines` (which drops NEL), so no break hides one.
 */
const LINE_BREAK = /\r\n|[\r\n\v\f\u0085\u2028\u2029]/u;
/**
 * A terminal control sequence (CSI), the bracketed-paste markers among them. The typing path drops only
 * its ESC, a terminal may act on the whole: a line is read both ways, since `ESC [v` is itself a CSI.
 */
// eslint-disable-next-line no-control-regex -- the point is to find a control sequence
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
/** Combining marks, removed after NFD so `v̲iew` reads `view`. */
const MARK = /\p{M}/gu;
/**
 * Look-alikes NFKC leaves alone, for the characters of `[view:`, `[morph`, `] from operator:` (review 9
 * M2): Cyrillic and Greek letters, small capitals, and brackets and colons of other scripts.
 */
const CONFUSABLE = new Map(Object.entries({
  "\u0430": "a", "\u0435": "e", "\u0456": "i", "\u043c": "m", "\u043e": "o", "\u0440": "p", "\u0442": "t",
  "\u04bb": "h", "\u0475": "v", "\u051d": "w", "\u0491": "r",
  "\u03b1": "a", "\u03b5": "e", "\u03b7": "n", "\u03b9": "i", "\u03bc": "m", "\u03bd": "v", "\u03bf": "o",
  "\u03c1": "p", "\u03c4": "t", "\u03c9": "w",
  "\u1d00": "a", "\u1d07": "e", "\u026a": "i", "\u1d0d": "m", "\u0274": "n", "\u1d0f": "o", "\u1d18": "p",
  "\u0280": "r", "\u1d1b": "t", "\u1d20": "v", "\u1d21": "w", "\u029c": "h", "\ua730": "f",
  // The letters of Collie's own words (review 10): Cyrillic c, s, d, y, x, k, the palochka, and small capitals.
  "\u0441": "c", "\u0455": "s", "\u0501": "d", "\u0443": "y", "\u0445": "x", "\u043a": "k", "\u04cf": "l",
  "\u1d04": "c", "\u029f": "l",
  "\u27e6": "[", "\u27e8": "[", "\u3014": "[", "\u3010": "[", "\u3016": "[", "\u3018": "[", "\u301a": "[",
  "\u2768": "[", "\u276a": "[", "\u2772": "[", "\u2045": "[", "\u298b": "[", "\u298d": "[", "\u298f": "[",
  "\u27e7": "]", "\u27e9": "]", "\u3015": "]", "\u3011": "]", "\u3017": "]", "\u3019": "]", "\u301b": "]",
  "\u2769": "]", "\u276b": "]", "\u2773": "]", "\u2046": "]", "\u298c": "]", "\u298e": "]", "\u2990": "]",
  "\ua789": ":", "\u2236": ":", "\u02f8": ":", "\u0589": ":", "\u05c3": ":", "\u16ec": ":", "\ufe55": ":",
} satisfies Record<string, string>));
/** What a head may stand behind and still read as one: blanks, quote and list marks, emphasis, a list number. */
const LEAD_IN = /^(?:[\s>\-*+#_~`"'|\u201c\u201d\u201e\u2018\u2019\u00ab\u00bb]|\d+[.)])*/u;
/** The view head, and the head of the native build before agent views, at the start of a folded line. */
const HEAD_START = /^\[\s*(?:view\s*:|morph(?:[\s\]]|$))/u;
/** How far into a line a `[` may sit for `] from operator:` after it to count as a head. */
const OPERATOR_REACH = 80;
/** `] from operator:` after a `[`: what an agent reads as the operator speaking, wherever the bracket opens. */
const OPERATOR_MARK = /\]\s*from\s+operator\s*:/u;

/**
 * One line as an agent would read it once typed, folded for comparison: every hidden character (the
 * shared {@link isHiddenChar}, which holds Cc, so ESC and DEL too) removed as the typing path removes
 * them, a tab made a space, then NFKC, lower case, combining marks removed and look-alikes folded.
 */
export function foldViewLine(line: string): string {
  let kept = "";
  for (const ch of line) {
    if (ch === "\t") kept += " ";
    else if (!isHiddenChar(ch)) kept += ch;
  }
  const folded = kept.normalize("NFKC").toLowerCase().normalize("NFD").replace(MARK, "");
  let out = "";
  for (const ch of folded) out += CONFUSABLE.get(ch) ?? ch;
  return out;
}

/**
 * THE head rule (agent views SECURITY rule 7, review 9 M2), one function for every door: whether one line,
 * once cleaned and folded ({@link foldViewLine}), reads as a view head. It does when, after a lead-in of
 * blanks, quote marks, list marks, emphasis or a list number, it starts `[view:` or `[morph` (a blank or
 * `]` or the end after it), blanks inside allowed; or when a `[` within its first 80 characters is
 * followed later on the line by `] from operator:`. No `from operator:` is needed for the first form.
 * The line is read as typed (ESC dropped) and with control sequences removed; a head in either counts.
 */
export function isViewHeadLine(line: string): boolean {
  return foldedHead(foldViewLine(line)) || foldedHead(foldViewLine(line.replace(CSI, "")));
}

/** {@link isViewHeadLine} on a line {@link foldViewLine} already folded. */
function foldedHead(folded: string): boolean {
  if (HEAD_START.test(folded.replace(LEAD_IN, ""))) return true;
  const open = folded.indexOf("[");
  return open !== -1 && open < OPERATOR_REACH && OPERATOR_MARK.test(folded.slice(open + 1));
}

/** Whether `text` holds a line, after any kind of line break, that {@link isViewHeadLine} reads as a head. */
export function hasViewHead(text: string): boolean {
  return text.split(LINE_BREAK).some(isViewHeadLine);
}

/** Whether one character folds to `[`: the characters {@link neutraliseViewHeads} turns into `(`. */
function opensBracket(ch: string): boolean {
  return foldViewLine(ch) === "[";
}

/**
 * A text Collie composes from stored words (a Hill receipt, the crew state's tell), with every line that
 * {@link isViewHeadLine} reads as a head made harmless: each character on it that folds to `[` becomes
 * `(`, so neither form of the rule can match it. Every other character and every other line stays.
 */
export function neutraliseViewHeads(text: string): string {
  // Split with the breaks kept (odd places), so every line, the one after a leading break too, is read.
  const parts = text.split(/(\r\n|[\r\n\v\f\u0085\u2028\u2029])/u);
  return parts
    .map((part, i) => {
      if (i % 2 === 1 || !isViewHeadLine(part)) return part;
      let out = "";
      for (const ch of part) out += opensBracket(ch) ? "(" : ch;
      return out;
    })
    .join("");
}

/**
 * Why a send with a view's head, and the switch that would turn a view on, are refused for a pane with no
 * profile (review 9 M1): Collie types there blind, with no read of a dialog, an answer box or a turn.
 */
export const VIEW_NO_PROFILE = "This session's program is not one Collie can read, so a view cannot send to it.";

/** Why a text with an agent view's head is refused on every door but the view's own send (one head, one door). */
export const BAD_HEAD = "A line that starts with an agent view's head is sent only from that view on the phone. Rewrite the line.";

/** The decision block's question, in characters: the hill's title cap. */
export const VIEW_QUESTION_MAX = HILL_TITLE_MAX;
/** Options in one decision block: the hill's. */
export const VIEW_OPTIONS_MAX = HILL_OPTIONS_MAX;

/** One option of the decision block. A pick sends its label: an option carries no hidden `value`. */
export interface ViewOption {
  /** At most {@link HILL_OPTION_LABEL_MAX} characters, one line. */
  label: string;
  /** At most {@link HILL_OPTION_DETAIL_MAX} characters, one line. */
  detail?: string;
  /** A short word for the second tap, at most {@link HILL_OPTION_CONFIRM_MAX} characters. */
  confirm?: string;
  /** A picture ref: this option's preview. */
  preview?: number;
}

/** The decision block a screen may carry beside its view: one decision per screen. */
export interface ViewChoice {
  /** At most {@link VIEW_QUESTION_MAX} characters, drawn as the block's heading. */
  question?: string;
  /** One to {@link VIEW_OPTIONS_MAX}. */
  options: ViewOption[];
  /** The option the agent suggests (an index into `options`), and why. Never pre-selected. */
  recommends?: { option: number; why?: string };
}

/**
 * A pick COLLIE marks (review 10 W7): the bridge writes one when a tap or a pick from the view went (its
 * keys landed), from its own record of the send. Never the agent's: a button's `pressed` and a choice's
 * `picked` are refused at the write. `block` is the block's id ({@link VIEW_CHOICE_BLOCK} for the decision
 * block); `path` is the button's steps under that block's node (`0`, `1/0`), or the option's index.
 */
export interface ViewPick {
  block: string;
  path: string;
}

/** The most picks one screen carries: one per bar, and the decision block. */
export const VIEW_PICKS_MAX = 32;
/** A pick's path: one to eight steps of up to three digits. */
const PICK_PATH_RE = /^\d{1,3}(?:\/\d{1,3}){0,7}$/u;

/** Why a button's `pressed` is refused in an agent view (review 10 W7). */
export const VIEW_NO_PRESSED = 'A button in an agent view takes no "pressed": Collie marks the pick when the operator taps. Keep the question\'s block when you draw the next step.';
/** Why a choice's `picked` is refused (review 10 W7). */
export const VIEW_NO_PICKED = 'A choice takes no "picked": Collie marks the pick when the operator picks. Keep the question\'s block when you draw the next step.';

/** A block id: 1 to 32 of a-z, 0-9 and `-`. `choice` names the decision block in `keep`, never a block. */
export const VIEW_BLOCK_ID_RE = /^[a-z0-9-]{1,32}$/u;
/** The word `keep` names the decision block with. */
export const VIEW_CHOICE_BLOCK = "choice";
/** A pending block's label, in characters. */
export const VIEW_PENDING_MAX = 40;
/** The `start` notes one drawing run keeps, newest last. */
export const VIEW_NOTES_MAX = 8;

/** One block of a screen: the top-level node at the same index of `view`. */
export interface ViewBlock {
  /** Stable across `set`, `keep` and `pending`; minted `b1`, `b2`… for a node shown without one. */
  id: string;
  /** ISO time the bridge last set, kept or showed this block. Older than the latest request: stale. */
  at: string;
  /** A placeholder's label, at most {@link VIEW_PENDING_MAX} characters: the block is in work, its view node is a `spacer`. */
  pending?: string;
}

/** The screen the agent drew last for one view. */
export interface ViewScreen {
  /** Rises with every write to this view. A tap names it, and the bridge sends only for the rev it holds. */
  rev: number;
  /** ISO time of the write. */
  at: string;
  /** At most {@link VIEW_TITLE_MAX} characters, one line. */
  title?: string;
  /** A trick part's view, checked by {@link parseAgentView}. Buttons allowed, pictures by `ref`. */
  view: View;
  /** The picture set's id, present exactly when `media` is. */
  set?: string;
  /** Up to {@link VIEW_MEDIA_MAX} pictures, in the order given. A view's `ref` and an option's `preview` index into it. */
  media?: ViewMedia[];
  /** The decision block under the view. */
  choice?: ViewChoice;
  /** ISO time the decision block was last set, kept or shown. Present with `choice`. */
  choiceAt?: string;
  /** One per top-level node of `view`, same order. Absent on a screen stored before blocks: {@link viewBlocksOf} derives them. */
  blocks?: ViewBlock[];
  /** The picks Collie marked on this screen, oldest first (review 10 W7). Absent: none. */
  picks?: ViewPick[];
}

/** One `start` note, with the time it came. */
export interface ViewNote {
  at: string;
  note: string;
}

/** The agent called `start`: it is drawing, and has not shown yet. */
export interface ViewDrawing {
  /** ISO time of the start. */
  at: string;
  /** What the agent says it does, at most {@link VIEW_NOTE_MAX} characters, one line. */
  note?: string;
  /**
   * The notes of this drawing run, oldest first, at most {@link VIEW_NOTES_MAX}: every `start` with a note
   * appends one; a run ends with a `show`, a `clear`, the switch going off, or ten minutes. Each carries
   * its time, so the phone lists only the notes of the operator's latest request.
   */
  notes?: ViewNote[];
}

/** The most sent lines one view keeps, newest last. */
export const VIEW_SENT_MAX = 8;
/** The longest sent line the wire carries, in characters: a head, a tail and a typed text of a phone send. */
export const VIEW_SENT_LINE_MAX = 4096;

/**
 * One line the bridge typed into the session for this view: the exact text, head and tail included, so
 * the view shows it under Collie's words "Sent to this session", and Chat takes the head and the tail off
 * only for a turn whose request id is here (agent views, lead condition 7).
 */
export interface ViewSent {
  /** The send's request id. */
  rid: string;
  /** ISO time the bridge took the send. */
  at: string;
  /** A tap on a button or an option (`tap`), or typed text (`text`). */
  kind: "tap" | "text";
  /** The exact text the bridge handed to the session, every line. */
  line: string;
  /**
   * Set when the keys landed but the send did not end `sent` (review 9 R7): `typed_not_submitted` (the
   * text is in the box, not submitted) or `unknown` (it may have gone). Absent: sent.
   */
  outcome?: ViewSentOutcome;
  /**
   * For a tap: what it answered, read by the bridge from the screen it went from (review 10 W8): the
   * decision block's question for a pick (else the title), the screen's title for a button. The receipt
   * names it, never the screen shown now. Absent: the screen had none, or the line is typed text.
   */
  about?: string;
}

/** How a kept line ended when it did not end `sent`. */
export type ViewSentOutcome = "typed_not_submitted" | "unknown";

/** Why a view reads off although its switch may be on. Served so the phone can say it in Collie's words. */
export const VIEW_OFF_REASONS = ["switch", "trick_off"] as const;
export type ViewOffReason = (typeof VIEW_OFF_REASONS)[number];

/** One view: one trick's view of one session. */
export interface TrickViewSession {
  /** The trick id whose manifest lists `agent-view`. */
  trick: string;
  /** The session's walky address, the key the hill names a session with. */
  session: string;
  /**
   * Whether the view is on: the person's switch AND the trick's gate (approved at its current hash, on, no
   * new version waiting, still an agent view). A view that reads off serves no screen.
   */
  on: boolean;
  /** Why an `on: false` view is off: the person's switch, or the trick (off, removed, a version waiting). */
  off?: ViewOffReason;
  /** The head the bridge puts in front of a send from this view (`[view:<id> <address>] from operator:`). */
  head?: string;
  /**
   * The tail the bridge appends to a send from this view (`[rules: ...]`). Absent while the session holds
   * the rules (its last `start --rules` carried the trick's rules id): the send then goes with the head alone.
   */
  hint?: string;
  /** The current screen, while the view is on. Absent before the first show, after a clear, and while off. */
  view?: ViewScreen;
  /**
   * The screen was drawn in an earlier conversation of the pane (another harness, another conversation, or
   * a person turn that did not come from the view on a harness that reports no conversation). The phone
   * draws it with no live buttons, and the bridge refuses its taps `stale_view`.
   */
  stale?: true;
  /**
   * A question, a dialog or an answer box shows in the session now: taps wait, and typed text goes to the
   * session as the person's own answer, with no head.
   */
  question?: true;
  /** The agent's `start`, until the next show, a clear, the switch going off, or ten minutes. */
  drawing?: ViewDrawing;
  /** The lines the bridge typed for this view, newest last, at most {@link VIEW_SENT_MAX}. */
  sent?: ViewSent[];
}

/** One view's key: the trick and the session. */
export interface TrickViewKey {
  trick: string;
  session: string;
}

/** What `GET /api/trick-views[?since=<rev>]` answers. */
export interface TrickViewsAnswer {
  /** The views revision. It also rides on the snapshot as `trickViewsRev`. */
  rev: number;
  /** True when the caller's `since` equals `rev`. Then `views` is empty and means nothing. */
  unchanged?: true;
  /**
   * With `since`: only the views that moved after it, and `keys` lists every view the bridge holds, so
   * the phone drops the ones gone. Without `since` every view is here, and `keys` is absent.
   */
  views: TrickViewSession[];
  keys?: TrickViewKey[];
}

/** What the phone sends to `POST /api/trick-views/switch`. */
export interface TrickViewSwitchBody {
  trick: string;
  session: string;
  on: boolean;
}

/**
 * What the phone adds to `POST /api/send` for a send from a view: a tap names the screen's `rev` and the
 * renderer's `control` path of the button (or `choice/<index>` for an option of the decision block); typed
 * text names only the view. The bridge then builds the line itself, from its own stored screen.
 */
export interface ViewSendField {
  trick: string;
  session: string;
  rev?: number;
  control?: string;
}

/** What `parseAgentView` answers: the view when it passed, else every refusal with a pointer under `path`. */
export interface ParsedAgentView {
  view?: View;
  refusals: Refusal[];
  /** The top-level block ids the view named, one per node, null where a node named none. */
  ids?: (string | null)[];
}

/** What `parseAgentView` may know of the screen around the view. */
export interface AgentViewOptions {
  /** How many pictures the screen holds. Given, a `ref` past them is refused; absent, any `ref` from 0 to 3 passes. */
  images?: number;
}

const PROBE_PART_ID = "agent-view";
const PROBE_PREFIX = "/parts/0/view";
/** The path a picture subtree is read under by the Decision parser; its refusals are mapped back. */
const PICTURE_PROBE = "/~picture";
/** The node a picture subtree is swapped for while the part parser reads the rest: valid wherever a picture is. */
const NEUTRAL_NODE: JsonObject = { kind: "spacer" };
/** How deep the picture walk looks. Past the part parser's own depth cap the part parser refuses anyway. */
const PICTURE_WALK_DEPTH = VIEW_LIMITS.depth.max + 1;

/** Map a refusal's pointer inside the probe document onto the caller's own `path`. */
function rebase(refusal: Refusal, path: string): Refusal {
  const inner = refusal.path.startsWith(PROBE_PREFIX) ? refusal.path.slice(PROBE_PREFIX.length) : "";
  return { code: refusal.code, path: `${path}${inner}`, reason: refusal.reason };
}

/** A picture subtree: where it sits (index steps through `kids`) and the raw node. */
interface PictureAt {
  readonly steps: readonly number[];
  readonly node: JsonValue;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The node's `kids` as a JSON list, or undefined. */
function rawKids(node: JsonValue | undefined): JsonValue[] | undefined {
  const obj = asJsonObject(node);
  return obj !== undefined && Array.isArray(obj.kids) ? obj.kids : undefined;
}

/** An `image` that names a picture by `ref` (the Decision form), not a trick file by `src`. */
function isRefImage(node: JsonValue | undefined): boolean {
  const obj = asJsonObject(node);
  return obj?.kind === "image" && asJsonObject(obj.attrs)?.ref !== undefined;
}

/** A picture subtree: an image by `ref`, or a `compare` with at least one such image. A compare of `src` images stays the part's. */
function isPictureNode(node: JsonValue | undefined): boolean {
  if (isRefImage(node)) return true;
  return asJsonObject(node)?.kind === "compare" && (rawKids(node) ?? []).some(isRefImage);
}

/** Every picture subtree of a raw view, outermost only, with its place. Total on any JSON. */
function picturesIn(raw: readonly JsonValue[]): PictureAt[] {
  const found: PictureAt[] = [];
  const walk = (nodes: readonly JsonValue[], steps: readonly number[]): void => {
    if (steps.length >= PICTURE_WALK_DEPTH) return;
    nodes.forEach((node, i) => {
      const at = [...steps, i];
      if (isPictureNode(node)) {
        found.push({ steps: at, node });
        return;
      }
      const kids = rawKids(node);
      if (kids !== undefined) walk(kids, at);
    });
  };
  walk(raw, []);
  return found;
}

/** The JSON pointer of a place under `path`: `/0/kids/2`. */
function pointerOf(path: string, steps: readonly number[]): string {
  return steps.reduce((acc, step, depth) => `${acc}${depth === 0 ? "" : "/kids"}/${String(step)}`, path);
}

/** A raw list with the node at `steps` replaced, every list on the way copied. */
function replacedRaw(nodes: readonly JsonValue[], steps: readonly number[], next: JsonValue): JsonValue[] {
  const [head, ...rest] = steps;
  if (head === undefined) return [...nodes];
  return nodes.map((node, i) => {
    if (i !== head) return node;
    if (rest.length === 0) return next;
    const obj = asJsonObject(node);
    const kids = rawKids(node);
    if (obj === undefined || kids === undefined) return node;
    return { ...obj, kids: replacedRaw(kids, rest, next) };
  });
}

/** A parsed list with the node at `steps` replaced, every list on the way copied. */
function replacedNode(nodes: readonly ViewNode[], steps: readonly number[], next: ViewNode): ViewNode[] {
  const [head, ...rest] = steps;
  if (head === undefined) return [...nodes];
  return nodes.map((node, i) => {
    if (i !== head) return node;
    if (rest.length === 0) return next;
    if (!("kids" in node) || !Array.isArray(node.kids)) return node;
    return Object.assign({}, node, { kids: replacedNode(node.kids, rest, next) });
  });
}

/** Every node of a raw view, kids counted, as far as the walk depth. */
function rawNodeCount(nodes: readonly JsonValue[], depth = 0): number {
  if (depth > PICTURE_WALK_DEPTH) return 0;
  return nodes.reduce<number>((sum, node) => sum + 1 + rawNodeCount(rawKids(node) ?? [], depth + 1), 0);
}

/** Read the view as a trick part's view, through the parser's only public way in. */
function parseAsPart(raw: JsonValue, path: string): ParsedAgentView {
  const doc: JsonValue = { v: DOCUMENT_VERSION, parts: [{ at: "session", id: PROBE_PART_ID, view: raw }] };
  const parsed = parseTrickDocument(doc);
  const refusals = [...parsed.refusals, ...parsed.notes].map((r) => rebase(r, path));
  if (refusals.length > 0) return { refusals };
  const part = parsed.parts[0];
  if (part?.place !== "session") return { refusals: [{ code: "type", path, reason: "The view did not read as a screen." }] };
  return { view: part.part.view, refusals: [] };
}

/** Read one picture subtree with the Decision parser, as a one-node view, its refusals under its own place. */
function parsePicture(picture: PictureAt, path: string, opts: AgentViewOptions): { node?: ViewNode; refusals: Refusal[] } {
  const own = pointerOf(path, picture.steps);
  const probeNode = `${PICTURE_PROBE}/0`;
  const parsed = parseDecisionView([picture.node], PICTURE_PROBE, opts.images === undefined ? {} : { images: opts.images });
  const refusals = parsed.refusals.map((r) => {
    const inner = r.path.startsWith(probeNode) ? r.path.slice(probeNode.length) : "";
    return { code: r.code, path: `${own}${inner}`, reason: r.reason };
  });
  const node = parsed.view?.[0];
  return refusals.length > 0 || node === undefined ? { refusals } : { node, refusals: [] };
}

/**
 * Read an agent view: a list of nodes in a trick part's vocabulary, under the part caps, with pictures
 * by `ref` as a Decision's view takes them. Total: garbage is a refusal, never a throw. Strict: what the
 * tolerant trick read would drop or ignore is refused.
 *
 * The part parser refuses a `ref` and the Decision parser refuses a button, and the schema is not
 * the agent view's to change. So the view is read in two passes over the same JSON: every picture subtree (an
 * `image` with a `ref`, a `compare` holding one) is read alone by the Decision parser, with the screen's
 * picture count, and the rest by the part parser with each picture swapped for a `spacer`, which is
 * valid everywhere a picture is, so every index, path and depth stays. The part's byte and node caps are
 * checked on the ORIGINAL view, which the swap only makes smaller. The view answered holds the original
 * picture nodes in their places.
 */
export function parseAgentView(raw: JsonValue | undefined, path = "/view", opts: AgentViewOptions = {}): ParsedAgentView {
  if (raw === undefined) return { refusals: [{ code: "missing", path, reason: 'A screen needs "view": a list of nodes.' }] };
  if (!Array.isArray(raw)) return parseAsPart(raw, path);
  const split = splitBlockIds(raw, path);
  const parsed = parseNodes(split.nodes, path, opts);
  const refusals = [...split.refusals, ...parsed.refusals];
  if (refusals.length > 0 || parsed.view === undefined) return { refusals };
  const tight = agentViewRefusals(parsed.view, path);
  if (tight.length > 0) return { refusals: tight };
  return { view: parsed.view, refusals: [], ids: split.ids };
}

/** The sentence a button with a `value` is refused with in an agent view (SECURITY S1). */
export const VIEW_NO_VALUE = 'A button in an agent view has no "value": a tap sends its label (and its group\'s label), every word on screen. Put what the tap means in the label.';
/** The sentence a button with `does` is refused with in an agent view (SECURITY N2). */
export const VIEW_NO_DOES = 'A button in an agent view has no "does": a tap only sends its label to this session.';
/** The sentence a link whose text reads as an address other than its own is refused with (SECURITY N1). */
export const VIEW_LINK_TEXT = "A link whose text reads as a web address must show its own address: write the address as the text, or words that are no address.";

/** The dots a browser reads in a host: the full stop, and the ideographic one (U+3002), which NFKC leaves. */
const HOST_DOT = String.raw`[.\u3002]`;
/** One name of a host in any script: letters, digits, marks and the hyphen. */
const HOST_NAME = String.raw`[\p{L}\p{N}\p{M}-]+`;
const ADDRESS_SCHEME = /^[\p{L}][\p{L}\p{N}+.-]*:\/\//u;
const ADDRESS_WWW = new RegExp(`^www${HOST_DOT}`, "u");
const ADDRESS_HOST = new RegExp(`^${HOST_NAME}(?:${HOST_DOT}${HOST_NAME})+(?:[/:?#]\\S*)?$`, "u");

/**
 * Whether a link's text reads as a web address to a person: a scheme, `www.`, or a host with a dot and
 * no blank. Read on the FOLDED text ({@link foldViewLine}: hidden characters out, NFKC, look-alikes
 * folded), so a Cyrillic letter, a fullwidth or an ideographic dot, a zero-width space or a host in
 * another script reads as the address it shows (review 10 W4). The bridge's write and the phone share it.
 */
export function readsAsAddress(text: string): boolean {
  const folded = foldViewLine(text).trim();
  return ADDRESS_SCHEME.test(folded) || ADDRESS_WWW.test(folded) || ADDRESS_HOST.test(folded);
}

/** Why a link, a row or a run whose `href` names a session is refused in an agent view (review 10 W11). */
export const VIEW_WEB_LINKS_ONLY = "A link in an agent view goes to a web address (https) only: it cannot open another session.";

// ── Collie's own words (review 10, the reviewer's accept) ──────────────────────────────────────────

/**
 * The words Collie draws around an agent view, which no text of the agent's may say, so a screen cannot
 * pass for Collie's frame: "From Collie", the band's words, the line over a sent message, the band's lines
 * for a held button, the armed words, and the fold. ONE LIST for the bridge's write and the phone's read
 * (both run {@link parseAgentView} and {@link parseViewChoice}); the web's tests pin that the phone's own
 * strings stay in it. English: the phone draws the frame in the person's language, and a screen in
 * another one is the agent's to write.
 */
export const VIEW_COLLIE_PHRASES = [
  "From Collie",
  "Drawn by this session's agent",
  "Drawn in an earlier conversation",
  "Sent to this session",
  "A question waits in this session",
  "Your typing answers the question",
  "The screen changed",
  "The buttons wait",
  "The agent is working",
  "Tap again to send",
  "Earlier screen",
  "The agent answered in text",
] as const;

/** A text's words, folded as the head rule folds ({@link foldViewLine}), every run of other characters one space, padded. */
function foldedWords(text: string): string {
  return ` ${foldViewLine(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

const COLLIE_PHRASES_FOLDED = VIEW_COLLIE_PHRASES.map((phrase) => ({ phrase, words: foldedWords(phrase) }));

/**
 * The first of Collie's own phrases a text says, or null. Both sides are folded as the head rule folds
 * (hidden characters out, NFKC, lower case, marks out, look-alikes folded), then every run of characters
 * that are not letters or digits becomes one space; a phrase counts as whole words only, so "The screens
 * changed" passes. Collie's bare name is not a phrase: an agent that works on Collie names it. A text with a hidden character is read a second time with each one a
 * blank.
 */
export function collieWordsIn(text: string): string | null {
  // A hidden character is read both ways: dropped (`Col\u200blie` is "Collie") and as a blank (a wide
  // blank, which the shared predicate counts as hidden, still parts two words).
  let blanked = "";
  for (const ch of text) blanked += isHiddenChar(ch) ? " " : ch;
  const reads = [foldedWords(text), foldedWords(blanked)];
  return COLLIE_PHRASES_FOLDED.find((folded) => reads.some((words) => words.includes(folded.words)))?.phrase ?? null;
}

/** Why a text that says Collie's own words is refused. */
export function collieWordsReason(phrase: string): string {
  return `"${phrase}" is Collie's own words: a screen an agent draws cannot say them. Write it another way.`;
}

/** The attributes that hold no words a person reads as a sentence: an address, a picture, a command word. */
const NOT_WORDS = new Set(["href", "src", "ref", "intent"]);

/** Every text of one node a person reads: its `text` and its attributes' words, each with its pointer. */
function wordsOfNode(node: ViewNode, here: string): { readonly text: string; readonly path: string }[] {
  const out: { text: string; path: string }[] = [];
  const text = "text" in node ? asJsonString(node.text) : undefined;
  if (text !== undefined) out.push({ text, path: `${here}/text` });
  const attrs = "attrs" in node && node.attrs !== undefined ? Object.entries(node.attrs) : [];
  for (const [key, value] of attrs) {
    const words = NOT_WORDS.has(key) ? undefined : asJsonString(value);
    if (words !== undefined) out.push({ text: words, path: `${here}/attrs/${key}` });
  }
  return out;
}

/** Whether a tap word (a label, a group's label) is one line of shown characters. */
function shownLine(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f-\u009f]/u.test(text) && !hasHiddenChar(text);
}

/**
 * What an agent view refuses beyond a trick part (SECURITY S1, N1, N2, rule 3): a button's `value` and
 * `does`, a button or a group label that is not one line of shown characters or is longer than a tap sends,
 * and a link (or a linked run) whose text reads as another address than its own. Pointers under `path`.
 */
function agentViewRefusals(view: View, path: string): Refusal[] {
  const out: Refusal[] = [];
  const walk = (nodes: readonly ViewNode[], at: string): void => {
    nodes.forEach((node, i) => {
      const here = `${at}/${String(i)}`;
      if (node.kind === "button") {
        if (node.attrs.pressed !== undefined) out.push({ code: "unknown-key", path: `${here}/attrs/pressed`, reason: VIEW_NO_PRESSED });
        if (node.attrs.value !== undefined) out.push({ code: "unknown-key", path: `${here}/attrs/value`, reason: VIEW_NO_VALUE });
        if (node.attrs.does !== undefined) out.push({ code: "unknown-key", path: `${here}/attrs/does`, reason: VIEW_NO_DOES });
        if (!shownLine(node.attrs.label) || node.attrs.label.trim().length > VIEW_TAP_LABEL_MAX) out.push({ code: "text", path: `${here}/attrs/label`, reason: `A button's label is one line of shown characters, at most ${String(VIEW_TAP_LABEL_MAX)}.` });
      }
      if (node.kind === "group" && node.attrs?.label !== undefined && (!shownLine(node.attrs.label) || node.attrs.label.trim().length > VIEW_TAP_GROUP_MAX)) {
        out.push({ code: "text", path: `${here}/attrs/label`, reason: `A group's label in an agent view is one line of shown characters, at most ${String(VIEW_TAP_GROUP_MAX)}: a tap inside it sends it.` });
      }
      for (const words of wordsOfNode(node, here)) {
        const phrase = collieWordsIn(words.text);
        if (phrase !== null) out.push({ code: "text", path: words.path, reason: collieWordsReason(phrase) });
      }
      const href = node.kind === "link" ? node.attrs.href : node.kind === "row" || node.kind === "run" ? node.attrs?.href : undefined;
      if (href !== undefined && !isTrickUrl(href)) out.push({ code: "text", path: `${here}/attrs/href`, reason: VIEW_WEB_LINKS_ONLY });
      if (node.kind === "link" && readsAsAddress(node.text) && node.text.trim() !== node.attrs.href) out.push({ code: "text", path: `${here}/text`, reason: VIEW_LINK_TEXT });
      if (node.kind === "run" && node.attrs?.href !== undefined && readsAsAddress(node.text) && node.text.trim() !== node.attrs.href) out.push({ code: "text", path: `${here}/text`, reason: VIEW_LINK_TEXT });
      if ("kids" in node && Array.isArray(node.kids)) walk(node.kids, `${here}/kids`);
    });
  };
  walk(view, path);
  return out;
}

/** A label quoted for a tap line: `"` and `\` escaped, so a label cannot close the quote or forge a part. */
export function quoteTapWord(text: string): string {
  return `"${text.replace(/[\\"]/gu, (ch) => `\\${ch}`)}"`;
}

/** A group's label around a control, nearest first, or null. */
function groupLabelAt(view: View, steps: readonly number[]): string | null {
  let list: readonly ViewNode[] = view;
  let label: string | null = null;
  for (const step of steps) {
    const node: ViewNode | undefined = list[step];
    if (node === undefined) return label;
    const own = node.kind === "group" ? (node.attrs?.label?.trim() ?? "") : "";
    if (own !== "") label = own;
    list = "kids" in node && Array.isArray(node.kids) ? node.kids : [];
  }
  return label;
}

/** The node at a renderer control path (`v/0/2/1`) and its steps, or null when the path names none. */
function nodeAt(view: View, control: string): { node: ViewNode; steps: number[] } | null {
  const parts = control.split("/");
  if (parts[0] !== "v" || parts.length < 2 || parts.length > VIEW_LIMITS.depth.max + 2) return null;
  const steps: number[] = [];
  let list: readonly ViewNode[] = view;
  let node: ViewNode | undefined;
  for (const part of parts.slice(1)) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const step = Number(part);
    node = list[step];
    if (node === undefined) return null;
    steps.push(step);
    list = "kids" in node && Array.isArray(node.kids) ? node.kids : [];
  }
  return node === undefined ? null : { node, steps };
}

/** The largest control path a tap names, in characters. */
export const VIEW_CONTROL_MAX = 64;

/**
 * The words a tap sends, built by the bridge from ITS stored screen: `tapped "<label>"`, with
 * ` in "<group>"` when the button sits in a labelled group, for a button at the renderer's control path
 * (`v/0/2/1`); `picked "<label>"` for an option of the decision block (`choice/<index>`). Labels are quoted
 * by {@link quoteTapWord} and capped. Null when the control names no button or option a tap could reach:
 * a disabled button, a settled choice, a pending block, a label that is no line of shown characters.
 */
export function viewTapWords(screen: Pick<ViewScreen, "view" | "choice" | "picks">, control: string): string | null {
  if (control.length > VIEW_CONTROL_MAX) return null;
  const pick = /^choice\/(\d{1,2})$/u.exec(control);
  if (pick !== null) {
    const choice = screen.choice;
    const option = choice?.options[Number(pick[1])];
    if (choice === undefined || option === undefined || choicePick(screen) !== null) return null;
    const label = option.label.trim();
    if (label === "" || !shownLine(label) || label.length > VIEW_TAP_LABEL_MAX) return null;
    return `picked ${quoteTapWord(label)}`;
  }
  const at = nodeAt(screen.view, control);
  if (at?.node.kind !== "button") return null;
  const { attrs } = at.node;
  if (attrs.disabled !== undefined) return null;
  const label = attrs.label.trim();
  if (label === "" || !shownLine(label) || label.length > VIEW_TAP_LABEL_MAX) return null;
  const group = groupLabelAt(screen.view, at.steps);
  const groupOk = group !== null && shownLine(group) && group.length <= VIEW_TAP_GROUP_MAX;
  if (group !== null && !groupOk) return null;
  return group === null ? `tapped ${quoteTapWord(label)}` : `tapped ${quoteTapWord(label)} in ${quoteTapWord(group)}`;
}

/** The top-level nodes without their `id`, the ids in order, and a refusal for each id off its pattern or named twice. */
/** A view's top-level nodes split from their block ids. */
interface SplitBlockIds {
  nodes: JsonValue[];
  ids: (string | null)[];
  refusals: Refusal[];
}

function splitBlockIds(raw: readonly JsonValue[], path: string): SplitBlockIds {
  const refusals: Refusal[] = [];
  const ids: (string | null)[] = [];
  const nodes = raw.map((node, i) => {
    const obj = asJsonObject(node);
    if (obj === undefined || obj.id === undefined) {
      ids.push(null);
      return node;
    }
    const { id: rawId, ...rest } = obj;
    const id = asJsonString(rawId);
    const at = `${path}/${String(i)}/id`;
    const isBad = id === undefined || !VIEW_BLOCK_ID_RE.test(id) || id === VIEW_CHOICE_BLOCK;
    if (isBad) refusals.push({ code: "id", path: at, reason: `A block id is 1 to 32 of a-z, 0-9 and -, and not "${VIEW_CHOICE_BLOCK}".` });
    if (!isBad && ids.includes(id)) refusals.push({ code: "duplicate", path: at, reason: `Two blocks share the id "${id}".` });
    ids.push(id ?? null);
    return rest;
  });
  return { nodes, ids, refusals };
}

/** A view's nodes, ids already stripped: pictures by the Decision parser, the rest by the part parser. */
function parseNodes(raw: JsonValue[], path: string, opts: AgentViewOptions): ParsedAgentView {
  const pictures = picturesIn(raw);
  if (pictures.length === 0) return parseAsPart(raw, path);
  const refusals: Refusal[] = [];
  const bytes = utf8Length(JSON.stringify(raw));
  if (bytes > PART_MAX_BYTES) refusals.push({ code: "size", path, reason: `The view is ${String(bytes)} bytes. A screen holds at most ${String(PART_MAX_BYTES / 1024)} KiB of compact JSON.` });
  const nodes = rawNodeCount(raw);
  if (nodes > VIEW_LIMITS.nodes.max) refusals.push({ code: "count", path, reason: `The view holds ${String(nodes)} nodes. A screen holds at most ${String(VIEW_LIMITS.nodes.max)}.` });
  const read = pictures.map((picture) => ({ picture, ...parsePicture(picture, path, opts) }));
  const swapped = pictures.reduce<JsonValue[]>((list, picture) => replacedRaw(list, picture.steps, NEUTRAL_NODE), raw);
  const rest = parseAsPart(swapped, path);
  refusals.push(...rest.refusals, ...read.flatMap((r) => r.refusals));
  if (refusals.length > 0 || rest.view === undefined) return { refusals };
  let view: View = rest.view;
  for (const r of read) {
    if (r.node === undefined) return { refusals: [{ code: "type", path: pointerOf(path, r.picture.steps), reason: "The picture did not read." }] };
    view = replacedNode(view, r.picture.steps, r.node);
  }
  return { view, refusals: [] };
}

// ── the decision block ───────────────────────────────────────────────────────────────────────

/** What `parseViewChoice` answers: the block when it passed, else every refusal with a pointer under `path`. */
export interface ParsedViewChoice {
  choice?: ViewChoice;
  refusals: Refusal[];
}

const CHOICE_KEYS = ["question", "options", "recommends"] as const;
const OPTION_KEYS = ["label", "detail", "confirm", "preview"] as const;
const RECOMMENDS_KEYS = ["option", "why"] as const;

/** Keys of an object outside `allowed`, each refused once. */
function unknownKeys(obj: JsonObject, allowed: readonly string[], path: string, what: string): Refusal[] {
  return Object.keys(obj)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({ code: "unknown-key" as const, path: `${path}/${key}`, reason: `${what} takes ${allowed.map((k) => `"${k}"`).join(", ")}, not "${key}".` }));
}

/** A text field as read: its clean line, its refusal, or neither when it is absent. */
interface LineRead {
  value?: string;
  refusal?: Refusal;
}

/** An option as read: the option when it passed, else its refusals. */
interface OptionRead {
  option?: ViewOption;
  refusals: Refusal[];
}

/** One line of 1 to `max` characters once trimmed, or the refusal. Absent reads as undefined. */
function lineField(obj: JsonObject, key: string, max: number, path: string, what: string): LineRead {
  const raw = obj[key];
  if (raw === undefined) return {};
  const text = asJsonString(raw);
  const line = text === undefined ? null : cleanViewLine(text, max);
  if (line === null) return { refusal: { code: "text", path: `${path}/${key}`, reason: `${what} is one line of 1 to ${String(max)} characters.` } };
  return { value: line };
}

/** A whole number from 0 below `count`, or null. */
function indexBelow(value: JsonValue | undefined, count: number): number | null {
  const n = asJsonNumber(value);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 && n < count ? n : null;
}

function readOption(raw: JsonValue | undefined, path: string, images: number): OptionRead {
  const obj = asJsonObject(raw);
  if (obj === undefined) return { refusals: [{ code: "type", path, reason: 'An option is an object: { "label", "detail"?, "confirm"?, "preview"? }.' }] };
  const refusals = unknownKeys(obj, OPTION_KEYS, path, "An option");
  const label = lineField(obj, "label", HILL_OPTION_LABEL_MAX, path, "An option's label");
  if (obj.label === undefined) refusals.push({ code: "missing", path: `${path}/label`, reason: `An option needs "label", 1 to ${String(HILL_OPTION_LABEL_MAX)} characters.` });
  const detail = lineField(obj, "detail", HILL_OPTION_DETAIL_MAX, path, "An option's detail");
  const confirm = lineField(obj, "confirm", HILL_OPTION_CONFIRM_MAX, path, "An option's confirm word");
  for (const field of [label, detail, confirm]) if (field.refusal !== undefined) refusals.push(field.refusal);
  for (const [key, field] of [["label", label], ["detail", detail], ["confirm", confirm]] as const) {
    const phrase = field.value === undefined ? null : collieWordsIn(field.value);
    if (phrase !== null) refusals.push({ code: "text", path: `${path}/${key}`, reason: collieWordsReason(phrase) });
  }
  if (label.value !== undefined && !shownLine(label.value)) refusals.push({ code: "text", path: `${path}/label`, reason: "An option's label is one line of shown characters: a pick sends it." });
  const preview = obj.preview === undefined ? undefined : indexBelow(obj.preview, images);
  if (preview === null) {
    const held = images === 0 ? "the screen holds no pictures; add one with --image" : `0 to ${String(images - 1)}`;
    refusals.push({ code: "range", path: `${path}/preview`, reason: `"preview" is a picture ref, a whole number: ${held}.` });
  }
  if (refusals.length > 0 || label.value === undefined) return { refusals };
  const option: ViewOption = { label: label.value };
  if (detail.value !== undefined) option.detail = detail.value;
  if (confirm.value !== undefined) option.confirm = confirm.value;
  if (preview !== undefined && preview !== null) option.preview = preview;
  return { option, refusals: [] };
}

/**
 * Read a decision block: `{ question?, options: [1 to 5], recommends? }`, with the hill's option caps.
 * `images` is how many pictures the screen holds: an option's `preview` must name one. Total and strict,
 * as {@link parseAgentView}: an unknown key is refused, a text past its cap is refused, never cut.
 */
export function parseViewChoice(raw: JsonValue | undefined, path = "/choice", { images }: { images: number }): ParsedViewChoice {
  const obj = asJsonObject(raw);
  if (obj === undefined) return { refusals: [{ code: "type", path, reason: 'A choice is an object: { "question"?, "options": [...], "recommends"? }.' }] };
  // `picked` is Collie's to mark (review 10 W7): refused in its own words, not as an unknown key.
  const refusals = unknownKeys(obj, [...CHOICE_KEYS, "picked"], path, "A choice");
  if (obj.picked !== undefined) refusals.push({ code: "unknown-key", path: `${path}/picked`, reason: VIEW_NO_PICKED });
  const question = lineField(obj, "question", VIEW_QUESTION_MAX, path, "A choice's question");
  if (question.refusal !== undefined) refusals.push(question.refusal);
  const asked = question.value === undefined ? null : collieWordsIn(question.value);
  if (asked !== null) refusals.push({ code: "text", path: `${path}/question`, reason: collieWordsReason(asked) });
  const list = Array.isArray(obj.options) ? obj.options : null;
  if (list === null || list.length < 1 || list.length > VIEW_OPTIONS_MAX) {
    refusals.push({ code: "count", path: `${path}/options`, reason: `A choice has 1 to ${String(VIEW_OPTIONS_MAX)} options.` });
    return { refusals };
  }
  const options: ViewOption[] = [];
  list.forEach((item, i) => {
    const read = readOption(item, `${path}/options/${String(i)}`, images);
    refusals.push(...read.refusals);
    if (read.option === undefined) return;
    if (options.some((other) => other.label === read.option?.label)) {
      refusals.push({ code: "duplicate", path: `${path}/options/${String(i)}/label`, reason: `Two options share the label "${read.option.label}"; the pick is sent by its label.` });
    }
    options.push(read.option);
  });
  const recommends = obj.recommends === undefined ? undefined : readRecommends({ raw: obj.recommends, path: `${path}/recommends`, options: list.length, refusals });
  if (refusals.length > 0) return { refusals };
  const choice: ViewChoice = { options };
  if (question.value !== undefined) choice.question = question.value;
  if (recommends !== undefined) choice.recommends = recommends;
  return { choice, refusals: [] };
}

/** A choice's `recommends`: `{ option, why? }`, its refusals pushed onto `refusals`; undefined when it did not pass. */
function readRecommends({ raw, path, options, refusals }: { raw: JsonValue; path: string; options: number; refusals: Refusal[] }): ViewChoice["recommends"] {
  const rec = asJsonObject(raw);
  if (rec === undefined) {
    refusals.push({ code: "type", path, reason: 'A recommendation is { "option": <index>, "why"? }.' });
    return undefined;
  }
  refusals.push(...unknownKeys(rec, RECOMMENDS_KEYS, path, "A recommendation"));
  const option = indexBelow(rec.option, options);
  if (option === null) refusals.push({ code: "range", path: `${path}/option`, reason: `"option" is an option's index, 0 to ${String(options - 1)}.` });
  const why = lineField(rec, "why", HILL_WHY_MAX, path, "The why");
  if (why.refusal !== undefined) refusals.push(why.refusal);
  const said = why.value === undefined ? null : collieWordsIn(why.value);
  if (said !== null) refusals.push({ code: "text", path: `${path}/why`, reason: collieWordsReason(said) });
  if (option === null) return undefined;
  return why.value === undefined ? { option } : { option, why: why.value };
}

// ── pictures ─────────────────────────────────────────────────────────────────────────────────

/** A picture's side off its header: a whole number above 0, or null when the bridge could not read it. Undefined: it does not fit. */
function sideOf(value: JsonValue | undefined): number | null | undefined {
  if (value === null) return null;
  const n = asJsonNumber(value);
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** One stored or served picture, or null when any field does not fit. */
export function readViewMedia(raw: JsonValue | undefined): ViewMedia | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  const id = asJsonString(obj.id);
  const mime = HILL_MEDIA_MIMES.find((m) => m === obj.mime);
  const bytes = asJsonNumber(obj.bytes);
  if (id === undefined || !VIEW_MEDIA_ID_RE.test(id) || obj.kind !== "image" || mime === undefined) return null;
  if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > VIEW_MEDIA_BYTES_MAX) return null;
  const width = sideOf(obj.width);
  const height = sideOf(obj.height);
  if (width === undefined || height === undefined) return null;
  const media: ViewMedia = { id, kind: "image", mime, bytes, width, height };
  if (obj.caption === undefined) return media;
  const caption = asJsonString(obj.caption);
  if (caption === undefined || cleanViewLine(caption, VIEW_CAPTION_MAX) !== caption) return null;
  media.caption = caption;
  return media;
}

/** A stored or served picture set: `{ set, media }` both, or neither. Null when it does not fit. */
function readViewSet(obj: JsonObject): { set: string; media: ViewMedia[] } | "none" | null {
  if (obj.set === undefined && obj.media === undefined) return "none";
  const set = asJsonString(obj.set);
  if (set === undefined || !VIEW_SET_RE.test(set) || !Array.isArray(obj.media)) return null;
  if (obj.media.length < 1 || obj.media.length > VIEW_MEDIA_MAX) return null;
  const media = obj.media.map(readViewMedia);
  if (media.some((m) => m === null)) return null;
  return { set, media: media.filter((m): m is ViewMedia => m !== null) };
}

/** One line, trimmed, no control character. Null when it is empty or longer than `max`. */
export function cleanViewLine(text: string, max: number): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  const line = text.trim();
  if (line.length === 0 || line.length > max) return null;
  return line;
}

function isRev(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTime(text: string): boolean {
  return Number.isFinite(Date.parse(text));
}

function isSessionKey(text: string | undefined): text is string {
  return text !== undefined && cleanViewLine(text, VIEW_SESSION_MAX) === text;
}

/** One stored or served block, or null when a field does not fit. */
function readViewBlock(raw: JsonValue | undefined): ViewBlock | null {
  const obj = asJsonObject(raw);
  const id = asJsonString(obj?.id);
  const at = asJsonString(obj?.at);
  if (obj === undefined || id === undefined || !VIEW_BLOCK_ID_RE.test(id) || id === VIEW_CHOICE_BLOCK || at === undefined || !isIsoTime(at)) return null;
  if (obj.pending === undefined) return { id, at };
  const pending = asJsonString(obj.pending);
  if (pending === undefined || cleanViewLine(pending, VIEW_PENDING_MAX) !== pending) return null;
  return { id, at, pending };
}

/** A view's blocks: one per node, unique ids. Null when the list does not fit the view. */
function readViewBlocks(raw: JsonValue, length: number): ViewBlock[] | null {
  if (!Array.isArray(raw) || raw.length !== length) return null;
  const blocks = raw.map(readViewBlock);
  if (blocks.some((block) => block === null)) return null;
  const kept = blocks.filter((block): block is ViewBlock => block !== null);
  return new Set(kept.map((block) => block.id)).size === kept.length ? kept : null;
}

/** A screen's blocks: the wire's, or `b1`, `b2`… stamped at the screen's own time for a screen stored before blocks. */
export function viewBlocksOf(view: ViewScreen): ViewBlock[] {
  return view.blocks ?? view.view.map((_, i) => ({ id: `b${String(i + 1)}`, at: view.at }));
}

/** The first `b<n>` id none of `taken` holds. Of `b1` to `b<size + 1>` at least one is free. */
export function nextBlockId(taken: ReadonlySet<string>): string {
  const free = Array.from({ length: taken.size + 1 }, (_, i) => `b${String(i + 1)}`).find((id) => !taken.has(id));
  if (free === undefined) throw new Error("agent view: no free block id among size + 1 candidates");
  return free;
}

/** A stored or served view, or null when any field does not fit. */
export function readViewScreen(raw: JsonValue | undefined): ViewScreen | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  const rev = asJsonNumber(obj.rev);
  const at = asJsonString(obj.at);
  if (!isRev(rev) || at === undefined || !isIsoTime(at)) return null;
  const pictures = readViewSet(obj);
  if (pictures === null) return null;
  const images = pictures === "none" ? 0 : pictures.media.length;
  const parsed = parseAgentView(obj.view, "/view", { images });
  if (parsed.view === undefined) return null;
  const out: ViewScreen = { rev, at, view: parsed.view };
  if (pictures !== "none") {
    out.set = pictures.set;
    out.media = pictures.media;
  }
  if (obj.choice !== undefined) {
    const choice = parseViewChoice(obj.choice, "/choice", { images });
    if (choice.choice === undefined) return null;
    out.choice = choice.choice;
    const choiceAt = obj.choiceAt === undefined ? at : asJsonString(obj.choiceAt);
    if (choiceAt === undefined || !isIsoTime(choiceAt)) return null;
    out.choiceAt = choiceAt;
  }
  if (obj.blocks !== undefined) {
    const blocks = readViewBlocks(obj.blocks, parsed.view.length);
    if (blocks === null) return null;
    out.blocks = blocks;
  }
  if (obj.picks !== undefined) {
    const picks = readViewPicks(obj.picks);
    if (picks === null) return null;
    // A pick that names no button or option of this screen is no mark: dropped, never drawn.
    const kept = picks.filter((pick) => pickFits(out, pick));
    if (kept.length > 0) out.picks = kept;
  }
  if (obj.title === undefined) return out;
  const title = asJsonString(obj.title);
  if (title === undefined || cleanViewLine(title, VIEW_TITLE_MAX) !== title) return null;
  out.title = title;
  return out;
}

/**
 * An address as one shell word: bare when its characters are safe, in single quotes when not, null when
 * it cannot be quoted (an empty text, a control character or a quote). The tail and `trick view <id> help` print
 * it so a line can be copied as it stands.
 */
export function viewShellWord(address: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (address === "" || /[\u0000-\u001f\u007f']/u.test(address)) return null;
  return /^[\w./:%@+=,-]+(#[\w./:%@+=,-]*)*$/u.test(address) ? address : `'${address}'`;
}

/** A stored or served drawing mark, or null when any field does not fit. */
export function readViewDrawing(raw: JsonValue | undefined): ViewDrawing | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  const at = asJsonString(obj.at);
  if (at === undefined || !isIsoTime(at)) return null;
  const out: ViewDrawing = { at };
  if (obj.note !== undefined) {
    const note = asJsonString(obj.note);
    if (note === undefined || cleanViewLine(note, VIEW_NOTE_MAX) !== note) return null;
    out.note = note;
  }
  // Notes that do not fit are left out, one by one: the drawing stays, as a view does in a session.
  const notes = Array.isArray(obj.notes) ? obj.notes.slice(-VIEW_NOTES_MAX).flatMap((item) => readViewNote(item) ?? []) : [];
  if (notes.length > 0) out.notes = notes;
  return out;
}

function readViewNote(raw: JsonValue | undefined): ViewNote | null {
  const obj = asJsonObject(raw);
  const at = asJsonString(obj?.at);
  const note = asJsonString(obj?.note);
  if (at === undefined || !isIsoTime(at) || note === undefined || cleanViewLine(note, VIEW_NOTE_MAX) !== note) return null;
  return { at, note };
}

/** Whether a text is a trick id a view may be keyed by. */
function isViewTrick(text: string | undefined): text is string {
  return text !== undefined && isTrickId(text);
}

/** One sent line, or null when a field does not fit. */
function readViewSent(raw: JsonValue | undefined): ViewSent | null {
  const obj = asJsonObject(raw);
  const rid = asJsonString(obj?.rid);
  const at = asJsonString(obj?.at);
  const line = asJsonString(obj?.line);
  const kind = obj?.kind === "tap" || obj?.kind === "text" ? obj.kind : undefined;
  if (rid === undefined || rid === "" || rid.length > 128 || at === undefined || !isIsoTime(at) || kind === undefined) return null;
  if (line === undefined || line === "" || line.length > VIEW_SENT_LINE_MAX) return null;
  const outcome = obj?.outcome === "typed_not_submitted" || obj?.outcome === "unknown" ? obj.outcome : undefined;
  const sent: ViewSent = outcome === undefined ? { rid, at, kind, line } : { rid, at, kind, line, outcome };
  if (obj?.about === undefined) return sent;
  const about = asJsonString(obj.about);
  if (about === undefined || cleanViewLine(about, VIEW_QUESTION_MAX) !== about) return null;
  return { ...sent, about };
}

/** What a tap at `control` answered on `screen` (review 10 W8): a pick's question, else the screen's title; null for none. */
export function tapAbout(screen: Pick<ViewScreen, "choice" | "title">, control: string): string | null {
  if (control.startsWith("choice/")) return screen.choice?.question ?? screen.title ?? null;
  return screen.title ?? null;
}

/** A view's sent lines: the ones that fit, newest last, at most {@link VIEW_SENT_MAX}. */
export function readViewSentList(raw: JsonValue | undefined): ViewSent[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-VIEW_SENT_MAX).flatMap((item) => readViewSent(item) ?? []);
}

/**
 * One view, or null when its key, switch or a given hint does not fit. A screen that does not fit is left
 * out and the view kept: the switch still reads, and the phone shows no screen rather than half of one.
 */
export function readTrickViewSession(raw: JsonValue | undefined): TrickViewSession | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  const trick = asJsonString(obj.trick);
  const session = asJsonString(obj.session);
  const on = asJsonBoolean(obj.on);
  if (!isViewTrick(trick) || !isSessionKey(session) || on === undefined) return null;
  const out: TrickViewSession = { trick, session, on };
  const off = VIEW_OFF_REASONS.find((reason) => reason === obj.off);
  if (off !== undefined && !on) out.off = off;
  // No hint is a session that holds the rules; a hint that does not fit drops the view.
  if (obj.hint !== undefined) {
    const hint = asJsonString(obj.hint);
    if (hint === undefined || cleanViewLine(hint, VIEW_HINT_MAX) !== hint) return null;
    out.hint = hint;
  }
  // A head that does not fit is left out: the phone then sends no view field.
  const head = obj.head === undefined ? undefined : asJsonString(obj.head);
  if (head !== undefined && cleanViewLine(head, VIEW_HEAD_MAX) === head) out.head = head;
  const view = obj.view === undefined ? null : readViewScreen(obj.view);
  if (view !== null) out.view = view;
  if (obj.stale === true) out.stale = true;
  if (obj.question === true) out.question = true;
  // A drawing that does not fit is left out, as a view is: the session stays.
  const drawing = obj.drawing === undefined ? null : readViewDrawing(obj.drawing);
  if (drawing !== null) out.drawing = drawing;
  const sent = readViewSentList(obj.sent);
  if (sent.length > 0) out.sent = sent;
  return out;
}

/** One view key, or null. */
function readViewKey(raw: JsonValue | undefined): TrickViewKey | null {
  const obj = asJsonObject(raw);
  const trick = asJsonString(obj?.trick);
  const session = asJsonString(obj?.session);
  return isViewTrick(trick) && isSessionKey(session) ? { trick, session } : null;
}

/** The read route's answer, or null when its rev or list does not fit. A view that does not fit is dropped. */
export function readTrickViewsAnswer(raw: JsonValue | undefined): TrickViewsAnswer | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  const rev = asJsonNumber(obj.rev);
  if (!isRev(rev)) return null;
  if (obj.unchanged === true) return { rev, unchanged: true, views: [] };
  if (!Array.isArray(obj.views)) return null;
  const views: TrickViewSession[] = [];
  for (const item of obj.views) {
    const view = readTrickViewSession(item);
    if (view !== null) views.push(view);
  }
  if (obj.keys === undefined) return { rev, views };
  if (!Array.isArray(obj.keys)) return null;
  return { rev, views, keys: obj.keys.flatMap((key) => readViewKey(key) ?? []) };
}

/** The switch body, or null when it is not exactly `{ trick, session, on }`. */
export function readTrickViewSwitchBody(raw: JsonValue | undefined): TrickViewSwitchBody | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  if (Object.keys(obj).some((key) => key !== "trick" && key !== "session" && key !== "on")) return null;
  const trick = asJsonString(obj.trick);
  const session = asJsonString(obj.session);
  const on = asJsonBoolean(obj.on);
  if (!isViewTrick(trick) || !isSessionKey(session) || on === undefined) return null;
  return { trick, session, on };
}

/**
 * The `view` field of a send, or null when it is not exactly `{ trick, session }` (typed text) or
 * `{ trick, session, rev, control }` (a tap). Undefined when the send carries none.
 */
export function readViewSendField(raw: JsonValue | undefined): ViewSendField | null | undefined {
  if (raw === undefined) return undefined;
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  if (Object.keys(obj).some((key) => key !== "trick" && key !== "session" && key !== "rev" && key !== "control")) return null;
  const trick = asJsonString(obj.trick);
  const session = asJsonString(obj.session);
  if (!isViewTrick(trick) || !isSessionKey(session)) return null;
  if (obj.rev === undefined && obj.control === undefined) return { trick, session };
  const rev = asJsonNumber(obj.rev);
  const control = asJsonString(obj.control);
  if (!isRev(rev) || control === undefined || control === "" || control.length > VIEW_CONTROL_MAX) return null;
  return { trick, session, rev, control };
}

// ── picks Collie marks (review 10 W7) ───────────────────────────────────────────────────────────────

/** One stored or served pick, or null when a field does not fit. */
function readViewPick(raw: JsonValue): ViewPick | null {
  const obj = asJsonObject(raw);
  const block = asJsonString(obj?.block);
  const path = asJsonString(obj?.path);
  if (block === undefined || path === undefined || !VIEW_BLOCK_ID_RE.test(block) || !PICK_PATH_RE.test(path)) return null;
  return { block, path };
}

/** A screen's picks, or null when the list does not fit. */
function readViewPicks(raw: JsonValue): ViewPick[] | null {
  if (!Array.isArray(raw) || raw.length > VIEW_PICKS_MAX) return null;
  const picks = raw.map(readViewPick);
  return picks.some((pick) => pick === null) ? null : picks.filter((pick): pick is ViewPick => pick !== null);
}

/** The node at `path`'s steps under `node`, or undefined. */
function nodeUnder(node: ViewNode, path: string): ViewNode | undefined {
  let at: ViewNode | undefined = node;
  for (const step of path.split("/")) {
    const kids: readonly ViewNode[] = at !== undefined && "kids" in at && Array.isArray(at.kids) ? at.kids : [];
    at = kids[Number(step)];
  }
  return at;
}

/** Whether a pick names a button of the screen (its block by id) or an option of its decision block. */
export function pickFits(screen: Pick<ViewScreen, "view" | "choice" | "blocks" | "at">, pick: ViewPick): boolean {
  if (pick.block === VIEW_CHOICE_BLOCK) return screen.choice?.options[Number(pick.path)] !== undefined && /^\d{1,2}$/u.test(pick.path);
  const index = viewBlocksOf({ ...screen, rev: 0 }).findIndex((block) => block.id === pick.block);
  const node = index < 0 ? undefined : screen.view[index];
  return node !== undefined && nodeUnder(node, pick.path)?.kind === "button";
}

/** The decision block's marked option, or null. */
export function choicePick(screen: Pick<ViewScreen, "picks">): number | null {
  const pick = screen.picks?.find((held) => held.block === VIEW_CHOICE_BLOCK);
  return pick === undefined ? null : Number(pick.path);
}

/** The pick a tap at a control names on a screen (`v/2/0` → the third block, `0`; `choice/1`), or null. */
export function pickOfControl(screen: Pick<ViewScreen, "view" | "blocks" | "at">, control: string): ViewPick | null {
  const option = /^choice\/(\d{1,2})$/u.exec(control);
  if (option !== null) return { block: VIEW_CHOICE_BLOCK, path: option[1] ?? "" };
  const steps = /^v\/(\d{1,3})\/(\d{1,3}(?:\/\d{1,3}){0,7})$/u.exec(control);
  if (steps === null) return null;
  const block = viewBlocksOf({ ...screen, rev: 0 })[Number(steps[1])];
  return block === undefined ? null : { block: block.id, path: steps[2] ?? "" };
}

/** The bar a pick sits in: its block and its parent's steps. Two picks in one bar: the newer stays. */
function barOf(pick: ViewPick): string {
  const slash = pick.path.lastIndexOf("/");
  return pick.block === VIEW_CHOICE_BLOCK ? VIEW_CHOICE_BLOCK : `${pick.block}#${slash < 0 ? "" : pick.path.slice(0, slash)}`;
}

/** The picks after one more: the others of its bar (or the decision block's) go, the cap holds, the newest last. */
export function picksWith(held: readonly ViewPick[] | undefined, pick: ViewPick): ViewPick[] {
  const bar = barOf(pick);
  return [...(held ?? []).filter((other) => barOf(other) !== bar), pick].slice(-VIEW_PICKS_MAX);
}

/** Whether two decision blocks ask the same: the same question and the same option labels in order. */
function sameDecision(a: ViewChoice | undefined, b: ViewChoice | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.question === b.question && a.options.length === b.options.length && a.options.every((option, i) => option.label === b.options[i]?.label);
}

/**
 * The picks a new screen keeps from the one it replaces (review 10 W7): a button's while a block of the
 * same id still holds a button at the same steps (the agent redrew that block, or another one); the
 * decision block's while it asks the same question with the same options. A block removed, or drawn
 * under a new id, or a new decision, shows no mark.
 */
export function carriedPicks(held: Pick<ViewScreen, "picks" | "choice"> | undefined, next: Pick<ViewScreen, "view" | "choice" | "blocks" | "at">): ViewPick[] {
  return (held?.picks ?? []).filter((pick) => pickFits(next, pick) && (pick.block !== VIEW_CHOICE_BLOCK || sameDecision(held?.choice, next.choice)));
}
