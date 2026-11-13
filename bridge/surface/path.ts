// Which road one phone send takes (M99 spec 03, README decisions 5, 6, 8): the screen (the Send
// Protocol types it, as in 1.28.x) or data (the part inside the agent program takes it over the inside
// wire, `bridge/inside/WIRE.md`). One pure function, so the rule is read in one place.
//
// Data only when all of these hold, else the screen, unchanged:
//  - the inside wire is on for this instance (the kill switch, `COLLIE_INSIDE`);
//  - a part is bound to the pane and declares `send` and `wake`, or for a WalkyTalky delivery `mail`
//    and `wake` (wake is how the bridge knows a turn runs, so it can hold the send as today; a part
//    without it keeps the screen path);
//  - the request is a plain new message: mode `send`, not a steer, not from an agent view;
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
export type PathWhy = "data" | "off" | "no-part" | "not-declared" | "not-plain-mode" | "command" | "attachment" | "empty";

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

/** The road for one send. Pure. */
export function pickSendPath(input: PathInput): PathPick {
  if (!input.enabled) return screen("off");
  if (input.part === null) return screen("no-part");
  const { capabilities } = input.part;
  const { request } = input;
  const needs = request.mail ? DATA_MAIL_NEEDS : DATA_SEND_NEEDS;
  if (!needs.every((word) => capabilities.has(word))) return screen("not-declared");
  if (request.mode !== "send" || request.when !== undefined || request.fromView) return screen("not-plain-mode");
  if (request.text.trim() === "") return screen("empty");
  if (reservedLead(request.text, COMMAND_LEADS) !== null) return screen("command");
  if (hasUpload(request.text)) return screen("attachment");
  return { path: "data", why: "data" };
}
