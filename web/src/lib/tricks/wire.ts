// THE TWO TRICKS REPLIES, READ ON THE PHONE (M94 slice 02).
//
// The bridge writes `TricksReply` and `TrickTapReply` from parts its own parser accepted, so these readers
// do not parse a part again. They check the frame: the fields the store keys on and merges by. A body
// of the wrong shape (an older bridge, a proxy's page) is refused whole rather than half applied, so
// the phone never holds a part it cannot key.
//
// NOT PARSING THE PART IS ON PURPOSE. A crew member on a newer Collie may send a node kind this phone
// does not know. The schema's parser would refuse that part; the renderer instead draws it as the
// placeholder ("this Collie cannot draw this part"), which is what the design asks for, and clamps a
// core node whose numbers are out of range.

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, type JsonObject, type JsonValue } from "../json";
import {
  ABOUT_MAX,
  ACCESS_LEVELS,
  ACCESS_UNKNOWN,
  DESCRIPTION_MAX,
  EVERY_MAX_MS,
  EVERY_MIN_MS,
  INPUTS_MAX,
  INPUT_GLOB_MAX,
  BOUND_SESSIONS_MAX,
  isHostName,
  isScopeKey,
  menuLabelProblem,
  MENU_ROW_KINDS,
  TRICK_ICONS,
  isTrickId,
  isImageSrc,
  isSourceUrl,
  isTrickText,
  NAME_MAX,
  OFFICIAL_STATES,
  PLACE_KINDS,
  RUN_MAX,
  rulesNameProblem,
  rulesTextProblems,
  TAP_CODES,
  TAP_REFUSALS,
  TRICK_EVENTS,
  TRICK_MEDIA_VERSION,
  TRICK_MEDIA_VERSIONS_MAX,
  TRICK_WARNINGS_MAX,
  VERSION_RE,
  readWireFields,
  WATCH_MAX,
  WATCH_PATH_MAX,
  type OfficialState,
  type PlaceKind,
  type TrickEvent,
  type TrickProvenance,
  type WireRepoFacts,
  type OfficialTricksReply,
  type MenuPart,
  type MenuRow,
  type WireBound,
  type TrickPart,
  type TrickTapReply,
  type TricksReply,
  type WireTrickRules,
  type TricksRunsOn,
  type TapCode,
  type TapRefusal,
  type WireTrickInfo,
  type WireTrickPart,
  type WireTrickPending,
  type WireTrickWarning,
  type WireOfficialTrick,
} from "./schema";

function asJsonArray(value: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** A part value the store can key and place: an object with a string `at` and a string `id`. */
function isPartValue(value: JsonObject): value is JsonObject & TrickPart {
  return asJsonString(value.at) !== undefined && asJsonString(value.id) !== undefined;
}

/** A trick entry the store can list: a host, an id, a name and the switch. */
function isTrickValue(value: JsonObject): value is JsonObject & WireTrickInfo {
  const keyed = asJsonString(value.host) !== undefined && asJsonString(value.id) !== undefined && asJsonString(value.name) !== undefined;
  return keyed && asJsonBoolean(value.on) !== undefined;
}

function readPart(raw: JsonValue | undefined): WireTrickPart | undefined {
  const part = asJsonObject(raw);
  if (part === undefined) return undefined;
  const host = asJsonString(part.host);
  const trick = asJsonString(part.trick);
  const id = asJsonString(part.part);
  const rev = asJsonNumber(part.rev);
  const value = asJsonObject(part.value);
  if (host === undefined || trick === undefined || id === undefined || rev === undefined || value === undefined) return undefined;
  if (!isPartValue(value)) return undefined;
  const out: WireTrickPart = { host, trick, part: id, rev, value: value.at === "menu" ? readMenuPart(value) : value };
  const asOf = asJsonString(part.asOf);
  if (asOf !== undefined) out.asOf = asOf;
  const fresh = asJsonString(part.fresh);
  if (fresh !== undefined) out.fresh = fresh;
  if (part.stale === true) out.stale = true;
  const problem = asJsonString(part.problem);
  if (problem !== undefined) out.problem = problem;
  // Contract 2: a bound part's sessions and instances. One that does not read is no part at all: drawn
  // without its binding it would show in every session.
  if (part.bound !== undefined) {
    const bound = readBound(part.bound);
    if (bound === undefined) return undefined;
    out.bound = bound;
  }
  return out;
}

/**
 * A menu part's rows as this phone draws them (contract 2): each read again (a kind, an id, an intent, a
 * label the label rule takes, an icon of the set, a switch's state). The bridge refused the rest
 * already; a row that does not read here (an older or a newer bridge) is left out, never drawn half.
 */
function readMenuPart(value: JsonObject): MenuPart {
  const rows: MenuRow[] = [];
  for (const raw of Array.isArray(value.rows) ? value.rows : []) {
    const row = readMenuRow(asJsonObject(raw));
    if (row !== undefined) rows.push(row);
  }
  return { at: "menu", id: asJsonString(value.id) ?? "", rows };
}

function readMenuRow(obj: JsonObject | undefined): MenuRow | undefined {
  if (obj === undefined) return undefined;
  const id = asJsonString(obj.id);
  const kindWord = asJsonString(obj.kind);
  const label = asJsonString(obj.label);
  const intent = asJsonString(obj.intent);
  const iconWord = asJsonString(obj.icon);
  const on = asJsonBoolean(obj.on);
  const kind = MENU_ROW_KINDS.find((word) => word === kindWord);
  const icon = TRICK_ICONS.find((word) => word === iconWord);
  if (id === undefined || kind === undefined || label === undefined || intent === undefined) return undefined;
  if (menuLabelProblem(label) !== undefined || (iconWord !== undefined && icon === undefined)) return undefined;
  if (kind === "switch" && on === undefined) return undefined;
  const row: MenuRow = { id, kind, label, intent };
  if (icon !== undefined) row.icon = icon;
  if (kind === "switch" && on !== undefined) row.on = on;
  if (obj.disabled === true) row.disabled = true;
  if (kind === "button" && obj.confirm === true) row.confirm = true;
  return row;
}

/** A walky instance token: four characters of [a-z0-9] (bridge/walky/address.ts `INSTANCE_TOKEN`). */
const INSTANCE_TOKEN = /^[a-z0-9]{4}$/u;

/** A bound part's `bound`: 1 to {@link BOUND_SESSIONS_MAX} of a scope key and an instance token, or undefined. */
function readBound(raw: JsonValue): WireBound[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > BOUND_SESSIONS_MAX) return undefined;
  const out: WireBound[] = [];
  for (const entry of raw) {
    const obj = asJsonObject(entry);
    const session = asJsonString(obj?.session);
    const instance = asJsonString(obj?.instance);
    if (session === undefined || !isScopeKey(session) || instance === undefined || !INSTANCE_TOKEN.test(instance)) return undefined;
    out.push({ session, instance });
  }
  return out;
}

function readParts(raw: JsonValue | undefined): WireTrickPart[] | undefined {
  const list = asJsonArray(raw);
  if (list === undefined) return undefined;
  const parts: WireTrickPart[] = [];
  for (const entry of list) {
    const part = readPart(entry);
    if (part === undefined) return undefined;
    parts.push(part);
  }
  return parts;
}

function readKeys(raw: JsonValue | undefined): string[] | undefined {
  const list = asJsonArray(raw);
  if (list === undefined) return undefined;
  const keys: string[] = [];
  for (const entry of list) {
    const key = asJsonString(entry);
    if (key === undefined) return undefined;
    keys.push(key);
  }
  return keys;
}

/**
 * A trick's warnings (review 15), read tolerantly: each `{ kind, text }` with two strings is kept, any
 * other entry is left out, at most `TRICK_WARNINGS_MAX`. A bridge that sends none (an older one) gives [].
 */
export function readWarnings(raw: JsonValue | undefined): WireTrickWarning[] {
  const out: WireTrickWarning[] = [];
  for (const entry of asJsonArray(raw) ?? []) {
    const warning = asJsonObject(entry);
    const kind = asJsonString(warning?.kind);
    const text = asJsonString(warning?.text);
    if (kind !== undefined && text !== undefined) out.push({ kind, text });
  }
  return out.slice(0, TRICK_WARNINGS_MAX);
}

/** A count of files on the wire: a whole number from 0. */
function readCount(raw: JsonValue | undefined): number | undefined {
  const n = asJsonNumber(raw);
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * A trick's waiting version (crew slice 2), read tolerantly: kept only with a hash, three counts and the
 * powers flag; its warnings are read like the row's. Anything else is left out, as from an older bridge.
 */
export function readPending(raw: JsonValue | undefined): WireTrickPending | undefined {
  const body = asJsonObject(raw);
  const files = asJsonObject(body?.files);
  const hash = asJsonString(body?.hash);
  const powersChanged = asJsonBoolean(body?.powersChanged);
  const added = readCount(files?.added);
  const changed = readCount(files?.changed);
  const removed = readCount(files?.removed);
  if (body === undefined || hash === undefined || powersChanged === undefined || added === undefined || changed === undefined || removed === undefined) return undefined;
  return { hash, files: { added, changed, removed }, powersChanged, warnings: readWarnings(body.warnings) };
}

/**
 * What a trick's inputs read (contract 2), read tolerantly: kept only with 1 to `INPUTS_MAX` globs, each a
 * string of at most `INPUT_GLOB_MAX` characters, and the crew flag. Anything else is left out, as from an
 * older bridge.
 */
export function readInputs(raw: JsonValue | undefined): WireTrickInfo["inputs"] {
  const body = asJsonObject(raw);
  const crew = asJsonBoolean(body?.crew);
  const list = asJsonArray(body?.globs);
  if (crew === undefined || list === undefined || list.length === 0 || list.length > INPUTS_MAX) return undefined;
  const globs: string[] = [];
  for (const entry of list) {
    const glob = asJsonString(entry);
    if (glob === undefined || glob === "" || [...glob].length > INPUT_GLOB_MAX) return undefined;
    globs.push(glob);
  }
  return { globs, crew };
}

/** A trick's `on` events, read tolerantly: 1 to every event word once, each a word this phone knows. Anything else is left out. */
export function readEvents(raw: JsonValue | undefined): TrickEvent[] | undefined {
  const list = asJsonArray(raw);
  if (list === undefined || list.length === 0 || list.length > TRICK_EVENTS.length) return undefined;
  const events: TrickEvent[] = [];
  for (const entry of list) {
    const word = asJsonString(entry);
    const known = TRICK_EVENTS.find((event) => event === word);
    if (known === undefined) return undefined;
    events.push(known);
  }
  return events;
}

/** A trick's `watch` paths, read tolerantly: 1 to `WATCH_MAX` strings of at most `WATCH_PATH_MAX` characters. Anything else is left out. */
export function readWatch(raw: JsonValue | undefined): string[] | undefined {
  const list = asJsonArray(raw);
  if (list === undefined || list.length === 0 || list.length > WATCH_MAX) return undefined;
  const paths: string[] = [];
  for (const entry of list) {
    const path = asJsonString(entry);
    if (path === undefined || path === "" || [...path].length > WATCH_PATH_MAX) return undefined;
    paths.push(path);
  }
  return paths;
}

/**
 * A trick's `description` or `about`, read tolerantly: kept only as a string within its cap with no control
 * or invisible character. Anything else is left out, as from an older bridge. `about` may hold line breaks.
 */
export function readTrickText(raw: JsonValue | undefined, kind: "description" | "about"): string | undefined {
  const text = asJsonString(raw);
  if (text === undefined) return undefined;
  const rule = kind === "about" ? { max: ABOUT_MAX, multiline: true } : { max: DESCRIPTION_MAX };
  return isTrickText(text, rule) ? text : undefined;
}

/**
 * A trick's rules (contract 2), read tolerantly: kept only when the file's name passes the manifest's own
 * rule and the text passes the content rule again (printable ASCII and line breaks, at most 8 KiB, short
 * lines), so the phone never draws a text the bridge should have refused. Anything else is left out.
 */
export function readTrickRules(raw: JsonValue | undefined): WireTrickRules | undefined {
  const body = asJsonObject(raw);
  const file = asJsonString(body?.file);
  const text = asJsonString(body?.text);
  if (file === undefined || text === undefined || rulesNameProblem(file) !== undefined) return undefined;
  return rulesTextProblems(new TextEncoder().encode(text)).length === 0 ? { file, text } : undefined;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

/**
 * A repository's facts (bridge/tricks/repo-facts.ts), read as the bridge checked them: a whole number of stars,
 * 0 or more, and an ISO instant in UTC. Only those two fields are kept; anything else leaves the facts out.
 */
export function readRepoFacts(raw: JsonValue | undefined): WireRepoFacts | undefined {
  const body = asJsonObject(raw);
  const stars = asJsonNumber(body?.stars);
  const pushedAt = asJsonString(body?.pushedAt);
  if (stars === undefined || !Number.isSafeInteger(stars) || stars < 0) return undefined;
  if (pushedAt === undefined || !ISO_UTC.test(pushedAt) || !Number.isFinite(Date.parse(pushedAt))) return undefined;
  return { stars, pushedAt };
}

/** A provenance with its `url` kept only when it is a link the sheet may draw. */
function readProvenance(raw: TrickProvenance): TrickProvenance {
  if (raw.url === undefined) return raw;
  const url = asJsonString(raw.url);
  if (url !== undefined && isSourceUrl(url)) return raw;
  const { url: _dropped, ...rest } = raw;
  return rest;
}

/** A row's settings (contract 3): the fields and values held to their rules, and the two flags as true or absent. */
function readTrickFields(asked: JsonValue | undefined, kept: JsonValue | undefined, setup: true | undefined, unread: true | undefined): Pick<WireTrickInfo, "fields" | "values" | "needsSetup" | "valuesUnread"> {
  const read = readWireFields(asked, kept);
  if (read === undefined) return {};
  const out: Pick<WireTrickInfo, "fields" | "values" | "needsSetup" | "valuesUnread"> = { fields: read.fields };
  if (Object.keys(read.values).length > 0) out.values = read.values;
  if (setup !== undefined) out.needsSetup = true;
  if (unread !== undefined) out.valuesUnread = true;
  return out;
}

/** A row's `media` map: the entries whose name is an image `src` and whose version is 12 hex, at most `TRICK_MEDIA_VERSIONS_MAX`. Undefined when none is left. */
export function readMediaVersions(raw: JsonValue | undefined): Record<string, string> | undefined {
  const body = asJsonObject(raw);
  if (body === undefined) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [src, value] of Object.entries(body)) {
    const version = asJsonString(value);
    if (version === undefined || !TRICK_MEDIA_VERSION.test(version) || !isImageSrc(src)) continue;
    if (count === TRICK_MEDIA_VERSIONS_MAX) break;
    out[src] = version;
    count += 1;
  }
  return count === 0 ? undefined : out;
}

/** One trick entry as the list and the switch route give it, or `undefined` for a body of another shape. */
export function readTrick(raw: JsonValue | undefined): WireTrickInfo | undefined {
  // The closed words (`icon`, `state`, `places`) were written by the bridge from the schema's lists; the
  // renderer falls back on an icon it does not know, and a state it does not know reads as ok.
  const body = asJsonObject(raw);
  if (body === undefined) return undefined;
  // Read as JSON before the frame check narrows the body to the wire type.
  const sent = body.warnings;
  const waiting = body.pending;
  const reads = body.inputs;
  const described = body.description;
  const told = body.about;
  const auto = asJsonBoolean(body.auto);
  const autoAt = asJsonString(body.autoAt);
  const viewed = body.agentView;
  const approving = body.approves;
  const ruled = body.rules;
  const versioned = body.version;
  const known = body.repoFacts;
  const replying = body.decidesReply;
  const drafting = body.draftsSession;
  const pictured = body.media;
  const running = body.run;
  const ticking = body.everyMs;
  const asked = body.fields;
  const kept = body.values;
  const setup = asJsonBoolean(body.needsSetup) === true ? true : undefined;
  const unread = asJsonBoolean(body.valuesUnread) === true ? true : undefined;
  const reacting = body.events;
  const watching = body.watch;
  const leveled = body.access;
  const accessOff = body.accessOff;
  if (!isTrickValue(body)) return undefined;
  if (body.provenance !== undefined) body.provenance = readProvenance(body.provenance);
  if (sent === undefined && waiting === undefined && reads === undefined && body.auto === undefined && body.autoAt === undefined && described === undefined && told === undefined && viewed === undefined && ruled === undefined && body.rulesUnshown === undefined && approving === undefined && versioned === undefined && known === undefined && replying === undefined && drafting === undefined && pictured === undefined && running === undefined && ticking === undefined && reacting === undefined && watching === undefined && leveled === undefined && accessOff === undefined && asked === undefined && kept === undefined && setup === undefined && unread === undefined) return body;
  // The fields read past the frame: the Tricks card lists them, so their shapes are held here. One of
  // another shape is left out, as from an older bridge.
  const warnings = readWarnings(sent);
  const pending = readPending(waiting);
  const inputs = readInputs(reads);
  const description = readTrickText(described, "description");
  const about = readTrickText(told, "about");
  const rules = readTrickRules(ruled);
  const { warnings: _sent, pending: _waiting, auto: _auto, autoAt: _autoAt, inputs: _reads, description: _described, about: _told, agentView: _viewed, rules: _ruled, rulesUnshown: _unshown, approves: _approves, version: _versioned, repoFacts: _known, decidesReply: _replying, draftsSession: _drafting, media: _pictured, run: _running, everyMs: _ticking, events: _reacting, watch: _watching, access: _leveled, accessOff: _accessOff, fields: _asked, values: _kept, needsSetup: _setup, valuesUnread: _unread, ...rest } = body;
  const out: WireTrickInfo = warnings.length === 0 ? rest : { ...rest, warnings };
  if (pending !== undefined) out.pending = pending;
  if (inputs !== undefined) out.inputs = inputs;
  const events = readEvents(reacting);
  if (events !== undefined) out.events = events;
  const watch = readWatch(watching);
  if (watch !== undefined) out.watch = watch;
  // The declared level of the local API (M105 spec 04): one of two words this phone knows. Any other text is a
  // level of a newer bridge: kept as `unknown`, so the row says it and offers no switch on (review 3, item 4).
  const level = ACCESS_LEVELS.find((word) => word === leveled) ?? ((asJsonString(leveled) ?? "") === "" ? undefined : ACCESS_UNKNOWN);
  if (level !== undefined) out.access = level;
  if (accessOff === true && level !== undefined) out.accessOff = true;
  if (description !== undefined) out.description = description;
  if (about !== undefined) out.about = about;
  if (auto !== undefined) out.auto = auto;
  if (autoAt !== undefined && Number.isFinite(Date.parse(autoAt))) out.autoAt = autoAt;
  if (viewed === true) out.agentView = true;
  // Declared in the manifest of what runs: its Decisions may answer into a session (the token label reads it).
  if (replying === true) out.decidesReply = true;
  // Declared in the manifest of what runs: its buttons may put text into a reply box (the About sheet's line, the draft button).
  if (drafting === true) out.draftsSession = true;
  // The versions of the trick's pictures: only a name the image rule takes with a 12 hex version is kept, so an older or newer bridge reads as none.
  const media = readMediaVersions(pictured);
  if (media !== undefined) out.media = media;
  const approves = asJsonString(approving);
  if (approves !== undefined && /^[0-9a-f]{64}$/u.test(approves)) out.approves = approves;
  if (rules !== undefined) out.rules = rules;
  const version = asJsonString(versioned);
  if (version !== undefined && VERSION_RE.test(version)) out.version = version;
  const facts = readRepoFacts(known);
  if (facts !== undefined) out.repoFacts = facts;
  // The run line and the timer, read as the manifest holds them: one line of printable text within RUN_MAX,
  // and a whole number of milliseconds within the timer's bounds. Anything else is left out, as from an older bridge.
  const run = asJsonString(running);
  if (run !== undefined && isTrickText(run, { max: RUN_MAX })) out.run = run;
  const every = asJsonNumber(ticking);
  if (every !== undefined && Number.isSafeInteger(every) && every >= EVERY_MIN_MS && every <= EVERY_MAX_MS) out.everyMs = every;
  Object.assign(out, readTrickFields(asked, kept, setup, unread));
  // Review 8 V-N5: rules that were sent but do not read, or an agent view that came without them, are kept
  // as a state of their own, never dropped: the trick cannot be switched on from this phone.
  if (rules === undefined && (ruled !== undefined || viewed === true)) out.rulesUnshown = true;
  // A trick with rules never takes changes without asking: an older switch file that says so reads as off.
  if ((out.rules !== undefined || out.rulesUnshown === true || out.agentView === true) && out.auto === true) out.auto = false;
  return out;
}

/** `GET /api/tricks?since=` as the store merges it, or `undefined` for a body of another shape. */
export function readTricksReply(raw: JsonValue | undefined): TricksReply | undefined {
  const body = asJsonObject(raw);
  if (body === undefined) return undefined;
  const rev = asJsonNumber(body.rev);
  const parts = readParts(body.parts);
  const present = readKeys(body.present);
  const list = asJsonArray(body.tricks);
  if (rev === undefined || parts === undefined || present === undefined || list === undefined) return undefined;
  const tricks: WireTrickInfo[] = [];
  for (const entry of list) {
    const trick = readTrick(entry);
    if (trick === undefined) return undefined;
    tricks.push(trick);
  }
  const reply: TricksReply = { rev, tricks, parts, present };
  const runsOn = readRunsOn(body.runsOn);
  if (runsOn !== undefined) reply.runsOn = runsOn;
  // The Windows gate: a word of another shape is left out, so an older or newer bridge reads as ungated.
  if (body.gate === "windows") reply.gate = "windows";
  // Tricks switched off as a whole: only the word `true` counts, so a value of another shape reads as on.
  if (body.off === true) reply.off = true;
  return reply;
}

/**
 * Where a bridge that runs no tricks says they run, read tolerantly: a word of another shape is left
 * out and the reply kept, and a lead that is no host name reads as not known (`{}`).
 */
function readRunsOn(raw: JsonValue | undefined): TricksRunsOn | undefined {
  const body = asJsonObject(raw);
  if (body === undefined) return undefined;
  const lead = asJsonString(body.lead);
  return lead !== undefined && isHostName(lead) ? { lead } : {};
}

function isOfficialState(text: string | undefined): text is OfficialState {
  return OFFICIAL_STATES.some((state) => state === text);
}

/** The places of an official entry this phone draws, each once, in the list's order; any other word is left out. */
function readOfficialPlaces(raw: JsonValue | undefined): PlaceKind[] {
  const list = asJsonArray(raw) ?? [];
  const out: PlaceKind[] = [];
  for (const value of list.slice(0, PLACE_KINDS.length)) {
    const word = asJsonString(value);
    const kind = PLACE_KINDS.find((place) => place === word);
    if (kind !== undefined && !out.includes(kind)) out.push(kind);
  }
  return out;
}

/** One entry of the official list, or `undefined` when a field is of another shape. */
function readOfficialTrick(raw: JsonValue | undefined): WireOfficialTrick | undefined {
  const body = asJsonObject(raw);
  if (body === undefined) return undefined;
  const id = asJsonString(body.id);
  const name = asJsonString(body.name);
  const description = readTrickText(body.description, "description");
  const repo = asJsonString(body.repo);
  const repoName = asJsonString(body.repoName);
  const commit = asJsonString(body.commit);
  const state = asJsonString(body.state);
  if (id === undefined || !isTrickId(id) || name === undefined || !isTrickText(name, { max: NAME_MAX })) return undefined;
  if (description === undefined || repo === undefined || repoName === undefined || !isTrickText(repoName, { max: NAME_MAX * 2 })) return undefined;
  if (commit === undefined || !/^[0-9a-f]{40}$/u.test(commit) || !isOfficialState(state)) return undefined;
  const out: WireOfficialTrick = { id, name, description, repo, repoName, commit, state };
  if (body.unlisted === true && state === "taken") out.unlisted = true;
  if (body.changed === true && state === "taken") out.changed = true;
  if (body.givesRules === true) out.givesRules = true;
  if (body.addsMenu === true) out.addsMenu = true;
  const facts = readRepoFacts(body.repoFacts);
  if (facts !== undefined) out.repoFacts = facts;
  const places = readOfficialPlaces(body.places);
  if (places.length > 0) out.places = places;
  if (body.agentView === true) out.agentView = true;
  if (body.decidesReply === true) out.decidesReply = true;
  return out;
}

/**
 * `GET /api/tricks/official` (the official list), or `undefined` for a body of another shape. An entry
 * of another shape is left out and the rest kept: the list only offers, so one odd entry hides itself.
 */
export function readOfficialTricksReply(raw: JsonValue | undefined): OfficialTricksReply | undefined {
  const body = asJsonObject(raw);
  const list = asJsonArray(body?.tricks);
  if (body === undefined || list === undefined) return undefined;
  const tricks = list.map(readOfficialTrick).filter((entry) => entry !== undefined);
  const reply: OfficialTricksReply = { tricks };
  const runsOn = readRunsOn(body.runsOn);
  if (runsOn !== undefined) reply.runsOn = runsOn;
  if (body.gate === "windows") reply.gate = "windows";
  return reply;
}

/** The answer to an add or an update from the list: `{ id, state }`, or `undefined`. */
export function readOfficialAddReply(raw: JsonValue | undefined): { id: string; state: OfficialState } | undefined {
  const body = asJsonObject(raw);
  const id = asJsonString(body?.id);
  const state = asJsonString(body?.state);
  return id === undefined || !isOfficialState(state) ? undefined : { id, state };
}

function isTapCode(text: string | undefined): text is TapCode {
  return TAP_CODES.some((code) => code === text);
}

function isTapRefusal(text: string | undefined): text is TapRefusal {
  return TAP_REFUSALS.some((word) => word === text);
}

/**
 * A tap's receipt, or `undefined` when the body is not one. A refusal may come back on a non-2xx
 * status with a receipt in it, so the transport hands every body here before it throws.
 */
export function readTapReply(raw: JsonValue | undefined): TrickTapReply | undefined {
  const body = asJsonObject(raw);
  if (body === undefined) return undefined;
  const rid = asJsonString(body.rid);
  const code = asJsonString(body.code);
  if (rid === undefined || !isTapCode(code)) return undefined;
  const reply: TrickTapReply = { rid, code };
  const message = asJsonString(body.message);
  if (message !== undefined) reply.message = message;
  // A word a later bridge adds is no refusal this phone can name: the receipt still reads, without it.
  const refused = asJsonString(body.refused);
  if (isTapRefusal(refused)) reply.refused = refused;
  const rev = asJsonNumber(body.rev);
  if (rev !== undefined) reply.rev = rev;
  if (body.parts !== undefined) {
    const parts = readParts(body.parts);
    if (parts === undefined) return undefined;
    reply.parts = parts;
  }
  if (body.present !== undefined) {
    const present = readKeys(body.present);
    if (present === undefined) return undefined;
    reply.present = present;
  }
  return reply;
}
