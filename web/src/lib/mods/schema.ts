// Collie mods, the schema: every type a mod reads or writes, and the one total parser for each
// document that crosses the line between a mod and Collie (the "Collie mods" milestone, slice 00).
//
// WHAT CROSSES. Four documents, each versioned or closed:
//   * the manifest, `mod.toml` after the TOML parse (`parseManifest`);
//   * the facts, the JSON the bridge writes to the provider's stdin (`parseFacts`, for the CLI's
//     fixture check; the bridge builds them, it does not parse them);
//   * the output, the JSON the provider prints (`parseModDocument`, `parseModDocumentText`);
//   * a tap, the body the phone posts (`parseTapRequest`).
// The wire between the bridge and the phone (`ModsReply`, `ModTapReply`) is types only: the bridge
// writes it from parts this file already accepted.
//
// WHY THE PARSER IS TOTAL AND REFUSES PER PART. The theme parser is the model: it never throws, walks
// the whole document and returns every refusal with a path and a sentence a person can read. A mod
// adds one rule: a bad part is refused ALONE, and the other parts still draw (design §4 rule 1). The
// runner keeps the last good version of a refused part and marks it stale; `refusedParts` names them.
//
// CLOSED, NOT CLEANED. Unknown keys, kinds, places, tones and icons are refused, never dropped, and a
// string over its cap is refused, never cut (design §4 rule 2). The durable adapter cuts, because a
// program's pane must still show; a mod's part has a last good version to fall back on, and a cut
// string would hide a bug the author can fix with one `collie mod check`.
//
// WHY THIS FILE IMPORTS SO LITTLE. It loads without a DOM, React or the `@/` alias, because the
// bridge and the CLI import it by relative path, as they import `../json`. It must also pass the root
// tsconfig, which is stricter than the web one (`noUncheckedIndexedAccess`).

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonObject, type JsonValue } from "../json";

// ── Versions and byte caps ───────────────────────────────────────────────────────────────────

/** The output document version this build reads (`"v": 1`). */
export const DOCUMENT_VERSION = 1;
/** The facts document version this build writes. A manifest that needs a higher one is skipped. */
export const FACTS_VERSION = 1;

/** One part, serialised as compact JSON, at most this many UTF-8 bytes (design §4 rule 3). */
export const PART_MAX_BYTES = 16 * 1024;
/** One document at most this many UTF-8 bytes. Equal to the runner's stdout cap (design §3.2). */
export const DOCUMENT_MAX_BYTES = 64 * 1024;
/** An intent's `args`, serialised, at most this many bytes. They go back to the provider on a tap. */
export const ARGS_MAX_BYTES = 1024;
/** An `image` file, checked by the runner on disk and by the phone on fetch (design §5). */
export const IMAGE_MAX_BYTES = 512 * 1024;
/** Parts per document. One mod in many places, not a page of widgets. */
export const PARTS_MAX = 24;
/** The most refusals a result lists. One more row counts the rest, as the theme parser does. */
export const REFUSALS_MAX = 40;

// ── Text caps, in characters (code points) unless the name says bytes ────────────────────────
//
// WIRE.md §6 fixes the four a mod session shares with a program pane: subtitle 120, badge text 12,
// action label 16, step label 60. The rest are chosen here for a 390 px phone: a cap is the most
// text the slot can show before it wraps or truncates, so a longer string is an author's bug.

/** `subtitle` of a mod session (WIRE.md §6, `Pane.subtitle`). */
export const SUBTITLE_MAX = 120;
/** `badge.text` (WIRE.md §6, `Pane.badge.text`). */
export const BADGE_TEXT_MAX = 12;
/** `badge.count` and a mark's `count` (WIRE.md §6, `Pane.badge.count`): an integer 0 to 9999. */
export const COUNT_MAX = 9999;
/** A mod session action's `label` (WIRE.md §6, `PaneAction.label`). */
export const ACTION_LABEL_MAX = 16;
/** Actions on a mod session (WIRE.md §6, `Pane.actions`). */
export const ACTIONS_MAX = 4;
/** A step's `label` and a percent's `label` (WIRE.md §6, `Step.label`). */
export const STEP_LABEL_MAX = 60;
/** Steps in a progress or a `steps` figure (WIRE.md §6, `Pane.progress.steps`). */
export const STEPS_MAX = 12;
/** A mark's `face`, the live word in the belt (`23/34`). Same rule as a badge's text. */
export const FACE_MAX = 12;
/** A mark's `label`, its accessible name. */
export const MARK_LABEL_MAX = 60;
/** The mod's `name` in the manifest, and a mod session's `name`. */
export const NAME_MAX = 40;
/** A mod tab's `title` in the Tab row. */
export const TAB_TITLE_MAX = 40;
/** A view's `title` in the view picker, beside "Conversation" and "Terminal". */
export const VIEW_TITLE_MAX = 24;
/** A `section` title, a `settings` page title. */
export const TITLE_MAX = 60;
/** A `text` node's text, newlines included. `lines` reserves its height. */
export const TEXT_MAX = 2000;
/** A `button` label. Wider than an action's, because a view's button has the row to itself. */
export const BUTTON_LABEL_MAX = 24;
/** A short label beside a figure or a number (`number`, `spark`, `ring`, `time`, `kv` label). */
export const LABEL_MAX = 40;
/** A `kv` value, a `list` item's text and detail, a `link` label, an image's `alt`, a header line. */
export const LINE_MAX = 120;
/** A `number` node's value as text (`23/34`, `1.2k`). */
export const NUMBER_TEXT_MAX = 12;
/** A `list` item's trailing word, a `bar` item's label, a `table` column's label. */
export const WORD_MAX = 24;
/** A `table` cell. */
export const CELL_MAX = 80;
/** One `log` line. */
export const LOG_LINE_MAX = 240;
/** `log.tail` entries; the node draws the last `lines` of them. */
export const LOG_TAIL_MAX = 200;
/** `list.items` and `table.items`; past `rows` the renderer draws "+n more". */
export const ITEMS_MAX = 200;
/** A `menu:<match>` row's label (a later place). */
export const MENU_LABEL_MAX = 40;
/** Rows in a `menu:<match>` part (a later place). */
export const MENU_ROWS_MAX = 6;
/** A draft's text. It fills an empty reply box, so a page of prose is never what a mod meant. */
export const DRAFT_TEXT_MAX = 4000;
/** A URL in `open` or a `link` (WIRE.md §6, `Item.href`). */
export const URL_MAX = 2048;
/** The whole `at` string, match included. */
export const AT_MAX = 160;
/** An image's `src`, a path relative to the mod folder. */
export const IMAGE_SRC_MAX = 256;
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
/** A refused tap's or a failed run's one line of words on the wire. */
export const PROBLEM_MAX = 200;

/** Limits the view tree holds, as data, so the renderer and the docs read the same numbers. */
export const VIEW_LIMITS = {
  /** `text.lines`, required: the lines it reserves. */
  textLines: { min: 1, max: 12 },
  /** `list.rows` and `table.rows`, required: the rows they reserve. */
  listRows: { min: 1, max: 50 },
  tableRows: { min: 1, max: 50 },
  /** `table.columns`. */
  tableColumns: { min: 1, max: 4 },
  /** `log.lines`, required: the mono lines it reserves. */
  logLines: { min: 1, max: 40 },
  /** `grid.cols`, required. */
  gridCols: { min: 2, max: 4 },
  /** `kv.cols`, optional, default 1. */
  kvCols: { min: 1, max: 2 },
  /** `kv.rows`. */
  kvRows: { min: 1, max: 12 },
  /** `spark.values`. */
  sparkValues: { min: 2, max: 24 },
  /** `bar.items`. */
  barItems: { min: 1, max: 12 },
  /** `steps.steps` and a progress's steps (WIRE.md §7.12). */
  steps: { min: 1, max: STEPS_MAX },
  /** Children of one layout node. */
  children: { min: 1, max: 24 },
  /** Nesting: the view's root is depth 1. */
  depth: { min: 1, max: 6 },
  /** Nodes in one view, every child counted. */
  nodes: { min: 1, max: 300 },
} as const;

// ── Durations ────────────────────────────────────────────────────────────────────────────────

/** `every` in the manifest: at least 5 s (design §3.2), at most a day. */
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
 * `fresh`): three ticks of `every`, at least a minute; ten minutes for a mod with no timer. A part
 * always has a window, so a bridge that is down cannot leave "deploy green" on the glass.
 */
export function freshWindowMs(freshMs: number | undefined, everyMs: number | undefined): number {
  if (freshMs !== undefined) return freshMs;
  if (everyMs !== undefined) return Math.max(3 * everyMs, 60_000);
  return 10 * 60_000;
}

// ── Closed lists ─────────────────────────────────────────────────────────────────────────────

/** The tones a mod may name. Each maps to a token that already exists (`TONE_TOKENS`). */
export const TONES = ["plain", "muted", "ok", "warn", "error", "working", "unknown"] as const;
export type Tone = (typeof TONES)[number];

/**
 * THE TONE MAP. Each tone to a colour token of `index.css` (DESIGN.md §13). No new colour.
 *   * `ok` is `status-done`, `error` is `status-blocked`, `unknown` is `status-unknown`.
 *   * `warn` has no status token of its own. It takes `status-working`, the token the app's caution
 *     Notice already uses (components/ui/notice.tsx, `caution`). So `warn` and `working` draw in one
 *     colour; a mod tells them apart with its icon and its words, as Collie's own caution notice does.
 *   * `plain` and `muted` are the two inks, `foreground` and `muted-foreground`: a mod's part is not
 *     a status and most of it is plain text.
 * A part past its `fresh` window draws as `unknown` whatever it says (design §4, freshness).
 */
export const TONE_TOKENS = {
  plain: "foreground",
  muted: "muted-foreground",
  ok: "status-done",
  warn: "status-working",
  error: "status-blocked",
  working: "status-working",
  unknown: "status-unknown",
} as const satisfies { readonly [T in Tone]: string };
export type ToneToken = (typeof TONE_TOKENS)[Tone];

/**
 * The text class of each tone, spelled out so Tailwind's scan of this file finds every one (a class
 * built as `text-${token}` is never generated). The renderer uses these and nothing else for ink.
 */
export const TONE_TEXT_CLASS = {
  plain: "text-foreground",
  muted: "text-muted-foreground",
  ok: "text-status-done",
  warn: "text-status-working",
  error: "text-status-blocked",
  working: "text-status-working",
  unknown: "text-status-unknown",
} as const satisfies { readonly [T in Tone]: `text-${(typeof TONE_TOKENS)[T]}` };

/** The colour token a tone draws in. */
export function toneToken(tone: Tone): ToneToken {
  return TONE_TOKENS[tone];
}

/**
 * Session status words that are NOT tones. A provider that writes `"tone": "blocked"` meant a status,
 * and a mod's red is never read as "an agent needs you" (ADR 0063 point 3), so it gets its own reason.
 */
const STATUS_WORDS = ["blocked", "done", "idle", "waiting"] as const;

/**
 * Keys that would make a mod's mark look like Collie's status mark. Refused with their own reason:
 * a mod mark draws the mod's icon and face word in its own frame, never a status dot (design §2).
 */
export const STATUS_MARK_KEYS = ["status", "dot", "state", "pulse"] as const;

export const GAPS = ["tight", "normal", "loose"] as const;
export type Gap = (typeof GAPS)[number];
export const ALIGNS = ["start", "center", "end", "between"] as const;
export type Align = (typeof ALIGNS)[number];
export const TEXT_ROLES = ["display", "title", "body", "caption", "mono"] as const;
export type TextRole = (typeof TEXT_ROLES)[number];
/** `time.style`: "3 min ago", "09:41", "8 Nov", "in 4 min". The phone ticks it itself. */
export const TIME_STYLES = ["ago", "clock", "date", "until"] as const;
export type TimeStyle = (typeof TIME_STYLES)[number];
/** `image.ratio`, width to height. The image is letterboxed into it, so its height never moves. */
export const IMAGE_RATIOS = ["1:1", "4:3", "3:2", "16:9", "2:1", "3:4"] as const;
export type ImageRatio = (typeof IMAGE_RATIOS)[number];
/** `table.columns[].align`. */
export const COLUMN_ALIGNS = ["start", "end"] as const;
export type ColumnAlign = (typeof COLUMN_ALIGNS)[number];
/** A progress step's state (WIRE.md §7.12). */
export const STEP_STATES = ["done", "running", "todo"] as const;
export type StepState = (typeof STEP_STATES)[number];
/**
 * A `steps` figure's step state. DECISION: the figure adds `failed`, because a mod's steps are often
 * checks (the legs mod's red leg). A session part's `progress` keeps WIRE.md's three, since it rides
 * the pane fields that a program pane also fills.
 */
export const FIGURE_STEP_STATES = ["done", "running", "todo", "failed"] as const;
export type FigureStepState = (typeof FIGURE_STEP_STATES)[number];

/**
 * THE ICON SET a mod may name: a closed list of words, each a lucide icon the phone already ships in
 * the app's own code under `web/src` (so a mod adds no glyph to the bundle). `MOD_ICON_LUCIDE` names the lucide
 * export for each; the test holds every one to `lucide-react`. Left out on purpose: the spinner
 * (`Loader2`, Collie's own busy state), and the filled status circles (`CircleDot`, `CheckCircle2`,
 * `XCircle`, `CircleAlert`), which read as Collie's status marks.
 */
export const MOD_ICON_LUCIDE = {
  activity: "Activity",
  alert: "TriangleAlert",
  archive: "Archive",
  bell: "Bell",
  bot: "Bot",
  branch: "GitBranch",
  bug: "Bug",
  chart: "BarChart3",
  check: "Check",
  clock: "Clock",
  commit: "GitCommitHorizontal",
  cpu: "Cpu",
  disk: "HardDrive",
  file: "FileText",
  flag: "Flag",
  flask: "FlaskConical",
  folder: "Folder",
  gauge: "Gauge",
  globe: "Globe",
  inbox: "Inbox",
  info: "Info",
  link: "ExternalLink",
  list: "ListTodo",
  lock: "Lock",
  message: "MessageSquare",
  more: "Ellipsis",
  note: "StickyNote",
  pause: "Pause",
  play: "Play",
  plug: "Plug",
  refresh: "RefreshCw",
  search: "Search",
  send: "Send",
  server: "Server",
  settings: "Settings2",
  shield: "Shield",
  star: "Star",
  terminal: "SquareTerminal",
  timer: "Timer",
  trash: "Trash2",
  user: "User",
  wrench: "Wrench",
  x: "X",
  zap: "Zap",
} as const;
export type ModIcon = keyof typeof MOD_ICON_LUCIDE;
/** The icon words, sorted. */
export const MOD_ICONS: readonly ModIcon[] = keyStrings(MOD_ICON_LUCIDE);
/** The icon of a mod whose manifest names none. */
export const DEFAULT_MOD_ICON: ModIcon = "plug";

/**
 * A mod session action's icon: the twelve words of `PANE_ACTION_ICONS` (bridge/types.ts), because a
 * mod session's actions ride the pane fields as `PaneAction`s. Restated, not imported, so this file
 * loads without the bridge; the test reads both and fails on drift.
 */
export const ACTION_ICONS = ["play", "pause", "check", "x", "refresh", "archive", "flag", "star", "send", "note", "search", "more"] as const;
export type ActionIcon = (typeof ACTION_ICONS)[number];

/** The events a manifest may name in `on` (slice 10, the event bus). */
export const MOD_EVENTS = ["session.status", "turn.end", "ask.open"] as const;
export type ModEvent = (typeof MOD_EVENTS)[number];
/** `mode`: `once` runs per trigger; `serve` keeps the provider running (slice 10). */
export const MOD_MODES = ["once", "serve"] as const;
export type ModMode = (typeof MOD_MODES)[number];
/** The parts of a manifest that a later slice builds. Refused as "later" until a caller enables them. */
export const LATER_TRIGGERS = ["watch", "on", "serve"] as const;
export type LaterTrigger = (typeof LATER_TRIGGERS)[number];

/** The session statuses the facts carry (`AgentStatus` in bridge/types.ts). */
export const SESSION_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// ── Places ───────────────────────────────────────────────────────────────────────────────────

/**
 * Where a part draws, by kind. The `at` of a part names one (`belt`, `tab:fix`, `view:agent:claude`)
 * and the manifest's `places` lists the kinds it uses. DECISION: the manifest declares kinds, not
 * whole `at` strings, so a mod may compute its matches at run time; `tab-mark` is `tab:<tabmatch>`,
 * `view` is `view:<match>`, `menu` is `menu:<match>`.
 */
export const PLACE_KINDS = ["belt", "session", "tab-mark", "tab", "view", "dashboard", "header.line", "menu", "settings"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];
/** The places slices 03 to 07 build. A parser call with no `places` accepts these. */
export const NEAR_PLACES = ["belt", "session", "tab-mark", "tab", "view"] as const satisfies readonly PlaceKind[];
/** The places slice 11 builds. Refused with "not in this Collie" unless a caller enables them. */
export const LATER_PLACES = ["dashboard", "header.line", "menu", "settings"] as const satisfies readonly PlaceKind[];

// ── Node kinds ───────────────────────────────────────────────────────────────────────────────

/** Slice 02 draws these. The two first real mods (`legs`, `tracker`) use only these. */
export const CORE_NODE_KINDS = ["stack", "row", "text", "number", "kv", "list", "button", "progress", "steps", "mark", "time"] as const;
/** Slice 08 draws these. Typed and parsed now. */
export const MORE_NODE_KINDS = ["grid", "spacer", "divider", "section", "card", "badge", "icon", "link", "log", "table", "image", "bar", "spark", "ring"] as const;
export const NODE_KINDS = [...CORE_NODE_KINDS, ...MORE_NODE_KINDS] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
/** The layout kinds, the ones with `children`. */
export const LAYOUT_KINDS = ["stack", "row", "grid", "section", "card"] as const;
/** The kinds a tap reaches through an `intent`, and the list item. Nothing else is tappable. */
export const TAPPABLE_KINDS = ["button", "link", "mark", "list"] as const;

/** Every key each node kind takes, `kind` included. Anything else is refused. */
export const NODE_KEYS = {
  stack: ["kind", "children", "gap", "align"],
  row: ["kind", "children", "gap", "align"],
  grid: ["kind", "children", "gap", "align", "cols"],
  spacer: ["kind", "size"],
  divider: ["kind"],
  section: ["kind", "children", "gap", "align", "title"],
  card: ["kind", "children", "gap", "align"],
  text: ["kind", "text", "role", "tone", "lines"],
  number: ["kind", "value", "label", "tone"],
  mark: ["kind", "icon", "face", "count", "tone", "label", "intent", "args"],
  badge: ["kind", "text", "count", "tone"],
  icon: ["kind", "name", "tone", "label"],
  kv: ["kind", "rows", "cols"],
  list: ["kind", "rows", "items"],
  link: ["kind", "label", "detail", "icon", "session", "url", "intent", "args"],
  button: ["kind", "label", "intent", "args", "primary", "icon", "disabled"],
  progress: ["kind", "value", "label", "steps"],
  log: ["kind", "lines", "tail"],
  time: ["kind", "at", "style", "label"],
  table: ["kind", "columns", "rows", "items"],
  image: ["kind", "src", "ratio", "alt"],
  bar: ["kind", "items", "max", "tone"],
  spark: ["kind", "values", "label", "tone"],
  steps: ["kind", "steps"],
  ring: ["kind", "value", "label", "tone"],
} as const satisfies { readonly [K in NodeKind]: readonly string[] };

// ── Types: the view tree (design §5) ────────────────────────────────────────────────────────

/** Something a tap names: the intent goes back to the provider with its args (design §4). */
export interface Intent {
  intent: string;
  /** Any JSON object, at most `ARGS_MAX_BYTES` serialised. Handed back unchanged on the tap. */
  args?: JsonObject;
}

interface LayoutBase {
  children: ViewNode[];
  gap?: Gap;
  align?: Align;
}

export interface StackNode extends LayoutBase {
  kind: "stack";
}
export interface RowNode extends LayoutBase {
  kind: "row";
}
export interface GridNode extends LayoutBase {
  kind: "grid";
  cols: number;
}
export interface SpacerNode {
  kind: "spacer";
  size?: Gap;
}
export interface DividerNode {
  kind: "divider";
}
export interface SectionNode extends LayoutBase {
  kind: "section";
  title: string;
}
export interface CardNode extends LayoutBase {
  kind: "card";
}
export interface TextNode {
  kind: "text";
  text: string;
  role?: TextRole;
  tone?: Tone;
  /** The lines it reserves, always, whatever the text: 1 to 12. */
  lines: number;
}
export interface NumberNode {
  kind: "number";
  value: string | number;
  label?: string;
  tone?: Tone;
}

/**
 * A mod's mark: its icon (the manifest's when absent), a face word, a count, a tone and one intent.
 * At least one of icon, face and count. A part that should show nothing is left out of the document;
 * the renderer keeps its slot (design §5). The same type serves a `belt` part, a `tab:` part and the
 * `mark` node.
 */
export interface Mark {
  icon?: ModIcon;
  face?: string;
  count?: number;
  tone?: Tone;
  /** The accessible name. Absent: the renderer composes one from the mod's name and the face. */
  label?: string;
  intent?: string;
  args?: JsonObject;
}
export interface MarkNode extends Mark {
  kind: "mark";
}

/** A badge: a count or a short word, never both (WIRE.md §7.11). */
export type Badge = { count: number } | { text: string };
export type BadgeNode = { kind: "badge"; tone?: Tone } & ({ count: number; text?: never } | { text: string; count?: never });

export interface IconNode {
  kind: "icon";
  name: ModIcon;
  tone?: Tone;
  label?: string;
}
export interface KvRow {
  label: string;
  value: string;
  tone?: Tone;
}
export interface KvNode {
  kind: "kv";
  rows: KvRow[];
  cols?: number;
}
export interface ListItem {
  text: string;
  detail?: string;
  icon?: ModIcon;
  tone?: Tone;
  /** A word at the row's end (`3d`, `red`). */
  trailing?: string;
  intent?: string;
  args?: JsonObject;
}
export interface ListNode {
  kind: "list";
  /** The rows it reserves, 1 to 50. Past them the renderer draws "+n more". */
  rows: number;
  items: ListItem[];
}
/** A row that opens a session or a URL, or names an intent. Exactly one of the three. */
export interface LinkNode {
  kind: "link";
  label: string;
  detail?: string;
  icon?: ModIcon;
  session?: string;
  url?: string;
  intent?: string;
  args?: JsonObject;
}
export interface ButtonNode {
  kind: "button";
  label: string;
  intent: string;
  args?: JsonObject;
  primary?: boolean;
  icon?: ModIcon;
  disabled?: boolean;
}
export interface ProgressStep {
  label: string;
  state: StepState;
}
/** A progress bar: a percent (with an optional label) or steps, never both. */
export interface PercentProgressNode {
  kind: "progress";
  /** 0 to 100. */
  value: number;
  label?: string;
  steps?: never;
}
export interface StepProgressNode {
  kind: "progress";
  steps: ProgressStep[];
  value?: never;
  label?: never;
}
export type ProgressNode = PercentProgressNode | StepProgressNode;
export interface LogNode {
  kind: "log";
  /** The mono lines it reserves, 1 to 40. It draws the last `lines` entries of `tail`. */
  lines: number;
  tail: string[];
}
export interface TimeNode {
  kind: "time";
  /** An ISO 8601 instant with `Z` or an offset. */
  at: string;
  style?: TimeStyle;
  label?: string;
}
export interface TableColumn {
  label: string;
  align?: ColumnAlign;
}
export interface TableNode {
  kind: "table";
  columns: TableColumn[];
  /** The rows it reserves, 1 to 50. */
  rows: number;
  /** One array of cells per row, each as long as `columns`. */
  items: string[][];
}
export interface ImageNode {
  kind: "image";
  /** A `.png`, `.jpg` or `.jpeg` file, relative to the mod folder, no `..`. */
  src: string;
  ratio: ImageRatio;
  alt: string;
}
export interface BarItem {
  label: string;
  value: number;
}
export interface BarNode {
  kind: "bar";
  items: BarItem[];
  /** The full length. Absent: the largest value. */
  max?: number;
  tone?: Tone;
}
export interface SparkNode {
  kind: "spark";
  values: number[];
  label?: string;
  tone?: Tone;
}
export interface FigureStep {
  label: string;
  state: FigureStepState;
}
export interface StepsNode {
  kind: "steps";
  steps: FigureStep[];
}
export interface RingNode {
  kind: "ring";
  /** 0 to 100. */
  value: number;
  label?: string;
  tone?: Tone;
}

export type ViewNode =
  | StackNode
  | RowNode
  | GridNode
  | SpacerNode
  | DividerNode
  | SectionNode
  | CardNode
  | TextNode
  | NumberNode
  | MarkNode
  | BadgeNode
  | IconNode
  | KvNode
  | ListNode
  | LinkNode
  | ButtonNode
  | ProgressNode
  | LogNode
  | TimeNode
  | TableNode
  | ImageNode
  | BarNode
  | SparkNode
  | StepsNode
  | RingNode;

// ── Types: matches (design §2) ──────────────────────────────────────────────────────────────

/**
 * One term of a session match. A match is one or more terms separated by single spaces, and ALL must
 * hold (DECISION: the design names the terms, not how they combine). Globs take `*` and `?` only.
 * A match never reaches a mod session unless one term is `kind:mod`.
 */
export type MatchTerm =
  | { term: "any" }
  | { term: "name"; glob: string }
  | { term: "agent"; agent: string }
  | { term: "cwd"; glob: string }
  | { term: "space"; glob: string }
  | { term: "mod" };
export interface SessionMatch {
  text: string;
  terms: MatchTerm[];
}
/** One term of a tab match: `*`, a title glob, `space:<glob>`. All must hold. */
export type TabMatchTerm = { term: "any" } | { term: "title"; glob: string } | { term: "space"; glob: string };
export interface TabMatch {
  text: string;
  terms: TabMatchTerm[];
}

// ── Types: parts (design §2, §4) ────────────────────────────────────────────────────────────

/** A mod session's action, on the belt of its session (`PaneAction`, plus the intent it taps). */
export interface ModAction {
  id: string;
  label: string;
  intent: string;
  args?: JsonObject;
  icon?: ActionIcon;
  disabled?: boolean;
}

/** The progress of a mod session, WIRE.md §7.12's shape: it rides the pane field `progress`. */
export type PartProgress = { kind: "percent"; value: number; label?: string } | { kind: "steps"; steps: ProgressStep[] };

export interface BeltPart {
  at: "belt";
  id: string;
  mark: Mark;
}
export interface SessionPart {
  at: "session";
  id: string;
  /** The session's name on the Dashboard. Absent: the manifest's `name`. */
  name?: string;
  icon?: ModIcon;
  /**
   * The session's tone (slice 03). `working` makes the pane read as working on the snapshot; every
   * other tone reads idle, because a mod session is outside triage and push and never "needs you".
   */
  tone?: Tone;
  subtitle?: string;
  badge?: Badge;
  progress?: PartProgress;
  actions?: ModAction[];
  view: ViewNode;
}
export interface TabMarkPart {
  at: `tab:${string}`;
  id: string;
  /** No `intent`: a tap on the tab opens the tab. */
  mark: Mark;
}
export interface TabPart {
  at: "tab";
  id: string;
  title: string;
  icon?: ModIcon;
  /** A Space name glob. The tab joins the first Space in Collie's order that matches, and stays. */
  space: string;
  view: ViewNode;
}
export interface ViewPart {
  at: `view:${string}`;
  id: string;
  /** The view's name in the picker. */
  title: string;
  icon?: ModIcon;
  view: ViewNode;
}
export interface DashboardPart {
  at: "dashboard";
  id: string;
  view: ViewNode;
}
export interface HeaderLine {
  text: string;
  icon?: ModIcon;
  tone?: Tone;
  intent?: string;
  args?: JsonObject;
}
export interface HeaderLinePart {
  at: "header.line";
  id: string;
  line: HeaderLine;
}
export interface MenuRow {
  label: string;
  icon?: ModIcon;
  intent: string;
  args?: JsonObject;
}
export interface MenuPart {
  at: `menu:${string}`;
  id: string;
  rows: MenuRow[];
}
export interface SettingsPart {
  at: "settings";
  id: string;
  title: string;
  view: ViewNode;
}
export type ModPart =
  | BeltPart
  | SessionPart
  | TabMarkPart
  | TabPart
  | ViewPart
  | DashboardPart
  | HeaderLinePart
  | MenuPart
  | SettingsPart;

/** A part the parser accepted, with its place kind and its match read out of `at`. */
export type ParsedPart =
  | { place: "belt"; part: BeltPart }
  | { place: "session"; part: SessionPart }
  | { place: "tab-mark"; part: TabMarkPart; tabMatch: TabMatch }
  | { place: "tab"; part: TabPart }
  | { place: "view"; part: ViewPart; match: SessionMatch }
  | { place: "dashboard"; part: DashboardPart }
  | { place: "header.line"; part: HeaderLinePart }
  | { place: "menu"; part: MenuPart; match: SessionMatch }
  | { place: "settings"; part: SettingsPart };

/** A draft for a session's reply box. Only after a tap; fills an EMPTY box; never sends. */
export interface Draft {
  /** A real session's scope key (`host:paneId`), never a name and never a mod session. */
  session: string;
  text: string;
}
/** Where a tap's reply takes the phone. Only after a tap. Back still goes up one level. */
export type OpenTarget = { session: string; url?: never } | { url: string; session?: never };

/** The provider's output, as written (design §4). */
export interface ModDocument {
  v: 1;
  parts: ModPart[];
  asOf?: string;
  fresh?: string;
  draft?: Draft;
  open?: OpenTarget;
}

// ── Types: the manifest and the facts (design §1, §3) ───────────────────────────────────────

/** `mod.toml`, read and with its defaults filled. A runtime value, not a file to write back. */
export interface ModManifest {
  id: string;
  name: string;
  run: string;
  every?: string;
  everyMs?: number;
  watch?: string[];
  on?: ModEvent[];
  mode: ModMode;
  /** The facts version the provider needs. */
  facts: number;
  icon: ModIcon;
  places: PlaceKind[];
}

export type FactsTrigger =
  | { kind: "start" }
  | { kind: "timer" }
  | { kind: "tap"; requestId: string; intent: string; args?: JsonObject; part: string; from?: TapFrom }
  /** Slice 10: a watched file changed. */
  | { kind: "watch"; path: string }
  /** Slice 10: an event of the bus, with the session it is about. */
  | { kind: "event"; event: ModEvent; session?: string };

export interface FactsSession {
  /** The scope key `host:paneId` until v2 session ids exist (design §3.1). */
  id: string;
  paneId: string;
  name?: string;
  agent?: string;
  status: SessionStatus;
  cwd?: string;
  space?: string;
  tab?: string;
  lastActiveAt?: string;
}
export interface FactsSpace {
  name: string;
  folder?: string;
}
export interface ModFacts {
  v: 1;
  trigger: FactsTrigger;
  mod: { id: string; dir: string; state: string };
  host: string;
  sessions: FactsSession[];
  spaces: FactsSpace[];
  /** Only for a `view:<match>` run: the session the view is drawn for. */
  session?: FactsSession;
}

// ── Types: taps and the wire (design §4) ────────────────────────────────────────────────────

/** Where a tap came from: the session open on the phone, when there is one. */
export interface TapFrom {
  session?: string;
}
/** `POST /api/mods/<host>/<id>/tap`. */
export interface TapRequest {
  /** A UUID, the shape every receipt route keys on (bridge/worktree-receipts.ts `isRequestId`). */
  requestId: string;
  intent: string;
  args?: JsonObject;
  /** The id of the part that holds the control. The mod and the host are in the path. */
  part: string;
  from?: TapFrom;
}
export const TAP_OUTCOMES = ["applied", "replayed", "failed", "unknown"] as const;
export type TapOutcome = (typeof TAP_OUTCOMES)[number];
/**
 * The tap reply: the receipt and the mod's new parts, which the phone applies at once. `replayed`
 * returns the first reply's parts and runs nothing. `unknown` is shown and never resent.
 */
export interface ModTapReply {
  requestId: string;
  outcome: TapOutcome;
  /** One masked line, at most `PROBLEM_MAX`, for `failed` and `unknown`. */
  message?: string;
  /** `modsRev` after the run. */
  rev?: number;
  /** This mod's parts that changed, as in `ModsReply.parts`. */
  parts?: WireModPart[];
  /** This mod's part keys now present. */
  present?: string[];
  draft?: Draft;
  open?: OpenTarget;
}

/** The (host, mod, part) a stored part is keyed on, from slice 1, so the crew merge needs no rename. */
export interface ModPartKey {
  host: string;
  mod: string;
  part: string;
}
/** One stored part on the wire. */
export interface WireModPart extends ModPartKey {
  /** Rises when this part changes. The phone redraws in place on a higher rev. */
  rev: number;
  value: ModPart;
  asOf?: string;
  fresh?: string;
  /** The last run failed or this part was refused: this is the last good version. */
  stale?: true;
  /** One masked line about why it is stale, at most `PROBLEM_MAX`. */
  problem?: string;
}
export const MOD_STATES = ["ok", "failing", "stopped", "off", "skipped"] as const;
/**
 * A mod's state on the wire: `ok`; `failing` (backing off, design §3.2); `stopped` (backoff ran
 * out); `off` (the switch); `skipped` (the manifest was refused, or needs a newer facts version).
 */
export type ModState = (typeof MOD_STATES)[number];
/** One mod as the phone lists it: belt order, Settings → Mods, the doctor row's summary. */
export interface WireModInfo {
  host: string;
  id: string;
  name: string;
  icon: ModIcon;
  on: boolean;
  state: ModState;
  places: PlaceKind[];
  /** One masked line, at most `PROBLEM_MAX`. */
  error?: string;
  /** When the provider last ran, an instant. Absent before the first run (added by slice 01). */
  lastRunAt?: string;
  /**
   * The refusals of the manifest and of the last document, capped like the parser's, so Settings →
   * Mods and the doctor row can say why a mod is skipped or a part stale (added by slice 01).
   */
  refusals?: Refusal[];
  /** Who added the mod, when and from where (design §6). Slice 01 knows only that a folder is there. */
  provenance?: ModProvenance;
}
/**
 * How a mod came to be on the machine. `folder` is a folder made by hand or by `collie mod init`;
 * `cli`, `agent` and `repo` are for `collie mod add` (slice 09), which records `at`, `repo` and `sha`.
 */
export interface ModProvenance {
  via: "folder" | "cli" | "agent" | "repo";
  at?: string;
  repo?: string;
  sha?: string;
}
/**
 * `GET /api/mods?since=<rev>`. The snapshot carries `modsRev`; when it moves, the phone asks for the
 * parts changed since the rev it holds. `since=0` gives every part. DECISION: the reply also carries
 * the mod list, which is small, so the belt's order and the switch need no second route.
 */
export interface ModsReply {
  /** The `modsRev` this reply brings the phone to. */
  rev: number;
  mods: WireModInfo[];
  /** Parts whose rev is above `since`. */
  parts: WireModPart[];
  /** Every part key present now (`partKey`). A key the phone holds and this list lacks is gone. */
  present: string[];
  /**
   * The PATH the bridge's runner gives providers, for `collie doctor` (added by slice 01). The phone
   * may ignore it.
   */
  path?: string;
}

/** The string key of a stored part. None of the three may hold `/`, so it splits back. */
export function partKey(key: ModPartKey): string {
  return `${key.host}/${key.mod}/${key.part}`;
}
/** `partKey` read back, or `undefined`. */
export function parsePartKey(text: string): ModPartKey | undefined {
  const pieces = text.split("/");
  if (pieces.length !== 3) return undefined;
  const [host, mod, part] = pieces;
  if (host === undefined || mod === undefined || part === undefined) return undefined;
  if (!isHostName(host) || !isModId(mod) || !isPartId(part)) return undefined;
  return { host, mod, part };
}

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────

export type RefusalCode =
  | "size"
  | "json"
  | "version"
  | "unknown-key"
  | "unknown-kind"
  | "place"
  | "later"
  | "undeclared"
  | "missing"
  | "type"
  | "text"
  | "range"
  | "count"
  | "word"
  | "icon"
  | "id"
  | "duplicate"
  | "target"
  | "status"
  | "tap-only"
  | "depth"
  | "more";

/**
 * Why something was refused. `path` is a JSON pointer into the document (`/parts/0/view/lines`;
 * `""` is the whole document). `reason` is a sentence the doctor row and `collie mod check` print as
 * they are. `part` is the id of the refused part, when it had a readable one.
 */
export interface Refusal {
  code: RefusalCode;
  path: string;
  reason: string;
  part?: string;
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

const MOD_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PART_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const INTENT = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const AGENT = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The mux id rule (bridge/mux/identity.ts): no control character, no whitespace, no `/`, `?`, `#`. */
const UNSAFE_ID_CHAR = /[\p{C}\s/?#]/u;
const MUX_ID_MAX_BYTES = 128;
/** An instant: date, time, optional fraction, `Z` or an offset. `Date.parse` must also accept it. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const INSTANT_MAX = 40;
const IMAGE_SRC = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._\-/]+\.(png|jpe?g)$/i;

/** A mod id: what `mod.toml` names and the folder is called. 1 to 32 of `a-z 0-9 -`. */
export function isModId(text: string): boolean {
  return MOD_ID.test(text);
}
/** A part id, unique inside its document. Same rule as a mod id. */
export function isPartId(text: string): boolean {
  return PART_ID.test(text);
}
/** An intent name: 1 to 48 of `a-z 0-9 . _ -`. */
export function isIntentName(text: string): boolean {
  return INTENT.test(text);
}
/**
 * A host name as the crew names machines. DECISION: `mod` is reserved, so `mod:<host>:<id>` (a mod
 * session's id) can never read as a real session's scope key.
 */
export function isHostName(text: string): boolean {
  return HOST.test(text) && text !== "mod";
}
/** A tap's request id: a UUID, as every receipt route in the bridge keys on. */
export function isRequestId(text: string): boolean {
  return UUID.test(text);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The prefix every mod session id, mod tab id and Mods Space id starts with. Reserved: no real pane takes it. */
export const MOD_SESSION_PREFIX = "mod:";
/**
 * A real session's scope key, `host:paneId` (design §3.1). The pane id follows the mux id rule and
 * may hold colons itself (`w6X:3`). A name (`composer`) has no host and is not one. A mod session's
 * id (`mod:bluefin:legs`) is not one either: it has no reply box and no terminal.
 */
export function isScopeKey(text: string): boolean {
  const colon = text.indexOf(":");
  if (colon <= 0) return false;
  const host = text.slice(0, colon);
  const paneId = text.slice(colon + 1);
  if (!isHostName(host)) return false;
  if (paneId.length === 0 || utf8Bytes(paneId) > MUX_ID_MAX_BYTES) return false;
  // A pane id that starts with `mod:` is a mod session's (`bluefin:mod:bluefin:legs:legs`): it has no
  // reply box, so it is never a real session's key. The prefix is reserved on the bridge too: the
  // durable adapter drops a pane, tab or space of that name (WIRE.md, the id rule).
  if (paneId.startsWith(MOD_SESSION_PREFIX)) return false;
  return !UNSAFE_ID_CHAR.test(paneId);
}
/** A mod session id read back: the host and the mod, and the part when the id names one. */
export interface ModSessionAddress {
  host: string;
  mod: string;
  part?: string;
}
/**
 * Read a mod session's id: `mod:<host>:<id>` names the mod (its first session part), and
 * `mod:<host>:<id>:<part>` one session part of it. DECISION (slice 03): the part rides after a colon,
 * not a `/`, because the id is a pane id on the snapshot and a pane id is one URL path segment
 * (bridge/mux/identity.ts, rule 5). A host holds no colon and neither id does, so it splits back.
 */
export function parseModSessionId(text: string): ModSessionAddress | undefined {
  const pieces = text.split(":");
  if ((pieces.length !== 3 && pieces.length !== 4) || pieces[0] !== "mod") return undefined;
  const host = pieces[1] ?? "";
  const mod = pieces[2] ?? "";
  if (!isHostName(host) || !isModId(mod)) return undefined;
  if (pieces.length === 3) return { host, mod };
  const part = pieces[3] ?? "";
  return isPartId(part) ? { host, mod, part } : undefined;
}
/** A mod session's id, `mod:<host>:<id>` or `mod:<host>:<id>:<part>` (design §2). */
export function isModSessionId(text: string): boolean {
  return parseModSessionId(text) !== undefined;
}
/**
 * The id of a mod's session: the mod's own address, or with `part` the pane id of one session part.
 * The mod's address is also the id of its tab in the Mods Space; the Space's own id is {@link modSpaceId}.
 */
export function modSessionId(host: string, mod: string, part?: string): string {
  return part === undefined ? `mod:${host}:${mod}` : `mod:${host}:${mod}:${part}`;
}
/** The id of a host's Mods Space, the one workspace its mod sessions live in. */
export function modSpaceId(host: string): string {
  return `mod:${host}`;
}

/** An ISO 8601 instant with a zone, as `asOf` and `time.at` need. */
export function isInstant(text: string): boolean {
  return text.length <= INSTANT_MAX && INSTANT.test(text) && !Number.isNaN(Date.parse(text));
}

/**
 * A URL a mod may open: `https://` or `http://`. Plain http is allowed because the operator opens
 * tailnet pages that have no certificate (`http://bluefin:8080`); the tailnet is the transport's
 * guard there. Every other scheme (`javascript:`, `file:`, `data:`) is refused.
 */
export function isModUrl(text: string): boolean {
  if (text.length > URL_MAX || !(text.startsWith("https://") || text.startsWith("http://"))) return false;
  if (/[\s\p{C}]/u.test(text)) return false;
  try {
    const protocol = new URL(text).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** An image `src`: relative to the mod folder, no `..` or `.` step, a `.png`, `.jpg` or `.jpeg`. */
export function isImageSrc(text: string): boolean {
  return text.length <= IMAGE_SRC_MAX && IMAGE_SRC.test(text) && !text.includes("//");
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
 * zero-width space, the word joiner, the byte order mark and the tag block. A mod's text is refused
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

function quoteList(list: readonly string[]): string {
  return list.join(", ");
}

// ── The field reader ─────────────────────────────────────────────────────────────────────────
//
// One object at one path, with the sink its refusals go to. Each read returns the value or
// `undefined`, and pushes a refusal for a present-but-wrong value or a missing required one.

interface TextRule {
  max: number;
  required?: boolean;
  /** Keeps `\n` and `\t`, as WIRE.md's multi-line fields do. */
  multiline?: boolean;
  /** Keeps `\t` alone: a log line. */
  tabs?: boolean;
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
  /** What the object is, in words, for the unknown-key sentence ("a belt part", "a list item"). */
  readonly what: string;

  constructor(obj: JsonObject, path: string, sink: Refusal[], what: string) {
    this.obj = obj;
    this.path = path;
    this.sink = sink;
    this.what = what;
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
        this.push(own.code, key, own.reason);
        continue;
      }
      this.push("unknown-key", key, `"${key}" is not part of ${this.what}. Remove it.`);
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
    if (value !== undefined && isOneOf(TONES, value)) return value;
    if (value !== undefined && isOneOf(STATUS_WORDS, value)) {
      this.push(
        "status",
        key,
        `"${value}" is a session status, not a tone. A mod never draws Collie's status; use one of: ${quoteList(TONES)}.`,
      );
      return undefined;
    }
    this.push("word", key, `"${key}" must be one of: ${quoteList(TONES)}.`);
    return undefined;
  }

  icon(key: string, required = false): ModIcon | undefined {
    const raw = this.obj[key];
    if (raw === undefined) {
      if (required) this.missing(key, "an icon name");
      return undefined;
    }
    const value = asJsonString(raw);
    if (value !== undefined && isOneOf(MOD_ICONS, value)) return value;
    this.push("icon", key, `"${key}" must be one of Collie's mod icons: ${quoteList(MOD_ICONS)}.`);
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
    return new Fields(value, this.at(key), this.sink, what);
  }

  /** `intent` and `args` as a pair. `args` without an `intent` is refused. */
  intent(required: boolean): Intent | undefined {
    const name = this.obj.intent;
    if (name === undefined) {
      if (required) this.missing("intent", "the intent a tap sends to the provider");
      if (this.has("args")) this.push("target", "args", '"args" goes with an "intent". Add one or remove "args".');
      return undefined;
    }
    const value = asJsonString(name);
    if (value === undefined || !isIntentName(value)) {
      this.push("id", "intent", '"intent" must be 1 to 48 of: lower-case letters, digits, ".", "_" and "-".');
      return undefined;
    }
    const out: Intent = { intent: value };
    if (!this.has("args")) return out;
    const args = asJsonObject(this.obj.args);
    if (args === undefined) {
      this.push("type", "args", '"args" must be an object.');
      return undefined;
    }
    const bytes = utf8Bytes(JSON.stringify(args));
    if (bytes > ARGS_MAX_BYTES) {
      this.push("size", "args", `"args" is ${bytes} bytes. At most ${ARGS_MAX_BYTES}.`);
      return undefined;
    }
    out.args = args;
    return out;
  }
}

function textProblem(value: string, rule: TextRule): string | undefined {
  if (value.trim() === "") return "is empty.";
  const n = codePoints(value);
  if (n > rule.max) return `is ${n} characters. At most ${rule.max}.`;
  const multiline = rule.multiline === true;
  if (hasControl(value, multiline, multiline || rule.tabs === true)) {
    return multiline ? "holds a control character. Only a line break and a tab are allowed." : "holds a control character or a line break.";
  }
  if (hasInvisible(value)) return "holds an invisible direction or tag character. Remove it.";
  return undefined;
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

function itemFields(value: JsonValue, path: string, sink: Refusal[], what: string): Fields | undefined {
  const obj = asJsonObject(value);
  if (obj === undefined) {
    sink.push({ code: "type", path, reason: `This must be ${what}, an object.` });
    return undefined;
  }
  return new Fields(obj, path, sink, what);
}

// ── Matches ──────────────────────────────────────────────────────────────────────────────────

const GLOB_BAD = /[\s\p{C}]/u;

function globProblem(glob: string): string | undefined {
  if (glob === "") return "is empty";
  if (GLOB_BAD.test(glob)) return "holds a space or a control character";
  return undefined;
}

/**
 * Read a session match (`*`, `composer*`, `agent:claude`, `cwd:~/projects/*`, `space:collie`,
 * `kind:mod`, or several of them with single spaces between). A term with a colon must use one of the
 * known prefixes, so a later prefix never reads as a name glob today.
 */
export function parseSessionMatch(text: string): { match: SessionMatch } | { reason: string } {
  if (text === "") return { reason: "The match is empty. Use * for every session." };
  const words = text.split(" ");
  const terms: MatchTerm[] = [];
  for (const word of words) {
    if (word === "") return { reason: "The match has a double or an outer space." };
    const term = readMatchTerm(word);
    if ("reason" in term) return term;
    terms.push(term);
  }
  return { match: { text, terms } };
}

function readMatchTerm(word: string): MatchTerm | { reason: string } {
  if (word === "*") return { term: "any" };
  if (word === "kind:mod") return { term: "mod" };
  const colon = word.indexOf(":");
  if (colon < 0) {
    const problem = globProblem(word);
    return problem === undefined ? { term: "name", glob: word } : { reason: `The name glob "${word}" ${problem}.` };
  }
  const prefix = word.slice(0, colon);
  const rest = word.slice(colon + 1);
  if (prefix === "agent") {
    return AGENT.test(rest) ? { term: "agent", agent: rest } : { reason: `"${word}": an agent is 1 to 32 of a-z, 0-9, ".", "_", "-".` };
  }
  if (prefix === "cwd" || prefix === "space") {
    const problem = globProblem(rest);
    if (problem !== undefined) return { reason: `"${word}": the glob ${problem}.` };
    return prefix === "cwd" ? { term: "cwd", glob: rest } : { term: "space", glob: rest };
  }
  return { reason: `"${word}" is not a match term. Use *, a name glob, agent:, cwd:, space: or kind:mod.` };
}

/** Read a tab match: `*`, a title glob, `space:<glob>`, single spaces between. */
export function parseTabMatch(text: string): { match: TabMatch } | { reason: string } {
  if (text === "") return { reason: "The tab match is empty. Use * for every tab." };
  const terms: TabMatchTerm[] = [];
  for (const word of text.split(" ")) {
    if (word === "") return { reason: "The tab match has a double or an outer space." };
    if (word === "*") {
      terms.push({ term: "any" });
      continue;
    }
    if (word.startsWith("space:")) {
      const glob = word.slice("space:".length);
      const problem = globProblem(glob);
      if (problem !== undefined) return { reason: `"${word}": the glob ${problem}.` };
      terms.push({ term: "space", glob });
      continue;
    }
    if (word.includes(":")) return { reason: `"${word}" is not a tab match term. Use *, a title glob or space:.` };
    const problem = globProblem(word);
    if (problem !== undefined) return { reason: `The title glob "${word}" ${problem}.` };
    terms.push({ term: "title", glob: word });
  }
  return { match: { text, terms } };
}

/** Whether `text` matches `glob`, where `*` is any run and `?` one character. Case-sensitive. */
export function globMatches(glob: string, text: string): boolean {
  const g = [...glob];
  const t = [...text];
  let gi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    const gc = g[gi];
    if (gc !== undefined && (gc === "?" || gc === t[ti])) {
      gi += 1;
      ti += 1;
      continue;
    }
    if (gc === "*") {
      star = gi;
      mark = ti;
      gi += 1;
      continue;
    }
    if (star < 0) return false;
    gi = star + 1;
    mark += 1;
    ti = mark;
  }
  while (g[gi] === "*") gi += 1;
  return gi === g.length;
}

/**
 * What a session match is held against. The caller passes `cwd` already through realpath, and
 * `home` to expand a leading `~/` in a `cwd:` glob; the caller realpaths the glob's folder too when it
 * must (design §2: `/home` is a link on Fedora Atomic). This file touches no disk.
 */
export interface MatchSubject {
  name?: string;
  agent?: string;
  cwd?: string;
  space?: string;
  /** True for a mod's own session. */
  mod: boolean;
}

export function matchesSession(match: SessionMatch, subject: MatchSubject, home?: string): boolean {
  const wantsMod = match.terms.some((t) => t.term === "mod");
  if (subject.mod !== wantsMod) return false;
  return match.terms.every((term) => {
    switch (term.term) {
      case "any":
      case "mod":
        return true;
      case "name":
        return subject.name !== undefined && globMatches(term.glob, subject.name);
      case "agent":
        return subject.agent === term.agent;
      case "space":
        return subject.space !== undefined && globMatches(term.glob, subject.space);
      case "cwd": {
        if (subject.cwd === undefined) return false;
        const glob = home !== undefined && term.glob.startsWith("~/") ? `${home}${term.glob.slice(1)}` : term.glob;
        return globMatches(glob, subject.cwd);
      }
    }
  });
}

export function matchesTab(match: TabMatch, tab: { title: string; space?: string }): boolean {
  return match.terms.every((term) => {
    switch (term.term) {
      case "any":
        return true;
      case "title":
        return globMatches(term.glob, tab.title);
      case "space":
        return tab.space !== undefined && globMatches(term.glob, tab.space);
    }
  });
}

/** What an `at` string says: the place kind, and its match when it has one. */
export type AtReading =
  | { place: "belt" | "session" | "tab" | "dashboard" | "header.line" | "settings" }
  | { place: "tab-mark"; tabMatch: TabMatch }
  | { place: "view" | "menu"; match: SessionMatch };

/** Read a part's `at`. */
export function parseAt(at: string): AtReading | { reason: string } {
  if (codePoints(at) > AT_MAX) return { reason: `"at" is longer than ${AT_MAX} characters.` };
  if (at === "belt" || at === "session" || at === "tab" || at === "dashboard" || at === "header.line" || at === "settings") {
    return { place: at };
  }
  if (at.startsWith("tab:")) {
    const read = parseTabMatch(at.slice("tab:".length));
    return "reason" in read ? read : { place: "tab-mark", tabMatch: read.match };
  }
  for (const [prefix, place] of [
    ["view:", "view"],
    ["menu:", "menu"],
  ] as const) {
    if (!at.startsWith(prefix)) continue;
    const read = parseSessionMatch(at.slice(prefix.length));
    return "reason" in read ? read : { place, match: read.match };
  }
  return {
    reason: `"${at}" is not a place. Use belt, session, tab, tab:<tabmatch> or view:<match> (later: dashboard, header.line, menu:<match>, settings).`,
  };
}

// ── The view tree reader ─────────────────────────────────────────────────────────────────────

interface ViewContext {
  kinds: readonly NodeKind[];
  nodes: number;
  /** Set once the node cap is passed, so the cap is refused once, not once per node. */
  overflow: boolean;
}

function readView(value: JsonValue | undefined, path: string, sink: Refusal[], kinds: readonly NodeKind[]): ViewNode | undefined {
  const ctx: ViewContext = { kinds, nodes: 0, overflow: false };
  const node = readNode(value, path, sink, ctx, 1);
  if (ctx.overflow) {
    sink.push({ code: "count", path, reason: `The view holds more than ${VIEW_LIMITS.nodes.max} nodes. Draw less, or split it.` });
    return undefined;
  }
  return node;
}

function readNode(value: JsonValue | undefined, path: string, sink: Refusal[], ctx: ViewContext, depth: number): ViewNode | undefined {
  ctx.nodes += 1;
  if (ctx.nodes > VIEW_LIMITS.nodes.max) {
    ctx.overflow = true;
    return undefined;
  }
  if (depth > VIEW_LIMITS.depth.max) {
    sink.push({ code: "depth", path, reason: `The view nests deeper than ${VIEW_LIMITS.depth.max} levels.` });
    return undefined;
  }
  const obj = asJsonObject(value);
  if (obj === undefined) {
    sink.push({ code: "type", path, reason: "A view node must be an object with a \"kind\"." });
    return undefined;
  }
  const rawKind = asJsonString(obj.kind);
  if (rawKind === undefined) {
    sink.push({ code: "missing", path: pointer(path, "kind"), reason: 'A view node needs "kind".' });
    return undefined;
  }
  if (!isOneOf(NODE_KINDS, rawKind)) {
    sink.push({
      code: "unknown-kind",
      path: pointer(path, "kind"),
      reason: `"${rawKind}" is not a node kind. Use one of: ${quoteList(NODE_KINDS)}.`,
    });
    return undefined;
  }
  if (!ctx.kinds.includes(rawKind)) {
    sink.push({ code: "later", path: pointer(path, "kind"), reason: `"${rawKind}" is not in this Collie yet.` });
    return undefined;
  }
  const kind: NodeKind = rawKind;
  const before = sink.length;
  const f = new Fields(obj, path, sink, `a "${kind}" node`);
  // A mark checks its own keys, so a status key gets its own reason (`readMarkInto`).
  if (kind !== "mark") f.keys(NODE_KEYS[kind]);
  const node = readNodeBody(kind, f, ctx, depth);
  return sink.length === before ? node : undefined;
}

function readChildren(f: Fields, ctx: ViewContext, depth: number): ViewNode[] {
  const list = f.array("children", { ...VIEW_LIMITS.children, required: true, what: "nodes" });
  if (list === undefined) return [];
  const out: ViewNode[] = [];
  list.forEach((child, i) => {
    const node = readNode(child, pointer(f.at("children"), i), f.sink, ctx, depth + 1);
    if (node !== undefined) out.push(node);
  });
  return out;
}

function layout<K extends "stack" | "row" | "card">(kind: K, f: Fields, ctx: ViewContext, depth: number): LayoutBase & { kind: K } {
  const children = readChildren(f, ctx, depth);
  const node: LayoutBase & { kind: K } = { kind, children };
  const gap = f.word("gap", GAPS);
  const align = f.word("align", ALIGNS);
  if (gap !== undefined) node.gap = gap;
  if (align !== undefined) node.align = align;
  return node;
}

function setTone<T extends { tone?: Tone }>(node: T, f: Fields): T {
  const tone = f.tone();
  if (tone !== undefined) node.tone = tone;
  return node;
}

function setIntent<T extends { intent?: string; args?: JsonObject }>(node: T, intent: Intent | undefined): T {
  if (intent === undefined) return node;
  node.intent = intent.intent;
  if (intent.args !== undefined) node.args = intent.args;
  return node;
}

function readNodeBody(kind: NodeKind, f: Fields, ctx: ViewContext, depth: number): ViewNode | undefined {
  switch (kind) {
    case "stack":
      return layout("stack", f, ctx, depth);
    case "row":
      return layout("row", f, ctx, depth);
    case "card":
      return layout("card", f, ctx, depth);
    case "grid": {
      const cols = f.int("cols", { ...VIEW_LIMITS.gridCols, required: true });
      const base = layout("stack", f, ctx, depth);
      return { ...base, kind: "grid", cols: cols ?? VIEW_LIMITS.gridCols.min };
    }
    case "section": {
      const title = f.text("title", { max: TITLE_MAX, required: true }) ?? "";
      const base = layout("stack", f, ctx, depth);
      return { ...base, kind: "section", title };
    }
    case "spacer": {
      const node: SpacerNode = { kind: "spacer" };
      const size = f.word("size", GAPS);
      if (size !== undefined) node.size = size;
      return node;
    }
    case "divider":
      return { kind: "divider" };
    case "text": {
      const node: TextNode = {
        kind: "text",
        text: f.text("text", { max: TEXT_MAX, required: true, multiline: true }) ?? "",
        lines: f.int("lines", { ...VIEW_LIMITS.textLines, required: true }) ?? 1,
      };
      const role = f.word("role", TEXT_ROLES);
      if (role !== undefined) node.role = role;
      return setTone(node, f);
    }
    case "number":
      return readNumberNode(f);
    case "mark":
      return readMarkInto<MarkNode>({ kind: "mark" }, f, true);
    case "badge":
      return readBadgeNode(f);
    case "icon": {
      const node: IconNode = { kind: "icon", name: f.icon("name", true) ?? DEFAULT_MOD_ICON };
      const label = f.text("label", { max: LABEL_MAX });
      if (label !== undefined) node.label = label;
      return setTone(node, f);
    }
    case "kv":
      return readKv(f);
    case "list":
      return readList(f);
    case "link":
      return readLink(f);
    case "button": {
      const node: ButtonNode = {
        kind: "button",
        label: f.text("label", { max: BUTTON_LABEL_MAX, required: true }) ?? "",
        intent: "",
      };
      setIntent(node, f.intent(true));
      const primary = f.bool("primary");
      const disabled = f.bool("disabled");
      const icon = f.icon("icon");
      if (primary !== undefined) node.primary = primary;
      if (disabled !== undefined) node.disabled = disabled;
      if (icon !== undefined) node.icon = icon;
      return node;
    }
    case "progress":
      return readProgressNode(f);
    case "log": {
      const lines = f.int("lines", { ...VIEW_LIMITS.logLines, required: true }) ?? 1;
      const tail = readStrings(f, "tail", { min: 0, max: LOG_TAIL_MAX, required: true, what: "lines", text: { max: LOG_LINE_MAX, tabs: true } });
      return { kind: "log", lines, tail: tail ?? [] };
    }
    case "time": {
      const at = f.text("at", { max: INSTANT_MAX, required: true });
      if (at !== undefined && !isInstant(at)) f.push("text", "at", '"at" must be an ISO 8601 instant with a zone, such as 2026-11-08T09:41:00Z.');
      const node: TimeNode = { kind: "time", at: at ?? "" };
      const style = f.word("style", TIME_STYLES);
      const label = f.text("label", { max: LABEL_MAX });
      if (style !== undefined) node.style = style;
      if (label !== undefined) node.label = label;
      return node;
    }
    case "table":
      return readTable(f);
    case "image": {
      const src = f.text("src", { max: IMAGE_SRC_MAX, required: true });
      if (src !== undefined && !isImageSrc(src)) {
        f.push("target", "src", '"src" must be a .png, .jpg or .jpeg file inside the mod folder, as a relative path with no "..".');
      }
      return {
        kind: "image",
        src: src ?? "",
        ratio: f.word("ratio", IMAGE_RATIOS, true) ?? "1:1",
        alt: f.text("alt", { max: LINE_MAX, required: true }) ?? "",
      };
    }
    case "bar":
      return readBar(f);
    case "spark": {
      const node: SparkNode = { kind: "spark", values: readNumbers(f, "values", VIEW_LIMITS.sparkValues) ?? [] };
      const label = f.text("label", { max: LABEL_MAX });
      if (label !== undefined) node.label = label;
      return setTone(node, f);
    }
    case "steps":
      return { kind: "steps", steps: readSteps(f, "steps", FIGURE_STEP_STATES) ?? [] };
    case "ring": {
      const node: RingNode = { kind: "ring", value: f.num("value", { min: 0, max: 100, required: true }) ?? 0 };
      const label = f.text("label", { max: LABEL_MAX });
      if (label !== undefined) node.label = label;
      return setTone(node, f);
    }
  }
}

function readNumberNode(f: Fields): NumberNode {
  const raw = f.obj.value;
  let value: string | number = "";
  const asNumber = asJsonNumber(raw);
  const asText = asJsonString(raw);
  if (raw === undefined) f.missing("value", `a number, or text of 1 to ${NUMBER_TEXT_MAX} characters`);
  if (asNumber !== undefined) value = asNumber;
  if (asText !== undefined) value = f.text("value", { max: NUMBER_TEXT_MAX }) ?? "";
  if (raw !== undefined && asNumber === undefined && asText === undefined) f.push("type", "value", '"value" must be a number or text.');
  const node: NumberNode = { kind: "number", value };
  const label = f.text("label", { max: LABEL_MAX });
  if (label !== undefined) node.label = label;
  return setTone(node, f);
}

function readBadgeNode(f: Fields): BadgeNode {
  const tone = f.tone();
  const badge = readBadgeFields(f);
  const node: BadgeNode = badge !== undefined && "count" in badge ? { kind: "badge", count: badge.count } : { kind: "badge", text: badge?.text ?? "" };
  if (tone !== undefined) node.tone = tone;
  return node;
}

/** `count` or `text`, exactly one (WIRE.md §7.11). Shared by a badge node and a session's badge. */
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

function readKv(f: Fields): KvNode {
  const list = f.array("rows", { ...VIEW_LIMITS.kvRows, required: true, what: "rows" });
  const rows: KvRow[] = [];
  list?.forEach((item, i) => {
    const row = itemFields(item, pointer(f.at("rows"), i), f.sink, "a kv row");
    if (row === undefined) return;
    row.keys(["label", "value", "tone"]);
    const out: KvRow = {
      label: row.text("label", { max: LABEL_MAX, required: true }) ?? "",
      value: row.text("value", { max: LINE_MAX, required: true }) ?? "",
    };
    rows.push(setTone(out, row));
  });
  const node: KvNode = { kind: "kv", rows };
  const cols = f.int("cols", VIEW_LIMITS.kvCols);
  if (cols !== undefined) node.cols = cols;
  return node;
}

function readList(f: Fields): ListNode {
  const rows = f.int("rows", { ...VIEW_LIMITS.listRows, required: true }) ?? 1;
  const list = f.array("items", { min: 0, max: ITEMS_MAX, required: true, what: "items" });
  const items: ListItem[] = [];
  list?.forEach((value, i) => {
    const item = itemFields(value, pointer(f.at("items"), i), f.sink, "a list item");
    if (item === undefined) return;
    item.keys(["text", "detail", "icon", "tone", "trailing", "intent", "args"]);
    const out: ListItem = { text: item.text("text", { max: LINE_MAX, required: true }) ?? "" };
    const detail = item.text("detail", { max: LINE_MAX });
    const icon = item.icon("icon");
    const trailing = item.text("trailing", { max: WORD_MAX });
    if (detail !== undefined) out.detail = detail;
    if (icon !== undefined) out.icon = icon;
    if (trailing !== undefined) out.trailing = trailing;
    setTone(out, item);
    items.push(setIntent(out, item.intent(false)));
  });
  return { kind: "list", rows, items };
}

function readLink(f: Fields): LinkNode {
  const node: LinkNode = { kind: "link", label: f.text("label", { max: LINE_MAX, required: true }) ?? "" };
  const detail = f.text("detail", { max: LINE_MAX });
  const icon = f.icon("icon");
  if (detail !== undefined) node.detail = detail;
  if (icon !== undefined) node.icon = icon;
  const targets = ["session", "url", "intent"].filter((key) => f.has(key));
  if (targets.length !== 1) {
    f.push("target", undefined, 'A link opens exactly one of: "session", "url" or "intent".');
    return node;
  }
  if (f.has("session")) {
    const session = readSessionTarget(f, "session", false);
    if (session !== undefined) node.session = session;
    return node;
  }
  if (f.has("url")) {
    const url = readUrl(f, "url");
    if (url !== undefined) node.url = url;
    return node;
  }
  return setIntent(node, f.intent(true));
}

function readSessionTarget(f: Fields, key: string, draft: boolean): string | undefined {
  const value = f.text(key, { max: 256, required: true });
  if (value === undefined) return undefined;
  if (isScopeKey(value)) return value;
  if (!draft && isModSessionId(value)) return value;
  if (draft && isModSessionId(value)) {
    f.push("target", key, `"${value}" is a mod session. It has no reply box; a draft goes to a real session.`);
    return undefined;
  }
  f.push(
    "target",
    key,
    `"${value}" is not a session's scope key. Use the "id" from the facts (host:paneId, such as bluefin:w6X:3), never a name.`,
  );
  return undefined;
}

function readUrl(f: Fields, key: string): string | undefined {
  const value = f.text(key, { max: URL_MAX, required: true });
  if (value === undefined) return undefined;
  if (isModUrl(value)) return value;
  f.push("target", key, `"${key}" must be an https:// or http:// address of at most ${URL_MAX} characters.`);
  return undefined;
}

function readProgressNode(f: Fields): ProgressNode {
  if (f.has("steps") === f.has("value")) {
    f.push("target", undefined, 'A progress holds "value" (a percent) or "steps", exactly one.');
    return { kind: "progress", value: 0 };
  }
  if (f.has("steps")) {
    if (f.has("label")) f.push("target", "label", 'A progress with "steps" takes no "label"; each step has its own.');
    return { kind: "progress", steps: readSteps(f, "steps", STEP_STATES) ?? [] };
  }
  const node: PercentProgressNode = {
    kind: "progress",
    value: f.num("value", { min: 0, max: 100, required: true }) ?? 0,
  };
  const label = f.text("label", { max: STEP_LABEL_MAX });
  if (label !== undefined) node.label = label;
  return node;
}

function readSteps<S extends string>(f: Fields, key: string, states: readonly S[]): { label: string; state: S }[] | undefined {
  const list = f.array(key, { ...VIEW_LIMITS.steps, required: true, what: "steps" });
  if (list === undefined) return undefined;
  const out: { label: string; state: S }[] = [];
  list.forEach((value, i) => {
    const step = itemFields(value, pointer(f.at(key), i), f.sink, "a step");
    if (step === undefined) return;
    step.keys(["label", "state"]);
    const label = step.text("label", { max: STEP_LABEL_MAX, required: true });
    const state = step.word("state", states, true);
    if (label !== undefined && state !== undefined) out.push({ label, state });
  });
  return out;
}

function readNumbers(f: Fields, key: string, rule: { min: number; max: number }): number[] | undefined {
  const list = f.array(key, { ...rule, required: true, what: "numbers" });
  if (list === undefined) return undefined;
  const out: number[] = [];
  list.forEach((value, i) => {
    const n = asJsonNumber(value);
    if (n === undefined || !Number.isFinite(n) || Math.abs(n) > 1e15) {
      f.sink.push({ code: "type", path: pointer(f.at(key), i), reason: "This must be a finite number." });
      return;
    }
    out.push(n);
  });
  return out;
}

function readTable(f: Fields): TableNode {
  const cols = f.array("columns", { ...VIEW_LIMITS.tableColumns, required: true, what: "columns" });
  const columns: TableColumn[] = [];
  cols?.forEach((value, i) => {
    const col = itemFields(value, pointer(f.at("columns"), i), f.sink, "a table column");
    if (col === undefined) return;
    col.keys(["label", "align"]);
    const out: TableColumn = { label: col.text("label", { max: WORD_MAX, required: true }) ?? "" };
    const align = col.word("align", COLUMN_ALIGNS);
    if (align !== undefined) out.align = align;
    columns.push(out);
  });
  const rows = f.int("rows", { ...VIEW_LIMITS.tableRows, required: true }) ?? 1;
  const list = f.array("items", { min: 0, max: ITEMS_MAX, required: true, what: "rows of cells" });
  const items: string[][] = [];
  list?.forEach((value, i) => {
    const path = pointer(f.at("items"), i);
    if (!Array.isArray(value)) {
      f.sink.push({ code: "type", path, reason: "Each table row must be a list of cells." });
      return;
    }
    if (cols !== undefined && value.length !== cols.length) {
      f.sink.push({ code: "count", path, reason: `This row holds ${value.length} cells. The table has ${cols.length} columns.` });
      return;
    }
    const cells: string[] = [];
    value.forEach((cell, j) => {
      const text = asJsonString(cell);
      const problem = text === undefined ? "must be text." : textProblem(text, { max: CELL_MAX });
      if (text === undefined || problem !== undefined) {
        f.sink.push({ code: text === undefined ? "type" : "text", path: pointer(path, j), reason: `This cell ${problem ?? ""}`.trim() });
        return;
      }
      cells.push(text);
    });
    items.push(cells);
  });
  return { kind: "table", columns, rows, items };
}

function readBar(f: Fields): BarNode {
  const list = f.array("items", { ...VIEW_LIMITS.barItems, required: true, what: "bars" });
  const items: BarItem[] = [];
  list?.forEach((value, i) => {
    const item = itemFields(value, pointer(f.at("items"), i), f.sink, "a bar");
    if (item === undefined) return;
    item.keys(["label", "value"]);
    items.push({
      label: item.text("label", { max: WORD_MAX, required: true }) ?? "",
      value: item.num("value", { min: 0, max: 1e15, required: true }) ?? 0,
    });
  });
  const node: BarNode = { kind: "bar", items };
  const max = f.num("max", { min: 0, max: 1e15 });
  if (max !== undefined) node.max = max;
  return setTone(node, f);
}

/**
 * A mark's fields into `node`. `tappable` is false on a tab mark: a tap on the tab opens the tab, so
 * DECISION: a tab mark takes no intent. Keys that would draw a status mark get their own reason.
 */
function readMarkInto<T extends Mark>(node: T, f: Fields, tappable: boolean): T {
  const own = (key: string) =>
    isOneOf(STATUS_MARK_KEYS, key)
      ? { code: "status" as const, reason: `"${key}" would draw Collie's status mark. A mod mark draws its own icon and face; use "tone".` }
      : !tappable && (key === "intent" || key === "args")
        ? { code: "target" as const, reason: "A tab mark takes no intent: a tap on the tab opens the tab." }
        : undefined;
  const allowed = tappable ? NODE_KEYS.mark : NODE_KEYS.mark.filter((key) => key !== "intent" && key !== "args");
  f.keys(allowed, own);
  const icon = f.icon("icon");
  const face = f.text("face", { max: FACE_MAX });
  const count = f.int("count", { min: 0, max: COUNT_MAX });
  const label = f.text("label", { max: MARK_LABEL_MAX });
  if (icon !== undefined) node.icon = icon;
  if (face !== undefined) node.face = face;
  if (count !== undefined) node.count = count;
  if (label !== undefined) node.label = label;
  setTone(node, f);
  if (!f.has("icon") && !f.has("face") && !f.has("count")) {
    f.push("missing", undefined, 'A mark needs "icon", "face" or "count". To show nothing, leave the part out.');
  }
  if (tappable) setIntent(node, f.intent(false));
  return node;
}

// ── Parts ────────────────────────────────────────────────────────────────────────────────────

const PART_KEYS = {
  belt: ["at", "id", "mark"],
  session: ["at", "id", "name", "icon", "tone", "subtitle", "badge", "progress", "actions", "view"],
  "tab-mark": ["at", "id", "mark"],
  tab: ["at", "id", "title", "icon", "space", "view"],
  view: ["at", "id", "title", "icon", "view"],
  dashboard: ["at", "id", "view"],
  "header.line": ["at", "id", "line"],
  menu: ["at", "id", "rows"],
  settings: ["at", "id", "title", "view"],
} as const satisfies { readonly [K in PlaceKind]: readonly string[] };

const PLACE_WORDS = {
  belt: "a belt part",
  session: "a session part",
  "tab-mark": "a tab mark part",
  tab: "a tab part",
  view: "a view part",
  dashboard: "a dashboard part",
  "header.line": "a header line part",
  menu: "a menu part",
  settings: "a settings part",
} as const satisfies { readonly [K in PlaceKind]: string };

export interface ParseModDocumentOptions {
  /** The place kinds this Collie draws. Default `NEAR_PLACES`; a later place is refused as "later". */
  places?: readonly PlaceKind[];
  /** The node kinds this Collie draws. Default every kind; slice 01 may pass `CORE_NODE_KINDS` until slice 08. */
  kinds?: readonly NodeKind[];
  /** The manifest's `places`. Absent: not checked. A part in a kind it does not declare is refused. */
  declared?: readonly PlaceKind[];
  /** This run answered a tap. Only then may the document carry `draft` or `open`. */
  afterTap?: boolean;
}

export interface ParsedModDocument {
  /** The accepted parts, in document order. */
  parts: ParsedPart[];
  /** Every refusal, each with its path, capped at `REFUSALS_MAX` plus one counting row. */
  refusals: Refusal[];
  /** The ids of refused parts that had a readable id: the runner keeps their last good version, stale. */
  refusedParts: string[];
  /**
   * True when the document as a whole was refused (too big, not JSON, not an object, a wrong `v`,
   * `parts` not a list): no part was read, so the runner keeps every last good part, stale.
   */
  documentRefused: boolean;
  asOf?: string;
  fresh?: string;
  freshMs?: number;
  draft?: Draft;
  open?: OpenTarget;
}

const DOCUMENT_KEYS = ["v", "parts", "asOf", "fresh", "draft", "open"];

/** `parseModDocument` over the provider's stdout text: the byte cap first, then JSON. */
export function parseModDocumentText(text: string, opts: ParseModDocumentOptions = {}): ParsedModDocument {
  const bytes = utf8Bytes(text);
  if (bytes > DOCUMENT_MAX_BYTES) return wholeRefused("size", `The document is ${bytes} bytes. At most ${DOCUMENT_MAX_BYTES}.`);
  const doc = parseJson(text);
  if (doc === undefined) return wholeRefused("json", "The output is not JSON. Print one JSON document and nothing else.");
  return parseModDocument(doc, opts);
}

function wholeRefused(code: RefusalCode, reason: string): ParsedModDocument {
  return { parts: [], refusals: [{ code, path: "", reason }], refusedParts: [], documentRefused: true };
}

/**
 * Parse a provider's output. Total: any JSON value gives a result, and every refusal is collected. A
 * bad part is refused alone and the others are kept (design §4 rule 1). A bad `asOf`, `fresh`,
 * `draft` or `open` is refused alone too, and the parts still draw.
 */
export function parseModDocument(raw: JsonValue | undefined, opts: ParseModDocumentOptions = {}): ParsedModDocument {
  const obj = asJsonObject(raw);
  if (obj === undefined) return wholeRefused("type", "The document must be a JSON object with \"v\" and \"parts\".");
  const bytes = utf8Bytes(JSON.stringify(obj));
  if (bytes > DOCUMENT_MAX_BYTES) return wholeRefused("size", `The document is ${bytes} bytes. At most ${DOCUMENT_MAX_BYTES}.`);
  const refusals: Refusal[] = [];
  const top = new Fields(obj, "", refusals, "a mod document");
  top.keys(DOCUMENT_KEYS);
  if (asJsonNumber(obj.v) !== DOCUMENT_VERSION) {
    const said = obj.v === undefined ? 'has no "v"' : `says "v": ${JSON.stringify(obj.v)}`;
    refusals.push({ code: "version", path: "/v", reason: `The document ${said}. This Collie reads "v": ${DOCUMENT_VERSION}.` });
    return { parts: [], refusals: capRefusals(refusals), refusedParts: [], documentRefused: true };
  }
  const list = top.array("parts", { min: 0, max: PARTS_MAX, required: true, what: "parts" });
  if (list === undefined) return { parts: [], refusals: capRefusals(refusals), refusedParts: [], documentRefused: true };

  const result: ParsedModDocument = { parts: [], refusals, refusedParts: [], documentRefused: false };

  const seen = new Set<string>();
  let belt = false;
  list.forEach((value, i) => {
    const path = pointer("/parts", i);
    const sink: Refusal[] = [];
    const parsed = readPart(value, path, sink, opts);
    const id = parsed.id;
    if (id !== undefined && seen.has(id)) sink.push({ code: "duplicate", path: pointer(path, "id"), reason: `The part id "${id}" is used twice. Each part needs its own.` });
    if (parsed.part?.place === "belt" && belt) {
      sink.push({ code: "duplicate", path: pointer(path, "at"), reason: "A mod has one belt mark. This is a second one." });
    }
    if (id !== undefined) seen.add(id);
    if (sink.length > 0 || parsed.part === undefined) {
      for (const r of sink) refusals.push(id === undefined ? r : { ...r, part: id });
      if (id !== undefined) result.refusedParts.push(id);
      return;
    }
    if (parsed.part.place === "belt") belt = true;
    result.parts.push(parsed.part);
  });
  readDocumentExtras(top, opts, result);
  result.refusals = capRefusals(refusals);
  return result;
}

function readDocumentExtras(top: Fields, opts: ParseModDocumentOptions, out: ParsedModDocument): void {
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

  const draft = top.object("draft", "an object with \"session\" and \"text\"");
  if (draft !== undefined && opts.afterTap !== true) {
    top.push("tap-only", "draft", 'A "draft" comes only in the reply to a tap. Leave it out of a timer run.');
  }
  if (draft !== undefined && opts.afterTap === true) {
    const before = draft.sink.length;
    draft.keys(["session", "text"]);
    const session = readSessionTarget(draft, "session", true);
    const text = draft.text("text", { max: DRAFT_TEXT_MAX, required: true, multiline: true });
    if (draft.sink.length === before && session !== undefined && text !== undefined) out.draft = { session, text };
  }

  const open = top.object("open", "an object with \"session\" or \"url\"");
  if (open !== undefined && opts.afterTap !== true) {
    top.push("tap-only", "open", 'An "open" comes only in the reply to a tap. Leave it out of a timer run.');
  }
  if (open !== undefined && opts.afterTap === true) {
    const before = open.sink.length;
    open.keys(["session", "url"]);
    if (open.has("session") === open.has("url")) open.push("target", undefined, '"open" holds "session" or "url", exactly one.');
    const session = open.has("session") ? readSessionTarget(open, "session", false) : undefined;
    const url = open.has("url") ? readUrl(open, "url") : undefined;
    if (open.sink.length !== before) return;
    if (session !== undefined) out.open = { session };
    if (url !== undefined) out.open = { url };
  }
}

/** One part read: its id when it had a readable one, and the part when nothing was refused. */
interface PartReading {
  id?: string;
  part?: ParsedPart;
}

function readPart(value: JsonValue, path: string, sink: Refusal[], opts: ParseModDocumentOptions): PartReading {
  const obj = asJsonObject(value);
  if (obj === undefined) {
    sink.push({ code: "type", path, reason: 'A part must be an object with "at" and "id".' });
    return {};
  }
  const idRaw = asJsonString(obj.id);
  const id = idRaw !== undefined && isPartId(idRaw) ? idRaw : undefined;
  if (id === undefined) {
    sink.push({ code: "id", path: pointer(path, "id"), reason: 'A part needs an "id" of 1 to 32 lower-case letters, digits and hyphens.' });
  }
  const bytes = utf8Bytes(JSON.stringify(obj));
  if (bytes > PART_MAX_BYTES) {
    sink.push({ code: "size", path, reason: `The part is ${bytes} bytes. A part may be at most ${PART_MAX_BYTES}.` });
    return { id };
  }
  const atRaw = asJsonString(obj.at);
  if (atRaw === undefined) {
    sink.push({ code: "missing", path: pointer(path, "at"), reason: 'A part needs "at": where it draws.' });
    return { id };
  }
  const reading = parseAt(atRaw);
  if ("reason" in reading) {
    sink.push({ code: "place", path: pointer(path, "at"), reason: reading.reason });
    return { id };
  }
  const place = reading.place;
  const enabled = opts.places ?? NEAR_PLACES;
  if (!enabled.includes(place)) {
    sink.push({ code: "later", path: pointer(path, "at"), reason: `"${place}" is not in this Collie. The other parts still draw.` });
    return { id };
  }
  if (opts.declared !== undefined && !opts.declared.includes(place)) {
    sink.push({ code: "undeclared", path: pointer(path, "at"), reason: `The manifest's "places" does not list "${place}". Add it there.` });
    return { id };
  }
  const f = new Fields(obj, path, sink, PLACE_WORDS[place]);
  f.keys(PART_KEYS[place]);
  const kinds = opts.kinds ?? NODE_KINDS;
  const part = readPartBody(reading, atRaw, id ?? "", f, kinds);
  return { id, part };
}

function readPartBody(reading: AtReading, at: string, id: string, f: Fields, kinds: readonly NodeKind[]): ParsedPart | undefined {
  const view = (required: boolean) => {
    if (!f.has("view")) {
      if (required) f.missing("view", "the view tree it draws");
      return undefined;
    }
    return readView(f.obj.view, f.at("view"), f.sink, kinds);
  };
  switch (reading.place) {
    case "belt": {
      const markFields = f.object("mark", "a mark", true);
      const mark = markFields === undefined ? {} : readMarkInto({}, markFields, true);
      return { place: "belt", part: { at: "belt", id, mark } };
    }
    case "tab-mark": {
      const markFields = f.object("mark", "a mark", true);
      const mark = markFields === undefined ? {} : readMarkInto({}, markFields, false);
      // SAFETY: `parseAt` read this `at` as `tab:<tabmatch>`, so it starts with "tab:".
      return { place: "tab-mark", part: { at: at as `tab:${string}`, id, mark }, tabMatch: reading.tabMatch };
    }
    case "session":
      return readSessionPart(f, id, view(true));
    case "tab": {
      const title = f.text("title", { max: TAB_TITLE_MAX, required: true }) ?? "";
      const space = f.text("space", { max: 128, required: true }) ?? "";
      const problem = space === "" ? undefined : globProblem(space);
      if (problem !== undefined) f.push("text", "space", `"space" is a Space name glob; it ${problem}.`);
      const part: TabPart = { at: "tab", id, title, space, view: view(true) ?? DIVIDER };
      const icon = f.icon("icon");
      if (icon !== undefined) part.icon = icon;
      return { place: "tab", part };
    }
    case "view": {
      // SAFETY: `parseAt` read this `at` as `view:<match>`, so it starts with "view:".
      const part: ViewPart = { at: at as `view:${string}`, id, title: f.text("title", { max: VIEW_TITLE_MAX, required: true }) ?? "", view: view(true) ?? DIVIDER };
      const icon = f.icon("icon");
      if (icon !== undefined) part.icon = icon;
      return { place: "view", part, match: reading.match };
    }
    case "menu": {
      // SAFETY: `parseAt` read this `at` as `menu:<match>`, so it starts with "menu:".
      return { place: "menu", part: { at: at as `menu:${string}`, id, rows: readMenuRows(f) }, match: reading.match };
    }
    case "dashboard":
      return { place: "dashboard", part: { at: "dashboard", id, view: view(true) ?? DIVIDER } };
    case "header.line":
      return { place: "header.line", part: { at: "header.line", id, line: readHeaderLine(f) } };
    case "settings":
      return {
        place: "settings",
        part: { at: "settings", id, title: f.text("title", { max: TITLE_MAX, required: true }) ?? "", view: view(true) ?? DIVIDER },
      };
  }
}

/** A stand-in for a view that failed to read. The part is refused anyway; it never reaches a caller. */
const DIVIDER: DividerNode = { kind: "divider" };

function readSessionPart(f: Fields, id: string, view: ViewNode | undefined): ParsedPart {
  const part: SessionPart = { at: "session", id, view: view ?? DIVIDER };
  const name = f.text("name", { max: NAME_MAX });
  const icon = f.icon("icon");
  const subtitle = f.text("subtitle", { max: SUBTITLE_MAX });
  if (name !== undefined) part.name = name;
  if (icon !== undefined) part.icon = icon;
  setTone(part, f);
  if (subtitle !== undefined) part.subtitle = subtitle;
  const badgeFields = f.object("badge", 'an object with "count" or "text"');
  if (badgeFields !== undefined) {
    badgeFields.keys(["count", "text"]);
    const badge = readBadgeFields(badgeFields);
    if (badge !== undefined) part.badge = badge;
  }
  const progressFields = f.object("progress", 'an object with "kind": "percent" or "steps"');
  if (progressFields !== undefined) {
    const progress = readPartProgress(progressFields);
    if (progress !== undefined) part.progress = progress;
  }
  const actions = readActions(f);
  if (actions !== undefined) part.actions = actions;
  return { place: "session", part };
}

/** A mod session's `progress`, WIRE.md §7.12's two shapes. */
function readPartProgress(f: Fields): PartProgress | undefined {
  const kind = f.word("kind", ["percent", "steps"] as const, true);
  if (kind === "percent") {
    f.keys(["kind", "value", "label"]);
    const value = f.num("value", { min: 0, max: 100, required: true });
    const label = f.text("label", { max: STEP_LABEL_MAX });
    if (value === undefined) return undefined;
    return label === undefined ? { kind: "percent", value } : { kind: "percent", value, label };
  }
  if (kind === "steps") {
    f.keys(["kind", "steps"]);
    const steps = readSteps(f, "steps", STEP_STATES);
    return steps === undefined ? undefined : { kind: "steps", steps };
  }
  return undefined;
}

function readActions(f: Fields): ModAction[] | undefined {
  const list = f.array("actions", { min: 0, max: ACTIONS_MAX, what: "actions" });
  if (list === undefined) return undefined;
  const out: ModAction[] = [];
  const ids = new Set<string>();
  list.forEach((value, i) => {
    const a = itemFields(value, pointer(f.at("actions"), i), f.sink, "an action");
    if (a === undefined) return;
    a.keys(["id", "label", "intent", "args", "icon", "disabled"]);
    const idRaw = asJsonString(a.obj.id);
    if (idRaw === undefined || !isPartId(idRaw)) a.push("id", "id", 'An action needs an "id" of 1 to 32 lower-case letters, digits and hyphens.');
    if (idRaw !== undefined && ids.has(idRaw)) a.push("duplicate", "id", `The action id "${idRaw}" is used twice.`);
    if (idRaw !== undefined) ids.add(idRaw);
    const label = a.text("label", { max: ACTION_LABEL_MAX, required: true });
    const action: ModAction = { id: idRaw ?? "", label: label ?? "", intent: "" };
    setIntent(action, a.intent(true));
    const icon = a.word("icon", ACTION_ICONS);
    const disabled = a.bool("disabled");
    if (icon !== undefined) action.icon = icon;
    if (disabled !== undefined) action.disabled = disabled;
    out.push(action);
  });
  return out;
}

function readMenuRows(f: Fields): MenuRow[] {
  const list = f.array("rows", { min: 1, max: MENU_ROWS_MAX, required: true, what: "rows" });
  const out: MenuRow[] = [];
  list?.forEach((value, i) => {
    const row = itemFields(value, pointer(f.at("rows"), i), f.sink, "a menu row");
    if (row === undefined) return;
    row.keys(["label", "icon", "intent", "args"]);
    const out1: MenuRow = { label: row.text("label", { max: MENU_LABEL_MAX, required: true }) ?? "", intent: "" };
    const icon = row.icon("icon");
    if (icon !== undefined) out1.icon = icon;
    out.push(setIntent(out1, row.intent(true)));
  });
  return out;
}

function readHeaderLine(f: Fields): HeaderLine {
  const line = f.object("line", 'an object with "text"', true);
  if (line === undefined) return { text: "" };
  line.keys(["text", "icon", "tone", "intent", "args"]);
  const out: HeaderLine = { text: line.text("text", { max: LINE_MAX, required: true }) ?? "" };
  const icon = line.icon("icon");
  if (icon !== undefined) out.icon = icon;
  setTone(out, line);
  return setIntent(out, line.intent(false));
}

// ── The manifest ─────────────────────────────────────────────────────────────────────────────

const MANIFEST_KEYS = ["id", "name", "run", "every", "watch", "on", "mode", "facts", "icon", "places"];

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
   * with its reason, and the mod still runs with the rest (design §7: skipped with a reason).
   */
  manifest?: ModManifest;
  refusals: Refusal[];
}

/** Parse `mod.toml` after the TOML parse. Total, like the document parser. */
export function parseManifest(doc: JsonValue | undefined, opts: ParseManifestOptions = {}): ParsedManifest {
  const obj = asJsonObject(doc);
  if (obj === undefined) return { refusals: [{ code: "type", path: "", reason: "mod.toml must be a table of keys." }] };
  const refusals: Refusal[] = [];
  const f = new Fields(obj, "", refusals, "mod.toml");
  f.keys(MANIFEST_KEYS);
  const triggers = opts.triggers ?? [];
  const enabled = opts.places ?? NEAR_PLACES;

  const idRaw = asJsonString(obj.id);
  const id = idRaw !== undefined && isModId(idRaw) ? idRaw : undefined;
  if (id === undefined) f.push("id", "id", '"id" must be 1 to 32 lower-case letters, digits and hyphens, starting with a letter or a digit.');
  if (id !== undefined && opts.folder !== undefined && id !== opts.folder) {
    f.push("id", "id", `"id" is "${id}" but the folder is "${opts.folder}". Name them alike.`);
  }
  const name = f.text("name", { max: NAME_MAX, required: true });
  const run = f.text("run", { max: RUN_MAX, required: true });

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
  if (f.has("watch") && !triggers.includes("watch")) f.push("later", "watch", '"watch" is not in this Collie yet. The mod runs on its timer and taps.');

  const onList = f.array("on", { min: 1, max: MOD_EVENTS.length, what: "events" });
  const on: ModEvent[] = [];
  onList?.forEach((value, i) => {
    const word = asJsonString(value);
    if (word !== undefined && isOneOf(MOD_EVENTS, word)) {
      on.push(word);
      return;
    }
    refusals.push({ code: "word", path: pointer("/on", i), reason: `An event is one of: ${quoteList(MOD_EVENTS)}.` });
  });
  if (f.has("on") && !triggers.includes("on")) f.push("later", "on", '"on" is not in this Collie yet. The mod runs on its timer and taps.');

  const mode = f.word("mode", MOD_MODES);
  if (mode === "serve" && !triggers.includes("serve")) f.push("later", "mode", '"mode = serve" is not in this Collie yet. The mod runs once per trigger.');

  const facts = f.int("facts", { min: 1, max: 999 });
  if (facts !== undefined && facts > FACTS_VERSION) {
    f.push("version", "facts", `The mod needs facts version ${facts}. This Collie gives version ${FACTS_VERSION}. Update Collie to run it.`);
  }
  const icon = f.icon("icon");

  const placeList = f.array("places", { min: 1, max: PLACE_KINDS.length, required: true, what: "places" });
  const places: PlaceKind[] = [];
  placeList?.forEach((value, i) => {
    const word = asJsonString(value);
    const path = pointer("/places", i);
    if (word === undefined || !isOneOf(PLACE_KINDS, word)) {
      refusals.push({ code: "place", path, reason: `A place is one of: ${quoteList(PLACE_KINDS)}.` });
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
  if (placeList !== undefined && places.length === 0 && placeFaults.length === 0) {
    refusals.push({ code: "place", path: "/places", reason: "The mod lists no place this Collie draws." });
  }

  const fatal = refusals.some((r) => r.code !== "later");
  if (fatal || id === undefined || name === undefined || run === undefined) return { refusals: capRefusals(refusals) };
  const manifest: ModManifest = { id, name, run, mode: "once", facts: facts ?? 1, icon: icon ?? DEFAULT_MOD_ICON, places };
  if (every !== undefined && everyMs !== undefined && everyOk) {
    manifest.every = every;
    manifest.everyMs = everyMs;
  }
  if (watch !== undefined && triggers.includes("watch")) manifest.watch = watch;
  if (on.length > 0 && triggers.includes("on")) manifest.on = on;
  if (mode === "serve" && triggers.includes("serve")) manifest.mode = "serve";
  return { manifest, refusals: capRefusals(refusals) };
}

// ── The facts ────────────────────────────────────────────────────────────────────────────────

const FACTS_KEYS = ["v", "trigger", "mod", "host", "sessions", "spaces", "session"];
const SESSION_FACT_KEYS = ["id", "paneId", "name", "agent", "status", "cwd", "space", "tab", "lastActiveAt"];

export interface ParsedFacts {
  facts?: ModFacts;
  refusals: Refusal[];
}

/**
 * Parse a facts document. The bridge writes facts; this is for `collie mod check --run` with a fixture
 * facts file, and for a test that holds the bridge's builder to the type. Total, like the others.
 */
export function parseFacts(raw: JsonValue | undefined): ParsedFacts {
  const obj = asJsonObject(raw);
  if (obj === undefined) return { refusals: [{ code: "type", path: "", reason: "The facts must be a JSON object." }] };
  const refusals: Refusal[] = [];
  const f = new Fields(obj, "", refusals, "the facts");
  f.keys(FACTS_KEYS);
  if (asJsonNumber(obj.v) !== FACTS_VERSION) f.push("version", "v", `The facts must say "v": ${FACTS_VERSION}.`);
  const trigger = readTrigger(f);
  const modFields = f.object("mod", 'an object with "id", "dir" and "state"', true);
  modFields?.keys(["id", "dir", "state"]);
  const modId = modFields?.text("id", { max: 32, required: true });
  if (modId !== undefined && !isModId(modId)) modFields?.push("id", "id", '"id" is not a mod id.');
  const dir = modFields?.text("dir", { max: FACT_TEXT_MAX_BYTES, required: true });
  const state = modFields?.text("state", { max: FACT_TEXT_MAX_BYTES, required: true });
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
    sp.keys(["name", "folder"]);
    const name = sp.text("name", { max: 256, required: true });
    const folder = sp.text("folder", { max: FACT_TEXT_MAX_BYTES });
    if (name === undefined) return;
    spaces.push(folder === undefined ? { name } : { name, folder });
  });
  const session = f.has("session") ? readFactsSession(obj.session, "/session", refusals) : undefined;

  if (refusals.length > 0 || trigger === undefined || modId === undefined || dir === undefined || state === undefined || host === undefined) {
    return { refusals: capRefusals(refusals) };
  }
  const facts: ModFacts = { v: 1, trigger, mod: { id: modId, dir, state }, host, sessions, spaces };
  if (session !== undefined) facts.session = session;
  return { facts, refusals };
}

function readTrigger(f: Fields): FactsTrigger | undefined {
  const t = f.object("trigger", 'an object with "kind"', true);
  if (t === undefined) return undefined;
  const kind = t.word("kind", ["start", "timer", "tap", "watch", "event"] as const, true);
  switch (kind) {
    case undefined:
      return undefined;
    case "start":
    case "timer":
      t.keys(["kind"]);
      return { kind };
    case "watch": {
      t.keys(["kind", "path"]);
      const path = t.text("path", { max: WATCH_PATH_MAX, required: true });
      return path === undefined ? undefined : { kind, path };
    }
    case "event": {
      t.keys(["kind", "event", "session"]);
      const event = t.word("event", MOD_EVENTS, true);
      const session = t.text("session", { max: 256 });
      if (event === undefined) return undefined;
      return session === undefined ? { kind, event } : { kind, event, session };
    }
    case "tap": {
      t.keys(["kind", "requestId", "intent", "args", "part", "from"]);
      const tap = readTapFields(t);
      return tap === undefined ? undefined : { kind: "tap", ...tap };
    }
  }
}

function readFactsSession(value: JsonValue | undefined, path: string, sink: Refusal[]): FactsSession | undefined {
  const s = itemFields(value ?? null, path, sink, "a session");
  if (s === undefined) return undefined;
  const before = sink.length;
  s.keys(SESSION_FACT_KEYS);
  const id = s.text("id", { max: 256, required: true });
  if (id !== undefined && !isScopeKey(id)) s.push("target", "id", '"id" must be the scope key host:paneId.');
  const paneId = s.text("paneId", { max: MUX_ID_MAX_BYTES, required: true });
  const status = s.word("status", SESSION_STATUSES, true);
  const out: FactsSession = { id: id ?? "", paneId: paneId ?? "", status: status ?? "unknown" };
  for (const key of ["name", "agent", "cwd", "space", "tab"] as const) {
    const text = s.text(key, { max: FACT_TEXT_MAX_BYTES });
    if (text !== undefined) out[key] = text;
  }
  const last = s.text("lastActiveAt", { max: INSTANT_MAX });
  if (last !== undefined && !isInstant(last)) s.push("text", "lastActiveAt", '"lastActiveAt" must be an ISO 8601 instant.');
  if (last !== undefined) out.lastActiveAt = last;
  return sink.length === before ? out : undefined;
}

// ── A tap ────────────────────────────────────────────────────────────────────────────────────

export interface ParsedTapRequest {
  request?: TapRequest;
  refusals: Refusal[];
}

/** Parse `POST /api/mods/<host>/<id>/tap`'s body. Total. */
export function parseTapRequest(raw: JsonValue | undefined): ParsedTapRequest {
  const obj = asJsonObject(raw);
  if (obj === undefined) return { refusals: [{ code: "type", path: "", reason: "A tap must be a JSON object." }] };
  const refusals: Refusal[] = [];
  const f = new Fields(obj, "", refusals, "a tap");
  f.keys(["requestId", "intent", "args", "part", "from"]);
  const request = readTapFields(f);
  if (refusals.length > 0 || request === undefined) return { refusals: capRefusals(refusals) };
  return { request, refusals };
}

/** The fields a tap request and a tap trigger share. The caller has checked the keys. */
function readTapFields(f: Fields): TapRequest | undefined {
  const before = f.sink.length;
  const requestId = f.text("requestId", { max: 36, required: true });
  if (requestId !== undefined && !isRequestId(requestId)) f.push("id", "requestId", '"requestId" must be a UUID.');
  const intent = f.intent(true);
  const partRaw = f.text("part", { max: 32, required: true });
  if (partRaw !== undefined && !isPartId(partRaw)) f.push("id", "part", '"part" must be a part id.');
  const from = f.object("from", 'an object with "session"');
  let tapFrom: TapFrom | undefined;
  if (from !== undefined) {
    from.keys(["session"]);
    const session = from.has("session") ? readSessionTarget(from, "session", false) : undefined;
    tapFrom = session === undefined ? {} : { session };
  }
  if (f.sink.length !== before || requestId === undefined || intent === undefined || partRaw === undefined) return undefined;
  const out: TapRequest = { requestId, intent: intent.intent, part: partRaw };
  if (intent.args !== undefined) out.args = intent.args;
  if (tapFrom !== undefined) out.from = tapFrom;
  return out;
}
