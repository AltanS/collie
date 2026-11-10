// The wire of Morph: a third view of an agent session beside Terminal and Chat. The agent answers a
// request by drawing ONE screen (`collie morph show <file.json>`), in the trick node vocabulary. The
// bridge, the CLI and the web app all import this file by relative path, so it holds types, constants
// and small pure, total readers only. No I/O, no React, no runtime dependency, no `@/` alias.
//
// A SESSION IS ITS WALKY ADDRESS. Morph names a session the way the hill names one (`about`, the
// poster's `from.address`): the walky address of the pane, a plain string. The bridge fills it from
// the local socket for the CLI, never from the request.
//
// A VIEW IS A TRICK PART'S VIEW. `parseMorphView` reads it with the trick parser's full part
// vocabulary (buttons allowed, the `VIEW_LIMITS` caps, a part's byte cap), not the display-only
// Decision reader, and holds it strictly: a node or an attribute the parser would only drop or ignore
// is refused here, so what the agent drew is what the phone draws.

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../json";
import { DOCUMENT_VERSION, parseTrickDocument, type Refusal, type View } from "../tricks/schema";

/** A Morph title, in characters. */
export const MORPH_TITLE_MAX = 80;
/** The hint line the phone appends to a request sent from Morph, in characters. */
export const MORPH_HINT_MAX = 200;
/** The longest session key the wire carries. */
export const MORPH_SESSION_MAX = 256;
/** The read route. `?since=<rev>` gives the short answer when nothing moved. */
export const MORPH_ROUTE = "/api/morph";
/** The switch route, a paired device's write. */
export const MORPH_SWITCH_ROUTE = "/api/morph/switch";

/** The screen the agent drew last for one session. */
export interface MorphView {
  /** Rises with every show for this session. */
  rev: number;
  /** ISO time of the show. */
  at: string;
  /** At most {@link MORPH_TITLE_MAX} characters, one line. */
  title?: string;
  /** A trick part's view, checked by {@link parseMorphView}. Buttons allowed. */
  view: View;
}

/** One session's Morph. */
export interface MorphSession {
  /** The session's walky address, the key the hill names a session with. */
  session: string;
  on: boolean;
  /** One line the phone appends to a request sent from Morph. The bridge owns the wording. */
  hint: string;
  /** The current view. Absent before the first show and after a clear. */
  view?: MorphView;
}

/** What `GET /api/morph[?since=<rev>]` answers. */
export interface MorphAnswer {
  /** The Morph revision. It also rides on the snapshot as `morphRev`. */
  rev: number;
  /** True when the caller's `since` equals `rev`. Then `sessions` is empty and means nothing. */
  unchanged?: true;
  sessions: MorphSession[];
}

/** What the phone sends to `POST /api/morph/switch`. */
export interface MorphSwitchBody {
  session: string;
  on: boolean;
}

/** What `parseMorphView` answers: the view when it passed, else every refusal with a pointer under `path`. */
export interface ParsedMorphView {
  view?: View;
  refusals: Refusal[];
}

const PROBE_PART_ID = "morph";
const PROBE_PREFIX = "/parts/0/view";

/** Map a refusal's pointer inside the probe document onto the caller's own `path`. */
function rebase(refusal: Refusal, path: string): Refusal {
  const inner = refusal.path.startsWith(PROBE_PREFIX) ? refusal.path.slice(PROBE_PREFIX.length) : "";
  return { code: refusal.code, path: `${path}${inner}`, reason: refusal.reason };
}

/**
 * Read a Morph view: a list of nodes in a trick part's vocabulary, under the part caps. Total: garbage
 * is a refusal, never a throw. Strict: what the tolerant trick read would drop or ignore is refused.
 * The view is read as the `view` of a session part in a one-part trick document, the parser's only
 * public way in, so every rule and cap is the trick parser's own.
 */
export function parseMorphView(raw: JsonValue | undefined, path = "/view"): ParsedMorphView {
  if (raw === undefined) return { refusals: [{ code: "missing", path, reason: 'A Morph screen needs "view": a list of nodes.' }] };
  const doc: JsonValue = { v: DOCUMENT_VERSION, parts: [{ at: "session", id: PROBE_PART_ID, view: raw }] };
  const parsed = parseTrickDocument(doc);
  const refusals = [...parsed.refusals, ...parsed.notes].map((r) => rebase(r, path));
  if (refusals.length > 0) return { refusals };
  const part = parsed.parts[0];
  if (part?.place !== "session") return { refusals: [{ code: "type", path, reason: "The view did not read as a screen." }] };
  return { view: part.part.view, refusals: [] };
}

/** One line, trimmed, no control character. Null when it is empty or longer than `max`. */
export function cleanMorphLine(text: string, max: number): string | null {
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
  return text !== undefined && cleanMorphLine(text, MORPH_SESSION_MAX) === text;
}

/** A stored or served view, or null when any field does not fit. */
export function readMorphView(raw: JsonValue | undefined): MorphView | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  const rev = asJsonNumber(obj.rev);
  const at = asJsonString(obj.at);
  if (!isRev(rev) || at === undefined || !isIsoTime(at)) return null;
  const parsed = parseMorphView(obj.view);
  if (parsed.view === undefined) return null;
  const out: MorphView = { rev, at, view: parsed.view };
  if (obj.title === undefined) return out;
  const title = asJsonString(obj.title);
  if (title === undefined || cleanMorphLine(title, MORPH_TITLE_MAX) !== title) return null;
  out.title = title;
  return out;
}

/**
 * One session, or null when its key, switch or hint does not fit. A view that does not fit is left out
 * and the session kept: the switch still reads, and the phone shows no screen rather than half of one.
 */
export function readMorphSession(raw: JsonValue | undefined): MorphSession | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  const session = asJsonString(obj.session);
  const on = asJsonBoolean(obj.on);
  const hint = asJsonString(obj.hint);
  if (!isSessionKey(session) || on === undefined || hint === undefined) return null;
  if (cleanMorphLine(hint, MORPH_HINT_MAX) !== hint) return null;
  const out: MorphSession = { session, on, hint };
  const view = obj.view === undefined ? null : readMorphView(obj.view);
  if (view !== null) out.view = view;
  return out;
}

/** The read route's answer, or null when its rev or list does not fit. A session that does not fit is dropped. */
export function readMorphAnswer(raw: JsonValue | undefined): MorphAnswer | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  const rev = asJsonNumber(obj.rev);
  if (!isRev(rev)) return null;
  if (obj.unchanged === true) return { rev, unchanged: true, sessions: [] };
  if (!Array.isArray(obj.sessions)) return null;
  const sessions: MorphSession[] = [];
  for (const item of obj.sessions) {
    const session = readMorphSession(item);
    if (session !== null) sessions.push(session);
  }
  return { rev, sessions };
}

/** The switch body, or null when it is not exactly `{ session, on }`. */
export function readMorphSwitchBody(raw: JsonValue | undefined): MorphSwitchBody | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  if (Object.keys(obj).some((key) => key !== "session" && key !== "on")) return null;
  const session = asJsonString(obj.session);
  const on = asJsonBoolean(obj.on);
  if (!isSessionKey(session) || on === undefined) return null;
  return { session, on };
}
