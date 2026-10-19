// The Profile: everything Collie knows about ONE harness's input box, as data (M56 spec 02,
// experiments/reader-stability/ARCHITECTURE.md section 4). One JSON file per harness in `profiles/`,
// keyed by version range, with a status. This module is pure and imports no DOM and no Bun API, so
// the bridge imports it the way `bridge/crew-level-contract.test.ts` imports `lib/crew-level.ts`.
//
// It never names a harness: the ids come from the files (`profiles/index.ts`), and a CI test
// (`no-harness-names.test.ts`) keeps it that way. The version comes from the binary, never from the
// screen; `versionFromOutput` is the one reading rule, shared with whoever runs the version command.
//
// The frame module (`frame.ts`, spec 03) reads the `idle` anchors; the Surface fold (spec 04) will
// read the rest.

import { asJsonNumber, asJsonObject, asJsonString, type JsonObject, type JsonValue } from "../json";
import { compareSemver } from "../semver";
import { EDGE_KINDS, type EdgeProfile } from "./edges";
import { HOLD_DECISIONS, HOLD_GRACE_MS, type HoldProfile } from "./hold";
import { PROFILE_FILES } from "./profiles/index";

export type ProfileStatus = "verified" | "provisional" | "revoked";
export type HookKind = "edge" | "ask";
/**
 * What Enter does while a turn runs: `queues` (the text waits for the turn's end), `steers` (the text
 * goes into the running turn), `submits` or `ignored`. The Send Protocol presses Enter into a turn
 * only on `queues`; on any other mode it presses `keys.queueKey` when the profile names one. A
 * harness whose Enter steers may name a submit key that is not Enter at all (Codex: Tab sends on an
 * idle box and queues in a turn), so no send of text ever presses Enter there.
 */
export type EnterWhileRunning = "queues" | "steers" | "submits" | "ignored";
/**
 * What the commit key does to a command (a text with a reserved lead) entered while a turn runs, as
 * the lab measured it (M56 spec 15): `queues` (the harness draws it as a queued row and runs it after
 * the turn), `runs` (at once), `drops` or `steers`. Only `queues` lets a command take the native
 * queued path; on any other mode, or with the field absent, Collie holds the command until the pane
 * reads free.
 */
export type CommandWhileRunning = "queues" | "runs" | "drops" | "steers";

/** A queued message as the harness draws it (see `keys.queuedRow`). */
export interface QueuedRow {
  /** A regular expression source for the row that starts the text, with the named group `text`. */
  readonly pattern: string;
  /** A regular expression source for the hint row under the queued texts. */
  readonly hint: string;
  /** How many blank rows may stand between the last queued text and the hint. */
  readonly hintGap: number;
}

export interface VersionRange {
  /** `X.Y.Z - X.Y.Z`, both ends included. The upper end may be `*`. */
  readonly range: string;
  /** The lower end of `range`, parsed. */
  readonly low: string;
  /** The upper end of `range`, parsed. Null for `*`, no upper end. */
  readonly high: string | null;
  readonly status: ProfileStatus;
  /** The newest version a person or the lab proved this range against, or null. */
  readonly verifiedThrough: string | null;
  /** The day of that proof (`YYYY-MM-DD`), or null. */
  readonly verifiedOn: string | null;
}

/**
 * A frame anchor: a row pattern, the display cells it must span, and the column it starts in. A
 * `blank` anchor is a row with no text at all (a box drawn with a fill colour and no edge glyphs);
 * its pattern must match the empty string.
 */
export interface FrameAnchor {
  /** A regular expression source, matched against the row text with its trailing space cut and its
   *  leading `column` spaces kept. The top anchor may hold a named group `label` (the words on the
   *  edge); the prompt anchor must hold `draft` (the hole). */
  readonly pattern: string;
  readonly minCells?: number;
  /** The row's text starts in exactly this column: that many spaces, then a character that is no space.
   *  With `maxColumn`, in any column from this one to that one. */
  readonly column: number;
  /** The last column the row's text may start in. For a box that moves sideways (a splash screen
   *  centres it). Optional. */
  readonly maxColumn?: number;
  /** The edge is a blank row. Only the top and bottom anchors may be blank. */
  readonly blank?: true;
  /**
   * The bottom anchor only, on the interior walk: the box has no bottom edge and ends on the last
   * non-blank row of the screen. The anchor's pattern is not read.
   */
  readonly open?: true;
}

/** A notice the harness draws above its live box (`idle.notices`), read by surface/notice.ts. */
export interface NoticeHead {
  /** A regular expression source, matched on the notice's first row with its trailing spaces cut: it must not need a trailing space. */
  readonly head: string;
}

/** A named row under the box (`idle.volatile.below.footerRows`). */
export interface FooterRow {
  /** What the row is, for a trace or a log line. */
  readonly name: string;
  /** A regular expression source, matched on the row with its trailing space cut. */
  readonly pattern: string;
}

/**
 * A row under a box that says the box belongs to another screen of the harness, not to the
 * conversation (`idle.volatile.below.otherScreens`).
 */
export interface OtherScreenRow {
  /** The screen in plain words, for the receipt's detail: "agents screen". */
  readonly name: string;
  /** A regular expression source, matched on the row with its trailing space cut. */
  readonly pattern: string;
}

/**
 * The harness's own completion list for a slash command (`idle.volatile.below.commandList`), drawn
 * in the rows at the box while the box holds the command: one entry per row, the command in the
 * left column and its description in a second column, a long description wrapped onto rows indented
 * to that column. A pointer marks the entry Enter picks. Each source is matched on a row with its
 * trailing space cut; `pointer` and `entry` hold the command in the named group `command`.
 */
export interface CommandListRows {
  /** The highlighted entry: the pointer glyph, the command, and maybe its description. */
  readonly pointer: string;
  /** Any other entry: the command, and maybe its description. */
  readonly entry: string;
  /** A row of the list that is no entry, under an entry: a wrapped description, or a count row ("(1/24)"). */
  readonly wrapped: string;
  /**
   * The lead the list leaves off its commands: a list that shows `model` for `/model` names `/` here,
   * and the pointed command reads as the lead and the name. Optional: with none, the group `command`
   * is the command as typed.
   */
  readonly lead?: string;
  /** The sides of the box the harness draws the list on. Optional: both, under first. */
  readonly sides?: readonly CommandListSide[];
  /**
   * The harness's own rows that stay on screen under a list drawn under the box (a folder row and a
   * stats row): the first row after the list matches `pattern`, and from it to the screen's last row
   * the rows are one run with no blank row, at most `maxRows` tall. Optional: with none, the list runs
   * to the screen's last row.
   */
  readonly footer?: CommandListFooter;
  /**
   * Prefixes the harness lists some commands under, with the bare name after them: OMP lists a skill
   * as `skill:<name>`. A pointer on `<namespace><name>` also stands for the typed `<lead><name>`, but
   * only when no entry of the list is `<lead><name>` itself. A profile names a namespace only when the
   * harness runs the pointed entry on Enter and lists `<namespace><name>` for a typed `<lead><name>`
   * only when no command of that name exists, so both spellings run the same entry. Optional.
   */
  readonly namespaces?: readonly string[];
}

/** A side of the box a command list stands on. */
export type CommandListSide = "under" | "above";

/** The rows that stay under a command list drawn under the box ({@link CommandListRows.footer}). */
export interface CommandListFooter {
  /** A regular expression source for the footer's first row, matched with its trailing space cut. */
  readonly pattern: string;
  /** The footer's most rows. */
  readonly maxRows: number;
}

/**
 * The rows a box always draws under the draft that hold no draft text (a model row inside the box,
 * and the padding between it and the bottom edge). The interior walk (`idle.frame.walk`) takes them
 * off the draft.
 */
export interface FrameTrailer {
  /** A regular expression source for the one row that must stand last inside the box. */
  readonly row: string;
  /** A regular expression source for the padding rows allowed between that row and the bottom edge. */
  readonly pad?: string;
  /** How many padding rows at most. */
  readonly maxPad: number;
}

/** One shape of the input box: its anchors, bounds and the fields of its walk (`idle.frame`). */
export interface FrameLayout {
  readonly top: FrameAnchor;
  /** Must hold the named group `draft`: the hole where the person's text sits. */
  readonly prompt: FrameAnchor;
  /** With `open` set (interior walk only), the box has no bottom edge: it ends on the last row of the screen. */
  readonly bottom: FrameAnchor;
  /** Spaces in front of a wrapped draft row inside the box. */
  readonly continuationIndent: number;
  readonly maxDraftRows: number;
  /** How many rows above the last non-blank row the bottom edge may sit (the frame module's
   *  search bound, M56 spec 03): the tallest thing the harness draws under a live box. */
  readonly maxTailRows: number;
  /**
   * How the walk finds the box. `edges` (the default) walks up from the bottom edge: rows that are
   * no edge are the wrapped draft, the first edge row is the prompt row, the top edge is over it.
   * `interior` walks up from the bottom edge (or from the last row, with no bottom anchor) to the
   * nearest top edge. The prompt row is then the first row under it that matches the prompt anchor,
   * and a blank row may match, so a box with no prompt glyph can be framed.
   */
  readonly walk?: FrameWalk;
  /**
   * The interior walk only. A regular expression source: the rows of the box are one unbroken run
   * of rows that match it, and the top edge is the nearest row of the run that matches the top anchor
   * and not the prompt anchor, or else the first row of the run. Without `rows` the top edge is the
   * nearest row that matches the top anchor.
   */
  readonly rows?: string;
  /** The interior walk only. Rows under the draft that are no draft text. Optional. */
  readonly trailer?: FrameTrailer;
  /**
   * The interior walk only. A regular expression source with the named group `text`, applied to
   * every interior row that is not the prompt row to take the draft text out of it. Without it a
   * row counts as its trimmed text.
   */
  readonly continuation?: string;
  /**
   * The interior walk only. A regular expression source the first non-blank row under the bottom
   * edge must match, when there is one. A box with a blank prompt row has the same shape as the
   * gap between a notice and the real box, so the row the harness always draws under the box
   * (its status line) tells them apart. Optional; a closed box only.
   */
  readonly under?: string;
  /**
   * The interior walk only, with `under`. True when a PAINTED footer passes the `under` test too,
   * whatever its words: a row straight under the bottom edge whose first visible run has a foreground
   * colour or is dim, opening one run with no blank row that ends the screen and is at most
   * `volatile.below.maxRows` tall. An extension may replace the harness's status line with its own
   * (pi's `ctx.ui.setFooter`, issue 485), and it paints it as the harness does, while a draft row cut
   * from its box is plain. The run's shape is the rest of the test: the harness paints a picker's
   * list and a dialog's title too, and those stand apart by a blank row or run past the bound. Optional.
   */
  readonly underPainted?: boolean;

}

/** The ghost text after the cursor ({@link Profile.idle.inlineHint}). */
export interface InlineHint {
  /** The foreground colours the ghost text is painted in, each as `rgb(r,g,b)`. */
  readonly fg: readonly string[];
}

/** How the frame module walks to a box. `edges` is the walk up from a bottom edge to a prompt row and a top edge. */
export type FrameWalk = "edges" | "interior";

export interface Profile {
  readonly id: string;
  readonly identity: {
    readonly binary: string;
    readonly versionCommand: readonly string[];
    /** A regular expression source. The first match in the command output is the version. */
    readonly versionRegex: string;
    /**
     * Other names a multiplexer reports for this harness (Herdr reports Antigravity as `agy` and as
     * `antigravity`). The bridge files each of them under this profile. Optional; never the id of a profile.
     */
    readonly agentNames?: readonly string[];
  };
  readonly versions: readonly [VersionRange, ...VersionRange[]];
  readonly idle: {
    readonly frame: FrameLayout;
    readonly placeholders: {
      readonly texts: readonly string[];
      /**
       * Text that starts with one of these is a placeholder too, for a harness whose placeholder holds
       * a suggestion that changes. Optional. A draft that starts the same way reads as a placeholder,
       * which stalls a send and never sends one into a dialog.
       */
      readonly prefixes?: readonly string[];
      /** The SGR attribute the placeholder renders with (2 is faint). */
      readonly sgr: number;
    };
    readonly volatile: {
      readonly above: {
        readonly maxRows: number;
        /**
         * The rows above the box may lose text once the box holds a character (a welcome picture
         * that hides). The Send Protocol then accepts rows above that only lost text. Optional.
         */
        readonly losesText?: true;
      };
      readonly below: {
        readonly maxRows: number;
        readonly footerMaxRows: number;
        /**
         * Hint rows under the box that the harness hides or swaps while the box holds text, as
         * regular expression sources. The Send Protocol leaves them out when it compares the rows
         * under the box. Optional.
         */
        readonly hints?: readonly string[];
        /**
         * Rows the harness draws under its box that are neither a statusline nor a dialog, each with a
         * name and a regular expression source (Claude Code's agents panel and its hints). The frame
         * walk steps over them: a run of them at the bottom, set apart by a blank row, is a footer of
         * its own. No modal cue reads a row one of them matches. Optional.
         */
        readonly footerRows?: readonly FooterRow[];
        /**
         * Rows that another screen of the harness draws under a box of its own, each with the
         * screen's name in plain words and a regular expression source (Claude Code's agents screen
         * and its key-hint row, "enter to return · ..."). A box with such a row under it is not the
         * conversation's box: once text is typed, a message never gets Enter there, whatever the
         * row count under the box. Optional.
         */
        readonly otherScreens?: readonly OtherScreenRow[];
        /**
         * The harness's completion list for a slash command ({@link CommandListRows}). At a box that
         * holds a command, a list whose pointer rests on that same command is the command's own
         * typeahead, not a dialog: Enter there picks the typed command. A list that points at another
         * command, or at none, reads as before. Where the list hides the rows the frame walk checks
         * under the box (a footer row, an open box's tail), a box is still found past the list, but
         * only when the list is its own. Never Escape. Optional.
         */
        readonly commandList?: CommandListRows;
      };
    };
    /**
     * Rows that mean a turn runs, as regular expression sources, read on the volatile band above the
     * box, the frame's bottom edge and the rows under it (cues.ts `runningSign`). Optional: the generic running signs above the box
     * always count. For a harness that marks a turn on its own status rows. The prompt row is read
     * too, for a harness that swaps its prompt glyph while a turn runs: a draft that happens to match
     * only reads as a turn, which sends nothing.
     */
    readonly runningRows?: readonly string[];
    /**
     * The prompt row of a box that answers a question the agent asked, as a regular expression source
     * read on the frame's prompt row. A send typed there answers that question, so a person may send
     * into it, but a held send never goes there: it waits for an ordinary box. Optional.
     */
    readonly answerPrompt?: string;
    /**
     * Rows that mean a dialog is drawn over the screen above a live box, as regular expression
     * sources, read on every row above the box. A harness that draws its pickers and notices over
     * the transcript and leaves the box on screen needs them: the box looks free under a dialog.
     * A match makes the modal `unreadable`. Optional.
     */
    readonly overlayRows?: readonly string[];
    /**
     * True for a harness that draws its dialogs where the box stands, between the same two rules. The
     * frame walk then finds a box on a dialog screen, so the modal cues read the whole screen, the
     * box rows included, as they do on a screen with no frame. A draft that looks like a list reads
     * as a modal then, and a modal is never free. Optional.
     */
    readonly dialogsInBox?: boolean;
    /**
     * Notices the harness draws above its live box while the box keeps the keys, each named by its
     * head row. A notice is that head, up to three continuation rows indented by two spaces, and one
     * row of `<digit>: <label>` keys, with only blank rows under it down to the box. Its keys act only
     * on a box that holds one digit, so no modal cue reads its rows, and a send whose whole text is one
     * of its keys takes the manual Send. Optional.
     */
    readonly notices?: readonly NoticeHead[];
    /**
     * Rows the harness may draw between a notice's key row and the box's top edge (`idle.notices`),
     * as regular expression sources, matched with trailing spaces cut. None may match a blank row.
     * The notice reader skips them as it skips blank rows, and every cue read leaves them out with
     * the notice. Any other row there is no notice. Read only beside `idle.notices`. Optional.
     */
    readonly noticeGaps?: readonly string[];
    /**
     * Other shapes of the same box, tried in order when `frame` finds none. A harness whose border
     * style the person can change (OMP) draws more than one. Each is a full frame as `frame` is.
     * The first shape that finds a box wins, so a shape that is easy to match goes last. Optional.
     */
    readonly frameAlternates?: readonly FrameLayout[];
    /**
     * The ghost text the harness paints after the cursor at the end of the draft (OMP's word
     * completion: `push` typed, `ed` painted after it), named by the exact foreground colours it is
     * painted in, each as `rgb(r,g,b)`. Every frame shape reads such a run as blank, but only when the
     * run is letters only, has no other attribute, stands last in the draft on the draft's last row,
     * and follows a visible draft character in another style. Any other run stays draft text, so a box
     * that shows more than was typed stops a send. Optional.
     */
    readonly inlineHint?: InlineHint;
  };
  readonly keys: {
    /**
     * The keys that send a text. Codex names Tab here: its Enter steers a running turn
     * (`enterWhileRunning`). In the file this is a list, or an object `{ "default": [...], "win32": [...] }`
     * for a harness whose key differs by platform; this field holds the default list.
     */
    readonly submit: readonly string[];
    /** The lists for the platforms that differ from `submit`, by `process.platform`. {@link forPlatform} applies them. Optional. */
    readonly submitByPlatform?: Readonly<Record<string, readonly string[]>>;
    /**
     * The keys that send a command or a text that starts with a reserved lead, when they are not
     * `submit`. Optional: without it a command takes `submit`. Codex names Enter: Tab completes in its
     * slash popup. Never Escape.
     */
    readonly commandSubmit?: readonly string[];
    readonly newline: readonly string[];
    readonly interrupt: readonly string[];
    /** One `key` press per typed character, plus `slack` more. Never Escape. */
    readonly clear: { readonly key: string; readonly slack: number };
    readonly navigation: {
      readonly up: string;
      readonly down: string;
      readonly confirm: string;
      readonly cancel: string;
    };
    /** What Enter does in a running turn. Absent when no lab run measured it: a send into a turn is then refused. */
    readonly enterWhileRunning?: EnterWhileRunning;
    /**
     * The key that queues a message for after the running turn, on a harness whose Enter does not
     * queue (`enterWhileRunning` is not `queues`). Optional: without it, a send into a turn is refused.
     * Never Escape and never Enter (what Enter does in a turn is `enterWhileRunning`). It may be the
     * submit key itself, on a harness whose submit key sends on an idle box and queues in a turn.
     */
    readonly queueKey?: string;
    /** The queue keys for the platforms that differ from `queueKey`, by `process.platform`. Optional. */
    readonly queueKeyByPlatform?: Readonly<Record<string, string>>;
    /**
     * How the harness draws a message it queued during a turn, when that is known: a row whose
     * `pattern` holds the text in the named group `text` (later rows of a wrapped text are indented),
     * and a `hint` row at most `hintGap` blank rows under the last of them. Optional.
     */
    readonly queuedRow?: QueuedRow;
    /**
     * What the commit key does to a command entered while a turn runs ({@link CommandWhileRunning}).
     * Optional: without it a command in a turn is held by Collie and sent once the pane reads free.
     */
    readonly commandWhileRunning?: CommandWhileRunning;
    /** Where `commandWhileRunning` was measured: the versions and commands the lab ran. Optional, prose only. */
    readonly commandWhileRunningNote?: string;
    /**
     * The commands Collie never queues or holds from the phone while a turn runs (M56 spec 15 review):
     * each acts on the session as it stands (it ends, clears or swaps it), so a later turn is the wrong
     * one. Such a command in a turn is refused `turn_running`. A one-character entry (`!`) names every
     * line that starts with it; a longer one names the command word. Optional.
     */
    readonly neverHeld?: readonly string[];
    /**
     * The command words the harness runs at once while a turn runs, as the lab measured them: the
     * harness takes the command before its turn and acts on it, never as text that steers the turn
     * or waits for its end (OMP's `/goal`). Such a command in a turn goes in with the command keys
     * (`commandSubmit`, else `submit`) instead of being held, and is probed like every send into a
     * turn. Each entry is one command word that starts with a reserved lead (`/goal`), matched alone
     * or followed by a space (`/goal pause`, never `/goals`). Never a word in `neverHeld`. Optional:
     * without it every command in a turn takes `commandWhileRunning` or Collie's hold.
     */
    readonly commandsRunInTurn?: readonly string[];
    /** Where `commandsRunInTurn` was measured: the versions and commands the lab ran. Optional, prose only. */
    readonly commandsRunInTurnNote?: string;
  };
  readonly collapse: {
    /** The long-paste form as a regular expression source. Group `lines` is optional. */
    readonly pattern: string;
  };
  readonly reservedLeads: readonly string[];
  readonly probe: {
    readonly char: string;
    readonly status: "verified" | "provisional";
    readonly note: string;
  };
  /** How a send writes its text (M56 spec 05). Optional: a profile without it is written as typed keys. */
  readonly paste?: {
    /** The harness takes a bracketed paste as text, so a send may paste where the multiplexer can. */
    readonly bracketed: boolean;
    /**
     * A harness that swallows a submit key sent too soon after the text (Muse, #507) names the pause,
     * in ms, a send waits after the write before the reads that can send it. Optional.
     */
    readonly settleMs?: number;
  };
  /** How the bridge keeps an ask (M56 spec 08). Optional: a profile without it uses the default lifetime. */
  readonly ask?: {
    /** An ask older than this, in ms, is voided once the screen no longer shows it. */
    readonly lifetimeMs: number;
  };
  /**
   * Hook event name to what it is for the Surface: an `edge` forces a re-read, an `ask` carries one.
   * Empty for a harness with no hook Collie can install.
   */
  readonly hooks: Readonly<Record<string, HookKind>>;
  /**
   * What each edge is for the fold, and its timing (M56 spec 11). Optional: a profile without it maps
   * no event, so every edge only asks for a fresh read, with the default timing.
   */
  readonly edges?: EdgeProfile;
  /**
   * How the harness's permission hook holds a request for the phone (M56 spec 12). Optional: a
   * profile without it holds nothing, and every permission stays a screen ask.
   */
  readonly hold?: HoldProfile;
}

/** A profile that failed its check. `path` names the field, for example `keys.clear.slack`. */
export class ProfileError extends Error {
  readonly path: string;
  constructor(path: string, problem: string) {
    super(`profile field ${path}: ${problem}`);
    this.name = "ProfileError";
    this.path = path;
  }
}

const STATUSES = ["verified", "provisional", "revoked"] as const;
const PROBE_STATUSES = ["verified", "provisional"] as const;
const HOOK_KINDS = ["edge", "ask"] as const;
const FRAME_WALKS = ["edges", "interior"] as const;
const ENTER_MODES = ["queues", "steers", "submits", "ignored"] as const;
const COMMAND_MODES = ["queues", "runs", "drops", "steers"] as const;
const SEMVER = /^\d+\.\d+\.\d+$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const RANGE = /^(\d+\.\d+\.\d+) - (\d+\.\d+\.\d+|\*)$/;

function fail(path: string, problem: string): never {
  throw new ProfileError(path, problem);
}

function joined(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

function object(value: JsonValue | undefined, path: string): JsonObject {
  const node = asJsonObject(value);
  return node ?? fail(path, "must be an object");
}

function field(parent: JsonObject, key: string, path: string): JsonValue {
  const value = parent[key];
  return value === undefined ? fail(joined(path, key), "is missing") : value;
}

function text(value: JsonValue | undefined, path: string): string {
  const word = asJsonString(value);
  return word === undefined || word.length === 0 ? fail(path, "must be a non-empty string") : word;
}

function whole(value: JsonValue | undefined, path: string, min: number): number {
  const count = asJsonNumber(value);
  return count !== undefined && Number.isInteger(count) && count >= min
    ? count
    : fail(path, `must be a whole number of at least ${String(min)}`);
}

function list(value: JsonValue | undefined, path: string): JsonValue[] {
  return Array.isArray(value) ? value : fail(path, "must be an array");
}

function textList(value: JsonValue | undefined, path: string, minLength: number): string[] {
  const items = list(value, path);
  if (items.length < minLength) fail(path, `must hold at least ${String(minLength)} entries`);
  return items.map((item, i) => text(item, `${path}[${String(i)}]`));
}

const PLATFORMS = ["win32", "darwin", "linux"] as const;

/** A key list as the file wrote it: the default, and the lists of the platforms that differ. */
interface PlatformLists {
  readonly default: string[];
  readonly byPlatform: Record<string, string[]>;
}

/**
 * A key list that may differ by platform: an array, or an object `{ "default": [...], "win32": [...] }`.
 * With `single`, each list holds exactly one key (the queue key). Returns the default and the lists for
 * the platforms named.
 */
function platformLists(value: JsonValue | undefined, path: string, single = false): PlatformLists {
  const minimum = 1;
  const check = (items: string[], at: string): string[] => (single && items.length !== 1 ? fail(at, "must name one key") : items);
  const node = asJsonObject(value);
  if (node === undefined) return { default: check(textList(value, path, minimum), path), byPlatform: {} };
  const byPlatform: Record<string, string[]> = {};
  for (const key of Object.keys(node)) {
    if (key === "default") continue;
    if (!PLATFORMS.some((platform) => platform === key)) fail(`${path}.${key}`, `must be default or one of ${PLATFORMS.join(", ")}`);
    byPlatform[key] = check(textList(node[key], `${path}.${key}`, minimum), `${path}.${key}`);
  }
  return { default: check(textList(field(node, "default", path), `${path}.default`, minimum), `${path}.default`), byPlatform };
}

function oneOf<const T extends string>(value: JsonValue | undefined, path: string, allowed: readonly T[]): T {
  const word = text(value, path);
  return allowed.find((candidate) => candidate === word) ?? fail(path, `must be one of ${allowed.join(", ")}`);
}

function nullableMatch(value: JsonValue | undefined, path: string, form: RegExp, what: string): string | null {
  if (value === null) return null;
  const word = text(value, path);
  return form.test(word) ? word : fail(path, `must be ${what} or null`);
}

/** A regular expression source, compiled once to prove it is one. Returns the compiled form. */
function pattern(value: JsonValue | undefined, path: string): RegExp {
  const source = text(value, path);
  try {
    return new RegExp(source, "u");
  } catch {
    return fail(path, "is not a valid regular expression");
  }
}

function anchor(value: JsonValue | undefined, path: string, needsGroup: string | null, mayBeBlank: boolean): FrameAnchor {
  const node = object(value, path);
  const compiled = pattern(field(node, "pattern", path), `${path}.pattern`);
  if (needsGroup !== null && !compiled.source.includes(`(?<${needsGroup}>`)) {
    fail(`${path}.pattern`, `must hold the named group ${needsGroup}`);
  }
  const column = whole(field(node, "column", path), `${path}.column`, 0);
  const maxColumn = node.maxColumn === undefined ? undefined : whole(node.maxColumn, `${path}.maxColumn`, column);
  const base: FrameAnchor = maxColumn === undefined ? { pattern: compiled.source, column } : { pattern: compiled.source, column, maxColumn };
  const withCells = node.minCells === undefined ? base : { ...base, minCells: whole(node.minCells, `${path}.minCells`, 1) };
  if (node.open !== undefined) {
    if (node.open !== true) fail(`${path}.open`, "must be true when present");
    return { ...withCells, open: true };
  }
  if (node.blank === undefined) return withCells;
  if (node.blank !== true) fail(`${path}.blank`, "must be true when present");
  if (!mayBeBlank) fail(`${path}.blank`, "only the top and bottom anchors may be blank");
  if (!compiled.test("")) fail(`${path}.pattern`, "of a blank anchor must match the empty string");
  if (column !== 0) fail(`${path}.column`, "of a blank anchor must be 0");
  return { ...withCells, blank: true };
}

function parseVersions(value: JsonValue | undefined, path: string): [VersionRange, ...VersionRange[]] {
  const parsedRows = list(value, path).map((row, i): VersionRange => {
    const at = `${path}[${String(i)}]`;
    const node = object(row, at);
    const range = text(field(node, "range", at), `${at}.range`);
    const parts = RANGE.exec(range);
    const low = parts?.[1];
    const high = parts?.[2];
    if (low === undefined || high === undefined) {
      return fail(`${at}.range`, "must read X.Y.Z - X.Y.Z, with * allowed for the upper end");
    }
    if (high !== "*" && compareSemver(low, high) > 0) fail(`${at}.range`, "starts above where it ends");
    const status = oneOf(field(node, "status", at), `${at}.status`, STATUSES);
    const verifiedThrough = nullableMatch(field(node, "verifiedThrough", at), `${at}.verifiedThrough`, SEMVER, "X.Y.Z");
    const verifiedOn = nullableMatch(field(node, "verifiedOn", at), `${at}.verifiedOn`, ISO_DAY, "YYYY-MM-DD");
    if (status === "verified" && (verifiedThrough === null || verifiedOn === null)) {
      fail(at, "a verified range must carry verifiedThrough and verifiedOn");
    }
    return { range, low, high: high === "*" ? null : high, status, verifiedThrough, verifiedOn };
  });
  const [first, ...rest] = parsedRows;
  return first === undefined ? fail(path, "must hold at least one range") : [first, ...rest];
}

/**
 * Check one profile file's parsed JSON and return it typed. Every field is checked; the first
 * problem throws a {@link ProfileError} that names the field path.
 */

/** `idle.volatile.above`: its row count, and `losesText` only when the profile sets it (it may only be true). */
function volatileAbove(node: JsonObject): Profile["idle"]["volatile"]["above"] {
  const maxRows = whole(field(node, "maxRows", "idle.volatile.above"), "idle.volatile.above.maxRows", 0);
  if (node.losesText === undefined) return { maxRows };
  if (node.losesText !== true) fail("idle.volatile.above.losesText", "must be true when present");
  return { maxRows, losesText: true };
}

/** `idle.volatile.below.footerRows`: each row a unique name and a pattern that cannot match a blank row. */
function footerRows(value: JsonValue | undefined): FooterRow[] {
  const path = "idle.volatile.below.footerRows";
  const names = new Set<string>();
  return list(value, path).map((item, i) => {
    const at = `${path}[${String(i)}]`;
    const node = object(item, at);
    const name = text(field(node, "name", at), `${at}.name`);
    if (names.has(name)) fail(`${at}.name`, "is used twice");
    names.add(name);
    const compiled = pattern(field(node, "pattern", at), `${at}.pattern`);
    if (compiled.test("")) fail(`${at}.pattern`, "must not match a blank row");
    return { name, pattern: compiled.source };
  });
}

/** `idle.volatile.below.otherScreens`: each row a unique name and a pattern that cannot match a blank row. */
function otherScreens(value: JsonValue | undefined): OtherScreenRow[] {
  const path = "idle.volatile.below.otherScreens";
  const names = new Set<string>();
  return list(value, path).map((item, i) => {
    const at = `${path}[${String(i)}]`;
    const node = object(item, at);
    const name = text(field(node, "name", at), `${at}.name`);
    if (names.has(name)) fail(`${at}.name`, "is used twice");
    names.add(name);
    const compiled = pattern(field(node, "pattern", at), `${at}.pattern`);
    if (compiled.test("")) fail(`${at}.pattern`, "must not match a blank row");
    return { name, pattern: compiled.source };
  });
}

/**
 * `idle.volatile.below.commandList`: three patterns that cannot match a blank row, the pointer and the
 * entry holding the group `command`; a lead with no space in it, the sides as unique words, and a footer
 * whose pattern cannot match a blank row, only when the profile names them.
 */
function commandList(value: JsonValue | undefined): CommandListRows {
  const path = "idle.volatile.below.commandList";
  const node = object(value, path);
  const one = (key: "pointer" | "entry" | "wrapped"): string => {
    const at = `${path}.${key}`;
    const compiled = pattern(field(node, key, path), at);
    if (compiled.test("")) fail(at, "must not match a blank row");
    if (key !== "wrapped" && !compiled.source.includes("(?<command>")) fail(at, "must hold the named group command");
    return compiled.source;
  };
  const base: CommandListRows = { pointer: one("pointer"), entry: one("entry"), wrapped: one("wrapped") };
  const withLead = node.lead === undefined ? base : { ...base, lead: commandListLead(node.lead, `${path}.lead`) };
  const withSides = node.sides === undefined ? withLead : { ...withLead, sides: commandListSides(node.sides, `${path}.sides`) };
  const withFooter = node.footer === undefined ? withSides : { ...withSides, footer: commandListFooter(node.footer, `${path}.footer`) };
  return node.namespaces === undefined ? withFooter : { ...withFooter, namespaces: commandListNamespaces(node.namespaces, `${path}.namespaces`) };
}

/** `commandList.namespaces`: unique words with no space in them. */
function commandListNamespaces(value: JsonValue, path: string): string[] {
  const namespaces = textList(value, path, 1);
  namespaces.forEach((namespace, i) => {
    if (namespace.length === 0 || /\s/u.test(namespace)) fail(`${path}[${String(i)}]`, "must be a word with no space");
    if (namespaces.indexOf(namespace) !== i) fail(`${path}[${String(i)}]`, "is named twice");
  });
  return namespaces;
}

function commandListLead(value: JsonValue, path: string): string {
  const lead = text(value, path);
  if (/\s/u.test(lead)) fail(path, "must hold no space");
  return lead;
}

function commandListSides(value: JsonValue, path: string): CommandListSide[] {
  const sides = textList(value, path, 1);
  const known: ReadonlySet<string> = new Set(["under", "above"]);
  sides.forEach((side, i) => {
    if (!known.has(side)) fail(`${path}[${String(i)}]`, 'must be "under" or "above"');
    if (sides.indexOf(side) !== i) fail(`${path}[${String(i)}]`, "is named twice");
  });
  return sides.filter((side): side is CommandListSide => side === "under" || side === "above");
}

function commandListFooter(value: JsonValue, path: string): CommandListFooter {
  const node = object(value, path);
  const compiled = pattern(field(node, "pattern", path), `${path}.pattern`);
  if (compiled.test("")) fail(`${path}.pattern`, "must not match a blank row");
  return { pattern: compiled.source, maxRows: whole(field(node, "maxRows", path), `${path}.maxRows`, 1) };
}

/** `idle.volatile.below`: its row counts, and the hint rows, named footer rows, other screens' rows and command list only when the profile names them. */
function volatileBelow(node: JsonObject): Profile["idle"]["volatile"]["below"] {
  const maxRows = whole(field(node, "maxRows", "idle.volatile.below"), "idle.volatile.below.maxRows", 0);
  const footerMaxRows = whole(field(node, "footerMaxRows", "idle.volatile.below"), "idle.volatile.below.footerMaxRows", 0);
  const base: Profile["idle"]["volatile"]["below"] = { maxRows, footerMaxRows };
  const withHints =
    node.hints === undefined
      ? base
      : { ...base, hints: list(node.hints, "idle.volatile.below.hints").map((item, i) => pattern(item, `idle.volatile.below.hints[${String(i)}]`).source) };
  const withFooter = node.footerRows === undefined ? withHints : { ...withHints, footerRows: footerRows(node.footerRows) };
  const withScreens = node.otherScreens === undefined ? withFooter : { ...withFooter, otherScreens: otherScreens(node.otherScreens) };
  return node.commandList === undefined ? withScreens : { ...withScreens, commandList: commandList(node.commandList) };
}
/** `idle.notices`: each an object whose head pattern compiles and cannot match a blank row. */
function parseNotices(value: JsonValue | undefined): NoticeHead[] {
  const path = "idle.notices";
  return list(value, path).map((item, i) => {
    const at = `${path}[${String(i)}]`;
    const node = object(item, at);
    const head = pattern(field(node, "head", at), `${at}.head`);
    if (head.test("") || head.test(" ")) fail(`${at}.head`, "must not match a blank row");
    return { head: head.source };
  });
}

/** `idle.noticeGaps`: each a pattern that compiles and cannot match a blank row. */
function parseNoticeGaps(value: JsonValue | undefined): string[] {
  const path = "idle.noticeGaps";
  return list(value, path).map((item, i) => {
    const at = `${path}[${String(i)}]`;
    const gap = pattern(item, at);
    if (gap.test("") || gap.test(" ")) fail(at, "must not match a blank row");
    return gap.source;
  });
}

/** `idle.inlineHint`: at least one foreground colour, each written `rgb(r,g,b)` as the ANSI reader gives it, none twice. */
function parseInlineHint(value: JsonValue): InlineHint {
  const path = "idle.inlineHint";
  const node = object(value, path);
  const fg = textList(field(node, "fg", path), `${path}.fg`, 1);
  fg.forEach((colour, i) => {
    const at = `${path}.fg[${String(i)}]`;
    const parts = /^rgb\((\d{1,3}),(\d{1,3}),(\d{1,3})\)$/u.exec(colour);
    if (parts === null || parts.slice(1).some((part) => Number(part) > 255)) fail(at, "must read rgb(r,g,b) with each part 0 to 255");
    if (fg.indexOf(colour) !== i) fail(at, "is named twice");
  });
  return { fg };
}

/** `idle.placeholders`: the texts and the SGR attribute, and the prefixes only when the profile names them. */
function parsePlaceholders(node: JsonObject): Profile["idle"]["placeholders"] {
  const base = {
    texts: textList(field(node, "texts", "idle.placeholders"), "idle.placeholders.texts", 0),
    sgr: whole(field(node, "sgr", "idle.placeholders"), "idle.placeholders.sgr", 0),
  };
  if (node.prefixes === undefined) return base;
  return { ...base, prefixes: textList(node.prefixes, "idle.placeholders.prefixes", 1) };
}

/** `idle.frame.trailer`: the last row inside the box, and the padding rows under it. */
function parseTrailer(value: JsonValue): FrameTrailer {
  const node = object(value, "idle.frame.trailer");
  const row = pattern(field(node, "row", "idle.frame.trailer"), "idle.frame.trailer.row").source;
  const maxPad = node.maxPad === undefined ? 0 : whole(node.maxPad, "idle.frame.trailer.maxPad", 0);
  if (node.pad === undefined) {
    if (maxPad > 0) fail("idle.frame.trailer.maxPad", "needs a pad pattern");
    return { row, maxPad };
  }
  return { row, pad: pattern(node.pad, "idle.frame.trailer.pad").source, maxPad };
}

/** `idle.frame`: the three anchors, the bounds, and the interior walk's own fields when the profile names that walk. */
function parseFrame(frameNode: JsonObject): FrameLayout {
  const walk = frameNode.walk === undefined ? "edges" : oneOf(frameNode.walk, "idle.frame.walk", FRAME_WALKS);
  const base = {
    top: anchor(field(frameNode, "top", "idle.frame"), "idle.frame.top", null, true),
    prompt: anchor(field(frameNode, "prompt", "idle.frame"), "idle.frame.prompt", "draft", false),
    continuationIndent: whole(field(frameNode, "continuationIndent", "idle.frame"), "idle.frame.continuationIndent", 0),
    maxDraftRows: whole(field(frameNode, "maxDraftRows", "idle.frame"), "idle.frame.maxDraftRows", 1),
    maxTailRows: whole(field(frameNode, "maxTailRows", "idle.frame"), "idle.frame.maxTailRows", 0),
  };
  if (walk === "edges") {
    for (const key of ["rows", "trailer", "continuation"] as const) {
      if (frameNode[key] !== undefined) fail(`idle.frame.${key}`, "belongs to the interior walk");
    }
    const edgeBottom = anchor(field(frameNode, "bottom", "idle.frame"), "idle.frame.bottom", null, true);
    if (edgeBottom.open === true) fail("idle.frame.bottom.open", "belongs to the interior walk");
    return { ...base, bottom: edgeBottom };
  }
  const interior = { ...base, bottom: anchor(field(frameNode, "bottom", "idle.frame"), "idle.frame.bottom", null, true), walk };
  const withRows = frameNode.rows === undefined ? interior : { ...interior, rows: pattern(frameNode.rows, "idle.frame.rows").source };
  const withTrailer = frameNode.trailer === undefined ? withRows : { ...withRows, trailer: parseTrailer(frameNode.trailer) };
  const withUnder = frameNode.under === undefined ? withTrailer : { ...withTrailer, under: pattern(frameNode.under, "idle.frame.under").source };
  if (frameNode.underPainted !== undefined && frameNode.underPainted !== true && frameNode.underPainted !== false) {
    fail("idle.frame.underPainted", "must be true or false");
  }
  if (frameNode.underPainted === true && frameNode.under === undefined) fail("idle.frame.underPainted", "needs an under pattern");
  const withPainted = frameNode.underPainted === true ? { ...withUnder, underPainted: true } : withUnder;
  if (frameNode.continuation === undefined) return withPainted;
  const continuation = pattern(frameNode.continuation, "idle.frame.continuation");
  if (!continuation.source.includes("(?<text>")) fail("idle.frame.continuation", "must hold the named group text");
  return { ...withPainted, continuation: continuation.source };
}

export function parseProfile(raw: JsonValue): Profile {
  const root = object(raw, "profile");
  const id = text(field(root, "id", ""), "id");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) fail("id", "must be lower-case letters, digits and dashes");

  const identityNode = object(field(root, "identity", ""), "identity");
  const identity = {
    binary: text(field(identityNode, "binary", "identity"), "identity.binary"),
    versionCommand: textList(field(identityNode, "versionCommand", "identity"), "identity.versionCommand", 1),
    versionRegex: pattern(field(identityNode, "versionRegex", "identity"), "identity.versionRegex").source,
  };
  let agentNames: readonly string[] | undefined;
  if (identityNode.agentNames !== undefined) {
    agentNames = textList(identityNode.agentNames, "identity.agentNames", 1);
    for (const name of agentNames) {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) fail("identity.agentNames", `${name} must be lower-case letters, digits and dashes`);
      if (name === id) fail("identity.agentNames", "must not repeat the id");
    }
  }

  const versions = parseVersions(field(root, "versions", ""), "versions");

  const idleNode = object(field(root, "idle", ""), "idle");
  const frameNode = object(field(idleNode, "frame", "idle"), "idle.frame");
  const placeholderNode = object(field(idleNode, "placeholders", "idle"), "idle.placeholders");
  const volatileNode = object(field(idleNode, "volatile", "idle"), "idle.volatile");
  const aboveNode = object(field(volatileNode, "above", "idle.volatile"), "idle.volatile.above");
  const belowNode = object(field(volatileNode, "below", "idle.volatile"), "idle.volatile.below");
  const idle: Profile["idle"] = {
    frame: parseFrame(frameNode),
    placeholders: parsePlaceholders(placeholderNode),
    volatile: { above: volatileAbove(aboveNode), below: volatileBelow(belowNode) },
  };

  const runningRows =
    idleNode.runningRows === undefined
      ? undefined
      : list(idleNode.runningRows, "idle.runningRows").map((item, i) => pattern(item, `idle.runningRows[${String(i)}]`).source);
  const withRunning: Profile["idle"] = runningRows === undefined ? idle : { ...idle, runningRows };
  const overlayRows =
    idleNode.overlayRows === undefined
      ? undefined
      : list(idleNode.overlayRows, "idle.overlayRows").map((item, i) => pattern(item, `idle.overlayRows[${String(i)}]`).source);
  const withOverlay0: Profile["idle"] = overlayRows === undefined ? withRunning : { ...withRunning, overlayRows };
  const withOverlay: Profile["idle"] =
    idleNode.frameAlternates === undefined
      ? withOverlay0
      : {
          ...withOverlay0,
          frameAlternates: list(idleNode.frameAlternates, "idle.frameAlternates").map((item, i) => {
            try {
              return parseFrame(object(item, `idle.frameAlternates[${String(i)}]`));
            } catch (error) {
              // A field of the alternate says its own place, not the main frame's.
              if (error instanceof ProfileError && error.path.startsWith("idle.frame.")) {
                fail(`idle.frameAlternates[${String(i)}].${error.path.slice("idle.frame.".length)}`, error.message.split(": ").slice(1).join(": "));
              }
              throw error;
            }
          }),
        };
  if (idleNode.dialogsInBox !== undefined && idleNode.dialogsInBox !== true && idleNode.dialogsInBox !== false) {
    fail("idle.dialogsInBox", "must be true or false");
  }
  const withDialogs: Profile["idle"] = idleNode.dialogsInBox === true ? { ...withOverlay, dialogsInBox: true } : withOverlay;
  const withNotices: Profile["idle"] = idleNode.notices === undefined ? withDialogs : { ...withDialogs, notices: parseNotices(idleNode.notices) };
  const withGaps: Profile["idle"] = idleNode.noticeGaps === undefined ? withNotices : { ...withNotices, noticeGaps: parseNoticeGaps(idleNode.noticeGaps) };
  const withHint: Profile["idle"] = idleNode.inlineHint === undefined ? withGaps : { ...withGaps, inlineHint: parseInlineHint(idleNode.inlineHint) };
  const idleBlock: Profile["idle"] =
    idleNode.answerPrompt === undefined ? withHint : { ...withHint, answerPrompt: pattern(idleNode.answerPrompt, "idle.answerPrompt").source };

  const keysNode = object(field(root, "keys", ""), "keys");
  const clearNode = object(field(keysNode, "clear", "keys"), "keys.clear");
  const navNode = object(field(keysNode, "navigation", "keys"), "keys.navigation");
  const platformSubmit = platformLists(field(keysNode, "submit", "keys"), "keys.submit");
  const baseKeys = {
    submit: platformSubmit.default,
    newline: textList(field(keysNode, "newline", "keys"), "keys.newline", 1),
    interrupt: textList(field(keysNode, "interrupt", "keys"), "keys.interrupt", 1),
    clear: {
      key: text(field(clearNode, "key", "keys.clear"), "keys.clear.key"),
      slack: whole(field(clearNode, "slack", "keys.clear"), "keys.clear.slack", 0),
    },
    navigation: {
      up: text(field(navNode, "up", "keys.navigation"), "keys.navigation.up"),
      down: text(field(navNode, "down", "keys.navigation"), "keys.navigation.down"),
      confirm: text(field(navNode, "confirm", "keys.navigation"), "keys.navigation.confirm"),
      cancel: text(field(navNode, "cancel", "keys.navigation"), "keys.navigation.cancel"),
    },
  };
  let keys: Profile["keys"] = Object.keys(platformSubmit.byPlatform).length === 0 ? baseKeys : { ...baseKeys, submitByPlatform: platformSubmit.byPlatform };
  if (keysNode.enterWhileRunning !== undefined) {
    keys = { ...keys, enterWhileRunning: oneOf(keysNode.enterWhileRunning, "keys.enterWhileRunning", ENTER_MODES) };
  }
  if (keysNode.queuedRow !== undefined) {
    const queuedNode = object(keysNode.queuedRow, "keys.queuedRow");
    const rowPattern = pattern(field(queuedNode, "pattern", "keys.queuedRow"), "keys.queuedRow.pattern");
    if (!rowPattern.source.includes("(?<text>")) fail("keys.queuedRow.pattern", "must hold the named group text");
    const queuedRow: QueuedRow = {
      pattern: rowPattern.source,
      hint: pattern(field(queuedNode, "hint", "keys.queuedRow"), "keys.queuedRow.hint").source,
      hintGap: whole(field(queuedNode, "hintGap", "keys.queuedRow"), "keys.queuedRow.hintGap", 0),
    };
    keys = { ...keys, queuedRow };
  }
  if (keysNode.queueKey !== undefined) {
    const queueObject = asJsonObject(keysNode.queueKey);
    const queueNode = platformLists(
      queueObject === undefined ? [text(keysNode.queueKey, "keys.queueKey")] : Object.fromEntries(Object.entries(queueObject).map(([key, value]) => [key, [text(value, `keys.queueKey.${key}`)]])),
      "keys.queueKey",
      true,
    );
    const checkQueueKey = (key: string): void => {
      if (/^(?:escape|esc)$/i.test(key)) fail("keys.queueKey", "must not be Escape");
      if (/^(?:enter|return)$/i.test(key)) fail("keys.queueKey", "must not be Enter: keys.enterWhileRunning says what Enter does in a turn");
    };
    const queueKey = queueNode.default[0] ?? fail("keys.queueKey", "must name one key");
    checkQueueKey(queueKey);
    if (keys.enterWhileRunning === "queues") fail("keys.queueKey", "is for a harness whose Enter does not queue");
    const queueByPlatform = Object.fromEntries(Object.entries(queueNode.byPlatform).map(([platform, names]) => [platform, names[0] ?? ""]));
    for (const key of Object.values(queueByPlatform)) checkQueueKey(key);
    keys = Object.keys(queueByPlatform).length === 0 ? { ...keys, queueKey } : { ...keys, queueKey, queueKeyByPlatform: queueByPlatform };
  }
  if (keysNode.commandWhileRunning !== undefined) {
    const commandWhileRunning = oneOf(keysNode.commandWhileRunning, "keys.commandWhileRunning", COMMAND_MODES);
    keys = { ...keys, commandWhileRunning };
  }
  if (keysNode.commandWhileRunningNote !== undefined) {
    keys = { ...keys, commandWhileRunningNote: text(keysNode.commandWhileRunningNote, "keys.commandWhileRunningNote") };
  }
  if (keysNode.neverHeld !== undefined) {
    const neverHeld = textList(keysNode.neverHeld, "keys.neverHeld", 1);
    if (neverHeld.some((entry) => entry.trim() !== entry || entry.length === 0)) fail("keys.neverHeld", "entries must be trimmed and not empty");
    keys = { ...keys, neverHeld };
  }
  if (keysNode.commandSubmit !== undefined) {
    const commandSubmit = textList(keysNode.commandSubmit, "keys.commandSubmit", 1);
    if (commandSubmit.some((key) => /^(?:escape|esc)$/i.test(key))) fail("keys.commandSubmit", "must not hold Escape");
    keys = { ...keys, commandSubmit };
  }
  // Escape is never cleanup (ARCHITECTURE.md, Send Protocol): a profile cannot name it as the clear key.
  if (/^(?:escape|esc)$/i.test(keys.clear.key)) fail("keys.clear.key", "must not be Escape");

  const collapseNode = object(field(root, "collapse", ""), "collapse");
  const collapse = { pattern: pattern(field(collapseNode, "pattern", "collapse"), "collapse.pattern").source };

  const reservedLeads = textList(field(root, "reservedLeads", ""), "reservedLeads", 1);
  // Read after the leads: each entry is one command word that starts with one of them.
  if (keysNode.commandsRunInTurn !== undefined) {
    const commandsRunInTurn = textList(keysNode.commandsRunInTurn, "keys.commandsRunInTurn", 1);
    for (const entry of commandsRunInTurn) {
      if (/\s/u.test(entry) || [...entry].length < 2) fail("keys.commandsRunInTurn", `${entry} must be one command word, with no space`);
      if (!reservedLeads.some((lead) => entry.startsWith(lead))) fail("keys.commandsRunInTurn", `${entry} must start with a reserved lead`);
      if (keys.neverHeld?.includes(entry) === true) fail("keys.commandsRunInTurn", `${entry} is in keys.neverHeld`);
    }
    keys = { ...keys, commandsRunInTurn };
  }
  if (keysNode.commandsRunInTurnNote !== undefined) {
    keys = { ...keys, commandsRunInTurnNote: text(keysNode.commandsRunInTurnNote, "keys.commandsRunInTurnNote") };
  }

  const probeNode = object(field(root, "probe", ""), "probe");
  const probe = {
    char: text(field(probeNode, "char", "probe"), "probe.char"),
    status: oneOf(field(probeNode, "status", "probe"), "probe.status", PROBE_STATUSES),
    note: text(field(probeNode, "note", "probe"), "probe.note"),
  };
  if ([...probe.char].length !== 1) fail("probe.char", "must be exactly one character");

  let paste: Profile["paste"];
  if (root.paste !== undefined) {
    const pasteNode = object(root.paste, "paste");
    const bracketed = pasteNode.bracketed;
    if (bracketed !== true && bracketed !== false) fail("paste.bracketed", "must be true or false");
    const settleMs = asJsonNumber(pasteNode.settleMs);
    if (pasteNode.settleMs !== undefined && (settleMs === undefined || !Number.isInteger(settleMs) || settleMs < 1 || settleMs > 5000)) {
      fail("paste.settleMs", "must be a whole number of ms from 1 to 5000");
    }
    paste = settleMs === undefined ? { bracketed: bracketed === true } : { bracketed: bracketed === true, settleMs };
  }

  let ask: Profile["ask"];
  if (root.ask !== undefined) {
    const askNode = object(root.ask, "ask");
    const lifetimeMs = asJsonNumber(askNode.lifetimeMs);
    if (lifetimeMs === undefined || !Number.isInteger(lifetimeMs) || lifetimeMs < 500 || lifetimeMs > 600_000) {
      fail("ask.lifetimeMs", "must be a whole number of ms from 500 to 600000");
    }
    ask = { lifetimeMs };
  }

  const hooksNode = object(field(root, "hooks", ""), "hooks");
  const hooks = Object.fromEntries(
    Object.keys(hooksNode).map((event) => [event, oneOf(hooksNode[event], `hooks.${event}`, HOOK_KINDS)]),
  );

  const edges = root.edges === undefined ? undefined : parseEdges(root.edges, hooks);

  const hold = root.hold === undefined ? undefined : parseHold(root.hold, hooks);

  const parsedProfile: Profile = { id, identity: agentNames === undefined ? identity : { ...identity, agentNames }, versions, idle: idleBlock, keys, collapse, reservedLeads, probe, hooks };
  const withPaste = paste === undefined ? parsedProfile : { ...parsedProfile, paste };
  const withAsk = ask === undefined ? withPaste : { ...withPaste, ask };
  const withEdges = edges === undefined ? withAsk : { ...withAsk, edges };
  return hold === undefined ? withEdges : { ...withEdges, hold };
}

/**
 * The `hold` block. Its event must be a key of `hooks` with kind `ask`, its tool event one with kind
 * `edge`. The limit plus the hook's own grace must stay below the hook timeout, so the bridge lets go
 * before the harness kills the hook.
 */
function parseHold(value: JsonValue, hooks: Readonly<Record<string, HookKind>>): HoldProfile {
  const node = object(value, "hold");
  const event = text(field(node, "event", "hold"), "hold.event");
  if (hooks[event] !== "ask") fail("hold.event", `names ${event}, which hooks does not list as an ask`);
  const toolEvent = text(field(node, "toolEvent", "hold"), "hold.toolEvent");
  if (hooks[toolEvent] !== "edge") fail("hold.toolEvent", `names ${toolEvent}, which hooks does not list as an edge`);
  const limitMs = millis(field(node, "limitMs", "hold"), "hold.limitMs", 5000, 3_600_000);
  const hookTimeoutS = whole(field(node, "hookTimeoutS", "hold"), "hold.hookTimeoutS", 10);
  if (limitMs + HOLD_GRACE_MS >= hookTimeoutS * 1000) {
    fail("hold.limitMs", `plus ${String(HOLD_GRACE_MS)} ms must stay below hold.hookTimeoutS`);
  }
  const minVersion = text(field(node, "minVersion", "hold"), "hold.minVersion");
  if (!/^\d+\.\d+\.\d+$/u.test(minVersion)) fail("hold.minVersion", "must read X.Y.Z");
  const inputShown = textList(field(node, "inputShown", "hold"), "hold.inputShown", 1);
  const screenOnly = textList(field(node, "screenOnly", "hold"), "hold.screenOnly", 0);
  const headersNode = object(field(node, "headers", "hold"), "hold.headers");
  const headers = Object.fromEntries(Object.keys(headersNode).map((tool) => [tool, textList(headersNode[tool], `hold.headers.${tool}`, 1)]));
  const agentMark = pattern(field(node, "agentMark", "hold"), "hold.agentMark").source;
  // The first group names the subagent's type: the bridge compares it with the request's.
  if ((new RegExp(`${agentMark}|`, "u").exec("")?.length ?? 0) < 2) fail("hold.agentMark", "must hold one group, the subagent's type");
  const detailsNode = object(field(node, "inputDetails", "hold"), "hold.inputDetails");
  const inputDetails = Object.fromEntries(
    Object.keys(detailsNode).map((tool) => {
      const at = `hold.inputDetails.${tool}`;
      const detail = object(detailsNode[tool], at);
      const flags = detail.flags === undefined ? [] : textList(detail.flags, `${at}.flags`, 0);
      const body = detail.body === undefined ? [] : textList(detail.body, `${at}.body`, 0);
      return [tool, { flags, body }];
    }),
  );
  const options = list(field(node, "options", "hold"), "hold.options").map((item, i) => {
    const at = `hold.options[${String(i)}]`;
    const option = object(item, at);
    return { label: text(field(option, "label", at), `${at}.label`), decision: oneOf(field(option, "decision", at), `${at}.decision`, HOLD_DECISIONS) };
  });
  if (!options.some((o) => o.decision === "allow") || !options.some((o) => o.decision === "deny")) {
    fail("hold.options", "must offer one allow and one deny");
  }
  const decisions = list(field(node, "decisions", "hold"), "hold.decisions").map((item, i) => {
    const at = `hold.decisions[${String(i)}]`;
    const rule = object(item, at);
    return { match: pattern(field(rule, "match", at), `${at}.match`).source, decision: oneOf(field(rule, "decision", at), `${at}.decision`, HOLD_DECISIONS) };
  });
  const decidedLine = pattern(field(node, "decidedLine", "hold"), "hold.decidedLine").source;
  const deniedLine = pattern(field(node, "deniedLine", "hold"), "hold.deniedLine").source;
  const denyMessage = text(field(node, "denyMessage", "hold"), "hold.denyMessage");
  return { event, toolEvent, limitMs, hookTimeoutS, minVersion, inputShown, inputDetails, screenOnly, headers, agentMark, options, decisions, decidedLine, deniedLine, denyMessage };
}

/** A whole number of ms inside a range. */
function millis(value: JsonValue | undefined, path: string, min: number, max: number): number {
  const ms = asJsonNumber(value);
  return ms !== undefined && Number.isInteger(ms) && ms >= min && ms <= max
    ? ms
    : fail(path, `must be a whole number of ms from ${String(min)} to ${String(max)}`);
}

/**
 * The `edges` block. Each key is a hook event, or `Event:detail` for one detail of it (a notification
 * type). The event part must be a key of `hooks` with kind `edge`: an event the profile does not
 * register as an edge cannot be one.
 */
function parseEdges(value: JsonValue, hooks: Readonly<Record<string, HookKind>>): EdgeProfile {
  const node = object(value, "edges");
  const rereadMs = millis(field(node, "rereadMs", "edges"), "edges.rereadMs", 100, 5000);
  const settleMs = millis(field(node, "settleMs", "edges"), "edges.settleMs", 100, 10_000);
  const eventsNode = object(field(node, "events", "edges"), "edges.events");
  const events = Object.fromEntries(
    Object.keys(eventsNode).map((key) => {
      const at = `edges.events.${key}`;
      if (!/^[A-Za-z][A-Za-z-]*(?::[a-z_-]+)?$/.test(key)) fail(at, "must read Event or Event:detail");
      const event = key.split(":")[0] ?? key;
      if (hooks[event] !== "edge") fail(at, `names ${event}, which hooks does not list as an edge`);
      return [key, oneOf(eventsNode[key], at, EDGE_KINDS)];
    }),
  );
  return { rereadMs, settleMs, events };
}

/** The version a binary printed: the first match of the profile's own version expression, or null. */
export function versionFromOutput(profile: Profile, output: string): string | null {
  return new RegExp(profile.identity.versionRegex, "u").exec(output)?.[0] ?? null;
}

export interface ProfileMatch {
  readonly profile: Profile;
  /** What Collie may trust: `provisional` and `revoked` send through the probed path. */
  readonly status: ProfileStatus;
  /** The version asked for, or null when the binary could not be read. */
  readonly version: string | null;
  /** The range that held the version, the nearest older one on the fallback, null when the version is unreadable. */
  readonly range: VersionRange | null;
}

export interface ProfileForOptions {
  /** Where the once-per-version note goes. Defaults to `console.warn`. */
  readonly log?: (line: string) => void;
  /** The profiles to look in. Defaults to every file in `profiles/`. For tests. */
  readonly profiles?: ReadonlyMap<string, Profile>;
}

let parsed: ReadonlyMap<string, Profile> | null = null;

/** Every profile in `profiles/`, parsed and checked once. A bad file throws on first use. */
export function loadProfiles(): ReadonlyMap<string, Profile> {
  if (parsed !== null) return parsed;
  const out = new Map<string, Profile>();
  for (const [stem, raw] of Object.entries(PROFILE_FILES)) {
    const profile = parseProfile(raw);
    if (profile.id !== stem) throw new ProfileError("id", `${profile.id} does not match its file name ${stem}`);
    out.set(profile.id, profile);
  }
  const claimed = new Set(out.keys());
  for (const profile of out.values()) {
    for (const name of profile.identity.agentNames ?? []) {
      if (claimed.has(name)) throw new ProfileError("identity.agentNames", `${name} of ${profile.id} is already a profile id or another profile's name`);
      claimed.add(name);
    }
  }
  parsed = out;
  return out;
}

/**
 * The profile with this id, for a reader that serves one harness and needs its anchors whatever the
 * version (the frame module's callers). Throws when no file carries the id: such a reader ships with
 * its profile, so a missing one is a build mistake, not a state to handle.
 */
export function requireProfile(id: string): Profile {
  const profile = loadProfiles().get(id);
  if (profile === undefined) throw new ProfileError("id", `no profile file carries the id ${id}`);
  return profile;
}

/** The profile a multiplexer's agent name belongs to: the id itself, or a name in `identity.agentNames`. */
export function findProfile(profiles: ReadonlyMap<string, Profile>, name: string): Profile | undefined {
  const direct = profiles.get(name);
  if (direct !== undefined) return direct;
  for (const profile of profiles.values()) if (profile.identity.agentNames?.includes(name) === true) return profile;
  return undefined;
}

/**
 * The profile with the keys of one platform (`process.platform`): `keys.submit` and `keys.queueKey`
 * take the platform's entry where the profile names one. A profile with no platform entry comes back as it is.
 */
export function forPlatform(profile: Profile, platform: string): Profile {
  const { submitByPlatform, queueKeyByPlatform } = profile.keys;
  const submit = submitByPlatform?.[platform];
  const queueKey = queueKeyByPlatform?.[platform];
  if (submit === undefined && queueKey === undefined) return profile;
  const keys: Profile["keys"] = { ...profile.keys, submit: submit ?? profile.keys.submit };
  return { ...profile, keys: queueKey === undefined ? keys : { ...keys, queueKey } };
}

/**
 * {@link profileFor} for one platform: the match carries the profile with that platform's keys
 * ({@link forPlatform}). The bridge calls this with `process.platform`.
 */
export function profileForPlatform(harness: string, version: string | null, platform: string, options?: ProfileForOptions): ProfileMatch | null {
  const match = profileFor(harness, version, options);
  return match === null ? null : { ...match, profile: forPlatform(match.profile, platform) };
}

const logged = new Set<string>();

/** Forget which versions were logged. For tests. */
export function resetProfileLog(): void {
  logged.clear();
}

function holds(range: VersionRange, version: string): boolean {
  return compareSemver(version, range.low) >= 0 && (range.high === null || compareSemver(version, range.high) <= 0);
}

/** The range whose upper end is the nearest one at or below `version`; else the lowest range. */
function nearestOlder(ranges: readonly [VersionRange, ...VersionRange[]], version: string): VersionRange {
  let best: VersionRange | null = null;
  let lowest = ranges[0];
  for (const range of ranges) {
    if (compareSemver(range.low, lowest.low) < 0) lowest = range;
    const top = range.high ?? range.low;
    if (compareSemver(top, version) > 0) continue;
    if (best === null || compareSemver(top, best.high ?? best.low) > 0) best = range;
  }
  return best ?? lowest;
}

function note(options: ProfileForOptions | undefined, harness: string, version: string | null, status: ProfileStatus): void {
  const key = `${harness}@${version ?? "unreadable"}`;
  if (logged.has(key)) return;
  logged.add(key);
  const write = options?.log ?? ((line: string) => console.warn(line));
  write(
    version === null
      ? `input profile ${harness}: the binary version could not be read, so the profile is ${status}`
      : `input profile ${harness} ${version}: ${status}`,
  );
}

/**
 * The profile for `harness` at `version`, with the status Collie may trust it at.
 *
 * - A version inside a range gets that range's status (`verified`, `provisional` or `revoked`).
 * - A version no range holds, above them all or in a gap, gets the nearest older range's profile as
 *   `provisional`. So does a version below every range, with the lowest range.
 * - `version` null (the binary could not be read) gets `provisional`. The screen is never read for it.
 *
 * `provisional` and `revoked` are logged once per version. Null when no profile exists for the harness.
 */
export function profileFor(
  harness: string,
  version: string | null,
  options?: ProfileForOptions,
): ProfileMatch | null {
  const profile = findProfile(options?.profiles ?? loadProfiles(), harness);
  if (profile === undefined) return null;

  if (version === null || !SEMVER.test(version)) {
    note(options, harness, null, "provisional");
    return { profile, status: "provisional", version: null, range: null };
  }

  const range = profile.versions.find((candidate) => holds(candidate, version)) ?? null;
  if (range !== null) {
    if (range.status !== "verified") note(options, harness, version, range.status);
    return { profile, status: range.status, version, range };
  }

  const older = nearestOlder(profile.versions, version);
  note(options, harness, version, "provisional");
  return { profile, status: "provisional", version, range: older };
}
