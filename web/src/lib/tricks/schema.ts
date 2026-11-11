// Collie tricks, the schema: every type a trick reads or writes, and the one total parser for each
// document that crosses the line between a trick and Collie (the "Collie tricks" milestone, M94).
//
// WHAT CROSSES. Four documents, each versioned or closed:
//   * the manifest, `trick.toml` after the TOML parse (`parseManifest`);
//   * the facts, the JSON the bridge writes to the program's stdin (`parseFacts`, for the CLI's
//     fixture check; the bridge builds them, it does not parse them);
//   * the output, the JSON the program prints (`parseTrickDocument`, `parseTrickDocumentText`):
//     the parts it draws and the decisions it wants open on the Hill;
//   * a tap, the body the phone posts (`parseTapRequest`), in the Tree UI's intent shape.
// The wire between the bridge and the phone (`TricksReply`, `TrickTapReply`) is types only: the bridge
// writes it from parts this file already accepted.
//
// THE VOCABULARY IS TREE UI'S (the re-cut of 2026-11-08). A part's `view` is a list of nodes in the
// Tree UI vocabulary (experiments/tree-ui/VOCABULARY.md, draft 4), a closed subset of its kinds with
// its kind names, its attribute names and its value lists, plus one kind of its own, `number`. A node
// is `{ kind, text?, attrs?, kids? }` and every attribute value is text, as in the tree. So a trick
// draws the same whether the shell is React (today) or the tree (later): a shell decision costs a
// renderer, not a contract. A kind of the first schema is refused BY NAME, with the node or the
// attribute that replaces it (`REMOVED_KINDS`).
//
// WHY THE PARSER IS TOTAL AND REFUSES PER PART. The theme parser is the model: it never throws, walks
// the whole document and returns every refusal with a path and a sentence a person can read. A trick
// adds one rule: a bad part is refused ALONE, and the other parts still draw. The runner keeps the
// last good version of a refused part and marks it stale; `refusedParts` names them. A decision is
// refused alone in the same way (`refusedDecisions`).
//
// STRICT AT WRITE, TOLERANT AT READ (M94 review 11). What a person or an agent WRITES into Collie is
// read strictly: `trick.toml` (an unknown key at the same contract is a typo, and refuses), a tap, the
// facts, an agent's `collie hill post`, and every Decision a trick lists (the poster gets the error).
// What Collie READS from a program's output to draw is read tolerantly, so a trick written for a newer
// Collie at the same contract still draws on an older one:
//   * an unknown node kind (or one this Collie leaves out) drops that node, and an unknown place drops
//     that part, each with one note (code `dropped`); the other nodes and parts draw;
//   * an unknown field on a known node, part or document (a key, an attribute) is ignored, with a note
//     (code `ignored`), and never reaches the phone.
// Notes are not refusals: `notes` on the result, never `refusals`. The trick's row shows the `dropped`
// ones, and `collie trick check` and `collie trick dev` print every note without failing. A value that
// breaks its rule (a tone that is no tone, a string over its cap, a bad `href`) still refuses its part,
// never cut: the durable adapter cuts, because a program's pane must still show; a trick's part has a
// last good version to fall back on, and a cut string would hide a bug the author can fix with one
// `collie trick check`.
//
// WHY THIS FILE IMPORTS SO LITTLE. It loads without a DOM, React or the `@/` alias, because the
// bridge and the CLI import it by relative path, as they import `../json`. It must also pass the root
// tsconfig, which is stricter than the web one (`noUncheckedIndexedAccess`).

import {
  HILL_ANSWER_TEXT_MAX,
  HILL_BODY_MAX,
  HILL_INTENT_RE,
  HILL_LINK_HREF_MAX,
  HILL_LINK_LABEL_MAX,
  HILL_LINKS_MAX,
  HILL_MEDIA_CAPTION_MAX,
  HILL_MEDIA_MAX,
  HILL_NODE_PREFIX,
  HILL_OPEN_MAX,
  HILL_OPTION_CONFIRM_MAX,
  HILL_OPTION_DETAIL_MAX,
  HILL_OPTION_LABEL_MAX,
  HILL_OPTIONS_MAX,
  HILL_PRIORITIES,
  HILL_RESERVED_INTENTS,
  HILL_SUMMARY_MAX,
  HILL_TEXT_MODES,
  HILL_TITLE_MAX,
  HILL_WHY_MAX,
  isHillOptionIntent,
  type HillPriority,
  type HillTextMode,
} from "../hill/wire";
import { codePointName, firstHiddenChar, hasHiddenChar } from "../hidden-chars";
import { asJsonNumber, asJsonObject, asJsonString, asJsonBoolean, parseJson, type JsonObject, type JsonValue } from "../json";
import { AGENT_VIEW_CONTRACT, INPUTS_CONTRACT, TRICK_CONTRACT, TRICK_CONTRACT_DEFAULT } from "./contract";

export { AGENT_VIEW_CONTRACT, INPUTS_CONTRACT, TRICK_CONTRACT, TRICK_CONTRACT_DEFAULT };

// ── Versions and byte caps ───────────────────────────────────────────────────────────────────

/**
 * The output document's `"v"`: the trick contract number (contract.ts), the same one the manifest's
 * `contract` and the facts' `contract` name. One number, not three. This is the newest a document may
 * say; any number from 1 up to it reads.
 */
export const DOCUMENT_VERSION = TRICK_CONTRACT;

/** One part, serialised as compact JSON, at most this many UTF-8 bytes. */
export const PART_MAX_BYTES = 16 * 1024;
/** One document at most this many UTF-8 bytes. Equal to the runner's stdout cap. */
export const DOCUMENT_MAX_BYTES = 64 * 1024;
/** A button's `value`, an action's `value` and a tap's text value, at most this many UTF-8 bytes. */
export const VALUE_MAX_BYTES = 1024;
/** Parts per document. One trick in many places, not a page of widgets. */
export const PARTS_MAX = 24;
/** The most refusals a result lists. One more row counts the rest, as the theme parser does. */
export const REFUSALS_MAX = 40;

// ── Text caps, in characters (code points) unless the name says bytes ────────────────────────
//
// WIRE.md §6 fixes the four a trick session shares with a program pane: subtitle 120, badge text 12,
// action label 16, step label 60. The rest are chosen for a 390 px phone: a cap is the most text the
// slot can show before it wraps or truncates, so a longer string is an author's bug.

/** `subtitle` of a trick session (WIRE.md §6, `Pane.subtitle`). */
export const SUBTITLE_MAX = 120;
/** A session part's `badge.text` (WIRE.md §6, `Pane.badge.text`). */
export const BADGE_TEXT_MAX = 12;
/** A count: a session part's `badge.count` and a `badge` attribute (WIRE.md §6): a whole number 0 to 9999. */
export const COUNT_MAX = 9999;
/** A trick session action's `label` (WIRE.md §6, `PaneAction.label`). */
export const ACTION_LABEL_MAX = 16;
/** Actions on a trick session (WIRE.md §6, `Pane.actions`). */
export const ACTIONS_MAX = 4;
/** The most a `progress` counts to: a `meter` with `role` `progress` and a session's `progress` (WIRE.md §6, 12 steps). */
export const PROGRESS_MAX = 12;
/** A mark's `label`, the live word in the belt (`23/34`). Same rule as a badge's text. */
export const FACE_MAX = 12;
/** The trick's `name` in the manifest, and a trick session's `name`. */
export const NAME_MAX = 40;
/** The manifest's `description`: the one line a trick's row shows under its name. */
export const DESCRIPTION_MAX = 140;
/** The manifest's `about`: the full plain text of a trick's About sheet, paragraphs split by a blank line. */
export const ABOUT_MAX = 1200;
/** A `group`'s `label`. */
export const TITLE_MAX = 60;
/** A `para`'s text, and a `run`'s. One paragraph: no line break (the tree strips control characters). */
export const TEXT_MAX = 2000;
/** A `button`'s `label` and its `confirm` label. */
export const BUTTON_LABEL_MAX = 24;
/** A short label beside a figure (`meter`, `number`, `spacer`, a bar's name, a `para`'s `term`). */
export const LABEL_MAX = 40;
/** A `row`'s title, a `link`'s text, an image's `alt`, a button's `hint`, a `disabled` reason. */
export const LINE_MAX = 120;
/** A `number` node's figure as text (`23/34`, `1.2k`). */
export const NUMBER_TEXT_MAX = 12;
/** A `row`'s `end`, a `number`'s `unit`, a `code`'s `lang`. */
export const WORD_MAX = 24;
/** A `chip`'s text (WIRE.md §6, a step label). */
export const CHIP_TEXT_MAX = 60;
/** A `chip`'s `short`, the text shown when the box is narrow. */
export const SHORT_MAX = 12;
/** A `status` part's chip text: the face word's cap, as the line it sits in is one 390 px row. */
export const STATUS_TEXT_MAX = 12;
/** An `item`'s `label` (a `dashboard` tile's or a `tabbar` item's short name), truncated on the glass. */
export const ITEM_LABEL_MAX = 16;
/** A `para`'s `bullet` marker (`-`, `1.`, `12.`). */
export const BULLET_MAX = 4;
/** One `line`, a mono screen line; a tab is allowed. */
export const LINE_TEXT_MAX = 240;
/** A URL in a `link`, a `row` or a `run` `href` (WIRE.md §6, `Item.href`). */
export const URL_MAX = 2048;
/** The whole `at` string, match included. */
export const AT_MAX = 160;
/** An image's `src` and a decision's media `file`, a path relative to the trick folder. */
export const IMAGE_SRC_MAX = 256;
/** An image's `w` and `h`, in pixels. */
export const IMAGE_SIDE_MAX = 4096;
/** The manifest's `run` command line. */
export const RUN_MAX = 1024;
/** One `watch` path in the manifest, and the number of them. */
export const WATCH_PATH_MAX = 1024;
export const WATCH_MAX = 8;
/** Bytes of a facts string the bridge copies from the snapshot (a name, a tab, a cwd). */
export const FACT_TEXT_MAX_BYTES = 4096;
/** Sessions and spaces in one facts document (WIRE.md §6, panes and workspaces per snapshot). */
export const FACT_SESSIONS_MAX = 256;
export const FACT_SPACES_MAX = 64;
/**
 * The most bytes the sessions of one facts document take, written as JSON. On a crew's lead the facts
 * list every member's sessions too; past this cap (or past {@link FACT_SESSIONS_MAX}) the rest are left
 * out and `sessionsOmitted` counts them. The lead's own sessions come first, so they are never the cut.
 */
export const FACT_SESSIONS_MAX_BYTES = 512 * 1024;
/** A facts session's opaque `sessionId`. */
export const SESSION_ID_MAX = 256;
/** A refused tap's or a failed run's one line of words on the wire. */
export const PROBLEM_MAX = 200;

// ── Decision caps (the hill's decision shape) ────────────────────────────────────────────────
//
// The hill's wire (`../hill/wire.ts`, M96) is the one source of a decision's caps and rules: the title,
// summary, body, options, labels, links, why, text modes, priorities, reserved intents and the answer's
// words. This file imports them; only what the hill has no word for is a trick's own.

/** Open decisions one document may list: the hill's cap per sender, and a trick is one sender. */
export const DECISIONS_MAX = HILL_OPEN_MAX;
/** A decision `key`: 1 to 64 of `a-z 0-9 -`, unique in the document. A trick's own: the hill mints ids. */
export const DECISION_KEY_MAX = 64;
/** A tap's `seen`, the content hash of the decision the person saw (the runner's hex digest). */
export const DECISION_HASH_MAX = 64;

/** Limits the view tree holds, as data, so the renderer and the docs read the same numbers. */
export const VIEW_LIMITS = {
  /** Nodes in a part's `view`, the kids of the place's frame. */
  root: { min: 1, max: 24 },
  /** Kids of a `card`, a `group` or a `row`. */
  kids: { min: 1, max: 24 },
  /** Kids of a `list`: its rows and groups. The rows it reserves are its kids, so there is no `rows`. */
  listKids: { min: 0, max: 50 },
  /** Kids of a `bar`. */
  barKids: { min: 1, max: 12 },
  /** Kids of a `para` or a `line`: its runs and links. */
  runs: { min: 1, max: 64 },
  /** Kids of a `code`: its lines. */
  codeLines: { min: 1, max: 200 },
  /** `code.max`: the lines shown before the block scrolls on its own. */
  codeMax: { min: 1, max: 40 },
  /** `meter.max` with `role` `progress`, and a session's `progress.max`. */
  progressMax: { min: 1, max: PROGRESS_MAX },
  /** `image.w` and `image.h`. */
  imageSide: { min: 1, max: IMAGE_SIDE_MAX },
  /** Nesting: a node in the view list is depth 1. */
  depth: { min: 1, max: 6 },
  /** Nodes in one view, every kid counted. */
  nodes: { min: 1, max: 300 },
} as const;

/** A `table`: 1 to 4 columns, 1 to 12 rows of cells. */
export const TABLE_LIMITS = { cols: { min: 1, max: 4 }, rows: { min: 1, max: 12 } } as const;
/** A `diff`: at most 40 lines of at most 200 characters each. */
export const DIFF_LIMITS = { lines: 40, lineChars: 200 } as const;
/** A `spark`: 2 to 32 values. */
export const SPARK_LIMITS = { values: { min: 2, max: 32 } } as const;
/** An image's `focus`: the point (0 to 100 across and down, in percent) and the zoom (1 to 8). */
export const FOCUS_LIMITS = { point: { min: 0, max: 100 }, zoom: { min: 1, max: 8 } } as const;
/** How an image fills its frame: whole (`contain`, the default) or filling it and cut at the edges (`cover`). */
export const IMAGE_FITS = ["contain", "cover"] as const;
export type ImageFit = (typeof IMAGE_FITS)[number];
/** Which side of its column a table's words keep. A column of figures keeps the end side by default. */
export const COL_ALIGNS = ["start", "end"] as const;
export type ColAlign = (typeof COL_ALIGNS)[number];

// ── Durations ────────────────────────────────────────────────────────────────────────────────

/** `every` in the manifest: at least 5 s, at most a day. */
export const EVERY_MIN_MS = 5_000;
export const EVERY_MAX_MS = 24 * 60 * 60_000;
/** `fresh` in a document: at least 5 s, at most a day. */
export const FRESH_MIN_MS = 5_000;
export const FRESH_MAX_MS = 24 * 60 * 60_000;

const DURATION = /^([1-9]\d{0,5})(s|m|h)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/**
 * A duration string as milliseconds: one whole number and one unit, `90s`, `5m`, `1h`. No compound
 * (`1h30m`), no fraction, no bare number: `90m` says the same and a person reads it at once.
 * `undefined` for anything else.
 */
export function parseDuration(text: string): number | undefined {
  const m = DURATION.exec(text);
  if (m === null) return undefined;
  const unit = m[2];
  if (unit !== "s" && unit !== "m" && unit !== "h") return undefined;
  return Number(m[1]) * UNIT_MS[unit];
}

/**
 * How long a part keeps its tone after `asOf`. DECISION (the design is silent on a document with no
 * `fresh`): three ticks of `every`, at least a minute; ten minutes for a trick with no timer. A part
 * always has a window, so a bridge that is down cannot leave "deploy green" on the glass. The window
 * never passes `FRESH_MAX_MS`, the same day a `fresh` may name (an `every` of 9 h would give 27 h).
 */
export function freshWindowMs(freshMs: number | undefined, everyMs: number | undefined): number {
  if (freshMs !== undefined) return Math.min(freshMs, FRESH_MAX_MS);
  if (everyMs !== undefined) return Math.min(Math.max(3 * everyMs, 60_000), FRESH_MAX_MS);
  return 10 * 60_000;
}

// ── Closed lists ─────────────────────────────────────────────────────────────────────────────

/** The tones a trick may name: the tree's list (VOCABULARY.md 2.2). Each maps to a token that already exists. */
export const TONES = ["plain", "accent", "warn", "danger", "ok", "muted"] as const;
export type Tone = (typeof TONES)[number];
/**
 * The inks the renderer draws: the six tones and `unknown`, the grey a part takes past its `fresh`
 * window. `unknown` is the phone's, never a trick's: a trick does not say it does not know.
 */
export const DRAW_TONES = [...TONES, "unknown"] as const;
export type DrawTone = (typeof DRAW_TONES)[number];

/**
 * THE TONE MAP. Each tone to a colour token of `index.css` (DESIGN.md §13). No new colour, no amber.
 *   * `ok` is `status-done`, `danger` is `status-blocked`, `unknown` is `status-unknown`.
 *   * `warn` has no status token of its own. It takes `status-working`, the token the app's caution
 *     Notice already uses (components/ui/notice.tsx, `caution`). `accent`, the tree's word for "this is
 *     live" (the first schema's `working`), takes it too. So `warn` and `accent` draw in one colour; a
 *     trick tells them apart with its icon and its words, as Collie's own caution notice does.
 *   * `plain` and `muted` are the two inks, `foreground` and `muted-foreground`: a trick's part is not
 *     a status and most of it is plain text.
 * A part past its `fresh` window draws as `unknown` whatever it says.
 */
export const TONE_TOKENS = {
  plain: "foreground",
  muted: "muted-foreground",
  ok: "status-done",
  warn: "status-working",
  danger: "status-blocked",
  accent: "status-working",
  unknown: "status-unknown",
} as const satisfies { readonly [T in DrawTone]: string };
export type ToneToken = (typeof TONE_TOKENS)[DrawTone];

/**
 * The text class of each ink, spelled out so Tailwind's scan of this file finds every one (a class
 * built as `text-${token}` is never generated). The renderer uses these and nothing else for ink.
 */
export const TONE_TEXT_CLASS = {
  plain: "text-foreground",
  muted: "text-muted-foreground",
  ok: "text-status-done",
  warn: "text-status-working",
  danger: "text-status-blocked",
  accent: "text-status-working",
  unknown: "text-status-unknown",
} as const satisfies { readonly [T in DrawTone]: `text-${(typeof TONE_TOKENS)[T]}` };

/** The colour token an ink draws in. */
export function toneToken(tone: DrawTone): ToneToken {
  return TONE_TOKENS[tone];
}

/**
 * Session status words that are NOT tones. A program that writes `"tone": "blocked"` meant a status,
 * and a trick's red is never read as "an agent needs you" (ADR 0063 point 3), so it gets its own
 * reason. `working` is here since the re-cut: it is a `chip` state now, and the tone is `accent`.
 */
const STATUS_WORDS = ["blocked", "done", "idle", "waiting", "working"] as const;
/** Tones of the first schema, refused with the tree's word for them. */
const OLD_TONES = {
  error: 'use "danger"',
  working: 'use "accent"',
  unknown: "the phone draws a part grey itself once it is past its fresh window",
} as const satisfies Readonly<Record<string, string>>;

/**
 * Keys that would make a trick's mark look like Collie's status mark. Refused with their own reason:
 * a trick mark draws the trick's icon and face word in its own frame, never a status dot.
 */
export const STATUS_MARK_KEYS = ["status", "dot", "state", "pulse"] as const;

/** The 16 ANSI colour names of `style` `fg-<name>` and `bg-<name>` (VOCABULARY.md 2.1). */
export const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
] as const;
/** Every word `style` may hold, space separated (VOCABULARY.md 2.1, 2.13). */
export const STYLE_WORDS = [
  ...ANSI_NAMES.map((name) => `fg-${name}`),
  ...ANSI_NAMES.map((name) => `bg-${name}`),
  "bold",
  "dim",
  "italic",
  "underline",
  "inverse",
  "strike",
  "box",
  "syn-keyword",
  "syn-string",
  "syn-comment",
  "syn-number",
  "syn-type",
  "syn-func",
  "syn-const",
  "syn-punct",
] as const;

/** `group.fold`: a hint for the first draw; the phone owns the toggle after it. */
export const FOLDS = ["open", "closed"] as const;
export type Fold = (typeof FOLDS)[number];
/** `chip.clock` and `run.clock` with `at` (VOCABULARY.md 2.14). */
export const CLOCKS = ["ago", "elapsed", "left", "time"] as const;
export type Clock = (typeof CLOCKS)[number];
/** `chip.state`: the tree's row state list, one list, the steps of a bar of chips. A chip draws a dot. */
export const CHIP_STATES = ["working", "waiting", "idle", "done", "gone"] as const;
export type ChipState = (typeof CHIP_STATES)[number];
/** `button.pressed` (VOCABULARY.md 2.8). */
export const PRESSED_STATES = ["true", "false", "mixed"] as const;
export type Pressed = (typeof PRESSED_STATES)[number];
/** `button.does`: a trick may only copy. `install`, `notify`, `reload` and `wipe` are Collie's own. */
export const BUTTON_DOES = ["copy"] as const;
export type ButtonDoes = (typeof BUTTON_DOES)[number];
/** `link.rel`: what the `href` names. Absent: an https:// or http:// address or a session's scope key. `file` is refused: a trick opens no file. */
export const LINK_RELS = ["url", "file", "pane"] as const;
export type LinkRel = (typeof LINK_RELS)[number];
/** `bar.role`: a trick's bar sits in its view, or is the one `strip` band; the fixed bars are Collie's. */
export const BAR_ROLES = ["strip"] as const;
/** `bar.scroll`. */
export const BAR_SCROLLS = ["x"] as const;
/** `para.role`. */
export const PARA_ROLES = ["heading", "quote"] as const;
/** `line.role`. */
export const LINE_ROLES = ["text", "status", "note"] as const;
/** `meter.role`. Absent is `meter`. */
export const METER_ROLES = ["progress", "meter"] as const;
/** `row.cut`: where a long title is cut. */
export const CUTS = ["end", "mid"] as const;

/**
 * THE ICON SET a trick may name: the tree's list (VOCABULARY.md 2.15) and the words the first tricks
 * add (`flask`, `plug`, `tag`, `git-pull-request`, `x`, `play`, `pause`, `flag`, `camera`), and the
 * three session action words the tree lacks (`archive`, `send`, `note`), so the action icons are a
 * subset of this list and a trick has ONE icon list to learn (step 3). One list,
 * each word a lucide export (`TRICK_ICON_LUCIDE`); the test holds every one to `lucide-react`. Left out
 * on purpose: the spinner (`Loader2`, Collie's own busy state) and the filled status circles
 * (`CircleDot`, `CheckCircle2`, `XCircle`, `CircleAlert`), which read as Collie's status marks.
 */
export const TRICK_ICON_LUCIDE = {
  archive: "Archive",
  back: "ArrowLeft",
  bell: "Bell",
  branch: "GitBranch",
  camera: "Camera",
  chat: "MessageSquare",
  check: "Check",
  clock: "Clock",
  close: "X",
  copy: "Copy",
  crew: "Users",
  delete: "Trash2",
  down: "ArrowDown",
  download: "Download",
  edit: "Pencil",
  eye: "Eye",
  file: "FileText",
  flag: "Flag",
  flask: "FlaskConical",
  folder: "Folder",
  "git-pull-request": "GitPullRequest",
  image: "Image",
  info: "Info",
  key: "KeyRound",
  link: "ExternalLink",
  lock: "Lock",
  machine: "Server",
  menu: "Menu",
  mic: "Mic",
  minus: "Minus",
  more: "Ellipsis",
  move: "Move",
  next: "ChevronRight",
  note: "StickyNote",
  pause: "Pause",
  pin: "Pin",
  play: "Play",
  plug: "Plug",
  plus: "Plus",
  refresh: "RefreshCw",
  search: "Search",
  send: "Send",
  settings: "Settings2",
  share: "Share2",
  star: "Star",
  tag: "Tag",
  terminal: "SquareTerminal",
  up: "ArrowUp",
  upload: "Upload",
  warn: "TriangleAlert",
  x: "X",
} as const;
export type TrickIcon = keyof typeof TRICK_ICON_LUCIDE;
/** The icon words, sorted. */
export const TRICK_ICONS: readonly TrickIcon[] = keyStrings(TRICK_ICON_LUCIDE);
/** The icon of a trick whose manifest names none. */
export const DEFAULT_TRICK_ICON: TrickIcon = "plug";

/**
 * A trick session action's icon: the twelve words of `PANE_ACTION_ICONS` (bridge/types.ts), because a
 * trick session's actions ride the pane fields as `PaneAction`s. Restated, not imported, so this file
 * loads without the bridge; the test reads both and fails on drift. A SUBSET of the trick icon set:
 * the three words the tree lacks (`archive`, `send`, `note`) are trick icons too, and the test holds
 * every action word to `TRICK_ICON_LUCIDE`, so a trick has one icon list.
 */
export const ACTION_ICONS = ["play", "pause", "check", "x", "refresh", "archive", "flag", "star", "send", "note", "search", "more"] as const satisfies readonly TrickIcon[];
export type ActionIcon = (typeof ACTION_ICONS)[number];

/** The events a manifest may name in `on` (a later slice, the event bus). */
export const TRICK_EVENTS = ["session.status", "turn.end", "ask.open"] as const;
export type TrickEvent = (typeof TRICK_EVENTS)[number];
/** `mode`: `once` runs per trigger; `serve` keeps the program running (a later slice). */
export const TRICK_MODES = ["once", "serve"] as const;
export type TrickMode = (typeof TRICK_MODES)[number];
/** The parts of a manifest that a later slice builds. Refused as "later" until a caller enables them. */
export const LATER_TRIGGERS = ["watch", "on", "serve"] as const;
export type LaterTrigger = (typeof LATER_TRIGGERS)[number];

/** The session statuses the facts carry (`AgentStatus` in bridge/types.ts). */
export const SESSION_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// ── Places ───────────────────────────────────────────────────────────────────────────────────

/**
 * Where a part draws. The `at` of a part names one, and the manifest's `places` lists the ones it uses.
 * Every place here is drawn by this Collie: `belt` (agent-chat.tsx), `status` (trick-status-item.tsx),
 * `dashboard` and `tabbar` (trick-place-items.tsx, dashboard-tab-bar.tsx) and `session` (the bridge's
 * Tricks Space, panes.ts, and routes/trick-session.tsx). M94 review 11 removed `tab`, `tab:<match>` and
 * `view:<match>`, which parsed and drew nowhere; a later Collie adds a place back at the same contract,
 * and an older one leaves a part there out (`parseTrickDocument`).
 */
export const PLACE_KINDS = ["belt", "session", "dashboard", "status", "tabbar"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];
/** The places a parser call with no `places` accepts: every place. */
export const NEAR_PLACES: readonly PlaceKind[] = PLACE_KINDS;
/** The place kinds a later slice builds and a caller may refuse as "later" by leaving them out of `places`. None since step 3. */
export const LATER_PLACES: readonly PlaceKind[] = [];
/**
 * Place words of the first schema that come back later, each refused with the code "later" and its
 * place named, in an `at` and in the manifest's `places`. `menu` is the word of `menu:<match>`.
 */
/** The most place words a manifest's `places` may list, known or not. */
export const PLACES_LISTED_MAX = 16;
export const LATER_PLACE_WORDS = {
  "header.line": '"header.line" is a later place, not in this Collie yet. The other parts still draw.',
  menu: '"menu:<match>" is a later place, not in this Collie yet. The other parts still draw.',
  settings: '"settings" is a later place, not in this Collie yet. The other parts still draw.',
} as const satisfies Readonly<Record<string, string>>;

// ── Node kinds ───────────────────────────────────────────────────────────────────────────────

/**
 * The kinds a trick's view may hold: sixteen of the tree's thirty, with its names, plus `number`, the
 * one kind of its own (a big figure with a label; not in the tree yet), and the five display kinds of
 * the just-in-time round (2026-11-10): `compare` (two images side by side), `table` with its `col` and
 * `cell` kids, `diff` and `spark`. `col` and `cell` live only inside a `table`.
 */
export const NODE_KINDS = [
  "card",
  "group",
  "list",
  "row",
  "bar",
  "chip",
  "button",
  "para",
  "line",
  "run",
  "code",
  "link",
  "image",
  "meter",
  "spacer",
  "number",
  "compare",
  "table",
  "col",
  "cell",
  "diff",
  "spark",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** The keys a node object takes, as in the tree. The bridge gives each node its `id`. */
export const NODE_KEYS = ["kind", "text", "attrs", "kids"] as const;

/** Every attribute each kind takes. Anything else is refused. The tree's names, a subset of each kind's. */
export const NODE_ATTRS = {
  card: ["tone"],
  group: ["label", "fold", "badge"],
  list: [],
  row: ["href", "end", "badge", "tone", "cut", "icon", "disabled"],
  bar: ["role", "scroll", "label"],
  chip: ["tone", "icon", "at", "clock", "state", "current", "short"],
  button: ["intent", "label", "tone", "disabled", "pressed", "confirm", "badge", "icon", "hint", "does", "value"],
  para: ["role", "bullet", "term"],
  line: ["style", "role"],
  run: ["style", "code", "href", "at", "clock"],
  code: ["lang", "max"],
  link: ["href", "rel", "badge", "icon"],
  image: ["src", "alt", "w", "h", "ref", "caption", "fit", "focus"],
  meter: ["value", "max", "tone", "label", "role"],
  spacer: ["label"],
  number: ["label", "tone", "unit"],
  compare: [],
  table: [],
  col: ["align"],
  cell: ["tone"],
  diff: ["file"],
  spark: ["values", "tone", "label"],
} as const satisfies { readonly [K in NodeKind]: readonly string[] };

/**
 * The attributes a kind must carry. An `image` is not listed: what it must carry depends on where it is
 * (`src`, `alt`, `w` and `h` in a part, `ref` in a Decision's view), which `checkImage` holds.
 */
export const NODE_REQUIRED_ATTRS = {
  button: ["label"],
  link: ["href"],
  spark: ["values"],
} as const satisfies { readonly [K in NodeKind]?: readonly (typeof NODE_ATTRS)[K][number][] };

/** The kinds each container holds, in the tree's words (VOCABULARY.md 2, 2.12). A kind not listed holds no kids. */
export const NODE_KIDS = {
  card: ["para", "line", "chip", "button", "meter", "image", "bar", "group", "number", "spacer", "compare", "table", "diff", "spark"],
  group: ["row", "group", "bar", "para", "line", "link", "meter", "number", "spacer", "image", "compare", "table", "diff", "spark"],
  list: ["group", "row"],
  row: ["para", "chip", "button"],
  bar: ["button", "chip", "link"],
  para: ["run", "link"],
  line: ["run", "link"],
  code: ["line"],
  /** Exactly two images: the first is "Before", the second "After", unless a `caption` names them. */
  compare: ["image"],
  /** Its column heads first (1 to 4 `col`), then its cells row by row (`cell`), a whole row at a time. */
  table: ["col", "cell"],
} as const satisfies { readonly [K in NodeKind]?: readonly NodeKind[] };
export type ContainerKind = keyof typeof NODE_KIDS;

/** The kinds a part's `view` lists, the kids of the place's frame. They flow down the frame; there is no `stack`. */
export const VIEW_ROOT_KINDS = ["card", "group", "list", "bar", "para", "line", "code", "meter", "image", "spacer", "number", "compare", "table", "diff", "spark"] as const satisfies readonly NodeKind[];

/** What a kind's `text` is: its cap, whether it is required, and the characters it allows. A kind not listed takes no text. */
export const NODE_TEXT = {
  row: { max: LINE_MAX, required: true },
  chip: { max: CHIP_TEXT_MAX },
  para: { max: TEXT_MAX },
  line: { max: LINE_TEXT_MAX, tabs: true },
  run: { max: TEXT_MAX, required: true, blank: true },
  link: { max: LINE_MAX, required: true },
  number: { max: NUMBER_TEXT_MAX, required: true },
  col: { max: LABEL_MAX, required: true },
  cell: { max: LINE_MAX, empty: true },
  // The lines of a diff, one text with a line break between two lines; `checkDiff` holds each line's cap.
  diff: { max: DIFF_LIMITS.lines * (DIFF_LIMITS.lineChars + 1), required: true, multiline: true },
} as const satisfies { readonly [K in NodeKind]?: TextRule };

/**
 * Kinds that are not in a trick's vocabulary, each refused by name with what to write instead: the
 * first schema's kinds, and the tree's kinds that only Collie draws.
 */
export const REMOVED_KINDS = {
  stack: "the nodes of a view, a card or a group flow down on their own; list them there",
  grid: "use a table, or a list of row with end",
  kv: "use a list of row with end",
  steps: "use a bar of chip with state and current",
  time: "use a chip or a run with at and clock",
  section: "use a group with label",
  divider: "use a spacer, with label for a divider with words",
  log: "use a code with line kids",
  text: "use a para, or a line for one mono screen line",
  progress: 'use a meter with role "progress"',
  badge: "badge is an attribute now, on row, button, link and group",
  icon: "icon is an attribute now, on row, chip, button and link",
  ring: "use a meter, or a spark for a trend",
  mark: "mark is Collie's working mark; a trick's mark is the part's mark, or a button in a bar",
  screen: "a trick part is not a screen; the place gives the frame",
  sheet: "sheets are Collie's own",
  toast: "toasts are Collie's own",
  form: "forms are not in a trick's vocabulary yet",
  field: "fields are not in a trick's vocabulary yet",
  select: "selects are not in a trick's vocabulary yet",
  option: "selects are not in a trick's vocabulary yet",
  composer: "the composer is Collie's own; a trick never writes into a reply box",
  prompt: "a prompt is an agent's dialog; a trick asks the person through a decision",
  tool: "tool calls are an agent's",
  turn: "turns are an agent's",
  chat: "Chat is Collie's own",
  pane: "the Terminal is Collie's own",
  think: "thinking blocks are an agent's",
} as const;

/**
 * Tree attributes a trick may not use, each with its reason. `state` on a row reads as "an agent needs
 * you"; the rest are device preferences, Collie's own sheets and gestures, and the bridge's bookkeeping.
 */
const TREE_ONLY_ATTRS = {
  state: "would draw Collie's status mark. A trick never draws a session state; use \"tone\"",
  pref: "names a device preference, which is Collie's closed list",
  key: "draws a key cap, which is Collie's keyboard",
  holds: "opens one of Collie's sheets",
  opens: "opens one of Collie's sheets",
  repeat: "repeats an intent while held, which a trick may not ask for",
  span: "belongs to Collie's key grid",
  anchor: "is the bridge's to set",
  hue: "is the colour slot of a machine or a harness, which the bridge sets",
  since: "is the bridge's to set; a trick's time is a chip with at and clock",
  live: "is the bridge's to set",
  busy: "is the bridge's to set",
  when: "belongs to a form, which a trick does not draw",
  needs: "is the bridge's to set",
  id: "is the bridge's to set; it gives every node its id",
} as const satisfies Readonly<Record<string, string>>;

// ── Types: the view tree ─────────────────────────────────────────────────────────────────────
//
// Every attribute value is text, as in the tree. A flag (`current`, `code`) is present with the
// empty string, or absent. `disabled` carries its reason, the empty string for none. Numbers are
// digit strings (`"68"`, `"0.5"`); an instant (`at`) is epoch milliseconds as digits.

export interface CardNode {
  kind: "card";
  attrs?: { tone?: Tone };
  kids: ViewNode[];
}
export interface GroupNode {
  kind: "group";
  attrs?: { label?: string; fold?: Fold; badge?: string };
  kids: ViewNode[];
}
/** A list of rows and groups. It reserves the height of its kids, so a data change inside one row moves nothing. */
export interface ListNode {
  kind: "list";
  kids?: ViewNode[];
}
/**
 * One row: a title, at most one `para` (the second line), any `chip`, at most one trailing `button`.
 * `href` makes it tappable; a row that fires an intent takes the trailing button. Never a `state`.
 */
export interface RowNode {
  kind: "row";
  text: string;
  attrs?: { href?: string; end?: string; badge?: string; tone?: Tone; cut?: (typeof CUTS)[number]; icon?: TrickIcon; disabled?: string };
  kids?: ViewNode[];
}
export interface BarNode {
  kind: "bar";
  attrs?: { role?: (typeof BAR_ROLES)[number]; scroll?: (typeof BAR_SCROLLS)[number]; label?: string };
  kids: ViewNode[];
}
/** A small label. `state` draws a dot, `current` marks the step; `at` with `clock` makes it a live time. */
export interface ChipNode {
  kind: "chip";
  text?: string;
  attrs?: { tone?: Tone; icon?: TrickIcon; at?: string; clock?: Clock; state?: ChipState; current?: ""; short?: string };
}
/** Sends one intent on tap, or copies `value` with `does` `copy`. `confirm` is the second label (two taps, one intent). */
export interface ButtonNode {
  kind: "button";
  attrs: {
    label: string;
    intent?: string;
    tone?: Tone;
    disabled?: string;
    pressed?: Pressed;
    confirm?: string;
    badge?: string;
    icon?: TrickIcon;
    hint?: string;
    does?: ButtonDoes;
    value?: string;
  };
}
/** One paragraph: `text`, or `run` and `link` kids, never both. */
export interface ParaNode {
  kind: "para";
  text?: string;
  attrs?: { role?: (typeof PARA_ROLES)[number]; bullet?: string; term?: string };
  kids?: ViewNode[];
}
/** One mono screen line: `text`, or `run` and `link` kids, never both; neither is a blank line. */
export interface LineNode {
  kind: "line";
  text?: string;
  attrs?: { style?: string; role?: (typeof LINE_ROLES)[number] };
  kids?: ViewNode[];
}
export interface RunNode {
  kind: "run";
  text: string;
  attrs?: { style?: string; code?: ""; href?: string; at?: string; clock?: Clock };
}
export interface CodeNode {
  kind: "code";
  attrs?: { lang?: string; max?: string };
  kids: ViewNode[];
}
export interface LinkNode {
  kind: "link";
  text: string;
  attrs: { href: string; rel?: LinkRel; badge?: string; icon?: TrickIcon };
}
/**
 * An image, in one of two forms by where it sits. In a part: a file of the trick folder, PNG or JPEG,
 * `src`, `alt`, `w` and `h` (which reserve its box), all four required. In a Decision's view: `ref`, the
 * index of one of the Decision's own images (from 0). Both take a `caption` (in a `compare`, the frame's
 * label), `fit` and `focus`, "<x> <y>" or "<x> <y> <zoom>": the point of the picture to keep in the
 * middle of its frame, in percent across and down, and how far to zoom in on it, a crop drawn by CSS alone.
 */
export interface ImageNode {
  kind: "image";
  attrs: { src?: string; alt?: string; w?: string; h?: string; ref?: string; caption?: string; fit?: ImageFit; focus?: string };
}
/** Two images of the Decision side by side at one height, "Before" and "After" unless their captions say otherwise. */
export interface CompareNode {
  kind: "compare";
  kids: ViewNode[];
}
/** A small table: its `col` heads, then its `cell`s row by row. No sideways scroll: a cell takes at most two lines. */
export interface TableNode {
  kind: "table";
  kids: ViewNode[];
}
/** A column head of a `table`. `align` defaults to `end` for a column of figures, `start` for words. */
export interface ColNode {
  kind: "col";
  text: string;
  attrs?: { align?: ColAlign };
}
/** One cell of a `table`. An empty cell is `""`, or no `text` at all. */
export interface CellNode {
  kind: "cell";
  text?: string;
  attrs?: { tone?: Tone };
}
/** A hunk of a diff: its lines in one `text`, `+` added, `-` removed, `@@` a hunk head. `file` names the file. */
export interface DiffNode {
  kind: "diff";
  text: string;
  attrs?: { file?: string };
}
/** A trend as a small line, no axes, the last point marked: `values` is 2 to 32 numbers with a space between. */
export interface SparkNode {
  kind: "spark";
  attrs: { values: string; tone?: Tone; label?: string };
}
/** An amount (`role` `meter`) or a task (`role` `progress`; no `value` is indeterminate). `max` defaults to 1. */
export interface MeterNode {
  kind: "meter";
  attrs?: { value?: string; max?: string; tone?: Tone; label?: string; role?: (typeof METER_ROLES)[number] };
}
/** Layout only. With `label` it is a divider with words. */
export interface SpacerNode {
  kind: "spacer";
  attrs?: { label?: string };
}
/** A big figure (`text`, `23/34`) with a label. A trick's own kind, not in the tree yet. */
export interface NumberNode {
  kind: "number";
  text: string;
  attrs?: { label?: string; tone?: Tone; unit?: string };
}

export type ViewNode =
  | CardNode
  | GroupNode
  | ListNode
  | RowNode
  | BarNode
  | ChipNode
  | ButtonNode
  | ParaNode
  | LineNode
  | RunNode
  | CodeNode
  | LinkNode
  | ImageNode
  | MeterNode
  | SpacerNode
  | NumberNode
  | CompareNode
  | TableNode
  | ColNode
  | CellNode
  | DiffNode
  | SparkNode;

/** A part's view: the nodes of the place's frame, top to bottom. */
export type View = ViewNode[];

// ── Types: parts ─────────────────────────────────────────────────────────────────────────────

/**
 * A trick's mark: the attributes of a `button` in a `bar` (the tree's belt). Its icon (the manifest's
 * when absent), its face word as `label`, a `badge` (a count, or a dot when empty), a tone and, on the
 * belt only, one intent. At least one of icon, label and badge; a part that should show nothing is
 * left out of the document. Never `state`: a trick's red is not "an agent needs you".
 */
export interface Mark {
  icon?: TrickIcon;
  label?: string;
  badge?: string;
  tone?: Tone;
  intent?: string;
}

/** A trick session's action, on the belt of its session (`PaneAction`, plus the intent it taps). */
export interface TrickAction {
  id: string;
  label: string;
  intent: string;
  /** Sent as the intent's value, as a button's `value` is. */
  value?: string;
  icon?: ActionIcon;
  disabled?: boolean;
}

/** The progress of a trick session, a `meter` with `role` `progress`: `value` of `max` (1 to 12, default 1). No `value` is indeterminate. */
export interface PartProgress {
  value?: number;
  max?: number;
}
/** A badge on a trick session: a count or a short word, never both (WIRE.md §7.11). */
export type Badge = { count: number } | { text: string };

export interface BeltPart {
  at: "belt";
  id: string;
  mark: Mark;
}
/**
 * A trick's item in the status line above the Belt: the attributes of a tree `chip`, and no others. No
 * `state` (never a status shape), and no `intent`: the chip is not a control. `at` with `clock` makes it
 * a live time, as on any chip.
 */
export interface StatusChip {
  text: string;
  icon?: TrickIcon;
  tone?: Tone;
  at?: string;
  clock?: Clock;
}
export interface StatusPart {
  at: "status";
  id: string;
  chip: StatusChip;
}
/**
 * A trick's item in a fixed place of the app's own chrome (2026-11-10): a tile in the Dashboard's strip
 * (`dashboard`) or an item in the Dashboard's bottom bar (`tabbar`). An icon over a short name, an
 * optional badge (a count or a short word) and a tone. No `intent` and no status shape: the item is not
 * a control. A tap opens the trick's session when it has one.
 */
export interface PlaceItem {
  icon?: TrickIcon;
  /** 1 to {@link ITEM_LABEL_MAX} characters. */
  label: string;
  /** A count from 0 to {@link COUNT_MAX} (0 draws no badge), or 1 to {@link BADGE_TEXT_MAX} characters. */
  badge?: number | string;
  tone?: Tone;
}
/** One tile in the strip at the top of the Dashboard. One per trick. */
export interface DashboardPart {
  at: "dashboard";
  id: string;
  item: PlaceItem;
}
/** One item in the Dashboard's bottom bar, after the Hill, in the scrolling run. One per trick. */
export interface TabbarPart {
  at: "tabbar";
  id: string;
  item: PlaceItem;
}
export interface SessionPart {
  at: "session";
  id: string;
  /** The session's name on the Dashboard. Absent: the manifest's `name`. */
  name?: string;
  icon?: TrickIcon;
  /**
   * The session's tone. `accent` makes the pane read as working on the snapshot; every other tone
   * reads idle, because a trick session is outside triage and push and never "needs you".
   */
  tone?: Tone;
  subtitle?: string;
  badge?: Badge;
  progress?: PartProgress;
  actions?: TrickAction[];
  view: View;
}
export type TrickPart = BeltPart | SessionPart | DashboardPart | StatusPart | TabbarPart;

/** A part the parser accepted, with its place. */
export type ParsedPart =
  | { place: "belt"; part: BeltPart }
  | { place: "status"; part: StatusPart }
  | { place: "session"; part: SessionPart }
  | { place: "dashboard"; part: DashboardPart }
  | { place: "tabbar"; part: TabbarPart };

/** One control a part draws that sends a tap: its intent, and the value it sends (none for a mark). */
export interface TapControl {
  intent: string;
  value?: string;
}

/**
 * Every control of a part that sends a tap to the program (fault A): what the bridge holds a phone's tap
 * against. A belt mark with an intent; a session's actions and every `button` of its view, at any depth,
 * that sends an intent. A disabled control and a button that only copies send nothing, so they are left
 * out. A status chip, a Dashboard tile and a bottom bar item are no controls: a tap there opens the
 * trick's session on the phone and never reaches the bridge.
 */
export function tapControls(part: TrickPart): TapControl[] {
  switch (part.at) {
    case "belt":
      return part.mark.intent === undefined ? [] : [{ intent: part.mark.intent }];
    case "session": {
      const out: TapControl[] = [];
      for (const action of part.actions ?? []) {
        if (action.disabled === true) continue;
        out.push(action.value === undefined ? { intent: action.intent } : { intent: action.intent, value: action.value });
      }
      const walk = (nodes: readonly ViewNode[]): void => {
        for (const node of nodes) {
          if (node.kind === "button") {
            const { intent, value, does, disabled } = node.attrs;
            if (intent !== undefined && does === undefined && disabled === undefined) out.push(value === undefined ? { intent } : { intent, value });
            continue;
          }
          if ("kids" in node && node.kids !== undefined) walk(node.kids);
        }
      };
      walk(part.view);
      return out;
    }
    case "status":
    case "dashboard":
    case "tabbar":
      return [];
  }
}

// ── Types: decisions (the Hill's decision shape, as a trick lists it) ───────────────────────

/** `priority`: a request, not a fact. Only `now` pushes. Absent is `today`. The hill's words. */
export const DECISION_PRIORITIES = HILL_PRIORITIES;
export type DecisionPriority = HillPriority;
export const DEFAULT_DECISION_PRIORITY: DecisionPriority = "today";
/** `text`: whether the person may, or must, add words to the answer. The hill's words. Absent is `optional`. */
export const DECISION_TEXT_MODES = HILL_TEXT_MODES;
export type DecisionTextMode = HillTextMode;
export const DEFAULT_DECISION_TEXT: DecisionTextMode = "optional";
export { HILL_NODE_PREFIX };

/** An option: a named intent in the tree's shape. Collie runs none; it routes the chosen intent to the trick. */
export interface DecisionOption {
  intent: string;
  label: string;
  detail?: string;
  /**
   * The second label, the tree button's `confirm` (VOCABULARY.md 2.8): the phone arms the option on the
   * first tap and sends the intent on the second. The bridge sees one intent.
   */
  confirm?: string;
}
/** The trick's pick, never an answer: never pre-selected, never taken on a timeout. */
export interface DecisionRecommends {
  intent: string;
  why: string;
}
export interface DecisionMedia {
  /**
   * An image in the trick folder, as a relative path. The runner hands its real path to the hill, which
   * reads it, keeps a copy and decides its type by its first bytes: PNG, JPEG or WebP, at most
   * `HILL_MEDIA_BYTES_MAX` (bridge/tricks/hill.ts).
   */
  file: string;
  caption?: string;
}
export interface DecisionLink {
  label: string;
  href: string;
}
/**
 * One decision the trick wants open on the Hill. The list is declarative: the runner diffs it after
 * every run, posts a new key once, withdraws a dropped key, and supersedes a key whose content changed.
 * The answer comes back as a tap with `node` `hill/<key>`.
 */
export interface TrickDecision {
  key: string;
  title: string;
  summary: string;
  body?: string;
  options?: DecisionOption[];
  recommends?: DecisionRecommends | null;
  priority?: DecisionPriority;
  /** Whether the person may (`optional`, the default), must (`required`) or may not (`none`) add words. */
  text?: DecisionTextMode;
  /** A session's scope key from the facts: the card opens its Chat. */
  about?: string;
  /** A session's scope key: the person's words reach it as the person's own walky message. */
  replyTo?: string;
  media?: DecisionMedia[];
  links?: DecisionLink[];
  /** Epoch ms. Past it the decision closes as expired. */
  expiresAt?: number;
  /** A small display-only view under the summary (`parseDecisionView`): facts to read, never a control. */
  view?: View;
}

/** A decision's priority, its default filled. */
export function decisionPriority(decision: TrickDecision): DecisionPriority {
  return decision.priority ?? DEFAULT_DECISION_PRIORITY;
}

/** The program's output, as written. There is no `draft` and no `open`: a trick never writes into a reply box. */
export interface TrickDocument {
  /** The trick contract the document follows: 1 to {@link DOCUMENT_VERSION}. */
  v: number;
  parts: TrickPart[];
  asOf?: string;
  fresh?: string;
  decisions?: TrickDecision[];
}

// ── Types: the manifest and the facts ────────────────────────────────────────────────────────

/** `trick.toml`, read and with its defaults filled. A runtime value, not a file to write back. */
export interface TrickManifest {
  id: string;
  name: string;
  /**
   * The program's command line. Absent only for a trick that is an agent view and nothing else (places
   * exactly `["agent-view"]`, no `every`, `inputs` or `env`): such a trick has no program and never runs.
   */
  run?: string;
  every?: string;
  everyMs?: number;
  watch?: string[];
  on?: TrickEvent[];
  mode: TrickMode;
  /** The trick contract the trick was written for (contract.ts). At most this Collie's `TRICK_CONTRACT`. */
  contract: number;
  icon: TrickIcon;
  places: PlaceKind[];
  /** Environment names past the base allow-list the program asks for (bridge/tricks/env.ts). */
  env?: string[];
  /**
   * Contract 2: globs of files the program reads from its agent sessions' folders, on every machine of a
   * crew (M99, {@link inputGlobProblem}). The bridge fetches them before each run into `inputs/` of the
   * approved copy. Untrusted data: a program reads them, never runs them.
   */
  inputs?: string[];
  /**
   * One plain line saying what the trick does, at most `DESCRIPTION_MAX` characters. Text, not a right: it is
   * not in the powers (`powersOf`), and it is part of the code hash like any manifest change.
   */
  description?: string;
  /**
   * The full plain text of the trick's About sheet, at most `ABOUT_MAX` characters, paragraphs split by a
   * blank line. No markdown, no HTML, no link is drawn. Text, not a right, like `description`.
   */
  about?: string;
  /**
   * Contract 2: the manifest lists the place word `agent-view`, a view of a session that the session's own
   * agent draws ({@link AGENT_VIEW_PLACE}). Kept apart from `places`, which are the places a document's
   * parts draw in. A right: it is in the powers. The bridge draws the view (bridge/agent-view/service.ts).
   */
  agentView?: true;
  /**
   * Contract 2: the file name of the instructions the session's agent reads (`rules.md`), one step in the
   * folder ({@link rulesNameProblem}). Required with `agent-view`, refused without it.
   */
  rules?: string;
  /**
   * The bytes of the rules file as text, set by the bridge's folder reader (discover.ts `readManifestFile`)
   * once the file passed {@link rulesTextProblems}: printable ASCII and `\n` only, so the text is the bytes.
   * Absent from a manifest read from its text alone.
   */
  rulesText?: string;
  /** The SHA-256 (hex) of the rules file's bytes, set with {@link rulesText}. In the powers. */
  rulesSha256?: string;
}

/**
 * What a tap carries back to the program: a button's `value` (text), or a decision's answer, the
 * person's words (`{ text }`, `null` when they only tapped an option).
 */
export type TapValue = string | { text: string | null };

export type FactsTrigger =
  | { kind: "start" }
  | { kind: "timer" }
  | {
      kind: "tap";
      rid: string;
      node: string;
      intent: string;
      value?: TapValue;
      from?: TapFrom;
      /**
       * Only on the answer to a decision (`hill/<key>`): the content hash of the version of the decision
       * the person saw, the one the runner posted. A trick that changed the decision since can tell an
       * answer to the old words from one to the new. Absent when the bridge lost track of it.
       */
      seen?: string;
    }
  /** A later slice: a watched file changed. */
  | { kind: "watch"; path: string }
  /** A later slice: an event of the bus, with the session it is about. */
  | { kind: "event"; event: TrickEvent; session?: string };

export interface FactsSession {
  /**
   * The scope key `<memberId>:paneId`, the address a decision's `about` and `replyTo` name. The part
   * before the first colon is the session's `memberId`; read that field instead of parsing this one.
   */
  id: string;
  /**
   * The bridge the session runs on: its crew member id, or on a solo install its install id (`m_` and
   * ten of `[a-z0-9]`, minted once and kept). Stable across a host rename. Never a host name.
   */
  memberId: string;
  /** The session's id, an opaque string. UNSTABLE until v2 session ids exist; never parse it. */
  sessionId: string;
  /** The multiplexer pane the session is bound to now. */
  paneId: string;
  /** The machine's name, for display only. Never a key. */
  host: string;
  name?: string;
  agent?: string;
  status: SessionStatus;
  cwd?: string;
  space?: string;
  tab?: string;
  lastActiveAt?: string;
  /**
   * On a crew's lead only: whether the lead's last sweep reached the session's machine. The lead's own
   * sessions are always `true`. Absent on a solo bridge, where every session is this machine's.
   */
  reachable?: boolean;
  /**
   * Contract 2, for a trick that lists `inputs` only: the files of the session's folder its globs match,
   * fetched before the run into the trick's `inputs/` folder (M99). UNTRUSTED data: never run it.
   */
  inputs?: FactsInputs;
}
/**
 * Where a session's inputs stand: `ok` (read; `files` may be empty), `offline` (its machine did not
 * answer), `older` (its machine runs a Collie without trick reads), `refused` (its machine switched trick
 * reads off), `none` (no folder to read: a shell, or a session with no folder of its own).
 */
export const INPUT_STATES = ["ok", "offline", "older", "refused", "none"] as const;
export type InputState = (typeof INPUT_STATES)[number];
/** A text file, or a picture sniffed as PNG, JPEG or WebP. */
export const INPUT_KINDS = ["text", "image"] as const;
export type InputKind = (typeof INPUT_KINDS)[number];
/** The most files one session's inputs hold. */
export const INPUT_FILES_MAX = 32;
/** One file of a session's inputs. */
export interface FactsInputFile {
  /** The file's path relative to the session's folder, as the glob matched it. */
  rel: string;
  /** Where the copy is, relative to the trick's folder (`trick.dir`, the program's working folder): `inputs/...`. A Decision's `media` may name it. */
  path: string;
  bytes: number;
  /** The SHA-256 of the copy's bytes, hex. */
  sha256: string;
  /** When the file last changed on its machine, an ISO 8601 instant. */
  mtime: string;
  kind: InputKind;
}
export interface FactsInputs {
  state: InputState;
  files: FactsInputFile[];
  /** Files the globs matched that were left out: too large, not text or a picture, or past a cap. Absent when none. */
  skipped?: number;
}
export interface FactsSpace {
  name: string;
  folder?: string;
}
export interface TrickFacts {
  /** The trick contract these facts follow (contract.ts): the trick's own `contract`, 1 when it names none. */
  contract: number;
  trigger: FactsTrigger;
  trick: { id: string; dir: string; state: string };
  /** The bridge that runs the trick: the key a program keeps (see `FactsSession.memberId`). */
  memberId: string;
  /** The machine's name, for display only. It changes when the machine is renamed; never key on it. */
  host: string;
  sessions: FactsSession[];
  spaces: FactsSpace[];
  /** How many sessions the facts left out past {@link FACT_SESSIONS_MAX} or {@link FACT_SESSIONS_MAX_BYTES}. Absent when none. */
  sessionsOmitted?: number;
}

// ── Types: taps and the wire ─────────────────────────────────────────────────────────────────

/** Where a tap came from: the session open on the phone, when there is one. */
export interface TapFrom {
  session?: string;
}
/**
 * `POST /api/tricks/<host>/<id>/tap`, the tree's `POST /intent` shape `{ rid, node, intent, value }`.
 * `node` is the id of the part that holds the control, or `hill/<key>` for a decision's answer.
 * A `confirm` button sends one intent, after the phone's second tap.
 */
export interface TapRequest {
  /** A UUID minted by the phone. A known `rid` answers its receipt again and runs nothing. */
  rid: string;
  node: string;
  intent: string;
  value?: TapValue;
  from?: TapFrom;
}
/**
 * The body a phone posts: the request, and the rev of the part as the phone drew it (fault A). The
 * bridge checks the rev and strips it, so a program's trigger is the {@link TapRequest} alone.
 */
export interface TapBody extends TapRequest {
  rev?: number;
}
/**
 * The receipt codes, the tree's (VOCABULARY.md 5). The first schema's codes map onto them: `applied`
 * is `ok`; `replayed` is the same receipt again, from the receipt log; `failed` (the program exited
 * badly, its output was refused, the trick is off) is `rejected`; a timeout is `unknown`. `changed`,
 * `gone` and `denied` are the tree's race guard, a closed decision, and a device with no write right.
 */
export const TAP_CODES = ["ok", "changed", "rejected", "gone", "denied", "unknown"] as const;
export type TapCode = (typeof TAP_CODES)[number];
/**
 * Why the bridge refused a phone's tap before anything ran (fault A), beside the receipt's code. The
 * phone says each in its own words, never the code. `part`: the trick holds no such part now. `intent`:
 * the part has no control that sends this intent. `value`: no control of that intent sends this value.
 * `changed`: the part moved since the phone drew it (the code is `changed`; the phone draws the new one
 * and sends nothing again). `session`: `from.session` is no agent session the bridge lists now.
 */
export const TAP_REFUSALS = ["part", "intent", "value", "changed", "session"] as const;
export type TapRefusal = (typeof TAP_REFUSALS)[number];
/**
 * The bridge's line for each refused tap, in the reply's `message` (bridge/tricks/service.ts), for
 * `collie trick` and a phone that predates `refused`; a phone that reads `refused` says it in its own
 * words. It lives here so the tricks catalogue names the same lines on the reference page.
 */
export const TAP_REFUSED_LINES = {
  part: "The trick holds no such part now, so nothing ran.",
  intent: "No control of this part sends that intent, so nothing ran.",
  value: "No control of this part sends that value, so nothing ran.",
  changed: "The part changed since the phone drew it, so nothing ran. Look at it again.",
  session: "The tap names no agent session that is open here now, so nothing ran.",
} as const satisfies Readonly<Record<TapRefusal, string>>;
/**
 * The tap reply: the receipt and the trick's new parts, which the phone applies at once. A repeat
 * `rid` returns the first reply and runs nothing. `unknown` is shown and never resent.
 */
export interface TrickTapReply {
  rid: string;
  code: TapCode;
  /** One masked line, at most `PROBLEM_MAX`, for every code but `ok`. */
  message?: string;
  /** Set when the bridge refused the tap before anything ran (fault A): why, as a word the phone says in its own words. */
  refused?: TapRefusal;
  /** `tricksRev` after the run. */
  rev?: number;
  /** This trick's parts that changed, as in `TricksReply.parts`. */
  parts?: WireTrickPart[];
  /** This trick's part keys now present. */
  present?: string[];
}

/** The (host, trick, part) a stored part is keyed on, from slice 1, so the crew merge needs no rename. */
export interface TrickPartKey {
  /**
   * The bridge's member id (`FactsSession.memberId`): its crew member id, or its install id on a solo
   * install. Named `host` since slice 1; it is never the machine's host name.
   */
  host: string;
  trick: string;
  part: string;
}
/** One stored part on the wire. */
export interface WireTrickPart extends TrickPartKey {
  /** Rises when this part changes. The phone redraws in place on a higher rev. */
  rev: number;
  value: TrickPart;
  asOf?: string;
  fresh?: string;
  /** The last run failed or this part was refused: this is the last good version. */
  stale?: true;
  /** One masked line about why it is stale, at most `PROBLEM_MAX`. */
  problem?: string;
}
export const TRICK_STATES = ["ok", "failing", "stopped", "off", "skipped"] as const;
/**
 * A trick's state on the wire: `ok`; `failing` (backing off); `stopped` (backoff ran out); `off` (the
 * switch); `skipped` (the manifest was refused, or asks for a newer trick contract).
 */
export type TrickState = (typeof TRICK_STATES)[number];
/** One trick as the phone lists it: belt order, Settings → Tricks, the doctor row's summary. */
export interface WireTrickInfo {
  /** The bridge's member id, as in `TrickPartKey.host`. Never the machine's host name. */
  host: string;
  id: string;
  name: string;
  icon: TrickIcon;
  on: boolean;
  state: TrickState;
  places: PlaceKind[];
  /** One masked line, at most `PROBLEM_MAX`. */
  error?: string;
  /** When the program last ran, an instant. Absent before the first run. */
  lastRunAt?: string;
  /**
   * The refusals of the manifest and of the last document, capped like the parser's, so Settings →
   * Tricks and the doctor row can say why a trick is skipped or a part stale.
   */
  refusals?: Refusal[];
  /** Who added the trick, when and from where. */
  provenance?: TrickProvenance;
  /**
   * True when the trick is on and its folder no longer hashes to the version a person approved. Since the
   * approved copy (bridge/tricks/approved.ts) the trick keeps running that version, and `pending` says
   * what waits; an older bridge stopped the trick instead.
   */
  changed?: boolean;
  /**
   * The new version of an on trick that waits for a person's yes: a snapshot of its folder taken once the
   * folder settled. Absent when there is none, and from an older bridge.
   */
  pending?: WireTrickPending;
  /**
   * True when the trick's last good document listed at least one Decision. With the Hill switched off
   * (the snapshot's `hillOff`), its row in Settings says those Decisions are not shown.
   */
  decides?: boolean;
  /**
   * Fault B: the trick stopped because its approved copy asks for other rights than the person approved, as
   * this bridge reads them. The row says so in the phone's words; `error` carries the bridge's English line.
   * Absent: the rights hold, or an older bridge.
   */
  rightsMoved?: true;
  /** The environment names the manifest asks for past the base allow-list, so the person sees them. */
  env?: string[];
  /**
   * Contract 2 (M99): the globs the trick reads from its agent sessions' folders, and whether this bridge
   * leads a crew (the files then come from every machine). The row says it in one sentence
   * ({@link inputsSentence}). Absent: no inputs, or an older bridge.
   */
  inputs?: { globs: string[]; crew: boolean };
  /** The manifest's one-line `description`, at most `DESCRIPTION_MAX` characters. Absent: none, or an older bridge. */
  description?: string;
  /** The manifest's `about` text for the About sheet, at most `ABOUT_MAX` characters. Absent: none, or an older bridge. */
  about?: string;
  /**
   * Contract 2: the manifest lists `agent-view`. The About sheet says the two lines of that right, and the
   * row names the agent view as the trick's place. Absent: none, or an older bridge.
   */
  agentView?: true;
  /**
   * Contract 2: the instructions the trick gives the session's agent, the rules file's name and its bytes as
   * text, whole ({@link rulesTextProblems} holds them to printable ASCII and `\n`). The About sheet shows
   * them raw in a fold. Absent: none, or an older bridge.
   */
  rules?: WireTrickRules;
  /**
   * Set by the phone's own reader, never by a bridge (review 8 V-N5): the trick is an agent view, or the
   * bridge sent rules, but no rules this phone can show arrived. The trick then cannot be switched on here.
   */
  rulesUnshown?: true;
  /**
   * The code hash (64 hex) a switch on approves, as the row and the About sheet show the trick now: the
   * waiting version's, else the folder's (review 8 V-N1). The switch sends it back, and the bridge refuses
   * a switch on that names another. Absent: nothing to approve (a folder that does not hash), or an older bridge.
   */
  approves?: string;
  /**
   * What a text search of the code flags (bridge/tricks/scan.ts), one entry per kind, for a trick that is
   * off or changed, so the person sees them before the switch. Absent when there is none, on a trick that
   * is on and unchanged, and from an older bridge. A warning never refuses: the switch stays one tap.
   */
  warnings?: WireTrickWarning[];
  /**
   * Take a new version whose rights did not change without asking (crew slice 3), on a trick that is on.
   * Absent: off, or an older bridge.
   */
  auto?: boolean;
  /**
   * When the version that runs was taken without asking (ISO time), while an earlier version is there to
   * go back to. Settings then offers Undo. Absent otherwise, and from an older bridge.
   */
  autoAt?: string;
}
/** A trick's rules on the wire: the file's name and its bytes as text, whole. */
export type WireTrickRules = {
  file: string;
  text: string;
};

/** The kinds of warning the check scan gives. A phone reads a kind it does not know as plain text. */
export const TRICK_WARNING_KINDS = ["spawn", "network", "write", "model", "import"] as const;
export type TrickWarningKind = (typeof TRICK_WARNING_KINDS)[number];
/** One warning on a trick's row: its kind and one plain English sentence. */
export interface WireTrickWarning {
  kind: string;
  text: string;
}
/** The most warnings a trick's row carries. */
export const TRICK_WARNINGS_MAX = 8;
/** A new version of a trick that waits for a person's yes (`WireTrickInfo.pending`). */
export interface WireTrickPending {
  /** The code hash of the waiting version, 64 hex: what a yes approves. */
  hash: string;
  /** How many code files it adds, changes and removes against the version that runs. */
  files: { added: number; changed: number; removed: number };
  /** Whether the rights its manifest asks for (environment names, places) differ from the version that runs. */
  powersChanged: boolean;
  /** The warnings of the check scan that are new since the version that runs, one per kind. */
  warnings: WireTrickWarning[];
}
/**
 * How a trick came to be on the machine. `folder` is a folder made by hand or by `collie trick init`;
 * `cli`, `agent` and `repo` are for `collie trick add`, which records `at`, `repo` and `sha`.
 */
export interface TrickProvenance {
  via: "folder" | "cli" | "agent" | "repo";
  at?: string;
  repo?: string;
  sha?: string;
  /**
   * Set for a trick `collie trick propose` handed in (crew slice 8): who proposed it and the machine, as
   * the lead named it. Absent for any other trick, and from an older bridge. `by: "terminal"` means no
   * agent pane was placed: the machine is known, the session is not confirmed.
   */
  proposed?: { by: "agent" | "terminal"; host: string };
  /**
   * Set when `repo` is an official repository of the official list but this folder is not a version of
   * the list (official.ts `isUnlistedOfficialOrigin`): the phone says it is not on the official list.
   */
  unlisted?: true;
}
/**
 * `GET /api/tricks?since=<rev>`. The snapshot carries `tricksRev`; when it moves, the phone asks for the
 * parts changed since the rev it holds. `since=0` gives every part. DECISION: the reply also carries
 * the trick list, which is small, so the belt's order and the switch need no second route.
 */
export interface TricksReply {
  /** The `tricksRev` this reply brings the phone to. */
  rev: number;
  tricks: WireTrickInfo[];
  /** Parts whose rev is above `since`. */
  parts: WireTrickPart[];
  /** Every part key present now (`partKey`). A key the phone holds and this list lacks is gone. */
  present: string[];
  /** The PATH the bridge's runner gives programs, for `collie doctor`. The phone may ignore it. */
  path?: string;
  /**
   * Set when this bridge schedules no tricks because another machine of its crew does: a crew member,
   * a deputy or a deposed lead (bridge/index.ts). Absent on a lead and a solo bridge.
   */
  runsOn?: TricksRunsOn;
}

/** Where a bridge that schedules no tricks says they run: the lead's member id, when it knows it. */
export interface TricksRunsOn {
  lead?: string;
}

/**
 * Where one entry of the official list stands on this machine (bridge/tricks/official.ts): `absent`
 * (no folder of its id), `added` (a folder from the same repository and folder at the list's commit),
 * `update` (the same, at another commit) or `taken` (a folder of its id from anywhere else, never written over).
 */
export const OFFICIAL_STATES = ["absent", "added", "update", "taken"] as const;
export type OfficialState = (typeof OFFICIAL_STATES)[number];

/** One entry of the official list as the phone reads it (`GET /api/tricks/official`). */
export interface WireOfficialTrick {
  id: string;
  name: string;
  /** One line, at most `DESCRIPTION_MAX` characters. */
  description: string;
  /** The repository's https URL. */
  repo: string;
  /** The repository's short name, `owner/repo`. */
  repoName: string;
  /** The commit this Collie release expects, 40 hex. */
  commit: string;
  state: OfficialState;
  /**
   * Set on a `taken` entry whose folder came from this repository and folder, but not from the list: another
   * ref (a pull request's, a branch nobody listed) or a record without `official`. Absent otherwise.
   */
  unlisted?: true;
  /**
   * Set on a `taken` entry whose folder is a version of the list by its origin record, but whose code is
   * not that version's code any more: the person changed its files. Collie never updates it. Absent otherwise.
   */
  changed?: true;
  /**
   * Contract 2: the entry's trick gives its agents instructions. The list pins their sha256 (official.ts
   * `rules`) and the add refuses a folder whose rules file differs (review 8 V-N3). The text is not on the
   * list and nothing is fetched before Add, so the About sheet says to read them after the add; the trick
   * stays off until switched on. Absent: it gives none, or an older bridge.
   */
  givesRules?: true;
}

/** `GET /api/tricks/official`: the list with each entry's state, empty with `runsOn` on a machine that runs no tricks. */
export interface OfficialTricksReply {
  tricks: WireOfficialTrick[];
  runsOn?: TricksRunsOn;
}

/** The string key of a stored part. None of the three may hold `/`, so it splits back. */
export function partKey(key: TrickPartKey): string {
  return `${key.host}/${key.trick}/${key.part}`;
}
/** `partKey` read back, or `undefined`. */
export function parsePartKey(text: string): TrickPartKey | undefined {
  const pieces = text.split("/");
  if (pieces.length !== 3) return undefined;
  const [host, trick, part] = pieces;
  if (host === undefined || trick === undefined || part === undefined) return undefined;
  if (!isHostName(host) || !isTrickId(trick) || !isPartId(part)) return undefined;
  return { host, trick, part };
}

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────

/** Every refusal code, as data, so the contract reference lists them from here. */
export const REFUSAL_CODES = [
  "size",
  "json",
  "version",
  "unknown-key",
  "unknown-kind",
  "removed",
  "parent",
  "place",
  "later",
  "undeclared",
  "missing",
  "type",
  "text",
  "range",
  "count",
  "word",
  "icon",
  "id",
  "duplicate",
  "target",
  "status",
  "depth",
  "more",
  // Notes of a tolerant read (`ParsedTrickDocument.notes`), never refusals: a node or a part left out,
  // and a key or an attribute ignored.
  "dropped",
  "ignored",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/**
 * Why something was refused. `path` is a JSON pointer into the document (`/parts/0/view/2/attrs/tone`;
 * `""` is the whole document). `reason` is a sentence the doctor row and `collie trick check` print as
 * they are. `part` is the id of the refused part, `decision` the key of the refused decision, when it
 * had a readable one.
 */
export interface Refusal {
  code: RefusalCode;
  path: string;
  reason: string;
  part?: string;
  decision?: string;
}

/** A JSON pointer one step down (RFC 6901 escaping, so a key with `/` or `~` stays one step). */
export function pointer(base: string, key: string | number): string {
  return `${base}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function capRefusals(refusals: Refusal[]): Refusal[] {
  if (refusals.length <= REFUSALS_MAX) return refusals;
  const rest = refusals.length - REFUSALS_MAX;
  return [...refusals.slice(0, REFUSALS_MAX), { code: "more", path: "", reason: `And ${rest} more.` }];
}

// ── Small rules ──────────────────────────────────────────────────────────────────────────────

const TRICK_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PART_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DECISION_KEY = /^[a-z0-9-]{1,64}$/;
const INTENT = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANG = /^[a-z0-9][a-z0-9+#._-]{0,23}$/;
const EPOCH_MS = /^\d{1,16}$/;
const DECIMAL = /^(0|[1-9]\d{0,14})(\.\d{1,6})?$/;
const WHOLE = /^(0|[1-9]\d{0,8})$/;
/** The mux id rule (bridge/mux/identity.ts): no control character, no whitespace, no `/`, `?`, `#`. */
const UNSAFE_ID_CHAR = /[\p{C}\s/?#]/u;
const MUX_ID_MAX_BYTES = 128;
/** An instant: date, time, optional fraction, `Z` or an offset. `Date.parse` must also accept it. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const INSTANT_MAX = 40;
/**
 * An image node's `src`: a file in the trick's own `media/` folder, the one folder the bridge serves
 * (bridge/tricks/media.ts) and the code hash leaves out. No step starts with a dot (no `.`, `..` or
 * hidden name), and the type is one the route sends: PNG, JPEG or WebP.
 */
// `media/` is matched as written (a `MEDIA/` folder is another folder); the extension in either case.
const IMAGE_SRC = /^media\/(?!(?:.*\/)?\.)[A-Za-z0-9._\-/]+\.(?:[pP][nN][gG]|[jJ][pP][eE]?[gG]|[wW][eE][bB][pP])$/;
/** A decision's media `file`: the image `src` rule, and WebP too, which the hill keeps. */
const MEDIA_FILE = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._\-/]+\.(png|jpe?g|webp)$/i;
/** The latest instant `Date` holds, in ms. */
const EPOCH_MAX_MS = 8_640_000_000_000_000;

/** A trick id: what `trick.toml` names and the folder is called. 1 to 32 of `a-z 0-9 -`. */
export function isTrickId(text: string): boolean {
  return TRICK_ID.test(text);
}
/** A part id, unique inside its document. Same rule as a trick id. */
export function isPartId(text: string): boolean {
  return PART_ID.test(text);
}
/** A decision key, unique inside its document: 1 to 64 of `a-z 0-9 -`. */
export function isDecisionKey(text: string): boolean {
  return DECISION_KEY.test(text);
}
/** An intent name: 1 to 48 of `a-z 0-9 . _ -`. */
export function isIntentName(text: string): boolean {
  return INTENT.test(text);
}
/** A tap's `node`: a part id, or `hill/<decision key>`. */
export function isTapNode(text: string): boolean {
  if (text.startsWith(HILL_NODE_PREFIX)) return isDecisionKey(text.slice(HILL_NODE_PREFIX.length));
  return isPartId(text);
}
/**
 * A host name as the crew names machines. DECISION: `trick` is reserved, so `trick:<host>:<id>` (a trick
 * session's id) can never read as a real session's scope key.
 */
export function isHostName(text: string): boolean {
  return HOST.test(text) && text !== "trick";
}
/** A tap's `rid`: a UUID, as every receipt route in the bridge keys on. */
export function isRequestId(text: string): boolean {
  return UUID.test(text);
}
/** An instant in epoch milliseconds as digits, the tree's `at` (VOCABULARY.md 1). */
export function isEpochMs(text: string): boolean {
  return EPOCH_MS.test(text) && Number(text) <= EPOCH_MAX_MS;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The prefix every trick session id, trick tab id and Tricks Space id starts with. Reserved: no real pane takes it. */
export const TRICK_SESSION_PREFIX = "trick:";
/**
 * A real session's scope key, `memberId:paneId`. The pane id follows the mux id rule and may hold colons
 * itself (`w6X:3`). A name (`composer`) has no host and is not one. A trick session's id
 * (`trick:lodge:legs`) is not one either: it has no reply box and no terminal.
 */
export function isScopeKey(text: string): boolean {
  const colon = text.indexOf(":");
  if (colon <= 0) return false;
  const host = text.slice(0, colon);
  const paneId = text.slice(colon + 1);
  if (!isHostName(host)) return false;
  if (paneId.length === 0 || utf8Bytes(paneId) > MUX_ID_MAX_BYTES) return false;
  // A pane id that starts with `trick:` is a trick session's (`lodge:trick:lodge:legs:legs`): it has no
  // reply box, so it is never a real session's key. The prefix is reserved on the bridge too: the
  // durable adapter drops a pane, tab or space of that name (WIRE.md, the id rule).
  if (paneId.startsWith(TRICK_SESSION_PREFIX)) return false;
  return !UNSAFE_ID_CHAR.test(paneId);
}
/**
 * The schemes a browser runs or loads on its own, and the two a trick may name as a URL. A scope key
 * whose host is one of them reads as that scheme to every reader that is not Collie (`javascript:x`
 * is a valid scope key by shape: host `javascript`, pane id `x`), so an `href` never takes it as a
 * session. A machine of one of these names keeps its facts; only a link to its sessions is refused.
 */
const SCHEME_HOSTS: ReadonlySet<string> = new Set(["javascript", "vbscript", "data", "file", "blob", "about", "filesystem", "http", "https"]);

/** A session an `href` may open: a scope key in the facts' exact shape (`isScopeKey`), never one whose host reads as a URL scheme. */
export function isLinkSessionKey(text: string): boolean {
  if (!isScopeKey(text)) return false;
  return !SCHEME_HOSTS.has(text.slice(0, text.indexOf(":")).toLowerCase());
}
/** A trick session id read back: the host and the trick, and the part when the id names one. */
export interface TrickSessionAddress {
  host: string;
  trick: string;
  part?: string;
}
/**
 * Read a trick session's id: `trick:<host>:<id>` names the trick (its first session part), and
 * `trick:<host>:<id>:<part>` one session part of it. DECISION (slice 03): the part rides after a colon,
 * not a `/`, because the id is a pane id on the snapshot and a pane id is one URL path segment
 * (bridge/mux/identity.ts, rule 5). A host holds no colon and neither id does, so it splits back.
 */
export function parseTrickSessionId(text: string): TrickSessionAddress | undefined {
  const pieces = text.split(":");
  if ((pieces.length !== 3 && pieces.length !== 4) || pieces[0] !== "trick") return undefined;
  const host = pieces[1] ?? "";
  const trick = pieces[2] ?? "";
  if (!isHostName(host) || !isTrickId(trick)) return undefined;
  if (pieces.length === 3) return { host, trick };
  const part = pieces[3] ?? "";
  return isPartId(part) ? { host, trick, part } : undefined;
}
/** A trick session's id, `trick:<host>:<id>` or `trick:<host>:<id>:<part>`. */
export function isTrickSessionId(text: string): boolean {
  return parseTrickSessionId(text) !== undefined;
}
/**
 * The id of a trick's session: the trick's own address, or with `part` the pane id of one session part.
 * The trick's address is also the id of its tab in the Tricks Space; the Space's own id is {@link trickSpaceId}.
 */
export function trickSessionId(host: string, trick: string, part?: string): string {
  return part === undefined ? `trick:${host}:${trick}` : `trick:${host}:${trick}:${part}`;
}
/** The id of a host's Tricks Space, the one workspace its trick sessions live in. */
export function trickSpaceId(host: string): string {
  return `trick:${host}`;
}

/** An ISO 8601 instant with a zone, as `asOf` and a facts session's `lastActiveAt` need. */
export function isInstant(text: string): boolean {
  return text.length <= INSTANT_MAX && INSTANT.test(text) && !Number.isNaN(Date.parse(text));
}

/**
 * A URL a trick may open: `https://` or `http://`. Plain http is allowed because the operator opens
 * tailnet pages that have no certificate (`http://lodge:8080`); the tailnet is the transport's
 * guard there. Every other scheme (`javascript:`, `file:`, `data:`) is refused.
 */
export function isTrickUrl(text: string): boolean {
  if (text.length > URL_MAX || !(text.startsWith("https://") || text.startsWith("http://"))) return false;
  if (/[\s\p{C}]/u.test(text)) return false;
  try {
    const protocol = new URL(text).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** The trick folder's own folder of pictures: an image's `src` names a file in it. */
export const TRICK_MEDIA_DIR = "media";

/** An image `src`: `media/` and a file in it, no step that starts with a dot, a `.png`, `.jpg`, `.jpeg` or `.webp`. */
export function isImageSrc(text: string): boolean {
  return text.length <= IMAGE_SRC_MAX && IMAGE_SRC.test(text) && !text.includes("//");
}

/**
 * Where the phone reads an image node's bytes: `GET /api/tricks/<host>/<id>/<src>`, `src` being
 * `media/` and the file (bridge/tricks/media.ts). Each step is encoded on its own. `rev`, the part's
 * revision, rides as a query the bridge ignores, so a new version of the part asks again.
 */
export function trickMediaPath(host: string, trick: string, src: string, rev?: number): string {
  const file = src.split("/").map(encodeURIComponent).join("/");
  const path = `/api/tricks/${encodeURIComponent(host)}/${encodeURIComponent(trick)}/${file}`;
  return rev === undefined ? path : `${path}?rev=${String(rev)}`;
}

/** A decision's media `file`: relative to the trick folder, no `..` or `.` step, a `.png`, `.jpg`, `.jpeg` or `.webp`. */
export function isMediaFile(text: string): boolean {
  return text.length <= IMAGE_SRC_MAX && MEDIA_FILE.test(text) && !text.includes("//");
}

/** A session a `link` with `rel` `pane` or a `row` opens: a real session's scope key, or a trick session's id. */
export function isPaneTarget(text: string): boolean {
  return isScopeKey(text) || isTrickSessionId(text);
}

function codePoints(text: string): number {
  return [...text].length;
}

/** U+0000 to U+001F, U+007F to U+009F. `multiline` lets `\n` through, `tabs` lets `\t` through (WIRE.md §6 step 1). */
function hasControl(text: string, multiline: boolean, tabs: boolean): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (multiline && code === 0x0a) continue;
    if (tabs && code === 0x09) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * The invisible characters WIRE.md §6 step 2 removes: direction marks, overrides and isolates, the
 * zero-width space, the word joiner, the byte order mark and the tag block. A trick's text is refused
 * for them, not cleaned. DECISION: U+200C and U+200D (the joiners) stay allowed, because emoji
 * sequences and several scripts need them.
 */
function hasInvisible(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x200e || code === 0x200f || code === 0x061c || code === 0x200b || code === 0x2060 || code === 0xfeff) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
    if (code >= 0xe0000 && code <= 0xe007f) return true;
  }
  return false;
}

function isOneOf<T extends string>(list: readonly T[], value: string): value is T {
  return list.some((item) => item === value);
}

function keyStrings<T extends string>(record: { readonly [K in T]: string }): T[] {
  // SAFETY: `Object.keys` of a record typed with exactly the keys `T` returns those keys.
  return (Object.keys(record) as T[]).toSorted();
}

function hasKey<T extends object>(record: T, key: string): key is Extract<keyof T, string> {
  return Object.hasOwn(record, key);
}

/** The reason a table of words gives for `key`, or undefined when the word is not in it. */
function reasonOf<T extends Readonly<Record<string, string>>>(record: T, key: string): string | undefined {
  return hasKey(record, key) ? record[key] : undefined;
}

function quoteList(list: readonly string[]): string {
  return list.join(", ");
}

// ── The field reader ─────────────────────────────────────────────────────────────────────────
//
// One object at one path, with the sink its refusals go to. Each read returns the value or
// `undefined`, and pushes a refusal for a present-but-wrong value or a missing required one.

interface TextRule {
  readonly max: number;
  readonly required?: boolean;
  /** Keeps `\n` and `\t`, as WIRE.md's multi-line fields do. */
  readonly multiline?: boolean;
  /** Keeps `\t` alone: a screen line. */
  readonly tabs?: boolean;
  /** Allows text of spaces only (a `run` keeps the spaces between words). The empty string is still refused. */
  readonly blank?: boolean;
  /** Allows the empty string (a `disabled` reason). */
  readonly empty?: boolean;
}
interface IntRule {
  min: number;
  max: number;
  required?: boolean;
}

class Fields {
  readonly obj: JsonObject;
  readonly path: string;
  readonly sink: Refusal[];
  /** What the object is, in words, for the unknown-key sentence ("a belt part", "a decision"). */
  readonly what: string;
  /**
   * Set on a tolerant read (a program's output, not a Decision): an unknown key is a note here, ignored,
   * never a refusal. Absent: an unknown key refuses (strict at write).
   */
  readonly notes: Refusal[] | undefined;

  constructor(obj: JsonObject, path: string, sink: Refusal[], what: string, notes?: Refusal[]) {
    this.obj = obj;
    this.path = path;
    this.sink = sink;
    this.what = what;
    this.notes = notes;
  }

  /** Ignore `key` on a tolerant read, with a note; or refuse it. */
  unknown(code: RefusalCode, key: string, reason: string): void {
    if (this.notes === undefined) {
      this.push(code, key, reason);
      return;
    }
    this.notes.push({ code: "ignored", path: this.at(key), reason: `${reason} This Collie ignores it.` });
  }

  at(key: string): string {
    return pointer(this.path, key);
  }

  push(code: RefusalCode, key: string | undefined, reason: string): void {
    this.sink.push({ code, path: key === undefined ? this.path : this.at(key), reason });
  }

  has(key: string): boolean {
    return this.obj[key] !== undefined;
  }

  /** Refuse every key outside `allowed`. `special` keys get their own reason instead. */
  keys(allowed: readonly string[], special?: (key: string) => { code: RefusalCode; reason: string } | undefined): void {
    for (const key of Object.keys(this.obj)) {
      if (allowed.includes(key)) continue;
      const own = special?.(key);
      if (own !== undefined) {
        this.unknown(own.code, key, own.reason);
        continue;
      }
      this.unknown("unknown-key", key, `"${key}" is not part of ${this.what}.${this.notes === undefined ? " Remove it." : ""}`);
    }
  }

  missing(key: string, what: string): void {
    this.push("missing", key, `${this.what} needs "${key}": ${what}.`);
  }

  text(key: string, rule: TextRule): string | undefined {
    const raw = this.obj[key];
    if (raw === undefined) {
      if (rule.required === true) this.missing(key, `text of 1 to ${rule.max} characters`);
      return undefined;
    }
    const value = asJsonString(raw);
    if (value === undefined) {
      this.push("type", key, `"${key}" must be text.`);
      return undefined;
    }
    const problem = textProblem(value, rule);
    if (problem !== undefined) {
      this.push("text", key, `"${key}" ${problem}`);
      return undefined;
    }
    return value;
  }

  int(key: string, rule: IntRule): number | undefined {
    const raw = this.obj[key];
    if (raw === undefined) {
      if (rule.required === true) this.missing(key, `a whole number from ${rule.min} to ${rule.max}`);
      return undefined;
    }
    const value = asJsonNumber(raw);
    if (value === undefined || !Number.isInteger(value) || value < rule.min || value > rule.max) {
      this.push("range", key, `"${key}" must be a whole number from ${rule.min} to ${rule.max}.`);
      return undefined;
    }
    return value;
  }

  num(key: string, rule: IntRule): number | undefined {
    const raw = this.obj[key];
    if (raw === undefined) {
      if (rule.required === true) this.missing(key, `a number from ${rule.min} to ${rule.max}`);
      return undefined;
    }
    const value = asJsonNumber(raw);
    if (value === undefined || !Number.isFinite(value) || value < rule.min || value > rule.max) {
      this.push("range", key, `"${key}" must be a number from ${rule.min} to ${rule.max}.`);
      return undefined;
    }
    return value;
  }

  bool(key: string): boolean | undefined {
    const raw = this.obj[key];
    if (raw === undefined) return undefined;
    const value = asJsonBoolean(raw);
    if (value === undefined) this.push("type", key, `"${key}" must be true or false.`);
    return value;
  }

  word<T extends string>(key: string, list: readonly T[], required = false): T | undefined {
    const raw = this.obj[key];
    if (raw === undefined) {
      if (required) this.missing(key, `one of ${quoteList(list)}`);
      return undefined;
    }
    const value = asJsonString(raw);
    if (value !== undefined && isOneOf(list, value)) return value;
    this.push("word", key, `"${key}" must be one of: ${quoteList(list)}.`);
    return undefined;
  }

  tone(key = "tone"): Tone | undefined {
    const raw = this.obj[key];
    if (raw === undefined) return undefined;
    const value = asJsonString(raw);
    if (value === undefined) {
      this.push("word", key, `"${key}" must be one of: ${quoteList(TONES)}.`);
      return undefined;
    }
    if (isOneOf(TONES, value)) return value;
    const problem = toneProblem(value) ?? { code: "word" as const, reason: `must be one of: ${quoteList(TONES)}.` };
    this.push(problem.code, key, `"${key}" ${problem.reason}`);
    return undefined;
  }

  icon(key: string, required = false): TrickIcon | undefined {
    const raw = this.obj[key];
    if (raw === undefined) {
      if (required) this.missing(key, "an icon name");
      return undefined;
    }
    const value = asJsonString(raw);
    if (value !== undefined && isOneOf(TRICK_ICONS, value)) return value;
    this.push("icon", key, iconReason(key));
    return undefined;
  }

  array(key: string, rule: IntRule & { what: string }): JsonValue[] | undefined {
    const raw = this.obj[key];
    if (raw === undefined) {
      if (rule.required === true) this.missing(key, `a list of ${rule.min} to ${rule.max} ${rule.what}`);
      return undefined;
    }
    if (!Array.isArray(raw)) {
      this.push("type", key, `"${key}" must be a list of ${rule.what}.`);
      return undefined;
    }
    if (raw.length < rule.min || raw.length > rule.max) {
      this.push("count", key, `"${key}" holds ${raw.length}. It must hold ${rule.min} to ${rule.max} ${rule.what}.`);
      return undefined;
    }
    return raw;
  }

  object(key: string, what: string, required = false): Fields | undefined {
    const raw = this.obj[key];
    if (raw === undefined) {
      if (required) this.missing(key, what);
      return undefined;
    }
    const value = asJsonObject(raw);
    if (value === undefined) {
      this.push("type", key, `"${key}" must be ${what}.`);
      return undefined;
    }
    return new Fields(value, this.at(key), this.sink, what, this.notes);
  }

  /** An intent name. */
  intent(key: string, required: boolean): string | undefined {
    const raw = this.obj[key];
    if (raw === undefined) {
      if (required) this.missing(key, "the intent a tap sends to the program");
      return undefined;
    }
    const value = asJsonString(raw);
    if (value === undefined || !isIntentName(value)) {
      this.push("id", key, `"${key}" must be 1 to 48 of: lower-case letters, digits, ".", "_" and "-".`);
      return undefined;
    }
    return value;
  }

  /** A fixed value sent with an intent: text of at most `VALUE_MAX_BYTES` bytes. */
  value(key: string): string | undefined {
    const raw = this.obj[key];
    if (raw === undefined) return undefined;
    const value = asJsonString(raw);
    if (value === undefined) {
      this.push("type", key, `"${key}" must be text. A tap sends it as the intent's value.`);
      return undefined;
    }
    const problem = valueProblem(value);
    if (problem !== undefined) this.push(problem.code, key, `"${key}" ${problem.reason}`);
    return problem === undefined ? value : undefined;
  }
}

function textProblem(value: string, rule: TextRule): string | undefined {
  if (value === "") return rule.empty === true ? undefined : "is empty.";
  if (value.trim() === "" && rule.blank !== true) return "is empty.";
  const n = codePoints(value);
  if (n > rule.max) return `is ${n} characters. At most ${rule.max}.`;
  const multiline = rule.multiline === true;
  if (hasControl(value, multiline, multiline || rule.tabs === true)) {
    if (multiline) return "holds a control character. Only a line break and a tab are allowed.";
    return rule.tabs === true ? "holds a control character or a line break. Only a tab is allowed." : "holds a control character or a line break.";
  }
  if (hasInvisible(value)) return "holds an invisible direction or tag character. Remove it.";
  return undefined;
}

/**
 * Whether a text a trick's row carries (`description`, `about`) is fit to draw: a string within `max`
 * characters that holds no control or invisible character (a line break and a tab only when `multiline`).
 * The phone reads a crew member's reply with this, as the bridge's manifest parser checked it.
 */
export function isTrickText(value: string, rule: { max: number; multiline?: boolean }): boolean {
  return textProblem(value, rule) === undefined;
}

function valueProblem(value: string): { code: RefusalCode; reason: string } | undefined {
  const bytes = utf8Bytes(value);
  if (bytes > VALUE_MAX_BYTES) return { code: "size", reason: `is ${bytes} bytes. At most ${VALUE_MAX_BYTES}.` };
  if (value === "") return { code: "text", reason: "is empty." };
  if (hasControl(value, true, true) || hasInvisible(value)) return { code: "text", reason: "holds a control or an invisible character." };
  return undefined;
}

/** Why a word is not a tone, said after the attribute's name, or undefined for a tone. */
function toneProblem(value: string): { code: RefusalCode; reason: string } | undefined {
  if (isOneOf(TONES, value)) return undefined;
  if (isOneOf(STATUS_WORDS, value)) {
    return {
      code: "status",
      reason: `is "${value}", a session status, not a tone. A trick never draws Collie's status; use one of: ${quoteList(TONES)}.`,
    };
  }
  const old = reasonOf(OLD_TONES, value);
  if (old !== undefined) return { code: "word", reason: `is "${value}", which is not a tone since the tree vocabulary: ${old}. Tones: ${quoteList(TONES)}.` };
  return { code: "word", reason: `must be one of: ${quoteList(TONES)}.` };
}

function iconReason(key: string): string {
  return `"${key}" must be one of Collie's trick icons: ${quoteList(TRICK_ICONS)}.`;
}

/** A refusal-free check: an array of short strings. */
function readStrings(fields: Fields, key: string, rule: IntRule & { what: string; text: TextRule }): string[] | undefined {
  const list = fields.array(key, rule);
  if (list === undefined) return undefined;
  const out: string[] = [];
  let ok = true;
  list.forEach((item, i) => {
    const value = asJsonString(item);
    const path = pointer(fields.at(key), i);
    if (value === undefined) {
      fields.sink.push({ code: "type", path, reason: `Each of "${key}" must be text.` });
      ok = false;
      return;
    }
    const problem = textProblem(value, rule.text);
    if (problem !== undefined) {
      fields.sink.push({ code: "text", path, reason: `This line ${problem}` });
      ok = false;
      return;
    }
    out.push(value);
  });
  return ok ? out : undefined;
}

function itemFields(value: JsonValue, path: string, sink: Refusal[], what: string, notes?: Refusal[]): Fields | undefined {
  const obj = asJsonObject(value);
  if (obj === undefined) {
    sink.push({ code: "type", path, reason: `This must be ${what}, an object.` });
    return undefined;
  }
  return new Fields(obj, path, sink, what, notes);
}

/** What an `at` string says: the place it names. */
export interface AtReading {
  place: PlaceKind;
}

/** An `at` that does not read: `place` for a word that is no place, `later` for a later place. */
export interface AtProblem {
  reason: string;
  code: "place" | "later";
}

/** Read a part's `at`: one of the place words, nothing more. */
export function parseAt(at: string): AtReading | AtProblem {
  if (codePoints(at) > AT_MAX) return { code: "place", reason: `"at" is longer than ${AT_MAX} characters.` };
  if (isOneOf(PLACE_KINDS, at)) return { place: at };
  const word = at.startsWith("menu:") ? "menu" : at;
  const later = reasonOf(LATER_PLACE_WORDS, word);
  if (later !== undefined) return { code: "later", reason: later };
  return { code: "place", reason: `"${at}" is not a place this Collie knows. The places are: ${quoteList(PLACE_KINDS)}.` };
}

// ── The view tree reader ─────────────────────────────────────────────────────────────────────

interface ViewContext {
  kinds: readonly NodeKind[];
  nodes: number;
  /** Set once the node cap is passed, so the cap is refused once, not once per node. */
  overflow: boolean;
  /** The node cap and the depth cap: a part's view takes {@link VIEW_LIMITS}, a Decision's {@link DECISION_VIEW_LIMITS}. */
  maxNodes: number;
  maxDepth: number;
  /** A Decision's view: display only (`parseDecisionView`). */
  display: boolean;
  /** Set on a tolerant read (a part's view): an unknown kind drops its node, an unknown key is ignored. */
  notes?: Refusal[];
  /** How many images the Decision holds, when the reader knows: an image's `ref` must name one of them. */
  images?: number;
}

/** The caps of a view other than a part's own. */
interface ViewCaps {
  nodes: number;
  depth: number;
  display: boolean;
  images?: number;
}

/** How one node attribute's text is read. Exported so the tricks catalogue describes each attribute from this table, never from a copy. */
export type AttrRule =
  | { readonly kind: "word"; readonly list: readonly string[] }
  | { readonly kind: "tone" }
  | { readonly kind: "icon" }
  | { readonly kind: "text"; readonly rule: TextRule }
  | { readonly kind: "flag" }
  | { readonly kind: "badge" }
  | { readonly kind: "whole"; readonly min: number; readonly max: number }
  | { readonly kind: "decimal" }
  | { readonly kind: "epoch" }
  | { readonly kind: "style" }
  | { readonly kind: "intent" }
  | { readonly kind: "value" }
  | { readonly kind: "url" }
  | { readonly kind: "href" }
  | { readonly kind: "src" }
  | { readonly kind: "lang" }
  | { readonly kind: "focus" }
  | { readonly kind: "values" };

const TONE_RULE = { kind: "tone" } as const;
const ICON_RULE = { kind: "icon" } as const;
const BADGE_RULE = { kind: "badge" } as const;
const FLAG_RULE = { kind: "flag" } as const;
const DISABLED_RULE = { kind: "text", rule: { max: LINE_MAX, empty: true } } as const;
const EPOCH_RULE = { kind: "epoch" } as const;
const CLOCK_RULE = { kind: "word", list: CLOCKS } as const;
const STYLE_RULE = { kind: "style" } as const;

/** Each attribute's rule, by kind. The compiler holds the names to `NODE_ATTRS`. */
export const NODE_ATTR_RULES = {
  card: { tone: TONE_RULE },
  group: { label: { kind: "text", rule: { max: TITLE_MAX } }, fold: { kind: "word", list: FOLDS }, badge: BADGE_RULE },
  list: {},
  row: {
    href: { kind: "href" },
    end: { kind: "text", rule: { max: WORD_MAX } },
    badge: BADGE_RULE,
    tone: TONE_RULE,
    cut: { kind: "word", list: CUTS },
    icon: ICON_RULE,
    disabled: DISABLED_RULE,
  },
  bar: { role: { kind: "word", list: BAR_ROLES }, scroll: { kind: "word", list: BAR_SCROLLS }, label: { kind: "text", rule: { max: LABEL_MAX } } },
  chip: {
    tone: TONE_RULE,
    icon: ICON_RULE,
    at: EPOCH_RULE,
    clock: CLOCK_RULE,
    state: { kind: "word", list: CHIP_STATES },
    current: FLAG_RULE,
    short: { kind: "text", rule: { max: SHORT_MAX } },
  },
  button: {
    intent: { kind: "intent" },
    label: { kind: "text", rule: { max: BUTTON_LABEL_MAX } },
    tone: TONE_RULE,
    disabled: DISABLED_RULE,
    pressed: { kind: "word", list: PRESSED_STATES },
    confirm: { kind: "text", rule: { max: BUTTON_LABEL_MAX } },
    badge: BADGE_RULE,
    icon: ICON_RULE,
    hint: { kind: "text", rule: { max: LINE_MAX } },
    does: { kind: "word", list: BUTTON_DOES },
    value: { kind: "value" },
  },
  para: { role: { kind: "word", list: PARA_ROLES }, bullet: { kind: "text", rule: { max: BULLET_MAX } }, term: { kind: "text", rule: { max: LABEL_MAX } } },
  line: { style: STYLE_RULE, role: { kind: "word", list: LINE_ROLES } },
  run: { style: STYLE_RULE, code: FLAG_RULE, href: { kind: "url" }, at: EPOCH_RULE, clock: CLOCK_RULE },
  code: { lang: { kind: "lang" }, max: { kind: "whole", ...VIEW_LIMITS.codeMax } },
  link: { href: { kind: "href" }, rel: { kind: "word", list: LINK_RELS }, badge: BADGE_RULE, icon: ICON_RULE },
  image: {
    src: { kind: "src" },
    alt: { kind: "text", rule: { max: LINE_MAX, empty: true } },
    w: { kind: "whole", ...VIEW_LIMITS.imageSide },
    h: { kind: "whole", ...VIEW_LIMITS.imageSide },
    ref: { kind: "whole", min: 0, max: HILL_MEDIA_MAX - 1 },
    caption: { kind: "text", rule: { max: HILL_MEDIA_CAPTION_MAX } },
    fit: { kind: "word", list: IMAGE_FITS },
    focus: { kind: "focus" },
  },
  meter: {
    value: { kind: "decimal" },
    max: { kind: "decimal" },
    tone: TONE_RULE,
    label: { kind: "text", rule: { max: LABEL_MAX } },
    role: { kind: "word", list: METER_ROLES },
  },
  spacer: { label: { kind: "text", rule: { max: LABEL_MAX } } },
  number: { label: { kind: "text", rule: { max: LABEL_MAX } }, tone: TONE_RULE, unit: { kind: "text", rule: { max: WORD_MAX } } },
  compare: {},
  table: {},
  col: { align: { kind: "word", list: COL_ALIGNS } },
  cell: { tone: TONE_RULE },
  diff: { file: { kind: "text", rule: { max: LINE_MAX } } },
  spark: { values: { kind: "values" }, tone: TONE_RULE, label: { kind: "text", rule: { max: LABEL_MAX } } },
} as const satisfies { readonly [K in NodeKind]: { readonly [A in (typeof NODE_ATTRS)[K][number]]: AttrRule } };

/** The kids count each container takes. */
export const KIDS_COUNT = {
  card: VIEW_LIMITS.kids,
  group: VIEW_LIMITS.kids,
  list: VIEW_LIMITS.listKids,
  row: { min: 0, max: VIEW_LIMITS.kids.max },
  bar: VIEW_LIMITS.barKids,
  para: VIEW_LIMITS.runs,
  line: VIEW_LIMITS.runs,
  code: VIEW_LIMITS.codeLines,
  compare: { min: 2, max: 2 },
  table: { min: 2, max: TABLE_LIMITS.cols.max * (TABLE_LIMITS.rows.max + 1) },
} as const satisfies { readonly [K in ContainerKind]: { min: number; max: number } };

/** What a parent is, in words, for a refusal about its kids. */
type Parent = ContainerKind | "view";

function kindsUnder(parent: Parent): readonly NodeKind[] {
  return parent === "view" ? VIEW_ROOT_KINDS : NODE_KIDS[parent];
}

function parentWords(parent: Parent): string {
  return parent === "view" ? "a view" : `a ${parent}`;
}

function isContainer(kind: NodeKind): kind is ContainerKind {
  return hasKey(NODE_KIDS, kind);
}

function readView(value: JsonValue | undefined, path: string, sink: Refusal[], kinds: readonly NodeKind[], caps?: ViewCaps, notes?: Refusal[]): View | undefined {
  if (asJsonObject(value) !== undefined) {
    sink.push({ code: "type", path, reason: '"view" is a list of nodes now, the kids of the place\'s frame. Wrap the node in [ ].' });
    return undefined;
  }
  if (!Array.isArray(value)) {
    sink.push({ code: "type", path, reason: '"view" must be a list of nodes.' });
    return undefined;
  }
  if (value.length < VIEW_LIMITS.root.min || value.length > VIEW_LIMITS.root.max) {
    sink.push({ code: "count", path, reason: `"view" holds ${value.length}. It must hold ${VIEW_LIMITS.root.min} to ${VIEW_LIMITS.root.max} nodes.` });
    return undefined;
  }
  const ctx: ViewContext = { kinds, nodes: 0, overflow: false, maxNodes: caps?.nodes ?? VIEW_LIMITS.nodes.max, maxDepth: caps?.depth ?? VIEW_LIMITS.depth.max, display: caps?.display ?? false };
  if (notes !== undefined && ctx.display === false) ctx.notes = notes;
  if (caps?.images !== undefined) ctx.images = caps.images;
  const before = sink.length;
  const out: ViewNode[] = [];
  value.forEach((item, i) => {
    const node = readNode(item, pointer(path, i), sink, ctx, 1, "view");
    if (node !== undefined) out.push(node);
  });
  if (ctx.overflow) {
    sink.push({ code: "count", path, reason: `The view holds more than ${ctx.maxNodes} nodes. Draw less, or split it.` });
    return undefined;
  }
  return sink.length === before ? out : undefined;
}

/** A node as the parser builds it, before every rule of its kind has passed. */
interface NodeReading {
  kind: NodeKind;
  text?: string;
  attrs?: JsonObject;
  kids?: ViewNode[];
}

function readNode(value: JsonValue | undefined, path: string, sink: Refusal[], ctx: ViewContext, depth: number, parent: Parent): ViewNode | undefined {
  ctx.nodes += 1;
  if (ctx.nodes > ctx.maxNodes) {
    ctx.overflow = true;
    return undefined;
  }
  if (depth > ctx.maxDepth) {
    sink.push({ code: "depth", path, reason: `The view nests deeper than ${ctx.maxDepth} levels.` });
    return undefined;
  }
  const obj = asJsonObject(value);
  if (obj === undefined) {
    sink.push({ code: "type", path, reason: 'A view node must be an object with a "kind".' });
    return undefined;
  }
  const rawKind = asJsonString(obj.kind);
  if (rawKind === undefined) {
    sink.push({ code: "missing", path: pointer(path, "kind"), reason: 'A view node needs "kind".' });
    return undefined;
  }
  const kindPath = pointer(path, "kind");
  if (!isOneOf(NODE_KINDS, rawKind)) {
    const removed = reasonOf(REMOVED_KINDS, rawKind);
    // Tolerant: a kind this Collie does not know (a newer Collie's, or one of the first schema's) is left
    // out with one note, and the rest of the view draws.
    if (ctx.notes !== undefined) {
      const why = removed === undefined ? `"${rawKind}" is not a node kind this Collie knows` : `"${rawKind}" is not in a trick's vocabulary: ${removed}`;
      ctx.notes.push({ code: "dropped", path: kindPath, reason: `${why}. This Collie leaves the node out; the rest draws.` });
      return undefined;
    }
    sink.push(
      removed === undefined
        ? { code: "unknown-kind", path: kindPath, reason: `"${rawKind}" is not a node kind. Use one of: ${quoteList(NODE_KINDS)}.` }
        : { code: "removed", path: kindPath, reason: `"${rawKind}" is not in a trick's vocabulary: ${removed}.` },
    );
    return undefined;
  }
  const kind: NodeKind = rawKind;
  const notShown = ctx.display ? reasonOf(DECISION_VIEW_REFUSED, kind) : undefined;
  if (notShown !== undefined) {
    sink.push({ code: "removed", path: kindPath, reason: `A Decision's view takes no "${kind}": ${notShown}.` });
    return undefined;
  }
  // A Decision's view names only the kinds it draws, so the hint never offers a card or a button.
  const allowed = ctx.display ? kindsUnder(parent).filter((k) => reasonOf(DECISION_VIEW_REFUSED, k) === undefined) : kindsUnder(parent);
  if (!allowed.includes(kind)) {
    sink.push({ code: "parent", path: kindPath, reason: `A "${kind}" cannot sit in ${parentWords(parent)}. ${capital(parentWords(parent))} holds: ${quoteList(allowed)}.` });
    return undefined;
  }
  if (!ctx.kinds.includes(kind)) {
    if (ctx.notes !== undefined) {
      ctx.notes.push({ code: "dropped", path: kindPath, reason: `"${kind}" is not drawn by this Collie. It leaves the node out; the rest draws.` });
      return undefined;
    }
    sink.push({ code: "later", path: kindPath, reason: `"${kind}" is not in this Collie yet.` });
    return undefined;
  }
  const before = sink.length;
  const f = new Fields(obj, path, sink, `a "${kind}" node`, ctx.notes);
  f.keys(NODE_KEYS, (key) => nodeKeyHint(kind, key));
  const node: NodeReading = { kind };
  readNodeText(kind, f, node);
  const beforeAttrs = sink.length;
  const attrs = readAttrs(kind, f);
  if (attrs !== undefined) node.attrs = attrs;
  const attrsClean = sink.length === beforeAttrs;
  const kids = readKids(kind, f, ctx, depth);
  if (kids !== undefined) node.kids = kids;
  checkNode(kind, f, attrsClean ? (attrs ?? {}) : undefined, kids, ctx);
  if (ctx.display) checkDisplayOnly(kind, f);
  // SAFETY: every key of `node` passed its kind's rule above (the text, each attribute, each kid), and a
  // refusal of any of them returns `undefined` here, so what is left is exactly the kind's node type.
  return sink.length === before ? (node as ViewNode) : undefined;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A hint for a key a node does not take: an attribute written at the top, or a first-schema key. */
function nodeKeyHint(kind: NodeKind, key: string): { code: RefusalCode; reason: string } | undefined {
  const names: readonly string[] = NODE_ATTRS[kind];
  if (names.includes(key)) return { code: "unknown-key", reason: `"${key}" is an attribute: put it in "attrs", as text.` };
  if (key === "children") return { code: "unknown-key", reason: '"children" is "kids" in the tree vocabulary.' };
  if (key === "id") return { code: "unknown-key", reason: '"id" is the bridge\'s to set; it gives every node its id.' };
  if (kind === "table" && (key === "columns" || key === "rows" || key === "items")) {
    return { code: "unknown-key", reason: `"${key}" is not a table's: it lists its "col" heads, then its "cell"s row by row, in "kids".` };
  }
  return undefined;
}

function readNodeText(kind: NodeKind, f: Fields, node: NodeReading): void {
  const rule = hasKey(NODE_TEXT, kind) ? NODE_TEXT[kind] : undefined;
  if (rule === undefined) {
    if (f.has("text")) f.unknown("unknown-key", "text", textHome(kind));
    return;
  }
  // `para` and `line` take text or kids; `chip` takes text or a clock. `checkNode` holds those pairs.
  const text = f.text("text", rule);
  if (text !== undefined) node.text = text;
}

function textHome(kind: NodeKind): string {
  switch (kind) {
    case "button":
      return 'A button takes no "text"; its words are the "label" attribute.';
    case "image":
      return 'An image takes no "text"; its words are the "alt" attribute in a part, and "caption" in a Decision\'s view.';
    case "meter":
    case "spacer":
    case "spark":
      return `A ${kind} takes no "text"; its words are the "label" attribute.`;
    case "compare":
      return 'A compare takes no "text"; its two images name themselves with "caption".';
    case "table":
      return 'A table takes no "text"; its words are its "col" heads and its "cell"s.';
    default:
      return `A ${kind} takes no "text". Put a para or a line in its kids.`;
  }
}

function readAttrs(kind: NodeKind, f: Fields): JsonObject | undefined {
  const required: readonly string[] = hasKey(NODE_REQUIRED_ATTRS, kind) ? NODE_REQUIRED_ATTRS[kind] : [];
  if (!f.has("attrs")) {
    for (const name of required) f.push("missing", "attrs", `${f.what} needs the attribute "${name}".`);
    return undefined;
  }
  const a = f.object("attrs", "an object of attributes, each one text");
  if (a === undefined) return undefined;
  const rules: { readonly [name: string]: AttrRule } = NODE_ATTR_RULES[kind];
  const out: JsonObject = {};
  let ignored = false;
  for (const name of Object.keys(a.obj)) {
    // M1 (review 11): an OWN rule only. `rules[name]` alone finds `constructor`, `toString` and the other
    // members of Object's prototype, which then passed with no cap and no filter; `__proto__` was dropped
    // with no note. Each is an attribute this Collie does not know: a note, or a refusal where it is closed.
    const rule = hasKey(rules, name) ? rules[name] : undefined;
    if (rule === undefined) {
      a.unknown(attrCode(name), name, attrReason(kind, name));
      ignored = true;
      continue;
    }
    const raw = a.obj[name];
    const value = asJsonString(raw);
    if (value === undefined) {
      const example = asJsonNumber(raw) !== undefined ? ` Write it as "${String(raw)}".` : asJsonBoolean(raw) === true ? ' A flag is "" when it is on.' : "";
      a.push("type", name, `"${name}" must be text: every attribute is text, as in the tree.${example}`);
      continue;
    }
    const problem = attrProblem(rule, value);
    if (problem !== undefined) {
      a.push(problem.code, name, `"${name}" ${problem.reason}`);
      continue;
    }
    out[name] = value;
  }
  for (const name of required) if (a.obj[name] === undefined) a.missing(name, "an attribute");
  // Every attribute ignored: the node draws as if it had none, not with an empty "attrs".
  if (ignored && Object.keys(out).length === 0) return undefined;
  return out;
}

function attrCode(name: string): RefusalCode {
  if (name === "state" || isOneOf(STATUS_MARK_KEYS, name)) return "status";
  return "unknown-key";
}

function attrReason(kind: NodeKind, name: string): string {
  const own = reasonOf(TREE_ONLY_ATTRS, name);
  if (own !== undefined) return `"${name}" ${own}.`;
  const list: readonly string[] = NODE_ATTRS[kind];
  return list.length === 0 ? `A ${kind} takes no attributes.` : `"${name}" is not an attribute of a ${kind}. It takes: ${quoteList(list)}.`;
}

function attrProblem(rule: AttrRule, value: string): { code: RefusalCode; reason: string } | undefined {
  switch (rule.kind) {
    case "word":
      if (rule.list === BUTTON_DOES && !isOneOf(rule.list, value)) {
        return { code: "word", reason: 'must be "copy". A trick\'s button copies or sends an intent; install, notify, reload and wipe are Collie\'s.' };
      }
      return isOneOf(rule.list, value) ? undefined : { code: "word", reason: `must be one of: ${quoteList(rule.list)}.` };
    case "tone":
      return toneProblem(value);
    case "icon":
      return isOneOf(TRICK_ICONS, value) ? undefined : { code: "icon", reason: `must be one of Collie's trick icons: ${quoteList(TRICK_ICONS)}.` };
    case "text": {
      const problem = textProblem(value, rule.rule);
      return problem === undefined ? undefined : { code: "text", reason: problem };
    }
    case "flag":
      return value === "" ? undefined : { code: "type", reason: 'is a flag: "" when it is on, left out when it is off.' };
    case "badge": {
      if (value === "") return undefined;
      return WHOLE.test(value) && Number(value) <= COUNT_MAX ? undefined : { code: "range", reason: `is a count from 0 to ${COUNT_MAX}, or "" for a dot.` };
    }
    case "whole":
      return WHOLE.test(value) && Number(value) >= rule.min && Number(value) <= rule.max
        ? undefined
        : { code: "range", reason: `must be a whole number from ${rule.min} to ${rule.max}, as text.` };
    case "decimal":
      return DECIMAL.test(value) ? undefined : { code: "range", reason: 'must be a number of 0 or more, as text, such as "68" or "0.5".' };
    case "epoch":
      return isEpochMs(value) ? undefined : { code: "range", reason: 'must be an instant in epoch milliseconds, as digits, such as "1794130692000".' };
    case "style": {
      const words = value.split(" ");
      const bad = words.find((word) => !isOneOf(STYLE_WORDS, word));
      if (value === "" || bad !== undefined) {
        return { code: "word", reason: `is a list of style words with single spaces between: fg-<name>, bg-<name> (${quoteList(ANSI_NAMES)}), bold, dim, italic, underline, inverse, strike, box and the syn-* inks.` };
      }
      return new Set(words).size === words.length ? undefined : { code: "word", reason: "names a style word twice." };
    }
    case "intent":
      return isIntentName(value) ? undefined : { code: "id", reason: 'must be 1 to 48 of: lower-case letters, digits, ".", "_" and "-".' };
    case "value":
      return valueProblem(value);
    case "url":
      return isTrickUrl(value) ? undefined : { code: "target", reason: `must be an https:// or http:// address of at most ${URL_MAX} characters.` };
    case "href":
      // A row's or a link's target: its shape depends on the link's `rel`, which `checkNode` reads.
      return value === "" ? { code: "text", reason: "is empty." } : undefined;
    case "src":
      return isImageSrc(value) ? undefined : { code: "target", reason: 'must name a .png, .jpg, .jpeg or .webp file in the trick\'s "media/" folder, such as "media/chart.png", with no step that starts with a dot.' };
    case "lang":
      return LANG.test(value) ? undefined : { code: "word", reason: 'must be a language word of 1 to 24 of a-z, 0-9, "+", "#", ".", "_", "-".' };
    case "focus":
      return readFocus(value) === undefined
        ? { code: "range", reason: `is "<x> <y>" or "<x> <y> <zoom>" with a space between: x and y from ${FOCUS_LIMITS.point.min} to ${FOCUS_LIMITS.point.max} (percent across and down), zoom from ${FOCUS_LIMITS.zoom.min} to ${FOCUS_LIMITS.zoom.max}, such as "50 30 2".` }
        : undefined;
    case "values":
      return readSparkValues(value) === undefined
        ? { code: "range", reason: `is ${SPARK_LIMITS.values.min} to ${SPARK_LIMITS.values.max} numbers with one space between, such as "3 5 4.5 -2".` }
        : undefined;
  }
}

/** A number of a `focus` or a spark's `values`: digits, an optional point and fraction, and for a value an optional minus. */
const SIGNED_DECIMAL = /^-?(0|[1-9]\d{0,14})(\.\d{1,6})?$/;

/** An image's crop, read from its `focus` text. */
export interface Focus {
  /** The point to keep in the middle, in percent across (`x`) and down (`y`) the picture. */
  x: number;
  y: number;
  /** How far in: 1 is the whole picture. */
  zoom: number;
}

/** A `focus` text as numbers, or `undefined` when it is not one ("50 30" or "50 30 2"). The renderer reads it with this too. */
export function readFocus(text: string): Focus | undefined {
  const parts = text.split(" ");
  if (parts.length !== 2 && parts.length !== 3) return undefined;
  if (!parts.every((part) => DECIMAL.test(part))) return undefined;
  const [x, y, zoom] = parts.map(Number);
  const inPoint = (n: number | undefined) => n !== undefined && n >= FOCUS_LIMITS.point.min && n <= FOCUS_LIMITS.point.max;
  const z = zoom ?? 1;
  if (!inPoint(x) || !inPoint(y) || z < FOCUS_LIMITS.zoom.min || z > FOCUS_LIMITS.zoom.max) return undefined;
  return { x: x ?? 0, y: y ?? 0, zoom: z };
}

/** A spark's `values` text as numbers, or `undefined` when it is not 2 to 32 numbers with one space between. */
export function readSparkValues(text: string): number[] | undefined {
  const parts = text.split(" ");
  if (parts.length < SPARK_LIMITS.values.min || parts.length > SPARK_LIMITS.values.max) return undefined;
  if (!parts.every((part) => SIGNED_DECIMAL.test(part))) return undefined;
  return parts.map(Number);
}

function readKids(kind: NodeKind, f: Fields, ctx: ViewContext, depth: number): ViewNode[] | undefined {
  if (!isContainer(kind)) {
    if (f.has("kids")) f.unknown("unknown-key", "kids", `A ${kind} holds no kids.`);
    return undefined;
  }
  const count = KIDS_COUNT[kind];
  const required = count.min > 0 && kind !== "para" && kind !== "line";
  const list = f.array("kids", { ...count, required, what: `nodes (${quoteList(NODE_KIDS[kind])})` });
  if (list === undefined) return undefined;
  const out: ViewNode[] = [];
  list.forEach((child, i) => {
    const node = readNode(child, pointer(f.at("kids"), i), f.sink, ctx, depth + 1, kind);
    if (node !== undefined) out.push(node);
  });
  return out;
}

/**
 * The rules that hold between a node's text, attributes and kids. `attrs` is undefined when one of
 * them was refused already: the rules between attributes then wait for the author's next try.
 */
function checkNode(kind: NodeKind, f: Fields, attrs: JsonObject | undefined, kids: ViewNode[] | undefined, ctx: ViewContext): void {
  const attrsPath = f.at("attrs");
  const pushAttr = (code: RefusalCode, name: string, reason: string) => f.sink.push({ code, path: pointer(attrsPath, name), reason });
  const attr = (name: string) => asJsonString(attrs?.[name]);
  const hasText = f.has("text");
  const hasKids = f.has("kids");
  switch (kind) {
    case "para":
      if (hasText === hasKids) f.push("target", undefined, 'A para holds "text", or "kids" of run and link, exactly one.');
      return;
    case "line":
      if (hasText && hasKids) f.push("target", undefined, 'A line holds "text", or "kids" of run and link, never both.');
      return;
    case "chip":
    case "run": {
      const at = f.has("attrs") ? asJsonObject(f.obj.attrs) : undefined;
      if ((at?.at === undefined) !== (at?.clock === undefined)) {
        f.sink.push({ code: "target", path: attrsPath, reason: `A ${kind}'s "at" and "clock" go together: the instant and how to tell it.` });
      }
      if (kind === "chip" && !hasText && at?.at === undefined) f.missing("text", "its words, unless it is a clock");
      return;
    }
    case "row":
      checkRowKids(f, kids ?? []);
      checkHref(pushAttr, "href", attr("href"), "row");
      return;
    case "link":
      checkHref(pushAttr, "href", attr("href"), attr("rel") ?? "link");
      return;
    case "button": {
      if (attrs === undefined) return;
      const does = attr("does");
      const intent = attr("intent");
      if (does === "copy" && attr("value") === undefined) pushAttr("missing", "value", 'A button with "does": "copy" needs "value", the text it copies.');
      if (does === "copy" && intent !== undefined) pushAttr("target", "intent", 'A button that copies sends no intent. Remove "intent".');
      if (does === undefined && intent === undefined) pushAttr("missing", "intent", 'A button needs "intent", the intent a tap sends, or "does": "copy".');
      return;
    }
    case "meter":
      if (attrs !== undefined) checkMeter(pushAttr, attrs);
      return;
    case "image":
      checkImage(f, pushAttr, ctx);
      return;
    case "table":
      // A kid refused on its own rule already says what is wrong; the rows are counted once every kid passed.
      if (kids !== undefined && Array.isArray(f.obj.kids) && kids.length === f.obj.kids.length) checkTable(f, kids);
      return;
    case "diff":
      checkDiff(f);
      return;
    case "card":
    case "group":
    case "list":
    case "bar":
    case "code":
    case "spacer":
    case "number":
    case "compare":
    case "col":
    case "cell":
    case "spark":
      return;
  }
}

/** The attributes an image takes in a part only, and in a Decision's view only. `caption`, `fit` and `focus` are both's. */
const PART_IMAGE_ATTRS = ["src", "alt", "w", "h"] as const;
const VIEW_IMAGE_ATTRS = ["ref"] as const;

/**
 * An image in its place's form: in a part a file of the trick folder (`src`, `alt`, `w`, `h`, all four),
 * in a Decision's view one of the Decision's images (`ref`, and `caption` and `fit` if it likes). A
 * `ref` past the Decision's images is refused when the reader knows how many it holds.
 */
function checkImage(f: Fields, push: (code: RefusalCode, name: string, reason: string) => void, ctx: ViewContext): void {
  const raw = f.has("attrs") ? asJsonObject(f.obj.attrs) : undefined;
  const has = (name: string) => raw?.[name] !== undefined;
  const [needs, other] = ctx.display ? [["ref"] as const, PART_IMAGE_ATTRS] : [PART_IMAGE_ATTRS, VIEW_IMAGE_ATTRS];
  for (const name of other) {
    if (!has(name)) continue;
    push(
      "unknown-key",
      name,
      ctx.display
        ? `A Decision's image takes no "${name}": it names one of the Decision's images with "ref" (0 is the first), and may add "caption", "fit" and "focus".`
        : `A part's image takes no "${name}": it names a file of the trick folder with "src", "alt", "w" and "h", and may add "caption", "fit" and "focus".`,
    );
  }
  for (const name of needs) {
    if (has(name)) continue;
    if (raw === undefined) f.push("missing", "attrs", `An image needs the attribute "${name}".`);
    else push("missing", name, `An image needs the attribute "${name}".`);
  }
  const ref = asJsonString(raw?.ref);
  if (!ctx.display || ref === undefined || ctx.images === undefined || !WHOLE.test(ref)) return;
  if (Number(ref) >= ctx.images) {
    const held = ctx.images === 0 ? "holds no images" : `holds ${String(ctx.images)} image${ctx.images === 1 ? "" : "s"}, "ref" 0 to ${String(ctx.images - 1)}`;
    push("target", "ref", `"ref" is ${ref}, but the Decision ${held}.`);
  }
}

/**
 * A table: its column heads first, 1 to 4, then its cells row by row, a whole row at a time, 1 to 12
 * rows. A head after a cell, a row cut short and a table with no row are refused.
 */
function checkTable(f: Fields, kids: ViewNode[]): void {
  const firstCell = kids.findIndex((kid) => kid.kind === "cell");
  const cols = firstCell === -1 ? kids.length : firstCell;
  const cells = kids.length - cols;
  if (kids.slice(cols).some((kid) => kid.kind === "col")) {
    f.push("target", "kids", 'A table lists its "col" heads first, then its cells: a "col" after a "cell" is refused.');
    return;
  }
  if (cols < TABLE_LIMITS.cols.min || cols > TABLE_LIMITS.cols.max) {
    f.push("count", "kids", `A table has ${String(cols)} columns. It takes ${String(TABLE_LIMITS.cols.min)} to ${String(TABLE_LIMITS.cols.max)} "col" heads.`);
    return;
  }
  if (cells === 0 || cells % cols !== 0) {
    f.push("count", "kids", `A table's ${String(cells)} cells do not fill rows of ${String(cols)}. List each row whole, one "cell" per column; an empty cell is "".`);
    return;
  }
  const rows = cells / cols;
  if (rows > TABLE_LIMITS.rows.max) f.push("count", "kids", `A table has ${String(rows)} rows. It takes at most ${String(TABLE_LIMITS.rows.max)}.`);
}

/** A diff's lines: at most 40, each at most 200 characters. */
function checkDiff(f: Fields): void {
  const text = asJsonString(f.obj.text);
  if (text === undefined) return;
  const lines = text.split("\n");
  if (lines.length > DIFF_LIMITS.lines) {
    f.push("count", "text", `A diff holds ${String(lines.length)} lines. It shows at most ${String(DIFF_LIMITS.lines)}: cut it to the hunk that matters.`);
    return;
  }
  const long = lines.findIndex((line) => codePoints(line) > DIFF_LIMITS.lineChars);
  if (long !== -1) f.push("text", "text", `A diff's line ${String(long + 1)} is ${String(codePoints(lines[long] ?? ""))} characters. Each line holds at most ${String(DIFF_LIMITS.lineChars)}.`);
  // Code shows as it is or not at all (review 7 M1): a line separator, a blank-looking letter or a
  // zero-width character would let a person read other code than the code that runs.
  // A control or a direction mark the text rule refused already is said once.
  const hidden = textProblem(text, NODE_TEXT.diff) === undefined ? lines.findIndex((line) => hasHiddenChar(line)) : -1;
  if (hidden !== -1) {
    const ch = firstHiddenChar(lines[hidden] ?? "") ?? "";
    f.push("text", "text", `A diff's line ${String(hidden + 1)} holds ${codePointName(ch)}, a character that does not show as itself. A diff shows code as it is.`);
  }
}

/** A row: at most one `para`, any `chip`, at most one `button`, and the button last (VOCABULARY.md 2.12). */
function checkRowKids(f: Fields, kids: ViewNode[]): void {
  const paras = kids.filter((k) => k.kind === "para").length;
  const buttons = kids.filter((k) => k.kind === "button").length;
  if (paras > 1) f.push("count", "kids", "A row holds at most one para, its second line.");
  if (buttons > 1) f.push("count", "kids", "A row holds at most one button, at its end.");
  if (buttons === 1 && kids.at(-1)?.kind !== "button") f.push("target", "kids", "A row's button is its last kid: it sits at the row's end.");
}

/**
 * A row's or a link's target (step 3): an `http://` or `https://` URL, or a real session's scope key
 * in the exact shape the facts give (`isScopeKey`, host and pane id, the pane id with its index). Any
 * other text is refused, `javascript:` and `file:` among it, and so are a file path and a trick
 * session's id: the phone opens a page in the browser or a Session one level down, nothing else.
 * A link's `rel` narrows it: `url` takes the URL, `pane` the scope key; `file` is not in this Collie.
 */
function checkHref(push: (code: RefusalCode, name: string, reason: string) => void, name: string, href: string | undefined, rel: string): void {
  if (href === undefined) return;
  const url = isTrickUrl(href);
  const session = isLinkSessionKey(href);
  switch (rel) {
    case "url":
      if (!url) push("target", name, `"href" must be an https:// or http:// address of at most ${URL_MAX} characters (with "rel" "url").`);
      return;
    case "pane":
      if (!session) push("target", name, '"href" must be a session\'s "id" from the facts (memberId:paneId), never a name (with "rel" "pane").');
      return;
    case "file":
      push("target", name, '"rel": "file" is not in this Collie: a trick opens a page or a session, never a file. Use an https:// or http:// address.');
      return;
    case "row":
    case "link":
      if (!url && !session) push("target", name, '"href" must be an https:// or http:// address, or a session\'s "id" from the facts (memberId:paneId). Nothing else opens.');
      return;
    default:
      // A bad `rel` is refused on its own; the href is not read against it.
      return;
  }
}

/** A meter: `value` within `max` (default 1); a progress counts to at most 12; a measure needs its value. */
function checkMeter(push: (code: RefusalCode, name: string, reason: string) => void, attrs: JsonObject): void {
  const role = asJsonString(attrs.role) ?? "meter";
  const valueText = asJsonString(attrs.value);
  const maxText = asJsonString(attrs.max);
  const max = maxText === undefined ? 1 : Number(maxText);
  if (role === "progress" && maxText !== undefined && !(WHOLE.test(maxText) && max >= VIEW_LIMITS.progressMax.min && max <= VIEW_LIMITS.progressMax.max)) {
    push("range", "max", `A progress counts to a whole number from ${VIEW_LIMITS.progressMax.min} to ${VIEW_LIMITS.progressMax.max}. For a percent, give "value" as a part of 1 ("0.68").`);
    return;
  }
  if (role === "meter" && maxText !== undefined && max <= 0) push("range", "max", '"max" must be above 0.');
  if (role === "meter" && valueText === undefined) push("missing", "value", 'A meter with role "meter" needs "value". Only a progress may leave it out (indeterminate).');
  if (valueText !== undefined && Number(valueText) > max) push("range", "value", `"value" is above "max" (${maxText ?? "1"}).`);
}

// ── A Decision's view (M96) ──────────────────────────────────────────────────────────────────
//
// A Decision may carry a small view under its summary: a few rows, a strip of chips, a code hunk, the
// facts a person reads before they choose. It is DISPLAY ONLY. The options are the Decision's taps, so
// its view holds no control: no `button`, no `intent`, `does`, `confirm` or `href` on any node but a
// `link` or a `row`, and those open a web page only. No `card` (the Decision's card is its frame). An
// `image` or a `compare` names the Decision's own images by `ref` (2026-11-10), so a poster places a
// picture among the facts, cropped by `focus`, and needs no image tool. It is the part view's parser,
// the same function, with these rules and smaller caps on top: the bridge refuses a post that breaks
// one, and the phone drops what it cannot read and keeps the rest and the Decision.

/** The kinds a Decision's view may hold. */
export const DECISION_VIEW_KINDS = [
  "group",
  "list",
  "row",
  "bar",
  "chip",
  "para",
  "line",
  "run",
  "code",
  "link",
  "meter",
  "spacer",
  "number",
  "image",
  "compare",
  "table",
  "col",
  "cell",
  "diff",
  "spark",
] as const satisfies readonly NodeKind[];

/** The caps of a Decision's view: its compact JSON, every node counted, and the nesting. */
export const DECISION_VIEW_LIMITS = { bytes: 8 * 1024, nodes: 100, depth: 4 } as const;

/** The kinds a Decision's view refuses, each with what to write instead. */
const DECISION_VIEW_REFUSED = {
  button: "no buttons, the options are the taps",
  card: "the Decision's card is its frame; list the nodes without one",
} as const satisfies Readonly<Record<string, string>>;

/** The attributes that act. On a Decision's view a `link` and a `row` keep one, their `href`, as a web address. */
const ACTING_ATTRS = ["intent", "does", "confirm", "href"] as const;

/** The kinds whose `href` a Decision's view keeps: a web address, drawn with its host. */
const VIEW_HREF_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(["link", "row"]);

/**
 * A Decision's view acts on nothing: no acting attribute but the `href` of a link or a row, and that
 * one a web address (a session's scope key and `rel: "pane"` open a Session, which a view never does).
 * One refusal per path: a shape the generic rule already refused is not refused twice.
 */
function checkDisplayOnly(kind: NodeKind, f: Fields): void {
  const raw = f.has("attrs") ? asJsonObject(f.obj.attrs) : undefined;
  if (raw === undefined) return;
  const attrsPath = f.at("attrs");
  const refuse = (name: string, reason: string) => {
    const path = pointer(attrsPath, name);
    if (f.sink.some((refusal) => refusal.path === path)) return;
    f.sink.push({ code: "target", path, reason });
  };
  const keepsHref = VIEW_HREF_KINDS.has(kind);
  for (const name of ACTING_ATTRS) {
    // An attribute the kind never takes is refused by its own rule already: one refusal per key.
    const takes: readonly string[] = NODE_ATTRS[kind];
    if (raw[name] === undefined || !takes.includes(name) || (keepsHref && name === "href")) continue;
    refuse(name, `A Decision's view takes no "${name}" on a ${kind}: only a link or a row opens anything, and the options are the taps.`);
  }
  if (!keepsHref) return;
  const href = asJsonString(raw.href);
  if (asJsonString(raw.rel) === "pane" || (href !== undefined && !isTrickUrl(href))) {
    refuse("href", `A ${kind} in a Decision's view opens a web page: an https:// or http:// address, never a session.`);
  }
}

/** What `parseDecisionView` answers: the view when it passed, and every refusal (with a JSON pointer under `path`). */
export interface ParsedDecisionView {
  view?: View;
  refusals: Refusal[];
}

/** What `parseDecisionView` may know of the Decision around the view. */
export interface DecisionViewOptions {
  /** How many images the Decision holds. Given, an image's `ref` past them is refused; absent, any `ref` from 0 to 3 passes. */
  images?: number;
}

/**
 * Read a Decision's `view`: a list of nodes of {@link DECISION_VIEW_KINDS}, display only, at most
 * {@link DECISION_VIEW_LIMITS}. The one reader of it, for a trick's document, an agent's post and the
 * phone. Total: garbage is a refusal, never a throw.
 */
export function parseDecisionView(value: JsonValue | undefined, path = "/view", opts: DecisionViewOptions = {}): ParsedDecisionView {
  const refusals: Refusal[] = [];
  const bytes = value === undefined ? 0 : utf8Bytes(JSON.stringify(value));
  if (bytes > DECISION_VIEW_LIMITS.bytes) {
    refusals.push({ code: "size", path, reason: `The view is ${String(bytes)} bytes. A Decision's view holds at most ${String(DECISION_VIEW_LIMITS.bytes / 1024)} KiB.` });
    return { refusals };
  }
  const caps: ViewCaps = { nodes: DECISION_VIEW_LIMITS.nodes, depth: DECISION_VIEW_LIMITS.depth, display: true };
  if (opts.images !== undefined) caps.images = opts.images;
  const view = readView(value, path, refusals, DECISION_VIEW_KINDS, caps);
  return view === undefined || refusals.length > 0 ? { refusals } : { view, refusals };
}

// ── Marks ────────────────────────────────────────────────────────────────────────────────────

/** Every key a mark takes, the attributes of the tree's belt button. A tab mark takes no `intent`. */
export const MARK_KEYS = ["icon", "label", "badge", "tone", "intent"] as const;

/**
 * A mark's attributes. `tappable` is false on a tab mark: a tap on the tab opens the tab, so DECISION:
 * a tab mark takes no intent. Keys that would draw a status mark get their own reason.
 */
function readMark(f: Fields): Mark {
  const own = (key: string): { code: RefusalCode; reason: string } | undefined => {
    if (isOneOf(STATUS_MARK_KEYS, key)) return { code: "status", reason: `"${key}" would draw Collie's status mark. A trick mark draws its own icon and words; use "tone".` };
    if (key === "face") return { code: "unknown-key", reason: '"face" is "label" now, the mark\'s live word.' };
    if (key === "count") return { code: "unknown-key", reason: '"count" is "badge" now, as text ("3"), or "" for a dot.' };
    if (key === "args") return { code: "unknown-key", reason: '"args" is gone: an intent names what it does, and a button\'s "value" carries one fixed string.' };
    return undefined;
  };
  f.keys(MARK_KEYS, own);
  const mark: Mark = {};
  const icon = f.icon("icon");
  const label = f.text("label", { max: FACE_MAX });
  const badge = readBadgeAttr(f, "badge");
  const tone = f.tone();
  if (icon !== undefined) mark.icon = icon;
  if (label !== undefined) mark.label = label;
  if (badge !== undefined) mark.badge = badge;
  if (tone !== undefined) mark.tone = tone;
  if (!f.has("icon") && !f.has("label") && !f.has("badge")) {
    f.push("missing", undefined, 'A mark needs "icon", "label" or "badge". To show nothing, leave the part out.');
  }
  const intent = f.intent("intent", false);
  if (intent !== undefined) mark.intent = intent;
  return mark;
}

/**
 * A `status` part's chip: `text` (1 to {@link STATUS_TEXT_MAX} characters), `icon`, `tone`, and `at` with `clock`.
 * DECISION: no `state` (a status shape would read as "an agent needs you"), no `intent` (the chip is not a
 * control; a tap opens the trick's session when it has one), no `current` and no `short` (the cap is the
 * narrow form already).
 */
function readStatusChip(f: Fields): StatusChip {
  const own = (key: string): { code: RefusalCode; reason: string } | undefined => {
    if (isOneOf(STATUS_MARK_KEYS, key)) return { code: "status", reason: `"${key}" would draw Collie's status mark. A status chip draws its own icon and words; use "tone".` };
    if (key === "intent") return { code: "target", reason: "A status chip takes no intent: it is not a control. A tap opens the trick's session when it has one." };
    if (key === "current" || key === "short") return { code: "unknown-key", reason: `"${key}" is not part of a status chip. Its text is at most ${STATUS_TEXT_MAX} characters already.` };
    return undefined;
  };
  f.keys(SUB_KEYS.chip, own);
  const chip: StatusChip = { text: f.text("text", { max: STATUS_TEXT_MAX, required: true }) ?? "" };
  const icon = f.icon("icon");
  const tone = f.tone();
  if (icon !== undefined) chip.icon = icon;
  if (tone !== undefined) chip.tone = tone;
  const instant = readChipAttr(f, "at", EPOCH_RULE);
  const clock = readChipAttr(f, "clock", CLOCK_RULE);
  if (f.has("at") !== f.has("clock")) f.push("target", undefined, 'A chip\'s "at" and "clock" go together: the instant and how to tell it.');
  if (instant !== undefined) chip.at = instant;
  if (clock !== undefined && isOneOf(CLOCKS, clock)) chip.clock = clock;
  return chip;
}

/**
 * The `item` of a `dashboard` or a `tabbar` part: `label` (1 to {@link ITEM_LABEL_MAX} characters), `icon`,
 * `badge` and `tone`. DECISION: no `intent` (the item is not a control; a tap opens the trick's session when
 * it has one), and no key that would draw a status shape. `badge` is a count from 0 to {@link COUNT_MAX} or 1
 * to {@link BADGE_TEXT_MAX} characters, the status chip's cap, so the corner it sits in stays small.
 */
function readPlaceItem(f: Fields, place: "dashboard" | "tabbar"): PlaceItem {
  const what = place === "dashboard" ? "A Dashboard tile" : "A bottom bar item";
  const own = (key: string): { code: RefusalCode; reason: string } | undefined => {
    if (isOneOf(STATUS_MARK_KEYS, key)) return { code: "status", reason: `"${key}" would draw Collie's status mark. ${what} draws its own icon and words; use "tone".` };
    if (key === "intent") return { code: "target", reason: `${what} takes no intent: it is not a control. A tap opens the trick's session when it has one.` };
    if (key === "text") return { code: "unknown-key", reason: '"text" is "label" in an item, its short name.' };
    return undefined;
  };
  f.keys(SUB_KEYS.item, own);
  const item: PlaceItem = { label: f.text("label", { max: ITEM_LABEL_MAX, required: true }) ?? "" };
  const icon = f.icon("icon");
  const tone = f.tone();
  if (icon !== undefined) item.icon = icon;
  if (tone !== undefined) item.tone = tone;
  const badge = readItemBadge(f);
  if (badge !== undefined) item.badge = badge;
  return item;
}

/** An item's `badge`: a whole number from 0 to {@link COUNT_MAX}, or text of 1 to {@link BADGE_TEXT_MAX} characters. */
function readItemBadge(f: Fields): number | string | undefined {
  const raw = f.obj.badge;
  if (raw === undefined) return undefined;
  const count = asJsonNumber(raw);
  if (count !== undefined) {
    if (Number.isInteger(count) && count >= 0 && count <= COUNT_MAX) return count;
    f.push("range", "badge", `"badge" as a number is a count from 0 to ${COUNT_MAX}.`);
    return undefined;
  }
  if (asJsonString(raw) === undefined) {
    f.push("type", "badge", `"badge" is a count from 0 to ${COUNT_MAX}, or text of 1 to ${BADGE_TEXT_MAX} characters.`);
    return undefined;
  }
  return f.text("badge", { max: BADGE_TEXT_MAX, required: true });
}

/** A chip attribute of the tree's kind, as text, by the tree's own rule. */
function readChipAttr(f: Fields, key: string, rule: AttrRule): string | undefined {
  const raw = f.obj[key];
  if (raw === undefined) return undefined;
  const value = asJsonString(raw);
  if (value === undefined) {
    f.push("type", key, `"${key}" must be text: every attribute is text, as in the tree.`);
    return undefined;
  }
  const problem = attrProblem(rule, value);
  if (problem !== undefined) {
    f.push(problem.code, key, `"${key}" ${problem.reason}`);
    return undefined;
  }
  return value;
}

function readBadgeAttr(f: Fields, key: string): string | undefined {
  const raw = f.obj[key];
  if (raw === undefined) return undefined;
  const value = asJsonString(raw);
  const problem = value === undefined ? { code: "type" as const, reason: `must be text: a count from 0 to ${COUNT_MAX} ("3"), or "" for a dot.` } : attrProblem(BADGE_RULE, value);
  if (problem !== undefined) {
    f.push(problem.code, key, `"${key}" ${problem.reason}`);
    return undefined;
  }
  return value;
}

// ── Parts ────────────────────────────────────────────────────────────────────────────────────

/**
 * Every key the objects inside a part take, by what the refusal calls them. Exported, with
 * `PART_KEYS`, `DOCUMENT_KEYS`, `MANIFEST_KEYS`, the decision lists and the facts lists, so the
 * contract reference reads the same lists the parser holds.
 */
export const SUB_KEYS = {
  mark: MARK_KEYS,
  badge: ["count", "text"],
  progress: ["value", "max"],
  action: ["id", "label", "intent", "value", "icon", "disabled"],
  /** The chip of a `status` part: a tree chip's text and four of its attributes, never `state`, `current` or `short`. */
  chip: ["text", "icon", "tone", "at", "clock"],
  /** The item of a `dashboard` or a `tabbar` part: an icon over a short name, a badge, a tone. */
  item: ["icon", "label", "badge", "tone"],
} as const;

export const PART_KEYS = {
  belt: ["at", "id", "mark"],
  session: ["at", "id", "name", "icon", "tone", "subtitle", "badge", "progress", "actions", "view"],
  dashboard: ["at", "id", "item"],
  status: ["at", "id", "chip"],
  tabbar: ["at", "id", "item"],
} as const satisfies { readonly [K in PlaceKind]: readonly string[] };

const PLACE_WORDS = {
  belt: "a belt part",
  session: "a session part",
  dashboard: "a dashboard part",
  status: "a status part",
  tabbar: "a tabbar part",
} as const satisfies { readonly [K in PlaceKind]: string };

export interface ParseTrickDocumentOptions {
  /** The place kinds this Collie draws. Default `NEAR_PLACES`; a part in another place is left out with a note. */
  places?: readonly PlaceKind[];
  /** The node kinds this Collie draws. Default every kind. */
  kinds?: readonly NodeKind[];
  /** The manifest's `places`. Absent: not checked. A part in a kind it does not declare is refused. */
  declared?: readonly PlaceKind[];
  /**
   * The manifest's `contract`. Absent: 1. From contract 2 a part read CLOSED (fault C): a key or an
   * attribute this Collie does not know, anywhere in the part, refuses that part alone ({@link CLOSED_KEY_LINE}).
   */
  contract?: number;
}

/**
 * Fault C: what a contract 2 part with a key this Collie does not know is told, after the key's own
 * sentence. A newer key may carry a meaning this Collie cannot keep, so the part is not drawn at all,
 * not even its last good version; the other parts draw.
 */
export const CLOSED_KEY_LINE = "A contract 2 trick uses only the keys this Collie knows, so the part is left out; the other parts draw.";
/** The suffix a tolerant read puts after an ignored key's sentence (`Fields.unknown`). */
const IGNORED_SUFFIX = " This Collie ignores it.";

export interface ParsedTrickDocument {
  /** The accepted parts, in document order. */
  parts: ParsedPart[];
  /** The accepted decisions, in document order. */
  decisions: TrickDecision[];
  /** Every refusal, each with its path, capped at `REFUSALS_MAX` plus one counting row. */
  refusals: Refusal[];
  /** The ids of refused parts that had a readable id: the runner keeps their last good version, stale. */
  refusedParts: string[];
  /** The keys of refused decisions that had a readable key: the runner leaves their open post as it is. */
  refusedDecisions: string[];
  /**
   * True when the document as a whole was refused (too big, not JSON, not an object, a wrong `v`,
   * `parts` not a list): no part was read, so the runner keeps every last good part, stale.
   */
  documentRefused: boolean;
  /**
   * What the tolerant read left out, never a refusal: a node or a part this Collie does not draw
   * (`dropped`), a key or an attribute it does not know (`ignored`). Capped like the refusals.
   */
  notes: Refusal[];
  asOf?: string;
  fresh?: string;
  freshMs?: number;
}

/** Every top-level key of a trick document. */
export const DOCUMENT_KEYS = ["v", "parts", "asOf", "fresh", "decisions"] as const;
/** Top-level keys of the first schema, refused with what replaced them. */
const REMOVED_DOCUMENT_KEYS = {
  draft: '"draft" is gone: a trick never writes into a reply box. Post a decision with "replyTo", and the person\'s answer reaches the session as their own message.',
  open: '"open" is gone: a tap moves nothing on the phone. Draw a "link", or a "row" with "href".',
} as const satisfies Readonly<Record<string, string>>;

/** `parseTrickDocument` over the program's stdout text: the byte cap first, then JSON. */
export function parseTrickDocumentText(text: string, opts: ParseTrickDocumentOptions = {}): ParsedTrickDocument {
  const bytes = utf8Bytes(text);
  if (bytes > DOCUMENT_MAX_BYTES) return wholeRefused("size", `The document is ${bytes} bytes. At most ${DOCUMENT_MAX_BYTES}.`);
  const doc = parseJson(text);
  if (doc === undefined) return wholeRefused("json", "The output is not JSON. Print one JSON document and nothing else.");
  return parseTrickDocument(doc, opts);
}

function wholeRefused(code: RefusalCode, reason: string): ParsedTrickDocument {
  return { parts: [], decisions: [], refusals: [{ code, path: "", reason }], refusedParts: [], refusedDecisions: [], documentRefused: true, notes: [] };
}

/**
 * Parse a program's output. Total: any JSON value gives a result, and every refusal is collected. A
 * bad part is refused alone and the others are kept. A bad decision is refused alone too. A bad
 * `asOf` or `fresh` is refused alone, and the parts still draw. Tolerant where it reads to draw (the
 * header's "strict at write, tolerant at read"): an unknown kind or place is left out and an unknown
 * key ignored, each with a note; the decisions are read strictly.
 */
export function parseTrickDocument(raw: JsonValue | undefined, opts: ParseTrickDocumentOptions = {}): ParsedTrickDocument {
  const obj = asJsonObject(raw);
  if (obj === undefined) return wholeRefused("type", 'The document must be a JSON object with "v" and "parts".');
  const bytes = utf8Bytes(JSON.stringify(obj));
  if (bytes > DOCUMENT_MAX_BYTES) return wholeRefused("size", `The document is ${bytes} bytes. At most ${DOCUMENT_MAX_BYTES}.`);
  const refusals: Refusal[] = [];
  const notes: Refusal[] = [];
  const top = new Fields(obj, "", refusals, "a trick document", notes);
  top.keys(DOCUMENT_KEYS, (key) => {
    const removed = reasonOf(REMOVED_DOCUMENT_KEYS, key);
    return removed === undefined ? undefined : { code: "removed", reason: removed };
  });
  const refused = (): ParsedTrickDocument => ({ parts: [], decisions: [], refusals: capRefusals(refusals), refusedParts: [], refusedDecisions: [], documentRefused: true, notes: capRefusals(notes) });
  const v = asJsonNumber(obj.v);
  if (v === undefined || !Number.isInteger(v) || v < 1 || v > DOCUMENT_VERSION) {
    const said = obj.v === undefined ? 'has no "v"' : `says "v": ${JSON.stringify(obj.v)}`;
    refusals.push({ code: "version", path: "/v", reason: `The document ${said}. This Collie reads "v" from 1 to ${String(DOCUMENT_VERSION)}.` });
    return refused();
  }
  const list = top.array("parts", { min: 0, max: PARTS_MAX, required: true, what: "parts" });
  if (list === undefined) return refused();

  const result: ParsedTrickDocument = { parts: [], decisions: [], refusals, refusedParts: [], refusedDecisions: [], documentRefused: false, notes };

  const seen = new Set<string>();
  let belt = false;
  let status = false;
  let dashboard = false;
  let tabbar = false;
  list.forEach((value, i) => {
    const path = pointer("/parts", i);
    const sink: Refusal[] = [];
    const partNotes: Refusal[] = [];
    const parsed = readPart(value, path, sink, opts, partNotes);
    const id = parsed.id;
    // Fault C: from contract 2 a key this Collie does not know, at any depth of the part (a node's key or
    // attribute included), refuses the part instead of being ignored. A node or a part of a kind this
    // Collie does not draw is still only left out, with its note.
    const closed = (opts.contract ?? 1) >= 2 ? partNotes.filter((note) => note.code === "ignored") : [];
    for (const note of closed) sink.push({ code: "unknown-key", path: note.path, reason: `${note.reason.endsWith(IGNORED_SUFFIX) ? note.reason.slice(0, -IGNORED_SUFFIX.length) : note.reason} ${CLOSED_KEY_LINE}` });
    for (const note of partNotes) if (!closed.includes(note)) notes.push(id === undefined ? note : { ...note, part: id });
    // A part in a place this Collie does not draw is left out: no refusal, no last good version.
    if (parsed.dropped === true) return;
    if (id !== undefined && seen.has(id)) sink.push({ code: "duplicate", path: pointer(path, "id"), reason: `The part id "${id}" is used twice. Each part needs its own.` });
    if (parsed.part?.place === "belt" && belt) {
      sink.push({ code: "duplicate", path: pointer(path, "at"), reason: "A trick has one belt mark. This is a second one." });
    }
    if (parsed.part?.place === "status" && status) {
      sink.push({ code: "duplicate", path: pointer(path, "at"), reason: "A trick has one status item. This is a second one." });
    }
    if (parsed.part?.place === "dashboard" && dashboard) {
      sink.push({ code: "duplicate", path: pointer(path, "at"), reason: "A trick has one Dashboard tile. This is a second one." });
    }
    if (parsed.part?.place === "tabbar" && tabbar) {
      sink.push({ code: "duplicate", path: pointer(path, "at"), reason: "A trick has one bottom bar item. This is a second one." });
    }
    if (id !== undefined) seen.add(id);
    if (sink.length > 0 || parsed.part === undefined) {
      for (const r of sink) refusals.push(id === undefined ? r : { ...r, part: id });
      // A part refused for a key this Collie does not know keeps no last good version: it would be stale for good.
      if (id !== undefined && closed.length === 0) result.refusedParts.push(id);
      return;
    }
    if (parsed.part.place === "belt") belt = true;
    if (parsed.part.place === "status") status = true;
    if (parsed.part.place === "dashboard") dashboard = true;
    if (parsed.part.place === "tabbar") tabbar = true;
    result.parts.push(parsed.part);
  });
  readDecisions(top, result);
  readDocumentExtras(top, result);
  result.refusals = capRefusals(refusals);
  result.notes = capRefusals(notes);
  return result;
}

function readDocumentExtras(top: Fields, out: ParsedTrickDocument): void {
  const asOf = top.text("asOf", { max: INSTANT_MAX });
  if (asOf !== undefined && !isInstant(asOf)) top.push("text", "asOf", '"asOf" must be an ISO 8601 instant with a zone, such as 2026-11-08T09:41:00Z.');
  if (asOf !== undefined && isInstant(asOf)) out.asOf = asOf;

  const fresh = top.text("fresh", { max: 8 });
  const freshMs = fresh === undefined ? undefined : parseDuration(fresh);
  if (fresh !== undefined && (freshMs === undefined || freshMs < FRESH_MIN_MS || freshMs > FRESH_MAX_MS)) {
    top.push("range", "fresh", '"fresh" must be a duration from 5s to 24h, such as "90s", "5m" or "1h".');
  }
  if (fresh !== undefined && freshMs !== undefined && freshMs >= FRESH_MIN_MS && freshMs <= FRESH_MAX_MS) {
    out.fresh = fresh;
    out.freshMs = freshMs;
  }
}

/** One part read: its id when it had a readable one, and the part when nothing was refused. */
interface PartReading {
  id?: string;
  part?: ParsedPart;
  /** The part names a place this Collie does not draw: left out, with a note. */
  dropped?: true;
}

function readPart(value: JsonValue, path: string, sink: Refusal[], opts: ParseTrickDocumentOptions, notes: Refusal[]): PartReading {
  const obj = asJsonObject(value);
  if (obj === undefined) {
    sink.push({ code: "type", path, reason: 'A part must be an object with "at" and "id".' });
    return {};
  }
  // The place first: a part in a place this Collie does not draw (a newer Collie's, a later one) is
  // left out whole, whatever else it holds.
  const idRaw = asJsonString(obj.id);
  const id = idRaw !== undefined && isPartId(idRaw) ? idRaw : undefined;
  const atRaw = asJsonString(obj.at);
  const reading = atRaw === undefined ? undefined : parseAt(atRaw);
  if (reading !== undefined && ("reason" in reading || !(opts.places ?? NEAR_PLACES).includes(reading.place))) {
    const why = "reason" in reading ? reading.reason : `"${reading.place}" is not drawn by this Collie.`;
    notes.push({ code: "dropped", path: pointer(path, "at"), reason: `${why} This Collie leaves the part out; the other parts draw.` });
    return id === undefined ? { dropped: true } : { id, dropped: true };
  }
  if (id === undefined) {
    sink.push({ code: "id", path: pointer(path, "id"), reason: 'A part needs an "id" of 1 to 32 lower-case letters, digits and hyphens.' });
  }
  const bytes = utf8Bytes(JSON.stringify(obj));
  if (bytes > PART_MAX_BYTES) {
    sink.push({ code: "size", path, reason: `The part is ${bytes} bytes. A part may be at most ${PART_MAX_BYTES}.` });
    return { id };
  }
  if (reading === undefined) {
    sink.push({ code: "missing", path: pointer(path, "at"), reason: 'A part needs "at": where it draws.' });
    return { id };
  }
  const place = reading.place;
  if (opts.declared !== undefined && !opts.declared.includes(place)) {
    sink.push({ code: "undeclared", path: pointer(path, "at"), reason: `The manifest's "places" does not list "${place}". Add it there.` });
    return { id };
  }
  const f = new Fields(obj, path, sink, PLACE_WORDS[place], notes);
  f.keys(PART_KEYS[place], (key) => {
    // The first schema's `dashboard` took a whole view, and nothing drew it. It is one item now.
    if (place === "dashboard" && key === "view") return { code: "removed", reason: 'A dashboard part draws one tile now, not a view: give it an "item" with "label", and "icon", "badge" or "tone".' };
    return undefined;
  });
  const kinds = opts.kinds ?? NODE_KINDS;
  const part = readPartBody(place, id ?? "", f, kinds);
  return { id, part };
}

function readPartBody(place: PlaceKind, id: string, f: Fields, kinds: readonly NodeKind[]): ParsedPart | undefined {
  const view = (): View => {
    if (!f.has("view")) {
      f.missing("view", "the nodes it draws");
      return [];
    }
    return readView(f.obj.view, f.at("view"), f.sink, kinds, undefined, f.notes) ?? [];
  };
  switch (place) {
    case "belt": {
      const markFields = f.object("mark", "a mark", true);
      const mark = markFields === undefined ? {} : readMark(markFields);
      return { place: "belt", part: { at: "belt", id, mark } };
    }
    case "status": {
      const chipFields = f.object("chip", "a chip", true);
      const chip = chipFields === undefined ? { text: "" } : readStatusChip(chipFields);
      return { place: "status", part: { at: "status", id, chip } };
    }
    case "session":
      return readSessionPart(f, id, view());
    case "dashboard":
    case "tabbar": {
      const placeFields = f.object("item", "an item", true);
      const item = placeFields === undefined ? { label: "" } : readPlaceItem(placeFields, place);
      return place === "dashboard" ? { place: "dashboard", part: { at: "dashboard", id, item } } : { place: "tabbar", part: { at: "tabbar", id, item } };
    }
  }
}

function readSessionPart(f: Fields, id: string, view: View): ParsedPart {
  const part: SessionPart = { at: "session", id, view };
  const name = f.text("name", { max: NAME_MAX });
  const icon = f.icon("icon");
  const tone = f.tone();
  const subtitle = f.text("subtitle", { max: SUBTITLE_MAX });
  if (name !== undefined) part.name = name;
  if (icon !== undefined) part.icon = icon;
  if (tone !== undefined) part.tone = tone;
  if (subtitle !== undefined) part.subtitle = subtitle;
  const badgeFields = f.object("badge", 'an object with "count" or "text"');
  if (badgeFields !== undefined) {
    badgeFields.keys(SUB_KEYS.badge);
    const badge = readBadgeFields(badgeFields);
    if (badge !== undefined) part.badge = badge;
  }
  const progressFields = f.object("progress", 'an object with "value" and "max", a meter\'s progress');
  if (progressFields !== undefined) {
    const progress = readPartProgress(progressFields);
    if (progress !== undefined) part.progress = progress;
  }
  const actions = readActions(f);
  if (actions !== undefined) part.actions = actions;
  return { place: "session", part };
}

/** `count` or `text`, exactly one (WIRE.md §7.11). */
function readBadgeFields(f: Fields): Badge | undefined {
  const hasCount = f.has("count");
  const hasText = f.has("text");
  if (hasCount === hasText) {
    f.push("target", undefined, 'A badge holds "count" or "text", exactly one.');
    return undefined;
  }
  if (hasCount) {
    const count = f.int("count", { min: 0, max: COUNT_MAX });
    return count === undefined ? undefined : { count };
  }
  const text = f.text("text", { max: BADGE_TEXT_MAX });
  return text === undefined ? undefined : { text };
}

/** A trick session's `progress`: the meter shape, `value` of `max` (a whole 1 to 12, default 1). */
function readPartProgress(f: Fields): PartProgress | undefined {
  f.keys(SUB_KEYS.progress, (key) =>
    key === "kind" || key === "steps" || key === "label"
      ? { code: "unknown-key", reason: `"${key}" is gone: a session's progress is a meter's, "value" of "max" (1 to ${PROGRESS_MAX}).` }
      : undefined,
  );
  const before = f.sink.length;
  const max = f.int("max", VIEW_LIMITS.progressMax);
  const value = f.num("value", { min: 0, max: max ?? PROGRESS_MAX });
  if (value !== undefined && max === undefined && value > 1) f.push("range", "value", `"value" is above "max" (1). Give "max", or "value" as a part of 1.`);
  if (f.sink.length !== before) return undefined;
  const out: PartProgress = {};
  if (value !== undefined) out.value = value;
  if (max !== undefined) out.max = max;
  return out;
}

function readActions(f: Fields): TrickAction[] | undefined {
  const list = f.array("actions", { min: 0, max: ACTIONS_MAX, what: "actions" });
  if (list === undefined) return undefined;
  const out: TrickAction[] = [];
  const ids = new Set<string>();
  list.forEach((value, i) => {
    const a = itemFields(value, pointer(f.at("actions"), i), f.sink, "an action", f.notes);
    if (a === undefined) return;
    a.keys(SUB_KEYS.action, (key) => (key === "args" ? { code: "unknown-key", reason: '"args" is "value" now: one fixed string the tap sends.' } : undefined));
    const idRaw = asJsonString(a.obj.id);
    if (idRaw === undefined || !isPartId(idRaw)) a.push("id", "id", 'An action needs an "id" of 1 to 32 lower-case letters, digits and hyphens.');
    if (idRaw !== undefined && ids.has(idRaw)) a.push("duplicate", "id", `The action id "${idRaw}" is used twice.`);
    if (idRaw !== undefined) ids.add(idRaw);
    const label = a.text("label", { max: ACTION_LABEL_MAX, required: true });
    const action: TrickAction = { id: idRaw ?? "", label: label ?? "", intent: a.intent("intent", true) ?? "" };
    const actionValue = a.value("value");
    const icon = a.word("icon", ACTION_ICONS);
    const disabled = a.bool("disabled");
    if (actionValue !== undefined) action.value = actionValue;
    if (icon !== undefined) action.icon = icon;
    if (disabled !== undefined) action.disabled = disabled;
    out.push(action);
  });
  return out;
}

// ── Decisions ────────────────────────────────────────────────────────────────────────────────

/** Every key a decision takes (the Hill's decision shape, the fields a trick writes). */
export const DECISION_KEYS = ["key", "title", "summary", "body", "options", "recommends", "priority", "text", "about", "replyTo", "media", "links", "expiresAt", "view"] as const;
export const DECISION_OPTION_KEYS = ["intent", "label", "detail", "confirm"] as const;
export const DECISION_RECOMMENDS_KEYS = ["intent", "why"] as const;
export const DECISION_MEDIA_KEYS = ["file", "caption"] as const;
export const DECISION_LINK_KEYS = ["label", "href"] as const;

/** The Hill's fields a trick does not write: the runner and the bridge set them. */
const HILL_OWNED_KEYS = {
  id: "the bridge mints a decision's id; a trick names its own with \"key\"",
  requestId: "the runner derives the request id from the trick, the key and the content",
  from: "the runner stamps who posted it",
  supersedes: "the runner supersedes a key whose content changed",
  channel: "the channel is the Hill's",
  state: "the Hill holds a decision's state",
  at: "the bridge stamps when it took the post",
} as const satisfies Readonly<Record<string, string>>;

function readDecisions(top: Fields, out: ParsedTrickDocument): void {
  const list = top.array("decisions", { min: 0, max: DECISIONS_MAX, what: "decisions" });
  if (list === undefined) return;
  const seen = new Set<string>();
  list.forEach((value, i) => {
    const path = pointer("/decisions", i);
    const sink: Refusal[] = [];
    const reading = readDecision(value, path, sink);
    const key = reading.key;
    if (key !== undefined && seen.has(key)) sink.push({ code: "duplicate", path: pointer(path, "key"), reason: `The decision key "${key}" is used twice. Each decision needs its own.` });
    if (key !== undefined) seen.add(key);
    if (sink.length > 0 || reading.decision === undefined) {
      for (const r of sink) out.refusals.push(key === undefined ? r : { ...r, decision: key });
      if (key !== undefined) out.refusedDecisions.push(key);
      return;
    }
    out.decisions.push(reading.decision);
  });
}

/** One decision read: its key when it had a good one (for the refused list), and the decision when it passed. */
interface DecisionReading {
  key?: string;
  decision?: TrickDecision;
}

function readDecision(value: JsonValue, path: string, sink: Refusal[]): DecisionReading {
  const f = itemFields(value, path, sink, "a decision");
  if (f === undefined) return {};
  f.keys(DECISION_KEYS, (key) => {
    const own = reasonOf(HILL_OWNED_KEYS, key);
    return own === undefined ? undefined : { code: "unknown-key", reason: `"${key}" is not a trick's to write: ${own}.` };
  });
  const keyRaw = asJsonString(f.obj.key);
  const key = keyRaw !== undefined && isDecisionKey(keyRaw) ? keyRaw : undefined;
  if (key === undefined) f.push("id", "key", `A decision needs a "key" of 1 to ${DECISION_KEY_MAX} lower-case letters, digits and hyphens.`);
  const title = f.text("title", { max: HILL_TITLE_MAX, required: true });
  const summary = f.text("summary", { max: HILL_SUMMARY_MAX, required: true });
  const body = f.text("body", { max: HILL_BODY_MAX, multiline: true });
  const options = readOptions(f);
  const recommends = readRecommends(f, options);
  const priority = f.word("priority", DECISION_PRIORITIES);
  const text = f.word("text", DECISION_TEXT_MODES);
  // The hill refuses a decision that takes no words and has no option: nothing could answer it.
  if (text === "none" && (options ?? []).length === 0) f.push("target", "text", '"text": "none" needs at least one option, or nothing could answer the decision.');
  const about = readSessionKey(f, "about");
  const replyTo = readSessionKey(f, "replyTo");
  const media = readMedia(f);
  const links = readLinks(f);
  const expiresAt = f.int("expiresAt", { min: 1, max: EPOCH_MAX_MS });
  const view = f.has("view") ? parseDecisionView(f.obj.view, f.at("view"), { images: media?.length ?? 0 }) : undefined;
  if (view !== undefined) f.sink.push(...view.refusals);
  if (key === undefined || title === undefined || summary === undefined) return { key };
  const decision: TrickDecision = { key, title, summary };
  if (body !== undefined) decision.body = body;
  if (options !== undefined) decision.options = options;
  if (recommends !== undefined) decision.recommends = recommends;
  if (priority !== undefined) decision.priority = priority;
  if (text !== undefined && !(text === "none" && (options ?? []).length === 0)) decision.text = text;
  if (about !== undefined) decision.about = about;
  if (replyTo !== undefined) decision.replyTo = replyTo;
  if (media !== undefined) decision.media = media;
  if (links !== undefined) decision.links = links;
  if (expiresAt !== undefined) decision.expiresAt = expiresAt;
  if (view?.view !== undefined) decision.view = view.view;
  return { key, decision };
}

function readOptions(f: Fields): DecisionOption[] | undefined {
  const list = f.array("options", { min: 0, max: HILL_OPTIONS_MAX, what: "options" });
  if (list === undefined) return undefined;
  const out: DecisionOption[] = [];
  const intents = new Set<string>();
  list.forEach((value, i) => {
    const o = itemFields(value, pointer(f.at("options"), i), f.sink, "an option");
    if (o === undefined) return;
    o.keys(DECISION_OPTION_KEYS);
    const intentRaw = o.intent("intent", true);
    // The hill's rule for an option's intent, narrower than a button's: a lower-case word of up to 32.
    let intent = intentRaw;
    if (intentRaw !== undefined && HILL_RESERVED_INTENTS.includes(intentRaw)) {
      o.push("id", "intent", `"${intentRaw}" is the Hill's own answer. Name the option's intent another way.`);
    } else if (intentRaw !== undefined && !isHillOptionIntent(intentRaw)) {
      o.push("id", "intent", `An option's "intent" is 1 to 32 of: lower-case letters, digits and "-", starting with a letter (${String(HILL_INTENT_RE)}).`);
      intent = undefined;
    }
    if (intent !== undefined && intents.has(intent)) o.push("duplicate", "intent", `The option intent "${intent}" is used twice.`);
    if (intent !== undefined) intents.add(intent);
    const label = o.text("label", { max: HILL_OPTION_LABEL_MAX, required: true });
    const detail = o.text("detail", { max: HILL_OPTION_DETAIL_MAX });
    const confirm = o.text("confirm", { max: HILL_OPTION_CONFIRM_MAX });
    if (intent === undefined || label === undefined) return;
    const option: DecisionOption = { intent, label };
    if (detail !== undefined) option.detail = detail;
    if (confirm !== undefined) option.confirm = confirm;
    out.push(option);
  });
  return out;
}

function readRecommends(f: Fields, options: DecisionOption[] | undefined): DecisionRecommends | null | undefined {
  if (f.obj.recommends === null) return null;
  const r = f.object("recommends", 'an object with "intent" and "why", or null');
  if (r === undefined) return undefined;
  r.keys(DECISION_RECOMMENDS_KEYS);
  const intent = r.intent("intent", true);
  const why = r.text("why", { max: HILL_WHY_MAX, required: true });
  if (intent !== undefined && !(options ?? []).some((o) => o.intent === intent)) {
    r.push("target", "intent", `"recommends" names "${intent}", which is not one of the decision's options.`);
    return undefined;
  }
  return intent === undefined || why === undefined ? undefined : { intent, why };
}

function readSessionKey(f: Fields, key: string): string | undefined {
  const value = f.text(key, { max: 256 });
  if (value === undefined) return undefined;
  if (isScopeKey(value)) return value;
  const what = isTrickSessionId(value) ? `"${value}" is a trick session. It has no reply box and no Chat` : `"${value}" is not a session's scope key`;
  f.push("target", key, `${what}. Use the "id" from the facts (memberId:paneId, such as lodge:w6X:3), never a name.`);
  return undefined;
}

function readMedia(f: Fields): DecisionMedia[] | undefined {
  const list = f.array("media", { min: 0, max: HILL_MEDIA_MAX, what: "images" });
  if (list === undefined) return undefined;
  const out: DecisionMedia[] = [];
  list.forEach((value, i) => {
    const m = itemFields(value, pointer(f.at("media"), i), f.sink, "a media file");
    if (m === undefined) return;
    m.keys(DECISION_MEDIA_KEYS);
    const file = m.text("file", { max: IMAGE_SRC_MAX, required: true });
    if (file !== undefined && !isMediaFile(file)) m.push("target", "file", '"file" must be a .png, .jpg, .jpeg or .webp file inside the trick folder, as a relative path with no "..".');
    const caption = m.text("caption", { max: HILL_MEDIA_CAPTION_MAX });
    if (file === undefined || !isMediaFile(file)) return;
    out.push(caption === undefined ? { file } : { file, caption });
  });
  return out;
}

function readLinks(f: Fields): DecisionLink[] | undefined {
  const list = f.array("links", { min: 0, max: HILL_LINKS_MAX, what: "links" });
  if (list === undefined) return undefined;
  const out: DecisionLink[] = [];
  list.forEach((value, i) => {
    const l = itemFields(value, pointer(f.at("links"), i), f.sink, "a link");
    if (l === undefined) return;
    l.keys(DECISION_LINK_KEYS);
    const label = l.text("label", { max: HILL_LINK_LABEL_MAX, required: true });
    const href = l.text("href", { max: HILL_LINK_HREF_MAX, required: true });
    if (href !== undefined && !isTrickUrl(href)) l.push("target", "href", `"href" must be an https:// or http:// address of at most ${HILL_LINK_HREF_MAX} characters.`);
    if (label === undefined || href === undefined || !isTrickUrl(href)) return;
    out.push({ label, href });
  });
  return out;
}

// ── The manifest ─────────────────────────────────────────────────────────────────────────────

/** The most environment names a manifest lists, and the longest one. */
export const ENV_NAMES_MAX = 32;
export const ENV_NAME_MAX = 64;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every key `trick.toml` takes. */
export const MANIFEST_KEYS = ["id", "name", "run", "every", "watch", "on", "mode", "contract", "icon", "places", "env", "inputs", "description", "about", "rules"] as const;

// ── Agent views: the place word `agent-view` and the key `rules` (contract 2) ───────────────────────

/**
 * The place word of an agent view: a view of a session that the session's own agent draws. A manifest word
 * only: no part of a document draws `at` it, so it is not a {@link PlaceKind}, and the manifest keeps it as
 * `agentView`. At most once per trick. It needs `rules`.
 */
export const AGENT_VIEW_PLACE = "agent-view";

/**
 * The words a person reads for these rights, the same on the version card, in `collie trick check` and in
 * the About sheet (whose English strings are `settings.tricks.about.agentView*` and `.rules`, held equal by a test).
 */
export const AGENT_VIEW_WORDS = "Adds a view of a session that the session's own agent draws. You switch it on per session.";
export const AGENT_VIEW_TAP_WORDS = "A tap in that view sends a message in your name to that session only.";
export const RULES_WORDS = "Gives your agents instructions written by its author.";
/** The version card's chip when a new version's instructions differ from the approved ones. */
export const RULES_CHIP = "new agent instructions";
/** Why a trick with `rules` never takes a new version without asking: the CLI, the bridge and the card say it. */
export const RULES_NEVER_AUTO = "A trick that gives your agents instructions never takes a new version without asking: every change of its code waits for your yes.";

/**
 * Trick ids no trick may take: the words of the heads Collie writes into a session (`[view:<id> ...]`,
 * `[walky-talky ...]`) and Collie's own names, so no trick reads as Collie or as another door. `morph` is
 * not here: it is a trick's name.
 */
export const RESERVED_TRICK_IDS: readonly string[] = ["walky-talky", "hill", "collie", "view"];

/** The most bytes of a rules file. */
export const RULES_MAX_BYTES = 8 * 1024;
/** The most characters of one line of a rules file. */
export const RULES_LINE_MAX = 160;
/** The longest run of spaces a rules line may hold. */
export const RULES_SPACES_MAX = 2;
/** The most blank lines a rules file may hold in a row. */
export const RULES_BLANK_LINES_MAX = 2;
/** The longest rules file name. */
export const RULES_NAME_MAX = 64;
const RULES_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u;

/**
 * Why a `rules` file name is refused, or undefined. One step in the trick's folder, so it is a file the code
 * hash walks (code-hash.ts): no `/` or `\`, no leading dot, letters, digits, `.`, `_` and `-` only, ending
 * in `.md`, at most {@link RULES_NAME_MAX} characters.
 */
export function rulesNameProblem(name: string): string | undefined {
  if (name.includes("/") || name.includes("\\")) return `"rules" names one file in the trick's folder, with no / or \\ in it.`;
  if (name.length > RULES_NAME_MAX || !RULES_NAME.test(name)) return `"rules" is a file name of at most ${String(RULES_NAME_MAX)} letters, digits, ".", "_" and "-", starting with a letter or a digit and ending in .md, such as "rules.md".`;
  return undefined;
}

/** One line of a rules file that breaks the content rule: its number (from 1) and one plain sentence. */
export interface RulesProblem {
  line: number;
  reason: string;
}

/**
 * Every way a rules file's bytes break the content rule (agent-view SECURITY S5), each with its own
 * sentence naming the line. Empty when they read. The rule is stricter than {@link hasHiddenChar}: what a
 * person reads before the yes must be exactly what the agent gets, so only bytes 0x20 to 0x7E and `\n` are
 * taken. No tab; no line over {@link RULES_LINE_MAX} characters; no space at a line's end; no run of more
 * than {@link RULES_SPACES_MAX} spaces; no more than {@link RULES_BLANK_LINES_MAX} blank lines in a row; at
 * most {@link RULES_MAX_BYTES} bytes; not empty. `file` names the file in each sentence.
 */
export function rulesTextProblems(bytes: Uint8Array, file = "The rules file"): RulesProblem[] {
  if (bytes.length > RULES_MAX_BYTES) return [{ line: 0, reason: `${file} is larger than ${String(RULES_MAX_BYTES / 1024)} KiB.` }];
  const out: RulesProblem[] = [];
  let line = 1;
  let start = 0;
  let blanks = 0;
  let printable = false;
  // One pass over the bytes; a line ends at `\n` or at the end of the file.
  for (let at = 0; at <= bytes.length; at += 1) {
    const byte = at < bytes.length ? (bytes[at] ?? 0) : 0x0a;
    if (byte !== 0x0a) continue;
    if (at === bytes.length && start === at && at > 0) break;
    const row = bytes.subarray(start, at);
    const words = rulesLineProblems(row, line, file);
    out.push(...words);
    if (row.length === 0) {
      blanks += 1;
      if (blanks === RULES_BLANK_LINES_MAX + 1) out.push({ line, reason: `${file} line ${String(line)} is a third blank line in a row. At most ${String(RULES_BLANK_LINES_MAX)} blank lines may follow each other.` });
    } else blanks = 0;
    if (row.some((b) => b !== 0x20)) printable = true;
    line += 1;
    start = at + 1;
  }
  if (!printable) return [{ line: 0, reason: `${file} is empty. Write the instructions your agents read.` }];
  // V-N4: one text, one form. Without this, "A\nB" and "A\nB\n" hash apart but read as the same lines.
  if (bytes[bytes.length - 1] !== 0x0a) out.push({ line: line - 1, reason: `${file} does not end with a line break. End its last line with one.` });
  return out;
}

/** The problems of one line of a rules file (its bytes without the `\n`). */
function rulesLineProblems(row: Uint8Array, line: number, file: string): RulesProblem[] {
  const at = `${file} line ${String(line)}`;
  const out: RulesProblem[] = [];
  if (row.includes(0x09)) out.push({ line, reason: `${at} holds a tab. Use spaces.` });
  if (row.includes(0x0d)) out.push({ line, reason: `${at} holds a carriage return. Save the file with plain \\n line ends.` });
  if (row.some((b) => b !== 0x09 && b !== 0x0d && b < 0x20)) out.push({ line, reason: `${at} holds a control character.` });
  if (row.some((b) => b > 0x7e)) out.push({ line, reason: `${at} holds a character outside plain ASCII (letters, digits, punctuation and spaces). Agent instructions are plain ASCII text.` });
  if (row.length > RULES_LINE_MAX) out.push({ line, reason: `${at} is longer than ${String(RULES_LINE_MAX)} characters. Break it in two.` });
  if (row.length > 0 && row[row.length - 1] === 0x20) out.push({ line, reason: `${at} ends with a space.` });
  let run = 0;
  for (const b of row) {
    run = b === 0x20 ? run + 1 : 0;
    if (run === RULES_SPACES_MAX + 1) {
      out.push({ line, reason: `${at} holds a run of more than ${String(RULES_SPACES_MAX)} spaces.` });
      break;
    }
  }
  return out;
}

/** Whether a manifest lists `agent-view` or `rules`: such a trick gives agents instructions, so no agent may propose it. */
export function givesAgentsInstructions(manifest: Pick<TrickManifest, "agentView" | "rules">): boolean {
  return manifest.agentView === true || manifest.rules !== undefined;
}

// ── The inputs: files a trick reads from its agent sessions' folders (contract 2, M99) ───────────────

/** The most globs `inputs` lists, the longest one, and the most folder levels one names. */
export const INPUTS_MAX = 8;
export const INPUT_GLOB_MAX = 256;
export const INPUT_DEPTH_MAX = 6;
/** Characters a glob may not hold: a control character, a backslash, and every glob word but `*`. */
const INPUT_GLOB_BAD = /[\p{C}\\?[\]{}]/u;

/**
 * Why an `inputs` glob is refused, or undefined when it reads. A glob is a path RELATIVE to a session's
 * folder (the Files view's root): 1 to {@link INPUT_DEPTH_MAX} steps split by `/`. `*` matches any run
 * of characters inside one step and never a leading dot; no other glob word reads. Refused: an absolute
 * path or `~`, an empty step, a `.` or `..` step, a `.git` step in any case, a step that starts with
 * `.env` in any case ({@link isEnvName}: a `.env` file holds keys, and a trick reads unattended), and `**`. The same rule runs
 * on the trick's machine, on the member that reads the files, and on the lead again for each file name
 * a member answers with ({@link inputGlobMatches}).
 */
export function inputGlobProblem(glob: string): string | undefined {
  if (glob === "") return "is empty.";
  if (codePoints(glob) > INPUT_GLOB_MAX) return `is longer than ${String(INPUT_GLOB_MAX)} characters.`;
  if (glob.startsWith("/") || glob.startsWith("~")) return "must be relative to the session's folder: no leading / or ~.";
  if (INPUT_GLOB_BAD.test(glob)) return "may hold * as its one wildcard, and no control character or backslash.";
  if (glob.includes("**")) return "may not hold **: a * matches inside one folder level only.";
  const steps = glob.split("/");
  if (steps.length > INPUT_DEPTH_MAX) return `names more than ${String(INPUT_DEPTH_MAX)} folder levels.`;
  for (const step of steps) {
    if (step === "") return "has an empty step (// or a / at an end).";
    if (step === "." || step === "..") return "may not hold a . or .. step.";
    if (step.toLowerCase() === ".git") return "may not name .git.";
    if (isEnvName(step)) return "may not name a .env file: it holds keys.";
  }
  return undefined;
}

/**
 * Whether a name is a `.env` file (`.env`, `.env.local`, `.envrc`, in any case), which a trick's inputs
 * never read: the Files view shows one to a person who opens it, but a trick reads without anyone looking.
 */
export function isEnvName(name: string): boolean {
  return name.toLowerCase().startsWith(".env");
}

/** Whether one name matches one glob step: `*` is any run of characters, and never a leading dot. A `.env` name never matches. */
function inputStepMatches(step: string, name: string): boolean {
  if (name.startsWith(".") && !step.startsWith(".")) return false;
  if (isEnvName(name)) return false;
  const pieces = step.split("*");
  if (pieces.length === 1) return step === name;
  const first = pieces[0] ?? "";
  const last = pieces[pieces.length - 1] ?? "";
  if (name.length < first.length + last.length || !name.startsWith(first) || !name.endsWith(last)) return false;
  let at = first.length;
  const end = name.length - last.length;
  for (const piece of pieces.slice(1, -1)) {
    const found = name.indexOf(piece, at);
    if (found < 0 || found + piece.length > end) return false;
    at = found + piece.length;
  }
  return true;
}

/** Whether a glob's step at `depth` matches `name`: what a walk asks at each folder level. */
export function inputGlobStepMatches(glob: string, depth: number, name: string): boolean {
  const step = glob.split("/")[depth];
  return step !== undefined && inputStepMatches(step, name);
}

/**
 * Whether a relative file path matches a glob, step by step, with as many steps as the glob. A glob
 * that does not read ({@link inputGlobProblem}) matches nothing, and so does a path with an empty, `.`,
 * `..` or `.git` step, a backslash or a control character, whatever the glob says.
 */
export function inputGlobMatches(glob: string, rel: string): boolean {
  if (inputGlobProblem(glob) !== undefined) return false;
  if (rel === "" || /[\p{C}\\]/u.test(rel)) return false;
  const names = rel.split("/");
  const steps = glob.split("/");
  if (names.length !== steps.length) return false;
  for (const [i, name] of names.entries()) {
    if (name === "" || name === "." || name === ".." || name.toLowerCase() === ".git") return false;
    if (!inputStepMatches(steps[i] ?? "", name)) return false;
  }
  return true;
}

/**
 * The one sentence that says what a trick's `inputs` read, the same on the version card, in Settings (its
 * English strings, `settings.tricks.reads.*`) and in `collie trick check`. `crew` is true on a crew's
 * lead, where the files come from every machine.
 */
export function inputsSentence(globs: readonly string[], crew: boolean): string {
  const list = globs.join(", ");
  return crew ? `Reads ${list} in your agent sessions' folders on every machine of the crew.` : `Reads ${list} in your agent sessions' folders.`;
}

/** The line a contract 1 trick that lists `inputs` is refused with. */
export const INPUTS_NEED_CONTRACT = `"inputs" needs contract = ${String(INPUTS_CONTRACT)}. Add contract = ${String(INPUTS_CONTRACT)} to trick.toml to read files from your sessions' folders.`;
/** The lines an agent view's keys are refused with: an older contract, a place without its rules, rules without the place. */
export const AGENT_VIEW_NEEDS_CONTRACT = `"agent-view" needs contract = ${String(AGENT_VIEW_CONTRACT)}. Add contract = ${String(AGENT_VIEW_CONTRACT)} to trick.toml.`;
export const RULES_NEEDS_CONTRACT = `"rules" needs contract = ${String(AGENT_VIEW_CONTRACT)}. Add contract = ${String(AGENT_VIEW_CONTRACT)} to trick.toml.`;
/** The keys a trick whose only place is `agent-view` may not name: it has no program. */
export const VIEW_ONLY_REFUSED = ["run", "every", "inputs", "env"] as const;
export function viewOnlyRefusal(key: (typeof VIEW_ONLY_REFUSED)[number]): string {
  return `A trick whose only place is "agent-view" has no program, so it takes no "${key}". Remove it, or add a place it draws in.`;
}
export const AGENT_VIEW_NEEDS_RULES = `"agent-view" needs "rules": the file of instructions the session's agent reads. Add rules = "rules.md" to trick.toml.`;
export const RULES_NEED_AGENT_VIEW = `"rules" goes with the place "agent-view": they are the instructions of the agent that draws the view. Add "agent-view" to places, or remove "rules".`;

/** The highest `contract` a manifest may write before it is refused as a typo rather than a newer Collie. */
export const CONTRACT_MAX = 999;

/**
 * The refusal of a manifest that asks for a contract this Collie does not speak. Exported so the CLI
 * and the bridge say the same sentence, naming both numbers.
 */
export function newerContractReason(asked: number): string {
  return `This trick needs a newer Collie: it is written for trick contract ${asked}, and this Collie knows contract ${TRICK_CONTRACT}. Update Collie to run it.`;
}

export interface ParseManifestOptions {
  /** The folder's name. A manifest whose `id` differs is refused. */
  folder?: string;
  /** The later triggers this Collie runs. Default none: `watch`, `on` and `mode = "serve"` are skipped with a reason. */
  triggers?: readonly LaterTrigger[];
  /** The place kinds this Collie draws. Default `NEAR_PLACES`. */
  places?: readonly PlaceKind[];
}

export interface ParsedManifest {
  /**
   * Present when every refusal is a "later" one. A later field or place is left out of the manifest
   * with its reason, and the trick still runs with the rest.
   */
  manifest?: TrickManifest;
  refusals: Refusal[];
}

/** Parse `trick.toml` after the TOML parse. Total, like the document parser. */
export function parseManifest(doc: JsonValue | undefined, opts: ParseManifestOptions = {}): ParsedManifest {
  const obj = asJsonObject(doc);
  if (obj === undefined) return { refusals: [{ code: "type", path: "", reason: "trick.toml must be a table of keys." }] };
  const refusals: Refusal[] = [];
  const f = new Fields(obj, "", refusals, "trick.toml");
  // The contract first: a trick written for a newer contract may use keys this Collie has never heard
  // of, so it is refused with the one sentence that names both numbers, never with a list of unknown keys.
  const contract = f.int("contract", { min: 1, max: CONTRACT_MAX }) ?? (f.has("contract") ? undefined : TRICK_CONTRACT_DEFAULT);
  if (contract !== undefined && contract > TRICK_CONTRACT) {
    return { refusals: [{ code: "version", path: "/contract", reason: newerContractReason(contract) }] };
  }
  f.keys(MANIFEST_KEYS, (key) => (key === "facts" ? { code: "unknown-key", reason: '"facts" is "contract" now: the trick contract number, 1, or leave it out.' } : undefined));
  const triggers = opts.triggers ?? [];
  const enabled = opts.places ?? NEAR_PLACES;

  const idRaw = asJsonString(obj.id);
  const id = idRaw !== undefined && isTrickId(idRaw) ? idRaw : undefined;
  if (id === undefined) f.push("id", "id", '"id" must be 1 to 32 lower-case letters, digits and hyphens, starting with a letter or a digit.');
  if (id !== undefined && opts.folder !== undefined && id !== opts.folder) {
    f.push("id", "id", `"id" is "${id}" but the folder is "${opts.folder}". Name them alike.`);
  }
  if (id !== undefined && RESERVED_TRICK_IDS.includes(id)) f.push("id", "id", `"${id}" is a name Collie keeps for itself. Give the trick another id.`);
  const name = f.text("name", { max: NAME_MAX, required: true });
  // A trick that is only an agent view has no program (review 8 V-N2): `run`, `every`, `inputs` and `env`
  // are refused, so nothing ever starts and no program draws nowhere. A place this Collie does not know
  // still counts as another place, so a newer trick keeps its program.
  const placesRaw = obj.places;
  const viewOnly = Array.isArray(placesRaw) && placesRaw.length === 1 && placesRaw[0] === AGENT_VIEW_PLACE;
  if (viewOnly) for (const key of VIEW_ONLY_REFUSED) if (f.has(key)) f.push("place", key, viewOnlyRefusal(key));
  const run = f.text("run", { max: RUN_MAX, required: !viewOnly });

  const every = f.text("every", { max: 8 });
  const everyMs = every === undefined ? undefined : parseDuration(every);
  const everyOk = everyMs !== undefined && everyMs >= EVERY_MIN_MS && everyMs <= EVERY_MAX_MS;
  if (every !== undefined && !everyOk) f.push("range", "every", '"every" must be a duration from 5s to 24h, such as "30s", "5m" or "1h".');

  const watch = readStrings(f, "watch", { min: 1, max: WATCH_MAX, what: "paths", text: { max: WATCH_PATH_MAX } });
  watch?.forEach((path, i) => {
    if (!path.startsWith("/") && !path.startsWith("~/")) {
      refusals.push({ code: "target", path: pointer("/watch", i), reason: "A watched path starts with / or ~/." });
    }
  });
  if (f.has("watch") && !triggers.includes("watch")) f.push("later", "watch", '"watch" is not in this Collie yet. The trick runs on its timer and taps.');

  const onList = f.array("on", { min: 1, max: TRICK_EVENTS.length, what: "events" });
  const on: TrickEvent[] = [];
  onList?.forEach((value, i) => {
    const word = asJsonString(value);
    if (word !== undefined && isOneOf(TRICK_EVENTS, word)) {
      on.push(word);
      return;
    }
    refusals.push({ code: "word", path: pointer("/on", i), reason: `An event is one of: ${quoteList(TRICK_EVENTS)}.` });
  });
  if (f.has("on") && !triggers.includes("on")) f.push("later", "on", '"on" is not in this Collie yet. The trick runs on its timer and taps.');

  const mode = f.word("mode", TRICK_MODES);
  if (mode === "serve" && !triggers.includes("serve")) f.push("later", "mode", '"mode = serve" is not in this Collie yet. The trick runs once per trigger.');

  const icon = f.icon("icon");
  const env = readStrings(f, "env", { min: 0, max: ENV_NAMES_MAX, what: "names", text: { max: ENV_NAME_MAX } });
  env?.forEach((envName, i) => {
    if (!ENV_NAME_RE.test(envName)) refusals.push({ code: "word", path: pointer("/env", i), reason: "An environment name is letters, digits and _, and does not start with a digit." });
  });
  // Contract 2 (M99): files the trick reads from its agent sessions' folders. A contract 1 trick that
  // lists them is refused whole, with one plain line, so it never runs thinking it has them.
  const inputs = readStrings(f, "inputs", { min: 1, max: INPUTS_MAX, what: "globs", text: { max: INPUT_GLOB_MAX } });
  if (f.has("inputs") && contract !== undefined && contract < INPUTS_CONTRACT) f.push("version", "inputs", INPUTS_NEED_CONTRACT);
  inputs?.forEach((glob, i) => {
    const problem = inputGlobProblem(glob);
    if (problem !== undefined) refusals.push({ code: "target", path: pointer("/inputs", i), reason: `This glob ${problem}` });
  });

  // Text for a person, not rights: they stay out of `powersOf`. Both contracts take them, and a manifest
  // without them reads as before. Over the cap is a refusal, like the name's.
  const description = f.text("description", { max: DESCRIPTION_MAX });
  const about = f.text("about", { max: ABOUT_MAX, multiline: true });

  // Room for the places of a newer Collie at the same contract: the words this one does not know are left out.
  const placeList = f.array("places", { min: 1, max: PLACES_LISTED_MAX, required: true, what: "places" });
  const places: PlaceKind[] = [];
  let agentView = false;
  placeList?.forEach((value, i) => {
    const word = asJsonString(value);
    const path = pointer("/places", i);
    // Contract 2: an agent view. Read and kept as a right; the bridge draws it (bridge/agent-view/).
    if (word === AGENT_VIEW_PLACE) {
      if (agentView) {
        refusals.push({ code: "duplicate", path, reason: `"${word}" is listed twice.` });
        return;
      }
      agentView = true;
      if (contract !== undefined && contract < AGENT_VIEW_CONTRACT) {
        refusals.push({ code: "version", path, reason: AGENT_VIEW_NEEDS_CONTRACT });
      }
      return;
    }
    const later = word === undefined ? undefined : reasonOf(LATER_PLACE_WORDS, word);
    if (later !== undefined) {
      refusals.push({ code: "later", path, reason: later });
      return;
    }
    if (word === undefined) {
      refusals.push({ code: "type", path, reason: `A place is a word, one of: ${quoteList(PLACE_KINDS)}.` });
      return;
    }
    // A place word this Collie does not know is left out, like a later one: a trick written for a newer
    // Collie at the same contract still runs with the places this one draws.
    if (!isOneOf(PLACE_KINDS, word)) {
      refusals.push({ code: "later", path, reason: `"${word}" is not a place this Collie knows, so it is left out. The places are: ${quoteList(PLACE_KINDS)}.` });
      return;
    }
    if (places.includes(word)) {
      refusals.push({ code: "duplicate", path, reason: `"${word}" is listed twice.` });
      return;
    }
    if (!enabled.includes(word)) {
      refusals.push({ code: "later", path, reason: `"${word}" is not in this Collie. The other places still draw.` });
      return;
    }
    places.push(word);
  });
  const placeFaults = refusals.filter((r) => r.path.startsWith("/places/") && r.code !== "later");
  if (placeList !== undefined && places.length === 0 && !agentView && placeFaults.length === 0) {
    refusals.push({ code: "place", path: "/places", reason: "The trick lists no place this Collie draws." });
  }

  // Contract 2: the instructions of an agent view. The name is checked here; the bytes where the folder is
  // read (bridge/tricks/discover.ts `readManifestFile`, {@link rulesTextProblems}).
  const rules = f.text("rules", { max: RULES_NAME_MAX });
  const rulesProblem = rules === undefined ? undefined : rulesNameProblem(rules);
  if (rulesProblem !== undefined) f.push("target", "rules", rulesProblem);
  if (f.has("rules") && contract !== undefined && contract < AGENT_VIEW_CONTRACT) f.push("version", "rules", RULES_NEEDS_CONTRACT);
  if (agentView && !f.has("rules")) f.push("missing", "places", AGENT_VIEW_NEEDS_RULES);
  if (f.has("rules") && !agentView) f.push("place", "rules", RULES_NEED_AGENT_VIEW);

  const fatal = refusals.some((r) => r.code !== "later");
  if (fatal || id === undefined || name === undefined || (run === undefined && !viewOnly) || contract === undefined) return { refusals: capRefusals(refusals) };
  const head = { id, name };
  const rest = { mode: "once" as const, contract, icon: icon ?? DEFAULT_TRICK_ICON, places };
  const manifest: TrickManifest = run === undefined ? { ...head, ...rest } : { ...head, run, ...rest };
  if (agentView) manifest.agentView = true;
  if (rules !== undefined) manifest.rules = rules;
  if (every !== undefined && everyMs !== undefined && everyOk) {
    manifest.every = every;
    manifest.everyMs = everyMs;
  }
  if (watch !== undefined && triggers.includes("watch")) manifest.watch = watch;
  if (on.length > 0 && triggers.includes("on")) manifest.on = on;
  if (mode === "serve" && triggers.includes("serve")) manifest.mode = "serve";
  if (env !== undefined && env.length > 0) manifest.env = [...new Set(env)];
  if (inputs !== undefined && inputs.length > 0) manifest.inputs = [...new Set(inputs)];
  if (description !== undefined) manifest.description = description;
  if (about !== undefined) manifest.about = about;
  return { manifest, refusals: capRefusals(refusals) };
}

// ── The facts ────────────────────────────────────────────────────────────────────────────────

/** Every key of the facts document, of a session in it, of a space, of the trick, and of each trigger. */
export const FACTS_KEYS = ["contract", "trigger", "trick", "memberId", "host", "sessions", "spaces", "sessionsOmitted"] as const;
export const SESSION_FACT_KEYS = ["id", "memberId", "sessionId", "paneId", "host", "name", "agent", "status", "cwd", "space", "tab", "lastActiveAt", "reachable", "inputs"] as const;
export const INPUTS_FACT_KEYS = ["state", "files", "skipped"] as const;
export const INPUT_FILE_FACT_KEYS = ["rel", "path", "bytes", "sha256", "mtime", "kind"] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;
export const SPACE_FACT_KEYS = ["name", "folder"] as const;
export const TRICK_FACT_KEYS = ["id", "dir", "state"] as const;
export const TRIGGER_KINDS = ["start", "timer", "tap", "watch", "event"] as const;
export const TRIGGER_KEYS = {
  start: ["kind"],
  timer: ["kind"],
  tap: ["kind", "rid", "node", "intent", "value", "from", "seen"],
  watch: ["kind", "path"],
  event: ["kind", "event", "session"],
} as const satisfies { readonly [K in (typeof TRIGGER_KINDS)[number]]: readonly string[] };

export interface ParsedFacts {
  facts?: TrickFacts;
  refusals: Refusal[];
}

/**
 * Parse a facts document. The bridge writes facts; this is for `collie trick check --run` with a fixture
 * facts file, and for a test that holds the bridge's builder to the type. Total, like the others.
 */
export function parseFacts(raw: JsonValue | undefined): ParsedFacts {
  const obj = asJsonObject(raw);
  if (obj === undefined) return { refusals: [{ code: "type", path: "", reason: "The facts must be a JSON object." }] };
  const refusals: Refusal[] = [];
  const f = new Fields(obj, "", refusals, "the facts");
  f.keys(FACTS_KEYS);
  const contract = asJsonNumber(obj.contract);
  const contractOk = contract !== undefined && Number.isInteger(contract) && contract >= 1 && contract <= TRICK_CONTRACT;
  if (!contractOk) f.push("version", "contract", `The facts must say "contract": a number from 1 to ${String(TRICK_CONTRACT)}.`);
  const trigger = readTrigger(f);
  const trickFields = f.object("trick", 'an object with "id", "dir" and "state"', true);
  trickFields?.keys(TRICK_FACT_KEYS);
  const trickId = trickFields?.text("id", { max: 32, required: true });
  if (trickId !== undefined && !isTrickId(trickId)) trickFields?.push("id", "id", '"id" is not a trick id.');
  const dir = trickFields?.text("dir", { max: FACT_TEXT_MAX_BYTES, required: true });
  const state = trickFields?.text("state", { max: FACT_TEXT_MAX_BYTES, required: true });
  const memberId = f.text("memberId", { max: 64, required: true });
  if (memberId !== undefined && !isHostName(memberId)) f.push("id", "memberId", '"memberId" is not a member id.');
  const host = f.text("host", { max: 64, required: true });
  if (host !== undefined && !isHostName(host)) f.push("id", "host", '"host" is not a host name.');

  const sessionList = f.array("sessions", { min: 0, max: FACT_SESSIONS_MAX, required: true, what: "sessions" });
  const sessions: FactsSession[] = [];
  sessionList?.forEach((value, i) => {
    const s = readFactsSession(value, pointer("/sessions", i), refusals);
    if (s !== undefined) sessions.push(s);
  });
  const spaceList = f.array("spaces", { min: 0, max: FACT_SPACES_MAX, required: true, what: "spaces" });
  const spaces: FactsSpace[] = [];
  spaceList?.forEach((value, i) => {
    const sp = itemFields(value, pointer("/spaces", i), refusals, "a space");
    if (sp === undefined) return;
    sp.keys(SPACE_FACT_KEYS);
    const name = sp.text("name", { max: 256, required: true });
    const folder = sp.text("folder", { max: FACT_TEXT_MAX_BYTES });
    if (name === undefined) return;
    spaces.push(folder === undefined ? { name } : { name, folder });
  });

  const omitted = f.int("sessionsOmitted", { min: 1, max: 1_000_000 });

  if (refusals.length > 0 || trigger === undefined || trickId === undefined || dir === undefined || state === undefined || memberId === undefined || host === undefined) {
    return { refusals: capRefusals(refusals) };
  }
  const facts: TrickFacts = { contract: contract ?? TRICK_CONTRACT_DEFAULT, trigger, trick: { id: trickId, dir, state }, memberId, host, sessions, spaces };
  if (omitted !== undefined) facts.sessionsOmitted = omitted;
  return { facts, refusals };
}

function readTrigger(f: Fields): FactsTrigger | undefined {
  const t = f.object("trigger", 'an object with "kind"', true);
  if (t === undefined) return undefined;
  const kind = t.word("kind", TRIGGER_KINDS, true);
  switch (kind) {
    case undefined:
      return undefined;
    case "start":
    case "timer":
      t.keys(TRIGGER_KEYS[kind]);
      return { kind };
    case "watch": {
      t.keys(TRIGGER_KEYS.watch);
      const path = t.text("path", { max: WATCH_PATH_MAX, required: true });
      return path === undefined ? undefined : { kind, path };
    }
    case "event": {
      t.keys(TRIGGER_KEYS.event);
      const event = t.word("event", TRICK_EVENTS, true);
      const session = t.text("session", { max: 256 });
      if (event === undefined) return undefined;
      return session === undefined ? { kind, event } : { kind, event, session };
    }
    case "tap": {
      t.keys(TRIGGER_KEYS.tap);
      const tap = readTapFields(t);
      const seen = t.text("seen", { max: DECISION_HASH_MAX });
      if (tap === undefined) return undefined;
      return seen === undefined ? { kind: "tap", ...tap } : { kind: "tap", ...tap, seen };
    }
  }
}

function readFactsSession(value: JsonValue | undefined, path: string, sink: Refusal[]): FactsSession | undefined {
  const s = itemFields(value ?? null, path, sink, "a session");
  if (s === undefined) return undefined;
  const before = sink.length;
  s.keys(SESSION_FACT_KEYS);
  const id = s.text("id", { max: 256, required: true });
  if (id !== undefined && !isScopeKey(id)) s.push("target", "id", '"id" must be the scope key memberId:paneId.');
  const memberId = s.text("memberId", { max: 64, required: true });
  if (memberId !== undefined && !isHostName(memberId)) s.push("id", "memberId", '"memberId" is not a member id.');
  const sessionId = s.text("sessionId", { max: SESSION_ID_MAX, required: true });
  const paneId = s.text("paneId", { max: MUX_ID_MAX_BYTES, required: true });
  const host = s.text("host", { max: 256, required: true });
  const status = s.word("status", SESSION_STATUSES, true);
  const out: FactsSession = { id: id ?? "", memberId: memberId ?? "", sessionId: sessionId ?? "", paneId: paneId ?? "", host: host ?? "", status: status ?? "unknown" };
  for (const key of ["name", "agent", "cwd", "space", "tab"] as const) {
    const text = s.text(key, { max: FACT_TEXT_MAX_BYTES });
    if (text !== undefined) out[key] = text;
  }
  const last = s.text("lastActiveAt", { max: INSTANT_MAX });
  if (last !== undefined && !isInstant(last)) s.push("text", "lastActiveAt", '"lastActiveAt" must be an ISO 8601 instant.');
  if (last !== undefined) out.lastActiveAt = last;
  const reachable = s.bool("reachable");
  if (reachable !== undefined) out.reachable = reachable;
  const inputs = s.object("inputs", 'an object with "state" and "files"');
  if (inputs !== undefined) {
    const read = readFactsInputs(inputs, sink);
    if (read !== undefined) out.inputs = read;
  }
  return sink.length === before ? out : undefined;
}

function readFactsInputs(f: Fields, sink: Refusal[]): FactsInputs | undefined {
  f.keys(INPUTS_FACT_KEYS);
  const state = f.word("state", INPUT_STATES, true);
  const list = f.array("files", { min: 0, max: INPUT_FILES_MAX, required: true, what: "files" });
  const skipped = f.int("skipped", { min: 1, max: 1_000_000 });
  const files: FactsInputFile[] = [];
  list?.forEach((value, i) => {
    const file = itemFields(value, pointer(f.at("files"), i), sink, "a file");
    if (file === undefined) return;
    file.keys(INPUT_FILE_FACT_KEYS);
    const rel = file.text("rel", { max: 1024, required: true });
    const path = file.text("path", { max: 2048, required: true });
    const bytes = file.int("bytes", { min: 0, max: 64 * 1024 * 1024, required: true });
    const sha256 = file.text("sha256", { max: 64, required: true });
    if (sha256 !== undefined && !SHA256_HEX.test(sha256)) file.push("text", "sha256", '"sha256" must be 64 lower-case hex digits.');
    const mtime = file.text("mtime", { max: INSTANT_MAX, required: true });
    if (mtime !== undefined && !isInstant(mtime)) file.push("text", "mtime", '"mtime" must be an ISO 8601 instant.');
    const kind = file.word("kind", INPUT_KINDS, true);
    if (rel === undefined || path === undefined || bytes === undefined || sha256 === undefined || mtime === undefined || kind === undefined) return;
    files.push({ rel, path, bytes, sha256, mtime, kind });
  });
  if (state === undefined || list === undefined) return undefined;
  const out: FactsInputs = { state, files };
  if (skipped !== undefined) out.skipped = skipped;
  return out;
}

// ── A tap ────────────────────────────────────────────────────────────────────────────────────

/**
 * Every key a tap's body takes. `rev` is the rev of the part as the phone drew it (fault A): the bridge
 * checks it and strips it, so it never reaches the program's trigger.
 */
export const TAP_KEYS = ["rid", "node", "intent", "value", "from", "rev"] as const;

export interface ParsedTapRequest {
  request?: TapRequest;
  /** The part's rev the phone sent, when it sent one. An older phone sends none. */
  rev?: number;
  refusals: Refusal[];
}

/** Parse `POST /api/tricks/<host>/<id>/tap`'s body. Total. */
export function parseTapRequest(raw: JsonValue | undefined): ParsedTapRequest {
  const obj = asJsonObject(raw);
  if (obj === undefined) return { refusals: [{ code: "type", path: "", reason: "A tap must be a JSON object." }] };
  const refusals: Refusal[] = [];
  const f = new Fields(obj, "", refusals, "a tap");
  f.keys(TAP_KEYS, (key) => {
    if (key === "requestId") return { code: "unknown-key", reason: '"requestId" is "rid" now, as in the tree\'s intent.' };
    if (key === "part") return { code: "unknown-key", reason: '"part" is "node" now: the part id, or hill/<key> for a decision.' };
    if (key === "args") return { code: "unknown-key", reason: '"args" is "value" now: a button\'s fixed string, or a decision\'s answer.' };
    return undefined;
  });
  const rev = f.int("rev", { min: 0, max: Number.MAX_SAFE_INTEGER });
  const request = readTapFields(f);
  if (refusals.length > 0 || request === undefined) return { refusals: capRefusals(refusals) };
  return rev === undefined ? { request, refusals } : { request, rev, refusals };
}

/** The fields a tap request and a tap trigger share. The caller has checked the keys. */
function readTapFields(f: Fields): TapRequest | undefined {
  const before = f.sink.length;
  const rid = f.text("rid", { max: 36, required: true });
  if (rid !== undefined && !isRequestId(rid)) f.push("id", "rid", '"rid" must be a UUID.');
  const intent = f.intent("intent", true);
  const node = f.text("node", { max: HILL_NODE_PREFIX.length + DECISION_KEY_MAX, required: true });
  if (node !== undefined && !isTapNode(node)) f.push("id", "node", '"node" must be a part id, or hill/<key> for a decision.');
  const value = node === undefined ? undefined : readTapValue(f, node.startsWith(HILL_NODE_PREFIX));
  const from = f.object("from", 'an object with "session"');
  let tapFrom: TapFrom | undefined;
  if (from !== undefined) {
    from.keys(["session"]);
    const session = from.has("session") ? readFromSession(from) : undefined;
    tapFrom = session === undefined ? {} : { session };
  }
  if (f.sink.length !== before || rid === undefined || intent === undefined || node === undefined) return undefined;
  const out: TapRequest = { rid, node, intent };
  if (value !== undefined) out.value = value;
  if (tapFrom !== undefined) out.from = tapFrom;
  return out;
}

/** A tap's value: a part's control sends text; a decision's answer sends `{ text }`, the person's words or null. */
function readTapValue(f: Fields, hill: boolean): TapValue | undefined {
  const raw = f.obj.value;
  if (raw === undefined) return undefined;
  if (!hill) return f.value("value");
  const v = f.object("value", 'an object with "text", the person\'s words or null');
  if (v === undefined) return undefined;
  v.keys(["text"]);
  if (v.obj.text === null) return { text: null };
  const text = v.text("text", { max: HILL_ANSWER_TEXT_MAX, required: true, multiline: true });
  return text === undefined ? undefined : { text };
}

function readFromSession(f: Fields): string | undefined {
  const value = f.text("session", { max: 256, required: true });
  if (value === undefined) return undefined;
  if (isPaneTarget(value)) return value;
  f.push("target", "session", `"${value}" is not a session's scope key. Use the "id" from the facts (memberId:paneId, such as lodge:w6X:3), never a name.`);
  return undefined;
}
