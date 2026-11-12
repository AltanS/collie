// THE TRICKS CATALOGUE: the one typed list of everything a trick can draw, write and ask, in words.
//
// It is data and small pure functions, with no React, no DOM and no node API, so the web app, the bridge,
// the CLI and the scripts all import it by relative path. It has three readers:
//   * `scripts/tricks-reference.ts` renders `docs/tricks-reference.md` from it, whole;
//   * `cli/trick-guide.ts` prints the places and the manifest keys of `collie trick guide` from it;
//   * `scripts/tricks-reference.test.ts` holds the page to it, parses every example with the real parser,
//     and fails when a place, a part kind, a manifest key or a verb has no entry.
//
// WHERE A NUMBER COMES FROM. This file never types a cap. Every number is read from the constant the
// parser or the bridge checks with (`schema.ts`, `limits.ts`, `../hill/wire`, `../agent-view/wire`), and
// each node attribute's type and limit is read from the parser's own rule table (`NODE_ATTR_RULES`,
// `NODE_TEXT`, `NODE_KIDS`). The words are this file's. A new place, node kind, node attribute or manifest
// key is a compile error until it is described here, because each table below is typed against the
// schema's own list of them.
//
// THE WORDS. A "place" is a spot on the phone where a trick can show (the schema calls it a place, and a
// person may say surface). A "program trick" is a program on the machine that prints parts. An "agent
// view" is one screen that a session's own agent draws.

import type { JsonValue } from "../json";
import {
  HILL_ANSWER_TEXT_MAX,
  HILL_BODY_MAX,
  HILL_CLOSED_SERVED,
  HILL_LINK_HREF_MAX,
  HILL_LINK_LABEL_MAX,
  HILL_LINKS_MAX,
  HILL_MEDIA_BYTES_MAX,
  HILL_MEDIA_CAPTION_MAX,
  HILL_MEDIA_MAX,
  HILL_NODE_PREFIX,
  HILL_NOW_MAX,
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
  type HillState,
} from "../hill/wire";
import {
  VIEW_CAPTION_MAX,
  VIEW_COLLIE_PHRASES,
  VIEW_MEDIA_BYTES_MAX,
  VIEW_MEDIA_MAX,
  VIEW_NOTE_MAX,
  VIEW_OPTIONS_MAX,
  VIEW_PENDING_MAX,
  VIEW_QUESTION_MAX,
  VIEW_SENDS_PER_MINUTE,
  VIEW_SET_BYTES_MAX,
  VIEW_TAP_GROUP_MAX,
  VIEW_TAP_LABEL_MAX,
  VIEW_TITLE_MAX,
  VIEW_WRITES_PER_MINUTE,
} from "../agent-view/wire";
import { AGENT_VIEW_CONTRACT, INPUTS_CONTRACT, TRICK_CONTRACT, TRICK_CONTRACT_DEFAULT } from "./contract";
import {
  ABOUT_MAX,
  ACTION_ICONS,
  ACTION_LABEL_MAX,
  ACTIONS_MAX,
  AGENT_VIEW_PLACE,
  ANSI_NAMES,
  BADGE_TEXT_MAX,
  CHIP_STATES,
  CLOCKS,
  CONTRACT_MAX,
  COUNT_MAX,
  DECISION_KEY_MAX,
  DECISION_KEYS,
  DECISION_VIEW_KINDS,
  DECISION_VIEW_LIMITS,
  DECISIONS_MAX,
  DEFAULT_DECISION_PRIORITY,
  DEFAULT_DECISION_TEXT,
  DEFAULT_TRICK_ICON,
  DESCRIPTION_MAX,
  DIFF_LIMITS,
  DOCUMENT_KEYS,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_VERSION,
  ENV_NAME_MAX,
  ENV_NAMES_MAX,
  EVERY_MAX_MS,
  EVERY_MIN_MS,
  FACT_SESSIONS_MAX,
  FACT_SESSIONS_MAX_BYTES,
  FACT_SPACES_MAX,
  FACE_MAX,
  FACTS_KEYS,
  FOCUS_LIMITS,
  FRESH_MAX_MS,
  FRESH_MIN_MS,
  freshWindowMs,
  INPUT_DEPTH_MAX,
  INPUT_FILES_MAX,
  INPUT_FILE_FACT_KEYS,
  INPUT_GLOB_MAX,
  INPUT_STATES,
  INPUTS_FACT_KEYS,
  INPUTS_NEED_CONTRACT,
  INPUTS_MAX,
  ITEM_LABEL_MAX,
  KIDS_COUNT,
  LATER_PLACE_WORDS,
  LATER_TRIGGERS,
  MANIFEST_KEYS,
  NAME_MAX,
  NODE_ATTR_RULES,
  NODE_ATTRS,
  NODE_KIDS,
  NODE_KINDS,
  NODE_REQUIRED_ATTRS,
  NODE_TEXT,
  PART_MAX_BYTES,
  PARTS_MAX,
  PLACE_KINDS,
  PLACES_LISTED_MAX,
  RESERVED_TRICK_IDS,
  RULES_BLANK_LINES_MAX,
  RULES_LINE_MAX,
  RULES_MAX_BYTES,
  RULES_NAME_MAX,
  RULES_SPACES_MAX,
  RUN_MAX,
  SESSION_FACT_KEYS,
  SESSION_STATUSES,
  SPACE_FACT_KEYS,
  SPARK_LIMITS,
  STATUS_TEXT_MAX,
  STYLE_WORDS,
  SUBTITLE_MAX,
  TABLE_LIMITS,
  TONES,
  TRICK_EVENTS,
  TRICK_FACT_KEYS,
  TRICK_ICONS,
  TRICK_MODES,
  TRIGGER_KEYS,
  TRIGGER_KINDS,
  URL_MAX,
  VALUE_MAX_BYTES,
  VIEW_LIMITS,
  VIEW_ROOT_KINDS,
  WATCH_MAX,
  WATCH_PATH_MAX,
  type AttrRule,
  type InputState,
  type NodeKind,
  type PlaceKind,
  CLOSED_KEY_LINE,
  TAP_REFUSALS,
  TAP_REFUSED_LINES,
  type TapCode,
  type TapRefusal,
  TRICKS_WINDOWS_LINE,
} from "./schema";
import {
  BACKOFF_MS,
  BASE_ENV_NAMES,
  GROUP_CARD_CODE_BYTES,
  GROUP_CODE_BYTES,
  GROUP_CODE_CARDS,
  GROUP_FILES_MAX,
  HILL_DEFAULT_EXPIRY_DAYS,
  HILL_MAX_EXPIRY_DAYS,
  HILL_QUEUE_MAX,
  INPUT_ANSWER_MAX_BYTES,
  INPUT_IMAGE_MAX_BYTES,
  INPUT_RUN_MAX_BYTES,
  INPUT_TEXT_MAX_BYTES,
  PROPOSAL_EXPIRY_MS,
  PROPOSALS_MACHINE_HOUR_MAX,
  PROPOSALS_MEMBER_OPEN_MAX,
  PROPOSALS_OPEN_MAX,
  PROPOSALS_SENDER_HOUR_MAX,
  PROPOSALS_SENDER_OPEN_MAX,
  PROPOSE_LIMITS,
  RUN_TIMEOUT_MS,
  RUNS_MAX,
  SEED_BYTES_MAX,
  SEED_FILES_MAX,
  SKILL_BYTES_MAX,
  STDERR_CAP_BYTES,
  STDOUT_CAP_BYTES,
} from "./limits";

// ── Small helpers that make the words from the numbers ───────────────────────────────────────

const KIB = 1024;
const MIB = KIB * KIB;

/** A byte count in the unit a person reads: `64 KiB`, `5 MiB`, or plain bytes. */
export function sizeWords(bytes: number): string {
  if (bytes >= MIB && bytes % MIB === 0) return `${String(bytes / MIB)} MiB`;
  if (bytes >= KIB && bytes % KIB === 0) return `${String(bytes / KIB)} KiB`;
  return `${String(bytes)} bytes`;
}

const plural = (n: number, unit: string): string => `${String(n)} ${unit}${n === 1 ? "" : "s"}`;

/** A span in the unit a person reads: `10 seconds`, `5 seconds`, `24 hours`, `3 days`. */
export function spanWords(ms: number): string {
  const day = 86_400_000;
  const hour = 3_600_000;
  const minute = 60_000;
  if (ms >= day && ms % day === 0) return plural(ms / day, "day");
  if (ms >= hour && ms % hour === 0) return plural(ms / hour, "hour");
  if (ms >= minute && ms % minute === 0) return plural(ms / minute, "minute");
  return plural(ms / 1000, "second");
}

/** A duration as a manifest writes it: `5s`, `1m`, `24h`. */
function durationWord(ms: number): string {
  if (ms % 3_600_000 === 0) return `${String(ms / 3_600_000)}h`;
  if (ms % 60_000 === 0) return `${String(ms / 60_000)}m`;
  return `${String(ms / 1000)}s`;
}

const code = (text: string): string => `\`${text}\``;
const codeList = (words: readonly string[]): string => words.map(code).join(", ");
const orList = (words: readonly string[]): string => {
  const quoted = words.map(code);
  const last = quoted.at(-1);
  return quoted.length < 2 || last === undefined ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} or ${last}`;
};

// ── The shapes of the entries ────────────────────────────────────────────────────────────────

/** One limit, in words: what it bounds and the value, read from a real constant. */
export interface Limit {
  readonly what: string;
  readonly value: string;
}

/**
 * An example the real parser accepts. `document` is a program's whole output, `node` one node of a view
 * (the test puts it in a session part), `screen` the list of nodes an agent view's `show` takes,
 * `manifest` a `trick.toml` fragment, `decision` one Decision as a program lists it, `tap` the trigger of
 * an answer, and `command` a command line (held to the CLI's own usage text by the test).
 */
export type Example =
  | { readonly kind: "document"; readonly json: JsonValue }
  | { readonly kind: "node"; readonly json: JsonValue }
  | { readonly kind: "screen"; readonly json: JsonValue }
  | { readonly kind: "manifest"; readonly toml: string }
  | { readonly kind: "decision"; readonly json: JsonValue }
  | { readonly kind: "tap"; readonly json: JsonValue }
  | { readonly kind: "command"; readonly text: string };

/** Who writes to a place: a program the person switched on, or the agent of one session. */
export type Who = "program" | "agent";

/** Every place word: the five a program draws in, and the one an agent view adds. */
export type PlaceId = PlaceKind | typeof AGENT_VIEW_PLACE;

export interface PlaceEntry {
  readonly id: PlaceId;
  /** The words the app uses for the place. */
  readonly name: string;
  /** Where on the phone it shows, in one sentence. */
  readonly where: string;
  /** What it can show: which parts it takes. */
  readonly shows: string;
  /** What a tap does. */
  readonly tap: string;
  readonly limits: readonly Limit[];
  readonly who: Who;
  readonly examples: readonly Example[];
}

// ── Places ───────────────────────────────────────────────────────────────────────────────────

const BADGE_WORDS = `a count from 0 to ${String(COUNT_MAX)} as text, or "" for a dot`;
const ITEM_BADGE_WORDS = `a count from 0 to ${String(COUNT_MAX)} (0 draws none), or text of 1 to ${String(BADGE_TEXT_MAX)} characters`;
const ONE_PER_TRICK: Limit = { what: "Parts of this place per trick", value: "one" };
const PART_SIZE: Limit = { what: "One part, as compact JSON", value: `at most ${sizeWords(PART_MAX_BYTES)}` };

/** Every place, described. A place added to `PLACE_KINDS` or to the agent view is a compile error until it is here. */
export const PLACES = {
  belt: {
    id: "belt",
    name: "Belt",
    where: "A mark at the end of the Belt, the scrolling strip of controls. It never takes fixed room.",
    shows: "One mark: an icon, a face word (`label`), a `badge` and a `tone`. It takes no view.",
    tap: "With an `intent`, a tap runs the trick with that intent. Without one, the mark is the same button and takes no tap.",
    limits: [
      ONE_PER_TRICK,
      { what: "`label`, the face word", value: `at most ${String(FACE_MAX)} characters` },
      { what: "`badge`", value: BADGE_WORDS },
      { what: "A mark needs", value: "at least one of `icon`, `label` and `badge`" },
      PART_SIZE,
    ],
    who: "program",
    examples: [{ kind: "document", json: { v: 1, parts: [{ at: "belt", id: "legs", mark: { icon: "check", label: "23/34", tone: "ok", intent: "open" } }] } }],
  },
  session: {
    id: "session",
    name: "Page",
    where: "A page of the trick's own: a row on the Dashboard under Tricks, and a screen of its own. The code word is `session`.",
    shows: "A name, an icon, a tone, a subtitle, a badge, a progress meter, up to four action buttons and a `view`: a list of nodes of any kind in the Parts table.",
    tap: "A button, or an action, sends its intent to the trick, which runs once with that tap. A `row` or a `link` with an `href` opens a web page or a session.",
    limits: [
      { what: "`name`", value: `at most ${String(NAME_MAX)} characters. Left out, the manifest's name` },
      { what: "`subtitle`", value: `at most ${String(SUBTITLE_MAX)} characters` },
      { what: "`badge`", value: `\`{ "count": 0 to ${String(COUNT_MAX)} }\` or \`{ "text": 1 to ${String(BADGE_TEXT_MAX)} characters }\`, one of the two` },
      { what: "`progress`", value: `\`value\` of \`max\`, \`max\` a whole number from ${String(VIEW_LIMITS.progressMax.min)} to ${String(VIEW_LIMITS.progressMax.max)}. No \`value\` means indeterminate` },
      { what: "`actions`", value: `at most ${String(ACTIONS_MAX)}, each \`id\`, \`label\` (at most ${String(ACTION_LABEL_MAX)} characters), \`intent\`, and optionally \`value\`, \`icon\` and \`disabled\`. An action icon is one of ${codeList(ACTION_ICONS)}` },
      { what: "`view`", value: `${String(VIEW_LIMITS.root.min)} to ${String(VIEW_LIMITS.root.max)} nodes at the top, ${String(VIEW_LIMITS.depth.max)} levels, ${String(VIEW_LIMITS.nodes.max)} nodes in all` },
      { what: "Parts of this place per trick", value: "as many as it needs, each with its own `id`" },
      PART_SIZE,
    ],
    who: "program",
    examples: [
      {
        kind: "document",
        json: {
          v: 1,
          parts: [
            {
              at: "session",
              id: "main",
              name: "Legs",
              icon: "check",
              subtitle: "3 of 5 done",
              badge: { count: 2 },
              progress: { value: 3, max: 5 },
              actions: [{ id: "refresh", label: "Refresh", intent: "refresh", icon: "refresh" }],
              view: [{ kind: "list", kids: [{ kind: "row", text: "api", attrs: { end: "ok", tone: "ok" } }] }],
            },
          ],
        },
      },
    ],
  },
  dashboard: {
    id: "dashboard",
    name: "Dashboard tile",
    where: "A round tile in the strip at the top of the Dashboard. The strip is hidden while no trick has a tile.",
    shows: "One item: an icon over a short name, with a `badge` and a `tone`. It takes no view.",
    tap: "A tap opens the trick's Page when it has one. Without a Page the tile is drawn and takes no tap.",
    limits: [
      ONE_PER_TRICK,
      { what: "`label`", value: `1 to ${String(ITEM_LABEL_MAX)} characters` },
      { what: "`badge`", value: ITEM_BADGE_WORDS },
      PART_SIZE,
    ],
    who: "program",
    examples: [{ kind: "document", json: { v: 1, parts: [{ at: "dashboard", id: "legs", item: { label: "Legs", icon: "check", badge: 3, tone: "ok" } }] } }],
  },
  status: {
    id: "status",
    name: "Status chip",
    where: "One chip in the status line above the Belt, after Collie's own items.",
    shows: "One chip: a short text, an icon, a `tone`, and a live time with `at` and `clock`. It takes no view.",
    tap: "A tap opens the trick's Page when it has one. The chip is not a control and takes no intent.",
    limits: [ONE_PER_TRICK, { what: "`text`", value: `1 to ${String(STATUS_TEXT_MAX)} characters` }, PART_SIZE],
    who: "program",
    examples: [{ kind: "document", json: { v: 1, parts: [{ at: "status", id: "ci", chip: { text: "CI green", icon: "check", tone: "ok" } }] } }],
  },
  tabbar: {
    id: "tabbar",
    name: "Bottom bar item",
    where: "An item in the Dashboard's bottom bar, after the Hill.",
    shows: "One item: an icon over a short name, with a `badge` and a `tone`. It takes no view.",
    tap: "A tap opens the trick's Page when it has one. Without a Page the item is drawn and takes no tap.",
    limits: [
      ONE_PER_TRICK,
      { what: "`label`", value: `1 to ${String(ITEM_LABEL_MAX)} characters` },
      { what: "`badge`", value: ITEM_BADGE_WORDS },
      PART_SIZE,
    ],
    who: "program",
    examples: [{ kind: "document", json: { v: 1, parts: [{ at: "tabbar", id: "legs", item: { label: "Legs", icon: "check", badge: "new" } }] } }],
  },
  "agent-view": {
    id: "agent-view",
    name: "Agent view",
    where: "A view of one agent session, beside Terminal and Chat. The session's own agent draws it, and the person switches it on per session.",
    shows: "One screen: a list of nodes in the Parts table's kinds (held tighter, see Parts), up to four pictures, and one decision block with a question and up to five options.",
    tap: "A tap on a button, or a pick in the decision block, sends a message in the person's name to that one session. It carries the label only: a button holds no hidden value. Collie marks the pick on the screen afterwards. The agent cannot: a button's `pressed` and a choice's `picked` are refused.",
    limits: [
      { what: "Contract", value: `${String(AGENT_VIEW_CONTRACT)}, and the manifest needs \`rules\`` },
      { what: "Screen title", value: `at most ${String(VIEW_TITLE_MAX)} characters` },
      { what: "The note of `start`", value: `at most ${String(VIEW_NOTE_MAX)} characters` },
      { what: "A button's label", value: `one line, at most ${String(VIEW_TAP_LABEL_MAX)} characters` },
      { what: "A group's label", value: `one line, at most ${String(VIEW_TAP_GROUP_MAX)} characters` },
      { what: "The view, as compact JSON", value: `at most ${sizeWords(PART_MAX_BYTES)}, and the view limits of a part` },
      { what: "Pictures", value: `at most ${String(VIEW_MEDIA_MAX)} on a screen, ${sizeWords(VIEW_MEDIA_BYTES_MAX)} each, ${sizeWords(VIEW_SET_BYTES_MAX)} together, caption at most ${String(VIEW_CAPTION_MAX)} characters` },
      { what: "Decision block", value: `a question of at most ${String(VIEW_QUESTION_MAX)} characters, 1 to ${String(VIEW_OPTIONS_MAX)} options` },
      { what: "A pending block's label", value: `at most ${String(VIEW_PENDING_MAX)} characters` },
      { what: "Writes by the agent", value: `${String(VIEW_WRITES_PER_MINUTE)} a minute for one trick and session` },
      { what: "Sends from the view", value: `${String(VIEW_SENDS_PER_MINUTE)} a minute for one session, one in flight at a time` },
      { what: "Marks of a pick", value: "Collie's, never the agent's. A redraw keeps a mark while a block of the same id holds a button at the same steps, and the decision block's while it asks the same question with the same options" },
      { what: "Links", value: "a web address only. A session `href` is refused. The phone shows the host after each link, whole" },
      { what: "Collie's own words", value: `no text of the agent's may say ${VIEW_COLLIE_PHRASES.map((phrase) => `"${phrase}"`).join(", ")}. A text is read as whole words, in any case, with look-alike letters and hidden characters folded. Collie's bare name passes` },
      { what: "The rules file", value: `see Limits: the rules file` },
    ],
    who: "agent",
    examples: [
      { kind: "manifest", toml: `id = "triage"\nname = "Triage"\ncontract = ${String(AGENT_VIEW_CONTRACT)}\nplaces = ["${AGENT_VIEW_PLACE}"]\nrules = "rules.md"\n` },
      { kind: "screen", json: [{ kind: "card", attrs: { tone: "accent" }, kids: [{ kind: "para", text: "Two tests fail." }, { kind: "button", attrs: { label: "Show me the first one", intent: "show-first" } }] }] },
    ],
  },
} satisfies Readonly<Record<PlaceId, PlaceEntry>>;

/** The places in the order the reference lists them: the five a program draws in, then the agent view. */
export const PLACE_ORDER: readonly PlaceId[] = [...PLACE_KINDS, AGENT_VIEW_PLACE];

// ── Parts: the node kinds ────────────────────────────────────────────────────────────────────

/** The kinds a program's view, a Decision's view and an agent view may hold, and what each is for. */
export interface PartAttr {
  readonly name: string;
  readonly type: string;
  /** `yes`, `no`, or the condition that makes it needed. */
  readonly required: string;
  readonly limit: string;
  readonly what: string;
}

export interface PartEntry {
  readonly kind: NodeKind;
  readonly what: string;
  /** Where the kind may sit: the top of a view, and the kinds that hold it. */
  readonly sits: string;
  /** What the kind holds, with its count. Empty for a kind that holds nothing. */
  readonly holds: string;
  /** What its `text` is, or empty when it takes none. */
  readonly text: string;
  readonly attrs: readonly PartAttr[];
  /** Whether a Decision's view takes it. */
  readonly inDecision: boolean;
  /** What differs in an agent view, or empty when nothing does. */
  readonly agentView: string;
  readonly example: JsonValue;
}

interface PartWords {
  readonly what: string;
  readonly example: JsonValue;
}

/** One sentence and one example per node kind. A new kind in `NODE_KINDS` is a compile error until it is here. */
const PART_WORDS = {
  card: { what: "A block that groups what belongs together. Its `tone` colours its edge.", example: { kind: "card", attrs: { tone: "ok" }, kids: [{ kind: "para", text: "All checks passed." }] } },
  group: { what: "A titled set of rows and other nodes. The person can fold it.", example: { kind: "group", attrs: { label: "Services", fold: "open" }, kids: [{ kind: "row", text: "api", attrs: { end: "ok" } }] } },
  list: { what: "A list of rows and groups. It keeps the height of its kids, so a change inside one row moves nothing.", example: { kind: "list", kids: [{ kind: "row", text: "api" }, { kind: "row", text: "web" }] } },
  row: {
    what: "One line: a title, an optional end word, and optionally a second line, chips and one trailing button.",
    example: { kind: "list", kids: [{ kind: "row", text: "api", attrs: { end: "ok", tone: "ok", icon: "check" }, kids: [{ kind: "para", text: "Deployed 2 min ago" }] }] },
  },
  bar: { what: "A strip of buttons, chips and links. With `role` `strip` it scrolls sideways as a band.", example: { kind: "bar", kids: [{ kind: "button", attrs: { label: "Rerun", intent: "rerun" } }, { kind: "chip", text: "3 failed", attrs: { tone: "danger" } }] } },
  chip: { what: "A small label. `state` draws a dot, `current` marks the step, and `at` with `clock` makes it a live time.", example: { kind: "card", kids: [{ kind: "chip", text: "building", attrs: { state: "working", icon: "refresh" } }] } },
  button: { what: "Sends one intent to the trick on a tap, or copies a text with `does` set to `copy`.", example: { kind: "card", kids: [{ kind: "button", attrs: { label: "Rerun", intent: "rerun", tone: "accent" } }] } },
  para: { what: "One paragraph of plain text, or of `run` and `link` kids.", example: { kind: "para", text: "Three checks failed on the last run." } },
  line: { what: "One line of monospace screen text, such as a command or a log line.", example: { kind: "line", text: "$ bun test", attrs: { style: "dim" } } },
  run: { what: "A piece of text inside a `para` or a `line`, with its own style, link or live time.", example: { kind: "para", kids: [{ kind: "run", text: "Build " }, { kind: "run", text: "passed", attrs: { style: "bold" } }] } },
  code: { what: "A block of code. Its kids are `line` nodes. It scrolls on its own past `max` lines.", example: { kind: "code", attrs: { lang: "ts" }, kids: [{ kind: "line", text: "const total = 3;" }] } },
  link: { what: "A link that opens a web page, or one agent session of the crew.", example: { kind: "group", attrs: { label: "More" }, kids: [{ kind: "link", text: "Open the run", attrs: { href: "https://example.com/run/1" } }] } },
  image: {
    what: "A picture. In a program's part it is a file of the trick's `media/` folder. In a Decision's view or an agent view it names one of the pictures that came with it, by `ref`.",
    example: { kind: "image", attrs: { src: "media/chart.png", alt: "Latency chart", w: "640", h: "360" } },
  },
  meter: { what: "An amount, or the progress of a task. With `role` `progress` and no `value` it is indeterminate.", example: { kind: "meter", attrs: { value: "68", max: "100", label: "Disk", tone: "warn" } } },
  spacer: { what: "Space between nodes. With a `label` it is a divider with words.", example: { kind: "spacer", attrs: { label: "Today" } } },
  number: { what: "A big figure with a label under it.", example: { kind: "number", text: "23/34", attrs: { label: "checks passed", tone: "ok" } } },
  compare: {
    what: "Two images side by side at one height, as before and after.",
    example: { kind: "compare", kids: [{ kind: "image", attrs: { src: "media/before.png", alt: "Before", w: "320", h: "200" } }, { kind: "image", attrs: { src: "media/after.png", alt: "After", w: "320", h: "200" } }] },
  },
  table: {
    what: "A small table: its column heads first, then its cells row by row.",
    example: { kind: "table", kids: [{ kind: "col", text: "Check" }, { kind: "col", text: "Time", attrs: { align: "end" } }, { kind: "cell", text: "build" }, { kind: "cell", text: "12 s" }] },
  },
  col: { what: "A column head of a `table`. It sits only inside a `table`.", example: { kind: "table", kids: [{ kind: "col", text: "Check" }, { kind: "cell", text: "build" }] } },
  cell: { what: "One cell of a `table`. It sits only inside a `table`. An empty cell has no `text`.", example: { kind: "table", kids: [{ kind: "col", text: "Check" }, { kind: "cell", text: "build", attrs: { tone: "ok" } }] } },
  diff: { what: "A hunk of a diff. Each line starts with `+` (added), `-` (removed) or `@@` (a hunk head).", example: { kind: "diff", text: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;", attrs: { file: "app.ts" } } },
  spark: { what: "A trend as a small line with no axes. The last point is marked.", example: { kind: "spark", attrs: { values: "3 5 4 8 6", tone: "accent", label: "latency" } } },
} satisfies Readonly<Record<NodeKind, PartWords>>;

/** Every attribute of every kind, in a sentence. The type and the limit are read from the parser's own rule table. */
const ATTR_WORDS = {
  card: { tone: "The colour of the card's edge." },
  group: { label: "The group's title.", fold: "Whether the group starts open or closed. The person owns the toggle after the first draw.", badge: "A count, or a dot, beside the title." },
  list: {},
  row: {
    href: "Makes the row tappable: an https or http address, or a session's `id` from the facts.",
    end: "A short word at the end of the row.",
    badge: "A count, or a dot, on the row.",
    tone: "The tone of the row.",
    cut: "Where a long title is cut.",
    icon: "An icon at the start of the row.",
    disabled: "The reason the row cannot be used. An empty text means no reason is given.",
  },
  bar: { role: "`strip` makes the bar one band that scrolls sideways.", scroll: "Sideways scroll for a bar of chips.", label: "A short name for the bar." },
  chip: {
    tone: "The tone of the chip.",
    icon: "An icon before the text.",
    at: "An instant that the chip shows as a live time. It goes with `clock`.",
    clock: "How the instant is told. It goes with `at`.",
    state: "Draws a status dot. Chips with a `state` in a `bar` draw a strip of steps.",
    current: "Marks this chip as the current step.",
    short: "The text shown when the box is narrow.",
  },
  button: {
    intent: "The intent a tap sends to the trick.",
    label: "The words on the button.",
    tone: "The tone of the button.",
    disabled: "The reason the button cannot be used. An empty text means no reason is given.",
    pressed: "Draws the button as a toggle: on, off or mixed. An agent view refuses it: Collie marks the pick.",
    confirm: "A second label. The first tap arms the button and the second sends the intent.",
    badge: "A count, or a dot, on the button.",
    icon: "An icon on the button.",
    hint: "A short line of help for the button.",
    does: "`copy` copies `value` to the phone's clipboard instead of sending an intent.",
    value: "The one fixed text a tap sends with the intent, or the text `copy` copies.",
  },
  para: { role: "Draws the paragraph as a heading or a quote.", bullet: "A marker before the paragraph, such as `-` or `1.`.", term: "A short term that the paragraph defines." },
  line: { style: "Style words for the whole line.", role: "Draws the line as plain text, a status line or a note." },
  run: { style: "Style words for this piece of text.", code: "A flag: draws the text as inline code.", href: "Makes the text a link to a web address.", at: "An instant that the text shows as a live time. It goes with `clock`.", clock: "How the instant is told. It goes with `at`." },
  code: { lang: "The language word of the code.", max: "How many lines show before the block scrolls on its own." },
  link: { href: "Where the link goes: a web address, or a session's `id` from the facts with `rel` `pane`.", rel: "What the `href` names: `url` or `pane`. `file` is refused: a trick opens no file.", badge: "A count, or a dot, on the link.", icon: "An icon before the link text." },
  image: {
    src: "A picture file in the trick's `media/` folder. Used in a program's part.",
    alt: "What the picture shows, in words.",
    w: "The picture's width in pixels. It reserves the box.",
    h: "The picture's height in pixels. It reserves the box.",
    ref: "The place of one of the Decision's or the screen's own pictures, counted from 0. Used in a Decision's view and an agent view.",
    caption: "A line of words under the picture. In a `compare` it labels the frame.",
    fit: "`contain` shows the whole picture. `cover` fills the frame and cuts the edges.",
    focus: "The point of the picture to keep in the middle of its frame, and how far to zoom in on it.",
  },
  meter: { value: "How much, from 0 to `max`.", max: "The full amount. It defaults to 1.", tone: "The tone of the meter.", label: "A short name for the meter.", role: "`meter` is an amount. `progress` is the steps of a task." },
  spacer: { label: "Words in the divider." },
  number: { label: "The words under the figure.", tone: "The tone of the figure.", unit: "A short unit after the figure." },
  compare: {},
  table: {},
  col: { align: "Which side of its column the words keep. A column of figures keeps the end side by default." },
  cell: { tone: "The tone of the cell." },
  diff: { file: "The name of the file the hunk is from." },
  spark: { values: "The numbers of the trend, oldest first.", tone: "The tone of the line.", label: "A short name for the trend." },
} as const satisfies { readonly [K in NodeKind]: { readonly [A in (typeof NODE_ATTRS)[K][number]]: string } };

/** Attributes that a kind needs only under a condition. The always-needed ones are `NODE_REQUIRED_ATTRS`. */
const ATTR_NEEDS = {
  button: { intent: "yes, unless `does` is `copy`", value: "yes, when `does` is `copy`" },
  meter: { value: "yes, unless `role` is `progress`" },
  image: { src: "in a program's part", alt: "in a program's part", w: "in a program's part", h: "in a program's part", ref: "in a Decision's view and an agent view" },
} as const satisfies { readonly [K in NodeKind]?: { readonly [A in (typeof NODE_ATTRS)[K][number]]?: string } };

/** What a kind's text needs besides the cap that `NODE_TEXT` holds. */
const TEXT_NOTES = {
  chip: "The words of the chip. They may be left out when the chip is a live time (`at` and `clock`).",
  para: "The paragraph's words. Give `text`, or `run` and `link` kids, exactly one of the two.",
  line: "The line's words, a tab allowed. Give `text`, or `run` and `link` kids, never both.",
  row: "The row's title.",
  run: "The piece of text. Spaces alone are allowed.",
  link: "The words of the link.",
  number: "The figure, such as `23/34` or `1.2k`.",
  col: "The column head.",
  cell: "The cell's words. It may be empty.",
  diff: "The lines of the hunk, one line break between two lines.",
} as const satisfies { readonly [K in keyof typeof NODE_TEXT]: string };

/** What an agent view does differently for a kind. Every other kind reads the same as in a program's part. */
const AGENT_VIEW_NOTES = {
  button: `A tap sends the label (and the label of the group it sits in). \`value\`, \`does\` and \`pressed\` are refused: Collie marks the pick, the agent does not. The label is one line of at most ${String(VIEW_TAP_LABEL_MAX)} characters, and says none of Collie's own words.`,
  group: `A \`label\` is one line of at most ${String(VIEW_TAP_GROUP_MAX)} characters, because a tap inside the group sends it.`,
  link: "Text that reads as a web address must be that address, in any script. The `href` is a web address only: a session is refused. The phone shows the host after the link.",
  run: "Text with an `href` that reads as a web address must be that address. The `href` is a web address only, and the phone shows its host after the run.",
  row: "An `href` is a web address only: a session is refused.",
  image: `The agent adds pictures with \`--image\` (at most ${String(VIEW_MEDIA_MAX)}) and names each by \`ref\`.`,
  compare: "Two images named by `ref`.",
} as const satisfies { readonly [K in NodeKind]?: string };

/** What a Decision's view does differently for a kind. */
const DECISION_VIEW_NOTES = {
  row: "A row opens a web page at most. It takes no button.",
  link: "A link opens a web page only.",
  image: "Names one of the Decision's own pictures by `ref`.",
  compare: "Two images named by `ref`.",
} as const satisfies { readonly [K in NodeKind]?: string };

/** The notes that cover only some kinds, as lookups by kind name. */
const AGENT_VIEW_NOTE_OF = new Map<string, string>(Object.entries(AGENT_VIEW_NOTES));
const DECISION_VIEW_NOTE_OF = new Map<string, string>(Object.entries(DECISION_VIEW_NOTES));

/** A type word and a limit, in words. */
export interface RuleWords {
  readonly type: string;
  readonly limit: string;
}

/** How one attribute's text is read, in a type word and the limit, from the parser's own rule. */
export function describeRule(rule: AttrRule): RuleWords {
  switch (rule.kind) {
    case "word":
      return { type: "word", limit: `one of ${codeList(rule.list)}` };
    case "tone":
      return { type: "tone", limit: `one of ${codeList(TONES)}` };
    case "icon":
      return { type: "icon", limit: "one of the icon words in Shared values" };
    case "text": {
      const { max, empty, multiline, tabs } = rule.rule;
      const extras = [empty === true ? "may be empty" : "", multiline === true ? "line breaks allowed" : "", tabs === true ? "tabs allowed" : ""].filter((x) => x !== "");
      return { type: "text", limit: [`at most ${String(max)} characters`, ...extras].join(", ") };
    }
    case "flag":
      return { type: "flag", limit: 'the empty text `""` when on, left out when off' };
    case "badge":
      return { type: "count or dot", limit: BADGE_WORDS };
    case "whole":
      return { type: "whole number", limit: `${String(rule.min)} to ${String(rule.max)}, as text` };
    case "decimal":
      return { type: "number", limit: '0 or more, as text, such as `"68"` or `"0.5"`' };
    case "epoch":
      return { type: "instant", limit: 'epoch milliseconds as digits, such as `"1794130692000"`' };
    case "style":
      return { type: "style words", limit: "words with single spaces between, each once, from Shared values" };
    case "intent":
      return { type: "intent", limit: "1 to 48 of `a-z`, `0-9`, `.`, `_` and `-`, starting with a letter or a digit" };
    case "value":
      return { type: "text", limit: `1 to ${String(VALUE_MAX_BYTES)} bytes, no control or invisible character` };
    case "url":
      return { type: "web address", limit: `https or http, at most ${String(URL_MAX)} characters` };
    case "href":
      return { type: "address", limit: `with no \`rel\`, an https or http address (at most ${String(URL_MAX)} characters) or a session's \`id\` from the facts` };
    case "src":
      return { type: "picture path", limit: "a `.png`, `.jpg`, `.jpeg` or `.webp` file in `media/`, such as `media/chart.png`, with no step that starts with a dot" };
    case "lang":
      return { type: "word", limit: "1 to 24 of `a-z`, `0-9`, `+`, `#`, `.`, `_` and `-`" };
    case "focus":
      return { type: "numbers", limit: `\`"x y"\` or \`"x y zoom"\`: x and y from ${String(FOCUS_LIMITS.point.min)} to ${String(FOCUS_LIMITS.point.max)} (percent), zoom from ${String(FOCUS_LIMITS.zoom.min)} to ${String(FOCUS_LIMITS.zoom.max)}` };
    case "values":
      return { type: "numbers", limit: `${String(SPARK_LIMITS.values.min)} to ${String(SPARK_LIMITS.values.max)} numbers with one space between` };
  }
}

function rangeWords(range: { readonly min: number; readonly max: number }): string {
  return `${String(range.min)} to ${String(range.max)}`;
}

/** What the parser's tables say of each kind, as lookups by kind name (a table that covers only some kinds has only those keys). */
interface TextRule {
  readonly max: number;
  readonly required?: boolean;
}
const KIDS_OF = new Map<string, readonly NodeKind[]>(Object.entries(NODE_KIDS));
const COUNT_OF = new Map<string, { readonly min: number; readonly max: number }>(Object.entries(KIDS_COUNT));
const TEXT_RULE_OF = new Map<string, TextRule>(Object.entries(NODE_TEXT));
const TEXT_NOTE_OF = new Map<string, string>(Object.entries(TEXT_NOTES));
const REQUIRED_ATTRS_OF = new Map<string, readonly string[]>(Object.entries(NODE_REQUIRED_ATTRS));
const ATTR_NEEDS_OF = new Map<string, Readonly<Record<string, string>>>(Object.entries(ATTR_NEEDS));
const ATTR_RULES_OF = new Map<string, Readonly<Record<string, AttrRule>>>(Object.entries(NODE_ATTR_RULES));
const ATTR_WORDS_OF = new Map<string, Readonly<Record<string, string>>>(Object.entries(ATTR_WORDS));

/** The kinds a kind holds and how many, from `NODE_KIDS` and `KIDS_COUNT`. */
function holdsOf(kind: NodeKind): string {
  const list = KIDS_OF.get(kind);
  const count = COUNT_OF.get(kind);
  if (list === undefined || count === undefined) return "";
  if (kind === "compare") return `exactly two ${orList(list)}`;
  if (kind === "table") return `\`col\` (${rangeWords(TABLE_LIMITS.cols)}), then \`cell\` row by row, at most ${String(TABLE_LIMITS.rows.max)} rows`;
  return `${orList(list)} (${rangeWords(count)})`;
}

/** Where a kind may sit: the top of a view, and the kinds that hold it. */
function sitsOf(kind: NodeKind): string {
  const roots: readonly NodeKind[] = VIEW_ROOT_KINDS;
  const parents = NODE_KINDS.filter((parent) => KIDS_OF.get(parent)?.includes(kind) === true);
  const places = [...(roots.includes(kind) ? ["the top of a view"] : []), ...parents.map((parent) => `in a ${parent}`)];
  return places.join(", ");
}

function textOf(kind: NodeKind): string {
  const rule = TEXT_RULE_OF.get(kind);
  const note = TEXT_NOTE_OF.get(kind);
  if (rule === undefined || note === undefined) return "";
  const needs = rule.required === true ? "required" : "optional";
  return `${note} (${needs}, at most ${String(rule.max)} characters)`;
}

function attrsOf(kind: NodeKind): PartAttr[] {
  const names: readonly string[] = NODE_ATTRS[kind];
  const rules = ATTR_RULES_OF.get(kind) ?? {};
  const words = ATTR_WORDS_OF.get(kind) ?? {};
  const always = REQUIRED_ATTRS_OF.get(kind) ?? [];
  const needs = ATTR_NEEDS_OF.get(kind) ?? {};
  return names.map((name) => {
    const rule = rules[name];
    const described = rule === undefined ? { type: "text", limit: "" } : describeRule(rule);
    return { name, type: described.type, required: always.includes(name) ? "yes" : (needs[name] ?? "no"), limit: described.limit, what: words[name] ?? "" };
  });
}

const DECISION_KINDS: readonly string[] = DECISION_VIEW_KINDS;

/** One entry per node kind, in the schema's order. */
export const PARTS: readonly PartEntry[] = NODE_KINDS.map((kind) => ({
  kind,
  what: PART_WORDS[kind].what,
  sits: sitsOf(kind),
  holds: holdsOf(kind),
  text: textOf(kind),
  attrs: attrsOf(kind),
  inDecision: DECISION_KINDS.includes(kind),
  agentView: AGENT_VIEW_NOTE_OF.get(kind) ?? "",
  example: PART_WORDS[kind].example,
}));

/** What the views have in common, in words: the three places a view of nodes shows. */
export const VIEW_KINDS_OF = {
  program: "A program's view, on its Page (a `session` part): every kind.",
  decision: `A Decision's view, under its summary: display only. It takes ${orList(DECISION_VIEW_KINDS)}. At most ${sizeWords(DECISION_VIEW_LIMITS.bytes)}, ${String(DECISION_VIEW_LIMITS.nodes)} nodes and ${String(DECISION_VIEW_LIMITS.depth)} levels.`,
  agentView: "An agent view: every kind, read strictly. A kind or an attribute that a program's part would only leave out is refused.",
} as const;

/** What a Decision's view does differently for one kind, or empty. */
export function decisionViewNote(kind: NodeKind): string {
  return DECISION_VIEW_NOTE_OF.get(kind) ?? "";
}

// ── Shared values ────────────────────────────────────────────────────────────────────────────

export interface SharedValue {
  readonly name: string;
  readonly values: string;
}

/** The closed lists that many attributes name, once each. */
export const SHARED_VALUES: readonly SharedValue[] = [
  { name: "tone", values: codeList(TONES) },
  { name: "icon", values: `${codeList(TRICK_ICONS)}. The default icon of a trick is ${code(DEFAULT_TRICK_ICON)}` },
  { name: "action icon", values: codeList(ACTION_ICONS) },
  { name: "chip state", values: codeList(CHIP_STATES) },
  { name: "clock", values: codeList(CLOCKS) },
  { name: "style", values: `${code("bold")}, ${code("dim")}, ${code("italic")}, ${code("underline")}, ${code("inverse")}, ${code("strike")}, ${code("box")}, ${code("fg-<colour>")}, ${code("bg-<colour>")} and the syntax inks ${codeList(STYLE_WORDS.filter((word) => word.startsWith("syn-")))}. The colours are ${codeList(ANSI_NAMES)}` },
  { name: "button intent", values: "1 to 48 of `a-z`, `0-9`, `.`, `_` and `-`, starting with a letter or a digit" },
  { name: "Decision option intent", values: `1 to 32 of \`a-z\`, \`0-9\` and \`-\`, starting with a letter, never ${orList(HILL_RESERVED_INTENTS)}` },
];

// ── The Hill ─────────────────────────────────────────────────────────────────────────────────

export interface DecisionKeyEntry {
  readonly key: string;
  readonly type: string;
  readonly required: string;
  readonly limit: string;
  readonly what: string;
}

/** One entry per key of a Decision a program lists. A new key in `DECISION_KEYS` is a compile error until it is here. */
const DECISION_KEY_WORDS = {
  key: { type: "text", required: "yes", limit: `1 to ${String(DECISION_KEY_MAX)} of \`a-z\`, \`0-9\` and \`-\`, unique in the document`, what: "The trick's own name for the Decision. The answer comes back with it." },
  title: { type: "text", required: "yes", limit: `at most ${String(HILL_TITLE_MAX)} characters`, what: "The question, as a sentence the options answer." },
  summary: { type: "text", required: "yes", limit: `at most ${String(HILL_SUMMARY_MAX)} characters`, what: "What the recommended option does, and the one fact that decides it." },
  body: { type: "text", required: "no", limit: `at most ${String(HILL_BODY_MAX)} characters`, what: "Longer text, shown behind More." },
  options: { type: "list", required: "no", limit: `at most ${String(HILL_OPTIONS_MAX)}; each \`intent\`, \`label\` (at most ${String(HILL_OPTION_LABEL_MAX)}), and optionally \`detail\` (at most ${String(HILL_OPTION_DETAIL_MAX)}) and \`confirm\` (at most ${String(HILL_OPTION_CONFIRM_MAX)})`, what: "The choices. A tap on one sends its `intent` back." },
  recommends: { type: "object or null", required: "no", limit: `\`{ intent, why }\`, \`why\` at most ${String(HILL_WHY_MAX)} characters`, what: "The trick's pick, one of the options. Shown as Recommended, never pre-selected." },
  priority: { type: "word", required: "no", limit: `one of ${codeList(HILL_PRIORITIES)}. Default \`${DEFAULT_DECISION_PRIORITY}\``, what: `A request, not a fact. Only \`now\` sends a notification, and one sender holds at most ${String(HILL_NOW_MAX)} open \`now\` Decisions.` },
  text: { type: "word", required: "no", limit: `one of ${codeList(HILL_TEXT_MODES)}. Default \`${DEFAULT_DECISION_TEXT}\``, what: "Whether the person may, must, or may not add words to the answer. `none` needs at least one option." },
  about: { type: "session id", required: "no", limit: "an `id` from the facts' sessions, `memberId:paneId`", what: "The session the card is about. The card opens its Chat." },
  replyTo: { type: "session id", required: "no", limit: "an `id` from the facts' sessions", what: "The session that gets the person's words, as the person's own WalkyTalky message." },
  media: { type: "list", required: "no", limit: `at most ${String(HILL_MEDIA_MAX)}; each \`file\` (a PNG, JPEG or WebP in the trick's folder, ${sizeWords(HILL_MEDIA_BYTES_MAX)} at most) and optionally \`caption\` (at most ${String(HILL_MEDIA_CAPTION_MAX)} characters)`, what: "Pictures on the card." },
  links: { type: "list", required: "no", limit: `at most ${String(HILL_LINKS_MAX)}; each \`label\` (at most ${String(HILL_LINK_LABEL_MAX)}) and \`href\` (an https or http address, at most ${String(HILL_LINK_HREF_MAX)} characters)`, what: "Web pages that give more." },
  expiresAt: { type: "instant", required: "no", limit: `epoch milliseconds. Left out, ${String(HILL_DEFAULT_EXPIRY_DAYS)} days; never more than ${String(HILL_MAX_EXPIRY_DAYS)} days`, what: "When the Decision closes by itself, as expired." },
  view: { type: "list of nodes", required: "no", limit: "see Parts: a Decision's view", what: "A small display-only view under the summary: facts to read, never a control." },
} as const satisfies { readonly [K in (typeof DECISION_KEYS)[number]]: Omit<DecisionKeyEntry, "key"> };

export interface HillEntry {
  readonly name: string;
  readonly what: string;
  /** How a program trick asks. */
  readonly program: string;
  /** How an agent asks. */
  readonly agent: string;
  readonly keys: readonly DecisionKeyEntry[];
  readonly limits: readonly Limit[];
  /** What an answer returns to a program, in words. */
  readonly answer: string;
  readonly examples: readonly Example[];
}

/** The Hill: the place a program or an agent asks the person one question. It is not a `place` word. */
export const HILL: HillEntry = {
  name: "The Hill",
  what: "A page of Decisions: questions that a program or an agent asks the person, each answered with one tap. It is built in. A trick does not list it in `places`. Settings → Tricks shows it as the first row, tagged \"Built in\", with its one switch.",
  program: `A program lists Decisions in the \`decisions\` key of its output (the helper's \`t.decide\`). The list is declarative: after each run that succeeded, Collie makes the Hill agree with it, as [The list is the truth](#the-list-is-the-truth) says below. A document lists at most ${String(DECISIONS_MAX)}.`,
  agent: "An agent posts one with `collie hill post` and reads the answer with `collie hill status <id>`. The answer also reaches the agent as a WalkyTalky message.",
  keys: DECISION_KEYS.map((key) => Object.assign({ key }, DECISION_KEY_WORDS[key])),
  limits: [
    { what: "Open Decisions per sender", value: String(HILL_OPEN_MAX) },
    { what: "Open `now` Decisions per sender", value: `${String(HILL_NOW_MAX)}. A further one shows as \`${DEFAULT_DECISION_PRIORITY}\`` },
    { what: "Closed Decisions served", value: `${String(HILL_CLOSED_SERVED)}, newest first` },
    { what: "The person's words in an answer", value: `at most ${String(HILL_ANSWER_TEXT_MAX)} characters` },
    { what: "Expiry", value: `${String(HILL_DEFAULT_EXPIRY_DAYS)} days when left out, at most ${String(HILL_MAX_EXPIRY_DAYS)}` },
    { what: "Answers waiting for one trick", value: `${String(HILL_QUEUE_MAX)}. One more is refused as busy` },
  ],
  answer: `When the person answers, the program runs once with a \`tap\` trigger. Its \`node\` is \`${HILL_NODE_PREFIX}<key>\`. Its \`intent\` is the chosen option's, \`answer\` for words alone, or \`dismiss\`. Its \`value\` is \`{ "text": ... }\`, the person's words or \`null\`. Its \`seen\` is the hash of the version the person saw, so the trick can tell an answer to old words from one to new.`,
  examples: [
    {
      kind: "decision",
      json: {
        key: "case-24",
        title: "Rerun the failed check?",
        summary: "Check 24 failed twice, on a timeout. A rerun takes about a minute.",
        options: [
          { intent: "rerun", label: "Rerun it" },
          { intent: "skip", label: "Skip it" },
        ],
        recommends: { intent: "rerun", why: "It failed on a timeout, not on a test." },
      },
    },
    {
      kind: "tap",
      json: { kind: "tap", rid: "0b9e8d7c-3a41-4c52-9d5e-1f2a3b4c5d6e", node: "hill/case-24", intent: "rerun", value: { text: "Rerun it, then tell me." }, seen: "944a71314b332828" },
    },
    { kind: "command", text: 'collie hill post --title "Rerun the failed check?" --summary "Check 24 failed on a timeout." --option rerun="Rerun it" --option skip="Skip it" --recommend rerun --why "It was a timeout."' },
  ],
};

// ── The program ──────────────────────────────────────────────────────────────────────────────

/**
 * The numbers of the program's side that live outside this folder: the bridge, the CLI and the helper
 * file each own one. This file is imported by the web app, so it cannot import them. The generator reads
 * each from the constant that owns it (or, for the helper, from the helper's own source) and hands them
 * over, and the test holds each to its owner.
 */
export interface ProgramNumbers {
  /** How long after a phone looked the timer keeps running: `WATCH_WINDOW_MS` (bridge/tricks/service.ts). */
  readonly watchWindowMs: number;
  /** The least time between two posts of a key that closed without the person: `REASK_AFTER_MS` (bridge/tricks/hill.ts). */
  readonly reaskAfterMs: number;
  /** The first Collie that reads a trick's inputs over a crew link: `TRICKS_CREW_FIRST_VERSION` (bridge/hill/crew.ts). */
  readonly tricksCrewFirstVersion: string;
  /** The soft limits of a card's wording: `HILL_TITLE_SOFT_MAX`, `HILL_SUMMARY_SOFT_SENTENCES`, `HILL_SUMMARY_SOFT_MAX` (cli/hill-rules.ts). */
  readonly titleSoftMax: number;
  readonly summarySoftSentences: number;
  readonly summarySoftMax: number;
  /** The most bytes of each of stdout and stderr that `t.sh` keeps, and its default time: `SH_CAP` and the `timeoutMs` default of cli/trick-kit/trick.ts. */
  readonly helperShCapBytes: number;
  readonly helperShTimeoutMs: number;
}

/** A row of a table of fields: the name, whether it is always there, and what it holds. */
export interface FieldRow {
  readonly field: string;
  readonly present: string;
  readonly what: string;
}

export interface TriggerRow {
  readonly kind: (typeof TRIGGER_KINDS)[number];
  readonly when: string;
  /** The other fields of the trigger, read from the schema's own list. */
  readonly fields: string;
}

export interface OutputRow {
  readonly key: (typeof DOCUMENT_KEYS)[number];
  readonly required: string;
  readonly what: string;
}

/** One case of the tolerant read: what the program printed, and what Collie does with it. */
export interface ReadingRow {
  readonly case: string;
  readonly result: string;
}

export interface HelperRow {
  /** The calls this row covers, as they are written in a program. */
  readonly call: string;
  /** The names a test finds in the helper's source: each must be a real call. */
  readonly names: readonly string[];
  readonly what: string;
}

export interface GlobRow {
  readonly rule: string;
  readonly value: string;
}

export interface InputStateRow {
  readonly state: InputState;
  readonly when: string;
}

export interface TapRefusalRow {
  readonly refused: TapRefusal;
  readonly receipt: TapCode;
  readonly line: string;
  readonly when: string;
}

/** When the bridge refuses a tap with each word. Typed against the schema's own list of them. */
const TAP_REFUSAL_WORDS = {
  part: "The trick holds no part with that `node` now. A trick that has drawn nothing since Collie started answers `changed` instead.",
  intent: "No control of the part sends that `intent`.",
  value: "No control of the part sends that `value` with that intent.",
  changed: `The part changed since the phone drew it: the tap's \`rev\` is older than the part, or missing. The reply carries the trick's parts now, and the phone draws them.`,
  session: "`from.session` names no agent session that is open here now, or one on a crew member this Collie cannot reach.",
} as const satisfies { readonly [K in TapRefusal]: string };

export interface ProgramEntry {
  /** The facts' own fields, and the fields of a session in them. */
  readonly facts: readonly FieldRow[];
  readonly session: readonly FieldRow[];
  readonly triggers: readonly TriggerRow[];
  /** The trigger kinds that the facts' schema names and this Collie never sends. */
  readonly triggersLater: readonly string[];
  readonly tap: readonly string[];
  /** Each tap the bridge refuses before the program runs: the word, the receipt, the bridge's line, and when. */
  readonly tapRefusals: readonly TapRefusalRow[];
  /** What `from.session` proves, and what it does not. */
  readonly tapProof: string;
  readonly output: readonly OutputRow[];
  /** The keys of the first schema, which are refused with a hint. */
  readonly removedOutputKeys: readonly string[];
  readonly reading: readonly ReadingRow[];
  readonly helper: readonly HelperRow[];
  readonly helperAfter: readonly string[];
  readonly globs: readonly GlobRow[];
  readonly inputStates: readonly InputStateRow[];
  /** The fields of a session's `inputs`, and of each file in it. */
  readonly inputsFields: readonly FieldRow[];
  readonly inputFiles: readonly FieldRow[];
  readonly inputsContractLine: string;
  readonly inputsTrust: string;
}

/** The keys of the first schema's document that are refused now. The test holds each to the parser. */
const REMOVED_OUTPUT_KEYS = ["draft", "open"] as const;

const FACTS_WORDS = {
  contract: { present: "always", what: "The trick's own contract number: `contract` of `trick.toml`, or 1 when it names none." },
  trigger: { present: "always", what: "Why this run happened. See the table of triggers below." },
  trick: { present: "always", what: `${codeList(TRICK_FACT_KEYS)}: the trick's id, the folder of the approved copy that the program runs in, and the state folder. The program keeps its notes in \`state\`, never in \`dir\`.` },
  memberId: { present: "always", what: "The bridge that runs the trick: its crew member id, or on a solo install its install id (`m_` and ten characters). It stays the same when the machine is renamed. Key anything the program keeps on it." },
  host: { present: "always", what: "The machine's name, for display only. It changes with a rename. Never key on it." },
  sessions: { present: "always", what: `The agent and shell sessions, at most ${String(FACT_SESSIONS_MAX)}. On a crew's lead they are every member's, the lead's own first.` },
  spaces: { present: "always", what: `Each space as ${codeList(SPACE_FACT_KEYS)} (\`folder\` is left out when there is none), at most ${String(FACT_SPACES_MAX)}.` },
  sessionsOmitted: { present: "only when some are left out", what: "How many sessions the caps left out. Only a crew's lead counts them: a solo machine past the cap leaves the rest out with no count. Absent when none." },
} as const satisfies { readonly [K in (typeof FACTS_KEYS)[number]]: Omit<FieldRow, "field"> };

const SESSION_WORDS = {
  id: { present: "always", what: "The scope key `<memberId>:<paneId>`. Pass it back in a Decision's `about` and `replyTo`, or as the `href` of a `link` or a `row`." },
  memberId: { present: "always", what: "The bridge the session runs on. Read it, and do not parse `id`." },
  sessionId: { present: "always", what: "An opaque id. Never parse it: it can change." },
  paneId: { present: "always", what: "The multiplexer pane the session is in now." },
  host: { present: "always", what: "The name of the session's machine, for display only. Never a key." },
  name: { present: "when it has one", what: "The session's name." },
  agent: { present: "an agent only", what: "The agent's name. A shell has none." },
  status: { present: "always", what: `One of ${codeList(SESSION_STATUSES)}.` },
  cwd: { present: "when known", what: "The session's working folder." },
  space: { present: "when known", what: "The label of the session's space." },
  tab: { present: "when known", what: "The label of the session's tab." },
  lastActiveAt: { present: "when known", what: "When the session was last active, as an ISO 8601 time. The sessions of a crew's members have none." },
  reachable: { present: "a crew's lead only", what: "Whether the lead's last sweep reached the session's machine. The lead's own sessions are `true`." },
  inputs: { present: "contract 2, with `inputs`", what: `The files of the session's folder that the manifest's globs matched: ${codeList(INPUTS_FACT_KEYS)}. See [Input globs](#input-globs).` },
} as const satisfies { readonly [K in (typeof SESSION_FACT_KEYS)[number]]: Omit<FieldRow, "field"> };

const INPUT_FILE_WORDS = {
  rel: { present: "always", what: "The file's path relative to the session's folder, as the glob matched it." },
  path: { present: "always", what: "Where the copy is, relative to the trick's folder: `inputs/...`. Read it with `t.inputs`." },
  bytes: { present: "always", what: "The size of the copy in bytes." },
  sha256: { present: "always", what: "The SHA-256 of the copy's bytes, in hex." },
  mtime: { present: "always", what: "When the file last changed on its machine, as an ISO 8601 time." },
  kind: { present: "always", what: "`text` or `image`: a text file, or a PNG, JPEG or WebP picture." },
} as const satisfies { readonly [K in (typeof INPUT_FILE_FACT_KEYS)[number]]: Omit<FieldRow, "field"> };

const INPUTS_FIELD_WORDS = {
  state: "Where the session's inputs stand. See the table of states below.",
  files: "The files that were copied, each with the fields in the table of files below. It may be empty.",
  skipped: "How many matched files were left out: too large, not text or a picture, or past a cap. Absent when none.",
} as const satisfies { readonly [K in (typeof INPUTS_FACT_KEYS)[number]]: string };

/** One entry per trigger kind of the facts' schema. A new kind there is a compile error until it is here. */
const TRIGGER_WORDS = {
  start: { sent: true, when: () => "The first run after the trick loads, is switched on, a new version is approved or its `config.toml` changes." },
  timer: { sent: true, when: (n: ProgramNumbers) => `Every \`every\` after the last run, while a phone has looked in the last ${spanWords(n.watchWindowMs)}. A trick with no \`every\` gets none.` },
  tap: { sent: true, when: () => "A person tapped a control of the trick, or answered one of its Decisions." },
  watch: { sent: false, when: () => "A watched file changed." },
  event: { sent: false, when: () => "An event of the bus, such as `session.status`." },
} as const satisfies { readonly [K in (typeof TRIGGER_KINDS)[number]]: { readonly sent: boolean; readonly when: (n: ProgramNumbers) => string } };

/** One entry per key of a program's output document. A new key in `DOCUMENT_KEYS` is a compile error until it is here. */
function outputWords() {
  const floor = freshWindowMs(undefined, EVERY_MIN_MS);
  const probe = FRESH_MAX_MS / 24;
  const factor = freshWindowMs(undefined, probe) / probe;
  return {
    v: { required: "yes", what: `The contract number of the document: a whole number from 1 to ${String(DOCUMENT_VERSION)}, this Collie's own. The helper prints the contract of the facts.` },
    parts: { required: "yes", what: `The parts, at most ${String(PARTS_MAX)}, each at most ${sizeWords(PART_MAX_BYTES)}. \`[]\` is allowed. See [Places](#places).` },
    decisions: { required: "no", what: `The Decisions to ask, at most ${String(DECISIONS_MAX)}. Left out, the open Decisions stay as they are. \`[]\` withdraws them all. See [The Hill](#the-hill).` },
    asOf: { required: "no", what: "When the data was true, as an ISO 8601 time with a zone, such as `2026-11-08T09:41:00Z`. Give it when the data is older than the run." },
    fresh: {
      required: "no",
      what: `How long the parts stay fresh: ${durationWord(FRESH_MIN_MS)} to ${durationWord(FRESH_MAX_MS)}, one whole number and \`s\`, \`m\` or \`h\`, such as \`90s\`. Left out, ${String(factor)} times \`every\`, at least ${spanWords(floor)}, or ${spanWords(freshWindowMs(undefined, undefined))} for a trick with no timer, and never more than ${durationWord(FRESH_MAX_MS)}. Past it, the phone draws every tone as unknown.`,
    },
  } as const satisfies { readonly [K in (typeof DOCUMENT_KEYS)[number]]: Omit<OutputRow, "key"> };
}

/** The one sentence per kind of the facts, for a person who reads the table of triggers. */
function triggerRows(n: ProgramNumbers): TriggerRow[] {
  return TRIGGER_KINDS.filter((kind) => TRIGGER_WORDS[kind].sent).map((kind) => ({
    kind,
    when: TRIGGER_WORDS[kind].when(n),
    fields: codeList(TRIGGER_KEYS[kind].filter((key) => key !== "kind")) || "none",
  }));
}

const INPUT_STATE_WORDS = {
  ok: () => "The files were read. `files` may be empty.",
  offline: () => "The session's machine did not answer.",
  older: (n: ProgramNumbers) => `The session's Collie is older than ${n.tricksCrewFirstVersion}, which cannot read trick inputs.`,
  refused: () => "The session's machine switched trick reads off.",
  none: () => "There is no folder to read: a shell, or a session with no folder of its own.",
} as const satisfies { readonly [K in InputState]: (n: ProgramNumbers) => string };

/** The helper's calls, by the names a program writes. `names` are the words a test finds in the helper's source. */
function helperRows(n: ProgramNumbers): HelperRow[] {
  return [
    { call: "`t.facts`, `t.config`, `t.tap`", names: ["t.facts", "t.config", "t.tap"], what: "The facts, `config.toml` parsed (`{}` when there is none), and the tap that started the run or `null`. A tap has `rid`, `node`, `intent`, `value`, `decision` (the key of the Decision it answers, or `null`), `text`, `from` and `seen`." },
    { call: "`t.status({ text, icon?, tone? })`", names: ["t.status"], what: `The chip in the status line. \`text\` is at most ${String(STATUS_TEXT_MAX)} characters.` },
    { call: "`t.belt({ label, icon?, tone?, badge?, intent? })`", names: ["t.belt"], what: "The mark at the end of the Belt." },
    { call: "`t.dashboard(item)`, `t.tabbar(item)`", names: ["t.dashboard", "t.tabbar"], what: "The Dashboard tile and the bottom bar item: `{ label, icon?, badge?, tone? }`." },
    { call: "`t.session({ id?, name?, icon?, tone?, subtitle?, badge?, progress?, actions?, view })`", names: ["t.session"], what: "The trick's own Page. Keep the default id `main`." },
    { call: "`v.card`, `v.list`, `v.row`, and one builder for each other kind in Parts", names: ["v.card", "v.list", "v.row", "v.table", "v.checks", "v.stat", "v.beforeAfter"], what: "Build a view. `v.table` makes the `col` and `cell` kids, so those two have no builder. `v.checks`, `v.stat` and `v.beforeAfter` put kinds together." },
    { call: "`t.decide({ key, title, summary, options, ... })`", names: ["t.decide"], what: "Ask the person on the Hill." },
    { call: "`t.keepDecisions()`", names: ["t.keepDecisions"], what: "Leave the `decisions` key out, so the open Decisions stay. It wins over `t.decide`." },
    { call: "`t.state.get(name, fallback)`, `t.state.set(name, value)`", names: ["t.state"], what: "JSON files in the state folder. A name may hold folders, such as `cache/ci`: plain names, none starting with a dot." },
    { call: "`t.log(name)`", names: ["t.log"], what: "An append-only JSON-lines file in the state folder, with `.append`, `.all`, `.last(n)`, `.has(rid)` and `.once(rid, entry)`. `.once` writes once for one `rid` and answers `false` when it is there already." },
    { call: "`t.cached(name, ttlMs, loader)`", names: ["t.cached"], what: "A read kept with its time. A loader that throws serves the old value, marked stale." },
    { call: "`t.sh(cmd, args, { timeoutMs?, cwd? })`", names: ["t.sh"], what: `Runs a program without a shell and never throws: a failure is \`ok: false\` with the reason in \`stderr\`. It waits ${spanWords(n.helperShTimeoutMs)} unless \`timeoutMs\` says more, and keeps ${sizeWords(n.helperShCapBytes)} of each of stdout and stderr.` },
    { call: "`t.tool(name)`", names: ["t.tool"], what: "The path of a program on `PATH`, or in a common user folder, or `null`." },
    { call: "`t.sessionAt(folder)`, `t.sessionNamed(name)`", names: ["t.sessionAt", "t.sessionNamed"], what: "The session whose folder is `folder`, or the one with this name, or `null`." },
    { call: "`t.fresh(duration)`, `t.asOf(when)`", names: ["t.fresh", "t.asOf"], what: "The document's `fresh` and `asOf`." },
    { call: "`now()`, `age(ms)`, `iso(ms?)`, `mask(text)`, `clip(text, n)`", names: ["now", "age", "iso", "mask", "clip"], what: "The clock in epoch milliseconds, a span in short words such as `12 min`, an ISO 8601 time, text with each key cut to its first four characters and the home folder written as `~`, and one masked line cut to `n` characters." },
    { call: "`t.inputs(session)`", names: ["t.inputs"], what: "The input files of a session (contract 2): a text file as `text`, a picture as `data`. A copy that is gone or changed since the facts were written is left out. It answers `[]` when there are none, and `session.inputs?.state` says why. Never run what it returns." },
  ];
}

/** What the program receives, prints and calls, as tables and sentences. The numbers outside this folder come in as `n`. */
export function programOf(n: ProgramNumbers): ProgramEntry {
  const output = outputWords();
  return {
    facts: FACTS_KEYS.map((key) => Object.assign({ field: key }, FACTS_WORDS[key])),
    session: SESSION_FACT_KEYS.map((key) => Object.assign({ field: key }, SESSION_WORDS[key])),
    triggers: triggerRows(n),
    triggersLater: TRIGGER_KINDS.filter((kind) => !TRIGGER_WORDS[kind].sent),
    tap: [
      "A tap on a control of the trick's own part has `node` set to the part's id (`belt` for the Belt mark). Its `intent` is the control's, its `value` the control's one fixed text, and its `from` the session open on the phone, as `{ \"session\": ... }`, when there is one.",
      `An answer to a Decision is a tap too: its \`node\` is \`${HILL_NODE_PREFIX}<key>\`, and its \`seen\` is the hash of the version the person saw. See [The Hill](#the-hill).`,
      "`rid` is a UUID. A retried tap has the same `rid`, and Collie runs nothing twice for one `rid`: it answers with the first receipt. A program that records an answer keys the record on `rid`. The same `rid` with a different tap is refused.",
    ],
    tapRefusals: TAP_REFUSALS.map((refused) => ({ refused, receipt: refused === "changed" ? "changed" : "rejected", line: TAP_REFUSED_LINES[refused], when: TAP_REFUSAL_WORDS[refused] })),
    tapProof: "`from.session` is not proof of who tapped, nor of the session the part was drawn for. Collie checks only that it is an agent session open here now. A program never lets it decide who may do what.",
    output: DOCUMENT_KEYS.map((key) => Object.assign({ key }, output[key])),
    removedOutputKeys: REMOVED_OUTPUT_KEYS,
    reading: [
      { case: "A node of a kind this Collie does not know", result: "Left out, with a `dropped` note. The rest of the view draws." },
      { case: "A part in a place this Collie does not know", result: "Left out whole, with a `dropped` note. The other parts draw." },
      { case: `A key or an attribute this Collie does not know, inside a part, at contract ${String(TRICK_CONTRACT_DEFAULT)}`, result: "Ignored, with an `ignored` note. A node with only such attributes draws as if it had none." },
      { case: `A key or an attribute this Collie does not know, at any depth of a part, at contract ${String(TRICK_CONTRACT)}`, result: `That part is refused alone, with an \`unknown-key\` refusal that names the key and ends: "${CLOSED_KEY_LINE}" Collie keeps no last good version of it.` },
      { case: "A key this Collie does not know at the top of the document, beside `v`, `parts`, `asOf`, `fresh` and `decisions`", result: "Ignored, with an `ignored` note, at every contract. Every part draws. A key that changes how a part draws or what a tap does goes in the part, never at the top." },
      { case: "A bad value of a known field", result: "That part is refused alone, and the other parts draw. The last good version of the part stays on the phone, marked old." },
      { case: "A bad Decision", result: "That Decision is refused alone. Its open card stays as it is." },
      { case: "A bad `asOf` or `fresh`", result: "Refused alone. The parts still draw." },
      { case: "A document that is too big, not JSON, not an object, with no usable `v`, or with `parts` that is not a list", result: "The whole document is refused. The run counts as failed, and the last good parts stay, marked old." },
    ],
    helper: helperRows(n),
    helperAfter: [
      "A run that calls neither `t.decide` nor `t.keepDecisions` prints `\"decisions\": []`, so it withdraws the open ones.",
      "A thrown error prints one warning card on the trick's Page and exits 0, when the trick has a Page. The document has no `decisions` key, so the open Decisions stay. A trick with no Page exits 1, so the failure rules apply.",
      "`collie trick helper <id>` rewrites `trick.ts` with the newest helper. The helper is part of the trick's code, so a trick that is on keeps running the approved copy, and the new helper waits for a yes.",
    ],
    globs: [
      { rule: "Shape", value: `A path relative to a session's folder: 1 to ${String(INPUT_DEPTH_MAX)} steps split by \`/\`, at most ${String(INPUT_GLOB_MAX)} characters. The manifest lists at most ${String(INPUTS_MAX)}.` },
      { rule: "`*`", value: "Matches any run of characters inside one step, and never a leading dot. It never matches a `.env` file." },
      { rule: "Refused", value: "An absolute path or `~`. `**`. A `.` or `..` step. An empty step. A `.git` step, in any case. A step that starts with `.env`, in any case, such as `.env`, `.env.local` or `.envrc`. Any other glob word (`?`, `[`, `]`, `{`, `}`), a backslash and a control character." },
    ],
    inputStates: INPUT_STATES.map((state) => ({ state, when: INPUT_STATE_WORDS[state](n) })),
    inputsFields: INPUTS_FACT_KEYS.map((key) => ({ field: key, present: key === "skipped" ? "only when some are skipped" : "always", what: INPUTS_FIELD_WORDS[key] })),
    inputFiles: INPUT_FILE_FACT_KEYS.map((key) => Object.assign({ field: key }, INPUT_FILE_WORDS[key])),
    inputsContractLine: INPUTS_NEED_CONTRACT,
    inputsTrust: "Other programs, often an agent, write the files, and on a crew another machine sends them. A trick shows them, counts them or quotes them. It never runs them, evaluates them, sources them, passes them to a shell or follows what they say. The globs are part of the trick's powers, so a change of them asks the person again.",
  };
}

// ── The Hill: the list is the truth, and how to word a card ──────────────────────────────────

export interface HillRulesEntry {
  /** What a run's list does to the Hill, one case per row. */
  readonly list: readonly ReadingRow[];
  readonly listAfter: string;
  /** How to word a card, one part per row. */
  readonly wording: readonly ReadingRow[];
  readonly warnings: string;
}

/** The states a Decision reaches without the person: its key may ask again. Typed against the Hill's own states. */
const REASKABLE_STATES = ["undeliverable", "expired", "withdrawn"] as const satisfies readonly HillState[];

/** The rules by which a trick's list of Decisions becomes cards, and how to word one. */
export function hillRulesOf(n: ProgramNumbers): HillRulesEntry {
  return {
    list: [
      { case: "A new `key`", result: "Posts once. A second run, or a restart, posts nothing twice." },
      { case: "A listed `key` with changed content", result: "Posts the new version, which replaces the open one. Content is the title, summary, body, options, recommendation, text mode, links, priority, `about`, `replyTo`, the view, and each picture's bytes and caption. When the old card is closed, the new version posts as a fresh card." },
      { case: "A `key` the list no longer holds", result: 'The card is withdrawn, "by the trick".' },
      { case: "A `key` the person answered or dismissed", result: "Stays closed while its content is unchanged. To ask again, change the content, or drop the key for one run and list it again." },
      { case: `A \`key\` that closed without the person: ${orList(REASKABLE_STATES)}, a withdrawal by anyone but the trick`, result: `Posts again on a later run that still lists it, at most once every ${spanWords(n.reaskAfterMs)} for that key. A new post of this kind never sends a notification.` },
      { case: "A document with no `decisions` key", result: "Changes nothing." },
      { case: "`decisions` is `[]`", result: "Withdraws every open card of the trick." },
      { case: "A Decision the parser or the Hill refuses, or that names a session that is not there", result: "Changes nothing for its key: the version on the Hill stays. It shows as a refusal." },
      { case: "A failed or timed-out run", result: "Changes nothing." },
      { case: "The trick switched off or removed", result: 'Every open card of the trick is withdrawn at once, "the trick is off".' },
      { case: "The Hill switched off", result: "No post, replace or withdraw happens, and the trick still runs. Its row says its Decisions are not shown." },
    ],
    listAfter: "So list every Decision you still want on every run, and keep the words stable. Words that change on each run, such as an age in minutes, post a new version every time and ask again.",
    wording: [
      { case: "Title", result: `The decision as a short question that the options answer, at most ${String(n.titleSoftMax)} characters. "Ship 1.28.1 to Stable now?" is good. "Are the new kinds right?" is not.` },
      { case: "Summary", result: `At most ${String(n.summarySoftSentences)} sentences and ${String(n.summarySoftMax)} characters. The first says what the recommended option does. The second gives the one fact that decides it. The evidence goes in the view or the body.` },
      { case: "Option", result: 'Starts with a verb and says what happens, such as "Hold until CI". Never a bare Yes or No.' },
    ],
    warnings: `\`collie trick dev\` and \`collie trick check --run\` warn about a title past ${String(n.titleSoftMax)} characters or with no question mark, a summary past ${String(n.summarySoftSentences)} sentences or ${String(n.summarySoftMax)} characters, and an option that says only Yes, No or OK. A warning never refuses.`,
  };
}

// ── The manifest ─────────────────────────────────────────────────────────────────────────────

export interface ManifestEntry {
  readonly key: string;
  readonly type: string;
  readonly required: string;
  readonly limit: string;
  /** The lowest trick contract that takes the key. */
  readonly contract: number;
  readonly what: string;
}

const PLACE_WORDS_LIST = codeList([...PLACE_KINDS, AGENT_VIEW_PLACE]);

/** One entry per `trick.toml` key. A new key in `MANIFEST_KEYS` is a compile error until it is here. */
const MANIFEST_WORDS = {
  id: { type: "text", required: "yes", limit: `1 to 32 of \`a-z\`, \`0-9\` and \`-\`, starting with a letter or a digit. It equals the folder's name. Not ${codeList(RESERVED_TRICK_IDS)}`, contract: TRICK_CONTRACT_DEFAULT, what: "The trick's id, which is also the name of its folder." },
  name: { type: "text", required: "yes", limit: `at most ${String(NAME_MAX)} characters`, contract: TRICK_CONTRACT_DEFAULT, what: "The name a person reads on the row." },
  run: { type: "text", required: "yes, unless the trick is only an agent view", limit: `at most ${String(RUN_MAX)} characters`, contract: TRICK_CONTRACT_DEFAULT, what: 'What Collie runs: a TypeScript file in the folder ("program.ts"), or a shell command line. An agent view alone has none.' },
  every: { type: "duration", required: "no", limit: `${durationWord(EVERY_MIN_MS)} to ${durationWord(EVERY_MAX_MS)}, one whole number and \`s\`, \`m\` or \`h\`, such as \`30s\` or \`5m\``, contract: TRICK_CONTRACT_DEFAULT, what: "How often it runs on its timer. Left out, it runs at start and on taps only." },
  watch: { type: "list of paths", required: "no", limit: `at most ${String(WATCH_MAX)} paths of at most ${String(WATCH_PATH_MAX)} characters, each an absolute path, or a path under the home folder written with a leading tilde`, contract: TRICK_CONTRACT_DEFAULT, what: "Kept for a later Collie. This one leaves it out with a note. Leave it out." },
  on: { type: "list of words", required: "no", limit: `${codeList(TRICK_EVENTS)}`, contract: TRICK_CONTRACT_DEFAULT, what: "Kept for a later Collie. This one leaves it out with a note. Leave it out." },
  mode: { type: "word", required: "no", limit: `${orList(TRICK_MODES)}. Default \`${TRICK_MODES[0]}\``, contract: TRICK_CONTRACT_DEFAULT, what: `\`${TRICK_MODES[0]}\` runs once per trigger and prints one document. \`${TRICK_MODES[1]}\` is kept for a later Collie.` },
  contract: { type: "whole number", required: "no", limit: `1 to ${String(CONTRACT_MAX)}. Default ${String(TRICK_CONTRACT_DEFAULT)}. This Collie speaks 1 to ${String(TRICK_CONTRACT)}`, contract: TRICK_CONTRACT_DEFAULT, what: `The contract the trick is written for. Write ${String(INPUTS_CONTRACT)} to read files with \`inputs\` or to add an agent view. A higher number than this Collie knows is refused with one line.` },
  icon: { type: "word", required: "no", limit: `one of the icon words in Shared values. Default \`${DEFAULT_TRICK_ICON}\``, contract: TRICK_CONTRACT_DEFAULT, what: "The trick's icon. `collie trick check` names a wrong one." },
  places: { type: "list of words", required: "yes", limit: `1 to ${String(PLACES_LISTED_MAX)} of ${PLACE_WORDS_LIST}. Each once`, contract: TRICK_CONTRACT_DEFAULT, what: `Where its parts draw. Each place a part uses must be listed. \`${AGENT_VIEW_PLACE}\` adds an agent view and needs contract ${String(AGENT_VIEW_CONTRACT)}.` },
  env: { type: "list of names", required: "no", limit: `at most ${String(ENV_NAMES_MAX)} names of at most ${String(ENV_NAME_MAX)} characters: letters, digits and \`_\`, not starting with a digit`, contract: TRICK_CONTRACT_DEFAULT, what: "Environment names the program gets beyond the base list, such as `GH_TOKEN`. The person sees each one." },
  inputs: { type: "list of globs", required: "no", limit: `at most ${String(INPUTS_MAX)} globs of at most ${String(INPUT_GLOB_MAX)} characters and ${String(INPUT_DEPTH_MAX)} steps, relative to a session's folder`, contract: INPUTS_CONTRACT, what: "Files the program reads from each agent session's folder. They are untrusted data: show them, never run them." },
  description: { type: "text", required: "no", limit: `at most ${String(DESCRIPTION_MAX)} characters, plain text`, contract: TRICK_CONTRACT_DEFAULT, what: "One plain line that says what the trick does. Settings shows it under the name." },
  about: { type: "text", required: "no", limit: `at most ${String(ABOUT_MAX)} characters, plain text, a blank line splits paragraphs`, contract: TRICK_CONTRACT_DEFAULT, what: "The text of the About sheet." },
  rules: { type: "file name", required: `yes, with \`${AGENT_VIEW_PLACE}\`; refused without it`, limit: `a file in the trick's folder of at most ${String(RULES_NAME_MAX)} characters ending in \`.md\`, such as \`rules.md\``, contract: AGENT_VIEW_CONTRACT, what: "The instructions the agent of a session reads. The person reads them whole before they switch the trick on." },
} as const satisfies { readonly [K in (typeof MANIFEST_KEYS)[number]]: Omit<ManifestEntry, "key"> };

/** A whole `trick.toml` of a program trick, in the smallest useful shape. */
export const MANIFEST_EXAMPLE: Example = {
  kind: "manifest",
  toml: `id = "legs"\nname = "Legs"\nrun = "program.ts"\nevery = "5m"\nicon = "check"\nplaces = ["belt", "status", "session"]\ndescription = "Shows how many checks passed."\n`,
};

/** One entry per manifest key, in the parser's order. */
export const MANIFEST: readonly ManifestEntry[] = MANIFEST_KEYS.map((key) => Object.assign({ key }, MANIFEST_WORDS[key]));

/** A sentence for one manifest key, for `collie trick guide`: the key's words with its limit folded in where the guide printed one. */
export function manifestWords(key: (typeof MANIFEST_KEYS)[number]): string {
  return MANIFEST_WORDS[key].what;
}

// ── Limits ───────────────────────────────────────────────────────────────────────────────────

export interface LimitGroup {
  readonly group: string;
  readonly limits: readonly Limit[];
}

/** The one limit of a platform: the Windows gate (bridge/tricks/service.ts `gated`), in the words the CLI and the phone say. */
export const PLATFORM_LIMIT = `${TRICKS_WINDOWS_LINE} [Collie on Windows](windows.md) says what works there.`;

/** The limits that are not a place's or a part's own, each read from the constant that holds it. */
export const LIMITS: readonly LimitGroup[] = [
  {
    group: "A run",
    limits: [
      { what: "Time", value: spanWords(RUN_TIMEOUT_MS) },
      { what: "Output on stdout", value: sizeWords(STDOUT_CAP_BYTES) },
      { what: "Output on stderr kept", value: sizeWords(STDERR_CAP_BYTES) },
      { what: "Programs at once, across all tricks", value: String(RUNS_MAX) },
      { what: "Waits after a failed run", value: `${BACKOFF_MS.map((ms) => spanWords(ms)).join(", then ")}, then the trick stops` },
      { what: "Environment", value: `the base list ${codeList(BASE_ENV_NAMES)} and every \`LC_*\`, plus the names in \`env\`` },
    ],
  },
  {
    group: "Files of a trick",
    limits: [
      { what: "Pictures in `media/` and `captures/`, copied with the approved copy", value: `at most ${String(SEED_FILES_MAX)} files and ${sizeWords(SEED_BYTES_MAX)} in all` },
      { what: "`SKILL.md`", value: `at most ${sizeWords(SKILL_BYTES_MAX)}. A larger file is refused, never cut` },
    ],
  },
  {
    group: "Timers",
    limits: [
      { what: "`every` in the manifest", value: `${durationWord(EVERY_MIN_MS)} to ${durationWord(EVERY_MAX_MS)}` },
      { what: "`fresh` in a document", value: `${durationWord(FRESH_MIN_MS)} to ${durationWord(FRESH_MAX_MS)}` },
    ],
  },
  {
    group: "A document",
    limits: [
      { what: "The document", value: `at most ${sizeWords(DOCUMENT_MAX_BYTES)}` },
      { what: "Parts", value: `at most ${String(PARTS_MAX)}, each at most ${sizeWords(PART_MAX_BYTES)}` },
      { what: "Decisions", value: `at most ${String(DECISIONS_MAX)}` },
      { what: "A view", value: `${rangeWords(VIEW_LIMITS.root)} nodes at the top, ${String(VIEW_LIMITS.depth.max)} levels, ${String(VIEW_LIMITS.nodes.max)} nodes in all` },
      { what: "Kids of a card, group or row", value: `at most ${String(VIEW_LIMITS.kids.max)}` },
      { what: "Kids of a list", value: `at most ${String(VIEW_LIMITS.listKids.max)}` },
      { what: "Kids of a bar", value: `at most ${String(VIEW_LIMITS.barKids.max)}` },
      { what: "A table", value: `${rangeWords(TABLE_LIMITS.cols)} columns, ${rangeWords(TABLE_LIMITS.rows)} rows` },
      { what: "A diff", value: `at most ${String(DIFF_LIMITS.lines)} lines of at most ${String(DIFF_LIMITS.lineChars)} characters` },
      { what: "A spark", value: `${rangeWords(SPARK_LIMITS.values)} numbers` },
      { what: "A progress", value: `\`max\` ${rangeWords(VIEW_LIMITS.progressMax)}` },
      { what: "A button's or an action's `value`", value: `at most ${String(VALUE_MAX_BYTES)} bytes` },
    ],
  },
  {
    group: "Facts",
    limits: [
      { what: "Sessions in the facts", value: `at most ${String(FACT_SESSIONS_MAX)}, and ${sizeWords(FACT_SESSIONS_MAX_BYTES)} of them. \`sessionsOmitted\` counts the rest` },
      { what: "Spaces in the facts", value: `at most ${String(FACT_SPACES_MAX)}` },
    ],
  },
  {
    group: "Inputs",
    limits: [
      { what: "Globs", value: `at most ${String(INPUTS_MAX)}, each at most ${String(INPUT_GLOB_MAX)} characters and ${String(INPUT_DEPTH_MAX)} steps` },
      { what: "Files per session", value: String(INPUT_FILES_MAX) },
      { what: "A text file", value: `at most ${sizeWords(INPUT_TEXT_MAX_BYTES)}` },
      { what: "A picture", value: `at most ${sizeWords(INPUT_IMAGE_MAX_BYTES)}` },
      { what: "One answer of one machine", value: `at most ${sizeWords(INPUT_ANSWER_MAX_BYTES)}` },
      { what: "One run", value: `at most ${sizeWords(INPUT_RUN_MAX_BYTES)}` },
    ],
  },
  {
    group: "The rules file",
    limits: [
      { what: "Name", value: `one file at the top of the folder, at most ${String(RULES_NAME_MAX)} characters, ending in \`.md\`, a regular file and not a link` },
      { what: "Size", value: `at most ${sizeWords(RULES_MAX_BYTES)}, not empty, with a line break at the end` },
      { what: "Characters", value: "plain ASCII (bytes 0x20 to 0x7E) and line breaks only: no tab" },
      { what: "A line", value: `at most ${String(RULES_LINE_MAX)} characters, no space at its end, no run of more than ${String(RULES_SPACES_MAX)} spaces` },
      { what: "Blank lines", value: `at most ${String(RULES_BLANK_LINES_MAX)} in a row` },
    ],
  },
  {
    group: "A proposal from an agent",
    limits: [
      { what: "Files", value: `at most ${String(PROPOSE_LIMITS.files)}, ${sizeWords(PROPOSE_LIMITS.bytes)} in all, ${String(PROPOSE_LIMITS.depth)} folders deep` },
      { what: "Open at once", value: `${String(PROPOSALS_SENDER_OPEN_MAX)} per session, ${String(PROPOSALS_MEMBER_OPEN_MAX)} per crew machine, ${String(PROPOSALS_OPEN_MAX)} on the lead` },
      { what: "Per hour", value: `${String(PROPOSALS_SENDER_HOUR_MAX)} per session, ${String(PROPOSALS_MACHINE_HOUR_MAX)} per machine` },
      { what: "The card closes by itself after", value: spanWords(PROPOSAL_EXPIRY_MS) },
    ],
  },
  {
    group: "Card groups",
    limits: [
      { what: "Cards", value: `card 1 holds the facts and at most ${String(GROUP_CODE_CARDS)} cards hold the code, ${String(GROUP_CARD_CODE_BYTES / KIB)} KB each` },
      { what: "Code shown in all", value: `${String(GROUP_CODE_BYTES / KIB)} KB, at most ${String(GROUP_FILES_MAX)} files` },
    ],
  },
];

// ── Not in this Collie yet ───────────────────────────────────────────────────────────────────

export interface LaterEntry {
  readonly kind: "place" | "key";
  readonly word: string;
  readonly what: string;
}

/** What each later place is called in the table. Typed against the parser's own list of later places. */
const LATER_PLACE_NAMES = {
  "header.line": "A line in the header.",
  menu: "An entry in a menu, as `menu:<match>`.",
  settings: "A part of the Settings screen.",
} as const satisfies { readonly [K in keyof typeof LATER_PLACE_WORDS]: string };

/** What each later trigger is: the manifest keys `watch` and `on`, and the mode `serve`. */
const LATER_TRIGGER_NAMES = {
  watch: "Run again when a watched file changes (manifest key `watch`).",
  on: "Run on an event, such as `session.status` (manifest key `on`).",
  serve: "Keep the program running between triggers (manifest `mode = \"serve\"`).",
} as const satisfies { readonly [K in (typeof LATER_TRIGGERS)[number]]: string };

/** The places and keys the parser names as later. A program that uses one still runs, without it. */
export const LATER: readonly LaterEntry[] = [
  ...Object.entries(LATER_PLACE_NAMES).map(([word, what]) => ({ kind: "place" as const, word, what })),
  ...LATER_TRIGGERS.map((word) => ({ kind: "key" as const, word, what: LATER_TRIGGER_NAMES[word] })),
];

// ── Commands ─────────────────────────────────────────────────────────────────────────────────

/** The three verb trees: `collie trick`, `collie trick view` and `collie hill`. */
export type CommandGroup = "trick" | "trick view" | "hill";

export interface CommandFlag {
  readonly flag: string;
  readonly what: string;
}

export interface CommandEntry {
  readonly group: CommandGroup;
  readonly verb: string;
  /** The usage, without the leading `collie`. */
  readonly usage: string;
  readonly what: string;
  readonly flags: readonly CommandFlag[];
}

const JSON_FLAG: CommandFlag = { flag: "--json", what: "Print one JSON document instead of text." };

/** Every verb of `collie trick`, `collie trick view` and `collie hill`. The test holds this list to the CLI's own verb lists. */
export const COMMANDS: readonly CommandEntry[] = [
  { group: "trick", verb: "list", usage: "trick list [--json] [--official]", what: "Lists every trick folder with its switch, state, last run and last error.", flags: [JSON_FLAG, { flag: "--official", what: "List the official tricks this Collie can add from the phone." }] },
  { group: "trick", verb: "add", usage: "trick add [<name> | <https-url>[//<folder>][#<ref>]]", what: "Copies a trick from a git repository into the tricks folder, off. With no source it lists the official tricks and adds nothing.", flags: [] },
  { group: "trick", verb: "update", usage: "trick update <id> [--ref <branch|tag|commit>] [--dry-run]", what: "Fetches an added trick again and replaces its code, keeping `config.toml`.", flags: [{ flag: "--ref", what: "Fetch this branch, tag or commit instead of the same ref." }, { flag: "--dry-run", what: "Print what would change and change nothing." }] },
  { group: "trick", verb: "remove", usage: "trick remove <id>", what: "Deletes a trick that is off, with its state folder.", flags: [] },
  { group: "trick", verb: "on", usage: "trick on <id>", what: "Switches a trick on, approving its code as it is now. It refuses inside an agent's pane.", flags: [] },
  { group: "trick", verb: "off", usage: "trick off <id>", what: "Switches a trick off.", flags: [] },
  { group: "trick", verb: "auto", usage: "trick auto <id> on|off", what: "Takes new versions without asking while the powers do not change. A trick with rules never takes one.", flags: [] },
  { group: "trick", verb: "check", usage: "trick check [--run] [--json] <folder>", what: "Checks a trick folder: its manifest, places and command lines.", flags: [{ flag: "--run", what: "Run the program once, as the bridge would." }, JSON_FLAG] },
  {
    group: "trick",
    verb: "dev",
    usage: "trick dev <folder|id> [--tap <intent> [--text <words>] [--node <node>] [--rid <uuid>]] [--facts <file.json>] [--state <dir>] [--inputs <dir>] [--json] [--watch]",
    what: "Runs a trick once with fixture facts and prints what the phone would get. It never talks to the bridge.",
    flags: [
      { flag: "--tap", what: "Run it as a tap with this intent." },
      { flag: "--text", what: "The person's words for a Decision answer, with `--tap`." },
      { flag: "--node", what: "The node the tap names. Default `main`." },
      { flag: "--rid", what: "The tap's request id, a UUID, with `--tap`." },
      { flag: "--facts", what: "Run on the facts in this file instead of the fixture's." },
      { flag: "--state", what: "Use and keep this state folder." },
      { flag: "--inputs", what: "Read a contract 2 trick's inputs from this folder." },
      JSON_FLAG,
      { flag: "--watch", what: "Run again when a file in the folder changes." },
    ],
  },
  { group: "trick", verb: "init", usage: "trick init [--sh] <id>", what: "Makes a new trick folder with a program and the helper.", flags: [{ flag: "--sh", what: "Write a shell program instead of a TypeScript one." }] },
  { group: "trick", verb: "helper", usage: "trick helper <id|folder>", what: "Rewrites a trick's `trick.ts` with the helper this Collie carries.", flags: [] },
  { group: "trick", verb: "skill", usage: "trick skill [<id>]", what: "Prints what a trick that is on asks of an agent. With no id, prints how to write a trick.", flags: [] },
  { group: "trick", verb: "guide", usage: "trick guide [--json]", what: "Prints how to write a trick and hand it to the person, as plain text for an agent.", flags: [JSON_FLAG] },
  { group: "trick", verb: "propose", usage: "trick propose <folder> [--request-id <uuid>] [--json]", what: "Hands a trick folder to the person as a card on the lead's Hill. Nothing runs before their yes.", flags: [{ flag: "--request-id", what: "The proposal's request id, a UUID. The same sender, id and files get the same answer." }, JSON_FLAG] },
  { group: "trick", verb: "view", usage: "trick view <trick> <verb> [args]", what: "Runs one verb of an agent view, from the agent's pane. The verbs are the `trick view` commands below.", flags: [] },
  { group: "trick view", verb: "start", usage: 'trick view <trick> start [--session <address>] [--rules <id>] ["<what you do>"] [--json]', what: "Says the agent is drawing. The phone shows Drawing and the note until `show` lands.", flags: [{ flag: "--session", what: "The session's address, copied from the request's head." }, { flag: "--rules", what: "The id of the rules the agent holds." }, JSON_FLAG] },
  { group: "trick view", verb: "show", usage: 'trick view <trick> show [--session <address>] <file.json | -> [--title "<one line, at most 80>"] [--image <path>[=<caption>]]... [--json]', what: "Draws one whole screen from a file, or from stdin with `-`.", flags: [{ flag: "--session", what: "The session's address." }, { flag: "--title", what: "The screen's title, one line." }, { flag: "--image", what: "Add a picture, with an optional caption. The first is ref 0." }, JSON_FLAG] },
  { group: "trick view", verb: "set", usage: "trick view <trick> set [--session <address>] <id> <file.json | -> [--after <id> | --first] [--image <path>[=<caption>]]... [--json]", what: "Puts one block on the screen. A block with that id is replaced where it stands.", flags: [{ flag: "--session", what: "The session's address." }, { flag: "--after", what: "Put a new block after this one." }, { flag: "--first", what: "Put a new block first." }, { flag: "--image", what: "Add a picture to the screen's set." }, JSON_FLAG] },
  { group: "trick view", verb: "pending", usage: 'trick view <trick> pending [--session <address>] <id> "<label>" [--after <id> | --first] [--json]', what: "Puts a placeholder block for one still in work.", flags: [{ flag: "--session", what: "The session's address." }, { flag: "--after", what: "Put the block after this one." }, { flag: "--first", what: "Put the block first." }, JSON_FLAG] },
  { group: "trick view", verb: "remove", usage: "trick view <trick> remove [--session <address>] <id> [--json]", what: "Removes one block.", flags: [{ flag: "--session", what: "The session's address." }, JSON_FLAG] },
  { group: "trick view", verb: "choice", usage: "trick view <trick> choice [--session <address>] <file.json | -> | --clear [--json]", what: "Sets or drops the decision block alone. It takes no `picked`: Collie marks the pick.", flags: [{ flag: "--session", what: "The session's address." }, { flag: "--clear", what: "Drop the decision block." }, JSON_FLAG] },
  { group: "trick view", verb: "keep", usage: "trick view <trick> keep [--session <address>] <id>... | --all [--json]", what: "Says these blocks still hold for the new request.", flags: [{ flag: "--session", what: "The session's address." }, { flag: "--all", what: "Keep every block." }, JSON_FLAG] },
  { group: "trick view", verb: "clear", usage: "trick view <trick> clear [--session <address>] [--json]", what: "Takes the whole screen away. The switch stays.", flags: [{ flag: "--session", what: "The session's address." }, JSON_FLAG] },
  { group: "trick view", verb: "status", usage: "trick view <trick> status [--session <address>] [--json]", what: "Shows the session, the switch, the screen and the tail line.", flags: [{ flag: "--session", what: "The session's address." }, JSON_FLAG] },
  { group: "trick view", verb: "help", usage: "trick view <trick> help [--session <address>]", what: "Prints Collie's view help and, while the view is on for the session, the trick's own rules after it.", flags: [{ flag: "--session", what: "The session's address." }] },
  {
    group: "hill",
    verb: "post",
    usage: 'hill post --title "<question>" --summary "<plain words>" --option <intent>="<label>" ... --recommend <intent> --why "<reason>" [flags] [-- "<body>"]',
    what: "Puts one Decision on the Hill. `collie hill post --help` prints every flag and the rules.",
    flags: [
      { flag: "--title", what: "The question." },
      { flag: "--summary", what: "The summary, in plain words." },
      { flag: "--option", what: "One option, as `intent=label`. Repeat it." },
      { flag: "--recommend", what: "The intent of the recommended option." },
      { flag: "--why", what: "The reason for the recommendation." },
      { flag: "--confirm", what: "A second label for an option, as `intent=word`." },
      { flag: "--detail", what: "A line of detail for an option, as `intent=line`." },
      { flag: "--priority", what: "`now`, `today` or `later`." },
      { flag: "--text", what: "`none`, `optional` or `required`." },
      { flag: "--link", what: 'A web page, as `"label=https://..."`.' },
      { flag: "--about", what: "The session the card is about: `here` or an address." },
      { flag: "--reply-to", what: "The session that gets the person's words." },
      { flag: "--supersedes", what: "The id of an open Decision that this one replaces." },
      { flag: "--expires", what: "When it closes by itself, such as `2h` or `3d`." },
      { flag: "--request-id", what: "Post again with the same id and it posts once." },
      { flag: "--image", what: "A picture, with an optional caption. Repeat it." },
      { flag: "--view", what: "A JSON file with a small view under the summary." },
      JSON_FLAG,
    ],
  },
  { group: "hill", verb: "status", usage: "hill status <dc_id> [--json]", what: "Reads a Decision's state and its answer.", flags: [JSON_FLAG] },
  { group: "hill", verb: "withdraw", usage: "hill withdraw <dc_id> [--json]", what: "Withdraws a Decision that is open.", flags: [JSON_FLAG] },
  { group: "hill", verb: "list", usage: "hill list [--json]", what: "Lists the sender's own Decisions, open first.", flags: [JSON_FLAG] },
  { group: "hill", verb: "clear", usage: "hill clear [--json]", what: "Removes every closed Decision from the Hill. Open ones stay.", flags: [{ flag: "--spoken", what: "Withdraw and clear the open cards the person answered in the session. Not from an agent's pane." }, JSON_FLAG] },
  { group: "hill", verb: "state", usage: "hill state [here|quiet|away] [--json]", what: "Reads the crew state. With a word, the person sets it.", flags: [JSON_FLAG] },
  { group: "hill", verb: "on", usage: "hill on", what: "Switches the Hill on for this Collie.", flags: [] },
  { group: "hill", verb: "off", usage: "hill off", what: "Switches the Hill off: every post is refused and the open Decisions stay.", flags: [] },
];
