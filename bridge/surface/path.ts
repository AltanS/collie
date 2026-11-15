// Which road one phone send takes (M99 spec 03, README decisions 5, 6, 8): the screen (the Send
// Protocol types it, as in 1.28.x) or data (the part inside the agent program takes it over the inside
// wire, `bridge/inside/WIRE.md`). One pure function, so the rule is read in one place.
//
// Data only when all of these hold, else the screen, unchanged:
//  - the inside wire is on for this instance (the kill switch, `COLLIE_INSIDE`);
//  - a part is bound to the pane and declares `send` and `wake`, or for a WalkyTalky delivery `mail`
//    and `wake` (wake is how the bridge knows a turn runs, so it can hold the send as today; a part
//    without it keeps the screen path);
//  - the request is a plain new message: mode `send`, not a steer, not from an agent view, not for a
//    sign-in field (that text goes into the field on screen, never to the part as a prompt);
//  - the text is plain: no reserved lead (`/`, `!`, `@`: a slash command, a shell line, a file
//    mention) and no uploaded image path anywhere in it (an attachment).
//
// Nothing here names a harness or a multiplexer.

import { pastePieces, isUploadImagePath } from "../../web/src/lib/upload-path.ts";
import { COMMAND_LEADS } from "../../web/src/lib/send-protocol.ts";
import { reservedLead, startsWithUploadPath, type SendMode, type SendWhen } from "../../web/src/lib/surface/send.ts";

/** The two roads. */
export type SendPath = "data" | "screen";

/** Why the pick fell where it did, for the log and the tests. Never shown on the phone. */
export type PathWhy = "data" | "off" | "no-part" | "not-declared" | "not-plain-mode" | "command" | "attachment" | "empty" | "secret";

/** What the pick reads about the pane's part: null when no part is bound. */
export interface PathPart {
  readonly capabilities: ReadonlySet<string>;
}

/** What the pick reads about the request. */
export interface PathRequest {
  readonly mode: SendMode;
  readonly text: string;
  readonly when?: SendWhen;
  /** Set for a send from an agent view. */
  readonly fromView: boolean;
  /** Set for a WalkyTalky delivery (`draftHolds`). */
  readonly mail: boolean;
  /** Set for a send into a sign-in field (`SendRequest.secret`): it goes into that field on screen, never to the part as a prompt. */
  readonly secret?: boolean;
}

export interface PathInput {
  /** The kill switch: the inside wire is on for this instance. */
  readonly enabled: boolean;
  readonly part: PathPart | null;
  readonly request: PathRequest;
}

/** The capabilities a part must declare for the data road: a phone send, and a WalkyTalky delivery (M99 spec 05). */
export const DATA_SEND_NEEDS = ["send", "wake"] as const;
export const DATA_MAIL_NEEDS = ["mail", "wake"] as const;

/** Whether a text carries one of Collie's uploaded image paths (an attachment). */
function hasUpload(text: string): boolean {
  // By paste piece (a path whose folders hold spaces) and by word (a path with text after it).
  return startsWithUploadPath(text) || pastePieces(text).some((piece) => isUploadImagePath(piece)) || text.split(/\s+/u).some((word) => isUploadImagePath(word));
}

/** The road the pick chose, and why. */
export interface PathPick {
  readonly path: SendPath;
  readonly why: PathWhy;
}

const screen = (why: PathWhy): PathPick => ({ path: "screen", why });

/** What the session half of the pick reads: the kill switch and the pane's part. */
export interface PathSession {
  readonly enabled: boolean;
  readonly part: PathPart | null;
}

/**
 * The session half of the pick (M99 spec 15): why this pane's sends take the screen whatever the request,
 * or null when its part can take one by data. `needs` is what the send needs, a phone send's by default.
 * Pure. {@link pickSendPath} asks it first, so the pane read's `linked` and the road cannot disagree.
 */
export function sessionRoad(session: PathSession, needs: readonly string[] = DATA_SEND_NEEDS): "off" | "no-part" | "not-declared" | null {
  if (!session.enabled) return "off";
  if (session.part === null) return "no-part";
  const { capabilities } = session.part;
  return needs.every((word) => capabilities.has(word)) ? null : "not-declared";
}

/**
 * Whether a pane is linked (M99 spec 15): the inside wire is on, and a live part of the pane declares
 * what a phone send needs. The pane read's `linked: true`. It does not promise every send: a command,
 * an attachment and a queued send still take the screen.
 */
export function isLinked(session: PathSession): boolean {
  return sessionRoad(session) === null;
}

/**
 * The one reader of "is this pane linked" for the whole bridge: the pane read's `linked`, the install
 * ping's trouble rows and its agent and multiplexer tally all call the function it returns, so none of
 * them can say linked for a pane the send pick would not send by data. No hub (the wire is not built):
 * never linked.
 */
export function paneLinkedReader(source: {
  readonly enabled: () => boolean;
  readonly hub: { partOf(address: { readonly session: string; readonly paneId: string }): PathPart | null } | null;
}): (session: string, paneId: string) => boolean {
  return (session, paneId) => source.hub !== null && isLinked({ enabled: source.enabled(), part: source.hub.partOf({ session, paneId }) });
}

/** The road for one send. Pure. */
export function pickSendPath(input: PathInput): PathPick {
  const { request } = input;
  const away = sessionRoad(input, request.mail ? DATA_MAIL_NEEDS : DATA_SEND_NEEDS);
  if (away !== null) return screen(away);
  if (request.secret === true) return screen("secret");
  if (request.mode !== "send" || request.when !== undefined || request.fromView) return screen("not-plain-mode");
  if (request.text.trim() === "") return screen("empty");
  if (reservedLead(request.text, COMMAND_LEADS) !== null) return screen("command");
  if (hasUpload(request.text)) return screen("attachment");
  return { path: "data", why: "data" };
}
