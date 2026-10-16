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
export type EnterWhileRunning = "queues" | "submits" | "ignored";

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

/** A frame anchor: a row pattern, the display cells it must span, and the column it starts in. */
export interface FrameAnchor {
  /** A regular expression source, matched against the row text with its trailing space cut. The top
   *  anchor may hold a named group `label` (the words on the edge); the prompt anchor must hold
   *  `draft` (the hole). */
  readonly pattern: string;
  readonly minCells?: number;
  readonly column: 0;
}

export interface Profile {
  readonly id: string;
  readonly identity: {
    readonly binary: string;
    readonly versionCommand: readonly string[];
    /** A regular expression source. The first match in the command output is the version. */
    readonly versionRegex: string;
  };
  readonly versions: readonly [VersionRange, ...VersionRange[]];
  readonly idle: {
    readonly frame: {
      readonly top: FrameAnchor;
      /** Must hold the named group `draft`: the hole where the person's text sits. */
      readonly prompt: FrameAnchor;
      readonly bottom: FrameAnchor;
      /** Spaces in front of a wrapped draft row inside the box. */
      readonly continuationIndent: number;
      readonly maxDraftRows: number;
      /** How many rows above the last non-blank row the bottom edge may sit (the frame module's
       *  search bound, M56 spec 03): the tallest thing the harness draws under a live box. */
      readonly maxTailRows: number;
    };
    readonly placeholders: {
      readonly texts: readonly string[];
      /** The SGR attribute the placeholder renders with (2 is faint). */
      readonly sgr: number;
    };
    readonly volatile: {
      readonly above: { readonly maxRows: number };
      readonly below: { readonly maxRows: number; readonly footerMaxRows: number };
    };
  };
  readonly keys: {
    readonly submit: readonly string[];
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
    readonly enterWhileRunning: EnterWhileRunning;
    /**
     * How the harness draws a message it queued during a turn, when that is known: a row whose
     * `pattern` holds the text in the named group `text` (later rows of a wrapped text are indented),
     * and a `hint` row at most `hintGap` blank rows under the last of them. Optional.
     */
    readonly queuedRow?: QueuedRow;
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
  };
  /** How the bridge keeps an ask (M56 spec 08). Optional: a profile without it uses the default lifetime. */
  readonly ask?: {
    /** An ask older than this, in ms, is voided once the screen no longer shows it. */
    readonly lifetimeMs: number;
  };
  /** Hook event name to what it is for the Surface: an `edge` forces a re-read, an `ask` carries one. */
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
const ENTER_MODES = ["queues", "submits", "ignored"] as const;
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

function anchor(value: JsonValue | undefined, path: string, needsGroup: string | null): FrameAnchor {
  const node = object(value, path);
  const compiled = pattern(field(node, "pattern", path), `${path}.pattern`);
  if (needsGroup !== null && !compiled.source.includes(`(?<${needsGroup}>`)) {
    fail(`${path}.pattern`, `must hold the named group ${needsGroup}`);
  }
  if (whole(field(node, "column", path), `${path}.column`, 0) !== 0) fail(`${path}.column`, "must be 0");
  const base = { pattern: compiled.source, column: 0 } as const;
  return node.minCells === undefined ? base : { ...base, minCells: whole(node.minCells, `${path}.minCells`, 1) };
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

  const versions = parseVersions(field(root, "versions", ""), "versions");

  const idleNode = object(field(root, "idle", ""), "idle");
  const frameNode = object(field(idleNode, "frame", "idle"), "idle.frame");
  const placeholderNode = object(field(idleNode, "placeholders", "idle"), "idle.placeholders");
  const volatileNode = object(field(idleNode, "volatile", "idle"), "idle.volatile");
  const aboveNode = object(field(volatileNode, "above", "idle.volatile"), "idle.volatile.above");
  const belowNode = object(field(volatileNode, "below", "idle.volatile"), "idle.volatile.below");
  const idle = {
    frame: {
      top: anchor(field(frameNode, "top", "idle.frame"), "idle.frame.top", null),
      prompt: anchor(field(frameNode, "prompt", "idle.frame"), "idle.frame.prompt", "draft"),
      bottom: anchor(field(frameNode, "bottom", "idle.frame"), "idle.frame.bottom", null),
      continuationIndent: whole(field(frameNode, "continuationIndent", "idle.frame"), "idle.frame.continuationIndent", 0),
      maxDraftRows: whole(field(frameNode, "maxDraftRows", "idle.frame"), "idle.frame.maxDraftRows", 1),
      maxTailRows: whole(field(frameNode, "maxTailRows", "idle.frame"), "idle.frame.maxTailRows", 0),
    },
    placeholders: {
      texts: textList(field(placeholderNode, "texts", "idle.placeholders"), "idle.placeholders.texts", 0),
      sgr: whole(field(placeholderNode, "sgr", "idle.placeholders"), "idle.placeholders.sgr", 0),
    },
    volatile: {
      above: { maxRows: whole(field(aboveNode, "maxRows", "idle.volatile.above"), "idle.volatile.above.maxRows", 0) },
      below: {
        maxRows: whole(field(belowNode, "maxRows", "idle.volatile.below"), "idle.volatile.below.maxRows", 0),
        footerMaxRows: whole(field(belowNode, "footerMaxRows", "idle.volatile.below"), "idle.volatile.below.footerMaxRows", 0),
      },
    },
  };

  const keysNode = object(field(root, "keys", ""), "keys");
  const clearNode = object(field(keysNode, "clear", "keys"), "keys.clear");
  const navNode = object(field(keysNode, "navigation", "keys"), "keys.navigation");
  const baseKeys = {
    submit: textList(field(keysNode, "submit", "keys"), "keys.submit", 1),
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
    enterWhileRunning: oneOf(field(keysNode, "enterWhileRunning", "keys"), "keys.enterWhileRunning", ENTER_MODES),
  };
  let keys: Profile["keys"] = baseKeys;
  if (keysNode.queuedRow !== undefined) {
    const queuedNode = object(keysNode.queuedRow, "keys.queuedRow");
    const rowPattern = pattern(field(queuedNode, "pattern", "keys.queuedRow"), "keys.queuedRow.pattern");
    if (!rowPattern.source.includes("(?<text>")) fail("keys.queuedRow.pattern", "must hold the named group text");
    const queuedRow: QueuedRow = {
      pattern: rowPattern.source,
      hint: pattern(field(queuedNode, "hint", "keys.queuedRow"), "keys.queuedRow.hint").source,
      hintGap: whole(field(queuedNode, "hintGap", "keys.queuedRow"), "keys.queuedRow.hintGap", 0),
    };
    keys = { ...baseKeys, queuedRow };
  }
  // Escape is never cleanup (ARCHITECTURE.md, Send Protocol): a profile cannot name it as the clear key.
  if (/^(?:escape|esc)$/i.test(keys.clear.key)) fail("keys.clear.key", "must not be Escape");

  const collapseNode = object(field(root, "collapse", ""), "collapse");
  const collapse = { pattern: pattern(field(collapseNode, "pattern", "collapse"), "collapse.pattern").source };

  const reservedLeads = textList(field(root, "reservedLeads", ""), "reservedLeads", 1);

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
    paste = { bracketed: bracketed === true };
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
  if (Object.keys(hooks).length === 0) fail("hooks", "must name at least one event");

  const edges = root.edges === undefined ? undefined : parseEdges(root.edges, hooks);

  const hold = root.hold === undefined ? undefined : parseHold(root.hold, hooks);

  const parsedProfile: Profile = { id, identity, versions, idle, keys, collapse, reservedLeads, probe, hooks };
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
  const inputShown = textList(field(node, "inputShown", "hold"), "hold.inputShown", 1);
  const screenOnly = textList(field(node, "screenOnly", "hold"), "hold.screenOnly", 0);
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
  return { event, toolEvent, limitMs, hookTimeoutS, inputShown, inputDetails, screenOnly, options, decisions, decidedLine, deniedLine, denyMessage };
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
      if (!/^[A-Za-z]+(?::[a-z_]+)?$/.test(key)) fail(at, "must read Event or Event:detail");
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
  const profile = (options?.profiles ?? loadProfiles()).get(harness);
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
