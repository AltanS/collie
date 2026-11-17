// THE OPAQUE SESSION ID (M105 spec 03, decision 12). A caller of the event bus, the local API and a
// trick's trigger names an agent session by one id, `ses_<base64url>`, and never by a bare pane id: a
// multiplexer reuses a pane id once the pane closes, so the id carries the pane's WalkyTalky instance
// token as well (bridge/walky/instances.ts). A pane id taken over by a new session then makes a new id.
//
//   ses_ + base64url( "1" | machine | paneId | instance )
//
// The id holds what a WalkyTalky address holds (`<memberId>/<paneId>#<token>`, bridge/walky/address.ts)
// and nothing more. `1` is the version of the inside. `machine` is this bridge's stable id
// (bridge/bridge-id.ts), the same id a trick's facts carry. `instance` is four of `[a-z0-9]`. Every part
// is percent-encoded before the join, so a `|` in a part is `%7C` inside and never a separator.
//
// NO MUX SESSION NAME. A multiplexer session's name is chosen by the person, and the id rides in every
// event, decodable (decision 4), so it stays out. The instance token is what makes a pane id unique
// across the bridge's mux sessions: the registry never mints a token that another pane with the same
// pane id holds (WalkyInstances.mint). So a reader resolves an id as a WalkyTalky address resolves:
// it searches the sessions for the pane with that pane id AND that instance token.
//
// The id is opaque to a caller: it copies it from a list and hands it back. It is not a secret and not
// a proof of anything; it only names a pane instance. Decoding is strict, so one set of parts has
// exactly one id: the decoder re-encodes what it read and refuses any text that does not come back the
// same (another base64 spelling, a needless `%41` for `A`, padding).
//
// Pure: no imports from the bridge, no disk, no clock.

/** The parts of a session id. */
export interface SessionIdParts {
  readonly machine: string;
  readonly paneId: string;
  readonly instance: string;
}

/** The prefix every session id carries. */
export const SESSION_ID_PREFIX = "ses_";
/** The longest session id the codec reads or writes. */
export const SESSION_ID_MAX = 512;

const VERSION = "1";
const FIELDS = 4;
// The same shape as walky's INSTANCE_TOKEN (bridge/walky/address.ts). Kept here so this codec stays pure.
const INSTANCE = /^[a-z0-9]{4}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function validParts(parts: SessionIdParts): boolean {
  return parts.machine !== "" && parts.paneId !== "" && INSTANCE.test(parts.instance);
}

function inside(parts: SessionIdParts): string {
  return [VERSION, parts.machine, parts.paneId, parts.instance].map((part) => encodeURIComponent(part)).join("|");
}

/**
 * The session id of a pane instance. Throws on parts that cannot make an id (an empty part, an
 * instance token of the wrong shape, an id past {@link SESSION_ID_MAX}): those are the caller's bug.
 */
export function encodeSessionId(parts: SessionIdParts): string {
  if (!validParts(parts)) throw new TypeError("session id: every part must be set and the instance must be four of [a-z0-9]");
  const id = SESSION_ID_PREFIX + Buffer.from(inside(parts), "utf8").toString("base64url");
  if (id.length > SESSION_ID_MAX) throw new RangeError(`session id: longer than ${String(SESSION_ID_MAX)} characters`);
  return id;
}

function decodePart(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** The parts of a session id, or null for any text that is not exactly an id this codec writes. */
export function decodeSessionId(text: string): SessionIdParts | null {
  if (text.length > SESSION_ID_MAX || !text.startsWith(SESSION_ID_PREFIX)) return null;
  const body = text.slice(SESSION_ID_PREFIX.length);
  if (!BASE64URL.test(body)) return null;
  const raw = Buffer.from(body, "base64url");
  // Another spelling of the same bytes (trailing bits set, a length base64 cannot end on) is refused.
  if (raw.toString("base64url") !== body) return null;
  const joined = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  if (Buffer.from(joined, "utf8").compare(raw) !== 0) return null;
  const fields = joined.split("|");
  if (fields.length !== FIELDS || fields[0] !== VERSION) return null;
  const decoded = fields.map(decodePart);
  const [, machine, paneId, instance] = decoded;
  if (machine == null || paneId == null || instance == null) return null;
  const parts: SessionIdParts = { machine, paneId, instance };
  if (!validParts(parts)) return null;
  // One set of parts, one id: a needless escape or a raw character the encoder would escape is refused.
  if (inside(parts) !== joined) return null;
  return parts;
}
