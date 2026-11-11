// The local walky talky channel (M62 README, "The local channel"): `<stateDir>/walky/sock`, mode
// 0600 in a 0700 folder, served by the bridge, the pattern of bridge/surface/hold.ts. One JSON
// request line per connection, one JSON answer line, then the bridge closes it. The CLI carries no
// token: the socket's mode is the credential, as the hold socket's is.
//
// Requests (`v: 1`, plus `markers`: the raw multiplexer markers the CLI read from its environment):
//   send    { id, to, body, replyTo, wake?, outside? }   → { ok, receipts, target? }
//   inbox   { all, ack, id? }           → { ok, pane, messages }   (`id`: that one message)
//   who     {}                          → { ok, self, ownSpace?, targets, note?, selfOff? }   (`ownSpace`: the asking pane's space, M98)
//   status  { id }                      → { ok, receipts, message, elsewhere, deliveries?, totals? }
//   ack     { ids | null }              → { ok, acked }
//   cancel  { id }                      → { ok, results }   (M62 spec 03: the sender takes a held message back)
//   off     {}                          → { ok, off }       (M89: the asker's own pane turns its walky talky off)
//   on      {}                          → { ok, off }       (M89: and on again)
//   pane    {}                          → { ok, agent }     (crew slice 3: whether the asking pane runs an
//                                                            agent; `collie trick on` asks it before it refuses)
// The hill (M96), four operations beside these, answered only by a bridge built with it:
//   hill.post     { requestId, title, summary, ... } → { ok, decision } | { ok: false, error, code }
//   hill.status   { id }                       → { ok, decision }   (the poster, and the session its replyTo names)
//   hill.withdraw { id }                       → { ok, decision }   (now `withdrawn`, "by the poster")
//   hill.list     { mine: true }               → { ok, decisions }  (the asker's own, open first)
//   hill.clear    {}                           → { ok, cleared }    (every closed decision; no pane needed, never an open one)
//   hill.state    { state? }                   → { ok, crewState }  (1.29.0: a read for anyone, from anywhere; on a
//                                                                     member the lead's. With `state` a person's write,
//                                                                     refused from an agent's pane, and on a member)
//   hill.spoken.clear {}                       → { ok, cleared }    (1.29.0: withdraw and clear the open cards answered
//                                                                     in the session; types nothing; refused from an
//                                                                     agent's pane, and on a member)
// A trick handed to the lead (crew slice 8), answered only by a bridge built with it:
//   trick.propose { requestId, files }        → { ok, kind, id, hash, decision, replaced } | { ok: false, error, code, propose: true }
//     From an agent's pane the proposer is that session; from a bare shell or with no markers, a terminal.
//     Its line may be up to PROPOSE_LINE_MAX when it opens with PROPOSE_LINE_PREFIX, read within
//     PROPOSE_LINE_MS, at most PROPOSE_LINES_MAX such lines at once.
// Every hill refusal carries `hill: true`, so the CLI tells a bridge that knows the hill from an older one.
// Morph, six operations beside these, answered only by a bridge built with it, always for the asking
// pane's own session (bridge/morph/service.ts). Every one MAY carry `session` (the address the caller
// names); the bridge refuses `wrong_session` unless it is the session the markers placed.
//   morph.start   { note?, rules? } → { ok, morph } | { ok: false, error, code }   (rules: the rules id the session holds; another id is no refusal)
//   morph.show    { view, title?, images?: [{ path, caption? }], choice? }  → { ok, morph } | { ok: false, error, code, refusals? }
//   morph.clear | morph.on | morph.off | morph.status  {}  → { ok, morph }
//   morph.set     { id, node, after? | first?, images? }   → { ok, morph } | { ok: false, error, code, refusals? }
//   morph.pending { id, label, after? | first? }           → the same
//   morph.remove  { id }                                    → the same
//   morph.keep    { ids: [...] } | { all: true }            → the same ("choice" names the decision block)
//   morph.choice  { choice } | { clear: true }              → the same
// Every Morph refusal carries `morph: true`, as the hill's carry `hill: true`.
// On a crew member from 1.29.0 the four go to the lead, which holds the one Hill (CREW_PROTOCOL §22).
// A refusal is `{ ok: false, error }`. `not here` means the markers name no pane of this bridge, so
// the CLI asks the next bridge on the machine; a request this bridge cannot read answers the same when
// its markers name no pane here, else `bad request: <reason>` (refusals.ts). A send with no markers
// at all is refused: the operator sends from a paired device, never from this socket.

import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { once } from "node:events";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";

import type { BeaconMatcher } from "../beacon/decorate.ts";
import type { BeaconMarker } from "../beacon/types.ts";
import { HOST, type Host } from "../host.ts";
import type { HillCrewState, HillCrewStateView, HillDecision, HillRefusalCode } from "../../web/src/lib/hill/wire.ts";
import type { HillService } from "../hill/service.ts";
import type { LocalProposer } from "../tricks/propose-door.ts";
import type { ProposeAnswer } from "../tricks/proposals.ts";
import { PROPOSE_TOO_MANY_PARTS, proposalParseable, type ProposeRefusalCode } from "../tricks/propose-wire.ts";
import type { JsonObject } from "../json.ts";
import { readChoiceFields, readKeepFields, readPendingFields, readRemoveFields, readSetFields } from "../morph/blocks.ts";
import { readShowFields, readStartFields, sameSession, wrongSessionWords, type MorphRefusalCode, type MorphService } from "../morph/service.ts";
import type { MorphSession } from "../../web/src/lib/morph/wire.ts";
import type { Refusal } from "../../web/src/lib/tricks/schema.ts";
import { isHillOp, isMorphOp, PROPOSE_LINE_MAX, PROPOSE_LINE_PREFIX, readWalkyRequest, WALKY_LINE_MAX, type MorphOp, type WalkyRequest, type WalkyRequestRead } from "./parse.ts";
import { unknownOp } from "./refusals.ts";
import type { WalkyDelivery, WalkyService } from "./service.ts";
import type { TakeBack, WalkyPane } from "./deliver.ts";
import type { WalkySpace } from "./space.ts";
import type { WalkyEntry, WalkyMessage, WalkyReceipt, WalkyTarget } from "./types.ts";

/** What the socket answers a send that names no pane. */
export const SEND_NEEDS_A_PANE = "run this inside a pane, or send from the phone";
/** What the socket answers a cancel that names no pane: an operator's message is cancelled on the phone. */
export const CANCEL_NEEDS_A_PANE = "run this inside the pane that sent it, or cancel from the phone";
/** What the socket answers `off` or `on` from outside an agent pane: the flag is the asker's own (M89). */
export const SWITCH_NEEDS_A_PANE = "run this inside an agent pane";
/** What the socket answers a hill operation from outside an agent pane (M96): a decision belongs to a session. */
export const HILL_NEEDS_A_PANE = "run this inside an agent's pane: a decision belongs to the session that posts it";

/** What the socket answers a Morph operation from outside an agent pane: a screen belongs to a session. */
export const MORPH_NEEDS_A_PANE = "run this inside an agent's pane: a Morph screen belongs to the session that draws it";

/** What the socket needs of Morph. Absent: the bridge answers the five operations as unknown. */
export type MorphSocket = Pick<MorphService, "start" | "show" | "clear" | "setOn" | "status" | "set" | "pending" | "remove" | "keep" | "setChoice">;

/**
 * What the socket needs of the hill (M96). Absent: the bridge answers the four operations as unknown. The
 * `ask` calls answer from this bridge, or on a crew member from its lead (CREW_PROTOCOL §22).
 */
export type HillSocket = Pick<HillService, "agentSender" | "postFields" | "askStatus" | "askWithdraw" | "askList" | "clear" | "askCrewState" | "setCrewState" | "clearSpoken">;

/** The socket of one state dir. */
export function walkySocketPath(stateDir: string): string {
  return join(stateDir, "walky", "sock");
}

/** How long the server waits for the request line. */
export const REQUEST_LINE_MS = 2000;
/** How long the server waits for a whole `trick.propose` line, up to 8 MB from a local process. */
export const PROPOSE_LINE_MS = 30_000;
/** How many `trick.propose` lines are read at once; one more is turned away unread. */
export const PROPOSE_LINES_MAX = 2;

/** What the socket needs of the proposals (crew slice 8, bridge/tricks/propose-door.ts). */
export interface ProposeSocket {
  local(fields: JsonObject, who: LocalProposer): Promise<ProposeAnswer>;
}

/** The pane the markers name: a session and a pane id. The service then reads its instance. */
export interface PlacedPane {
  readonly session: string;
  readonly paneId: string;
}

/** One terminal session, as the socket places a marker on it (an edge target's three fields). */
export interface PlaceTarget {
  readonly session: string;
  readonly matcher: BeaconMatcher;
  paneIds(): readonly string[];
}

/**
 * The one pane the markers name, across every session, or null. Exactly one pane must match, as an
 * edge is placed (bridge/surface/edges.ts `placeEdge`), without the pid check: the CLI is not the
 * agent's process, and a local process could lie about its pane anyway (decision 4).
 */
export async function placeMarkers(markers: readonly BeaconMarker[], targets: readonly PlaceTarget[]): Promise<PlacedPane | null> {
  const hits: PlacedPane[] = [];
  for (const target of targets) {
    const own = markers.filter((marker) => marker.namespace === target.matcher.namespace);
    if (own.length === 0) continue;
    const scope = await target.matcher.scope().catch(() => null);
    if (scope === null) continue;
    for (const paneId of target.paneIds()) {
      if (own.some((marker) => target.matcher.matches({ paneId }, marker, scope))) hits.push({ session: target.session, paneId });
    }
  }
  return hits.length === 1 ? hits[0]! : null;
}

export interface WalkyServerDeps {
  readonly socketPath: string;
  readonly host?: Host;
  readonly service: WalkyService;
  targets(): readonly PlaceTarget[];
  readonly log?: (line: string) => void;
  /** How long a `trick.propose` line may take to arrive. Default {@link PROPOSE_LINE_MS}; a test passes a short one. */
  readonly proposeLineMs?: number;
  /** The hill (M96). Absent: its operations are answered as an older bridge answers them. */
  readonly hill?: HillSocket;
  /** Morph. Absent: its operations are answered as an older bridge answers them. */
  readonly morph?: MorphSocket;
  /** `collie trick propose` (crew slice 8). Absent: the op is answered as unknown. */
  readonly propose?: ProposeSocket;
}

/** What one request is answered with. */
export type WalkyAnswer =
  | { readonly ok: false; readonly error: string; readonly missing?: string }
  | { readonly ok: true; readonly receipts: readonly WalkyReceipt[]; readonly target?: WalkyTarget }
  | {
      readonly ok: true;
      readonly receipts: readonly WalkyReceipt[];
      readonly message: WalkyMessage | null;
      readonly elsewhere: readonly string[];
      /** A scope send (M75): one line per delivery and the parent's totals. Absent for any other address. */
      readonly deliveries?: readonly WalkyDelivery[];
      readonly totals?: Readonly<Record<string, number>>;
    }
  | { readonly ok: true; readonly self: string | null; readonly ownSpace?: WalkySpace; readonly targets: readonly WalkyTarget[]; readonly note?: string; readonly selfOff?: true }
  | { readonly ok: true; readonly pane: string | null; readonly messages: readonly WalkyEntry[] }
  | { readonly ok: true; readonly acked: number }
  | { readonly ok: true; readonly off: boolean }
  | { readonly ok: true; readonly agent: boolean; readonly session: string; readonly paneId: string }
  | { readonly ok: true; readonly results: readonly TakeBack[] }
  // The hill (M96).
  | { readonly ok: false; readonly error: string; readonly hill: true; readonly code?: HillRefusalCode; readonly missing?: string }
  | { readonly ok: true; readonly decision: HillDecision; readonly crewState?: HillCrewState }
  | { readonly ok: true; readonly decisions: readonly HillDecision[] }
  | { readonly ok: true; readonly crewState: HillCrewStateView }
  | { readonly ok: true; readonly cleared: number }
  // A trick proposal (crew slice 8).
  | { readonly ok: true; readonly kind: "proposal" | "version"; readonly id: string; readonly hash: string; readonly decision: string | null; readonly replaced: string | null }
  | { readonly ok: false; readonly error: string; readonly code: ProposeRefusalCode; readonly propose: true }
  // Morph.
  | { readonly ok: false; readonly error: string; readonly morph: true; readonly code?: MorphRefusalCode; readonly refusals?: readonly Refusal[] }
  | { readonly ok: true; readonly morph: MorphSession };

/**
 * A bridge that knows the pane but holds no message with the id (added 2026-10-30). It answers `not here`,
 * so the CLI asks the next bridge, a machine can run two Collies on one multiplexer and either may hold
 * the message, and carries the sentence the CLI prints when no bridge held it in `missing`.
 */
export function noMessageHere(sentence: string): WalkyAnswer {
  return { ok: false, error: "not here", missing: sentence };
}

/** Answer one parsed request. Exported for its test: the server only frames it. */
export async function answerRequest(
  service: WalkyService,
  request: WalkyRequest,
  targets: readonly PlaceTarget[],
  hill?: HillSocket,
  morph?: MorphSocket,
  propose?: ProposeSocket,
): Promise<WalkyAnswer> {
  // A bridge built without the hill answers its operations as it answers any op it does not know.
  if (hill === undefined && isHillOp(request.op)) return answerUnread(service, { ok: false, markers: request.markers, reason: unknownOp(request.op) }, targets);
  // And so does a bridge built without Morph.
  if (morph === undefined && isMorphOp(request.op)) return answerUnread(service, { ok: false, markers: request.markers, reason: unknownOp(request.op) }, targets);
  // Clear is the person's verb from a terminal: it names no pane, so the markers are not placed.
  if (request.op === "hill.clear" && hill !== undefined) return answerClear(hill);
  // The crew state: a read names no pane; a write only looks at the pane to refuse an agent's.
  if (request.op === "hill.state" && hill !== undefined) return await answerCrewState(service, request, targets, hill);
  if (request.op === "hill.spoken.clear" && hill !== undefined) return await answerSpokenClear(service, request.markers, targets, hill);
  const placed = request.markers.length === 0 ? null : await placeMarkers(request.markers, targets);
  const notHere = notHereFor(request.op, hill !== undefined, morph !== undefined);
  if (request.markers.length > 0 && placed === null) return notHere;
  const pane = placed === null ? null : service.paneAt(placed.session, placed.paneId);
  if (placed !== null && pane === null) return notHere;
  switch (request.op) {
    case "send": {
      // The kind fails closed: a send names its pane, or it is not taken. An operator sends from a
      // paired device (`POST /api/walky`), which this socket cannot prove.
      if (pane === null) {
        service.noteRefusal("no pane");
        return { ok: false, error: SEND_NEEDS_A_PANE };
      }
      const answer = await service.send({ id: request.id, to: request.to, body: request.body, replyTo: request.replyTo, wake: request.wake, outside: request.outside }, { kind: "agent", pane });
      if (!answer.ok) return answer;
      return answer.target === undefined ? { ok: true, receipts: answer.receipts } : { ok: true, receipts: answer.receipts, target: answer.target };
    }
    case "who": {
      const self = pane === null ? null : service.addressOf(pane.paneId, pane.instance);
      // On a member the crew's panes come from its lead, else this machine's own with the note (service.whoCrew).
      const crew = await service.whoCrew();
      const base = { ok: true as const, self, targets: crew.targets };
      // The asking pane's own space rides along, so the CLI need not find its row in a list it may have trimmed.
      const answer = pane === null ? base : { ...base, ownSpace: pane.space };
      const withNote = crew.note === null ? answer : { ...answer, note: crew.note };
      return pane?.off === true ? { ...withNote, selfOff: true } : withNote;
    }
    case "status": {
      const { receipts, message, elsewhere, deliveries, totals } = service.status(request.id);
      if (deliveries === undefined || totals === undefined) return { ok: true, receipts, message, elsewhere };
      return { ok: true, receipts, message, elsewhere, deliveries, totals };
    }
    case "inbox": {
      if (request.id !== null) {
        // One message by id: the way an agent reads the body its nudge line named.
        const entry = service.one(request.id, pane);
        if (entry === null) return pane === null ? { ok: false, error: `no message ${request.id} on this machine` } : noMessageHere(`no message ${request.id} for this pane`);
        if (pane !== null && request.ack) service.ack(pane.session, pane.paneId, pane.instance, [entry.id]);
        return { ok: true, pane: pane === null ? null : service.addressOf(pane.paneId, pane.instance), messages: [entry] };
      }
      if (pane === null) {
        if (!request.all) return { ok: false, error: "needs a pane" };
        return { ok: true, pane: null, messages: service.newest() };
      }
      // The pane's current instance: a new session that took an old pane id reads its own inbox only.
      const messages = service.inbox(pane.session, pane.paneId, pane.instance, request.all);
      if (request.ack && !request.all) service.ack(pane.session, pane.paneId, pane.instance, messages.map((message) => message.id));
      return { ok: true, pane: service.addressOf(pane.paneId, pane.instance), messages };
    }
    case "ack":
      if (pane === null) return { ok: false, error: "needs a pane" };
      return { ok: true, acked: service.ack(pane.session, pane.paneId, pane.instance, request.ids) };
    case "cancel": {
      // The sender only (M62 spec 03): the pane the markers place must be the one that sent the message.
      if (pane === null) {
        service.noteRefusal("no pane");
        return { ok: false, error: CANCEL_NEEDS_A_PANE };
      }
      const taken = service.cancel(request.id, { kind: "agent", pane });
      return !taken.ok && taken.error.startsWith("no message ") ? noMessageHere(taken.error) : taken;
    }
    case "off":
    case "on":
      // The asker's own pane, placed by its markers, never named by an argument (M89, decision 3).
      if (pane === null || !pane.agent) {
        service.noteRefusal("no pane");
        return { ok: false, error: SWITCH_NEEDS_A_PANE };
      }
      return { ok: true, off: service.setOff(pane, request.op === "off", "session") };
    case "pane":
      // What the asking pane runs, from the pane its markers place: an agent's session, or a bare shell.
      // `collie trick on` and `collie pair` refuse only for an agent (cli/trick.ts, cli/pairing.ts); with
      // no markers there is no pane to say. `session` and `paneId` are where the bridge placed it: `pair`
      // carries them to the audit line of the pairing its code makes.
      if (pane === null) return { ok: false, error: "needs a pane" };
      return { ok: true, agent: pane.agent, session: pane.session, paneId: pane.paneId };
    case "hill.post":
    case "hill.status":
    case "hill.withdraw":
    case "hill.list":
      return await answerHill(service, request, pane, hill);
    case "hill.clear":
      // Answered above, before any pane is placed; kept so the switch stays exhaustive.
      return hill === undefined ? { ok: false, error: unknownOp(request.op) } : answerClear(hill);
    case "hill.state":
      return hill === undefined ? { ok: false, error: unknownOp(request.op) } : await answerCrewState(service, request, targets, hill);
    case "hill.spoken.clear":
      return hill === undefined ? { ok: false, error: unknownOp(request.op) } : await answerSpokenClear(service, request.markers, targets, hill);
    case "trick.propose": {
      if (propose === undefined) return { ok: false, error: unknownOp(request.op) };
      // An agent's pane proposes as that session; a bare shell, or no markers at all, as a terminal.
      const who: LocalProposer = pane !== null && pane.agent ? { kind: "agent", address: service.addressOf(pane.paneId, pane.instance), label: pane.label } : { kind: "terminal" };
      const answer = await propose.local(request.fields, who);
      return answer.ok ? answer : { ok: false, error: answer.error, code: answer.code, propose: true };
    }
    case "morph.start":
    case "morph.show":
    case "morph.clear":
    case "morph.on":
    case "morph.off":
    case "morph.status":
    case "morph.set":
    case "morph.pending":
    case "morph.remove":
    case "morph.keep":
    case "morph.choice":
      return answerMorph(service, request, pane, morph);
  }
}

/** `not here`, marked for the hill or Morph when the op is theirs and this bridge knows it. */
function notHereFor(op: WalkyRequest["op"], knowsHill: boolean, knowsMorph: boolean): WalkyAnswer {
  if (knowsHill && isHillOp(op)) return { ok: false, error: "not here", hill: true };
  if (knowsMorph && isMorphOp(op)) return { ok: false, error: "not here", morph: true };
  return { ok: false, error: "not here" };
}

/**
 * One Morph operation, for the session of the pane the markers placed, never a session an argument
 * names: its walky address with the instance token, the key the hill names a session with.
 */
function answerMorph(
  service: WalkyService,
  request: Extract<WalkyRequest, { op: MorphOp }>,
  pane: WalkyPane | null,
  morph: MorphSocket | undefined,
): WalkyAnswer {
  if (morph === undefined) return { ok: false, error: unknownOp(request.op) };
  if (pane === null || !pane.agent) {
    service.noteRefusal("no pane");
    return { ok: false, error: MORPH_NEEDS_A_PANE, morph: true };
  }
  const session = service.addressOf(pane.paneId, pane.instance);
  // The markers prove the caller. A session the request names must be the same one, or nothing is done.
  if (request.session !== null && !sameSession({ own: session, given: request.session })) {
    return { ok: false, error: wrongSessionWords({ own: session, given: request.session }), morph: true, code: "wrong_session" };
  }
  const answer = morphAnswerOf(request, session, morph);
  if (answer.ok) return { ok: true, morph: answer.session };
  return answer.refusals === undefined ? { ok: false, error: answer.error, morph: true, code: answer.code } : { ok: false, error: answer.error, morph: true, code: answer.code, refusals: answer.refusals };
}

function morphAnswerOf(
  request: Extract<WalkyRequest, { op: MorphOp }>,
  session: string,
  morph: MorphSocket,
): ReturnType<MorphSocket["show"]> {
  switch (request.op) {
    case "morph.start": {
      const fields = readStartFields(request.fields);
      if ("error" in fields) return { ok: false, error: fields.error, code: "bad_note" };
      return morph.start(session, fields);
    }
    case "morph.show": {
      const fields = readShowFields(request.fields);
      if ("error" in fields) return { ok: false, error: fields.error, code: fields.code };
      return morph.show(session, fields);
    }
    case "morph.clear":
      return morph.clear(session);
    case "morph.on":
    case "morph.off":
      return morph.setOn(session, request.op === "morph.on");
    case "morph.status":
      return { ok: true, session: morph.status(session) };
    case "morph.set": {
      const fields = readSetFields(request.fields);
      return "error" in fields ? { ok: false, error: fields.error, code: fields.code } : morph.set(session, fields);
    }
    case "morph.pending": {
      const fields = readPendingFields(request.fields);
      return "error" in fields ? { ok: false, error: fields.error, code: fields.code } : morph.pending(session, fields);
    }
    case "morph.remove": {
      const fields = readRemoveFields(request.fields);
      return "error" in fields ? { ok: false, error: fields.error, code: fields.code } : morph.remove(session, fields.id);
    }
    case "morph.keep": {
      const fields = readKeepFields(request.fields);
      return "error" in fields ? { ok: false, error: fields.error, code: fields.code } : morph.keep(session, fields.ids);
    }
    case "morph.choice": {
      const fields = readChoiceFields(request.fields);
      return "error" in fields ? { ok: false, error: fields.error, code: fields.code } : morph.setChoice(session, fields.choice);
    }
  }
}

/** Clear every closed decision: the count, or a refusal when the write failed (nothing was cleared). */
function answerClear(hill: HillSocket): WalkyAnswer {
  const cleared = hill.clear(null);
  if (cleared === null) return { ok: false, error: "the Hill could not be saved on this machine; nothing was cleared", hill: true };
  return { ok: true, cleared: cleared.cleared.length };
}

/** What the socket answers a person's verb asked from an agent's pane (1.29.0): the person decides it. */
export const HILL_PERSON_ONLY = "this is your person's choice, and this runs in a pane where an agent works; ask your operator, who sets it on the phone or in a terminal";

/**
 * Whether the markers place an agent's pane of this bridge: the speed bump a person's verb keeps (the
 * rule of `collie trick on`, cli/trick.ts). No markers, or markers this bridge does not place, are not an
 * agent here; a process that strips its markers gets past it, and the user account is the real boundary.
 */
async function fromAgentPane(service: WalkyService, markers: WalkyRequest["markers"], targets: readonly PlaceTarget[]): Promise<boolean> {
  if (markers.length === 0) return false;
  const placed = await placeMarkers(markers, targets);
  return placed !== null && service.paneAt(placed.session, placed.paneId)?.agent === true;
}

/**
 * The crew state (1.29.0). A read answers this bridge's state, or on a crew member its lead's, from any
 * caller. A write is the person's: refused from an agent's pane, and on a member (the state is the lead's).
 */
async function answerCrewState(service: WalkyService, request: Extract<WalkyRequest, { op: "hill.state" }>, targets: readonly PlaceTarget[], hill: HillSocket): Promise<WalkyAnswer> {
  if (request.state === null) {
    const read = await hill.askCrewState();
    if (read.ok) return { ok: true, crewState: read.crewState };
    return read.older === true ? { ok: false, error: read.error, hill: true, code: "lead_too_old" } : { ok: false, error: read.error, hill: true };
  }
  if (await fromAgentPane(service, request.markers, targets)) {
    service.noteRefusal("agent pane");
    return { ok: false, error: HILL_PERSON_ONLY, hill: true, code: "person_only" };
  }
  const set = hill.setCrewState(request.state, "terminal", "terminal");
  if (!set.ok) return set.notLead ? { ok: false, error: set.error, hill: true, code: "not_on_lead" } : { ok: false, error: set.error, hill: true };
  return { ok: true, crewState: set.crewState };
}

/** The second Clear (1.29.0): the person's verb, refused from an agent's pane and on a member. Types nothing. */
async function answerSpokenClear(service: WalkyService, markers: WalkyRequest["markers"], targets: readonly PlaceTarget[], hill: HillSocket): Promise<WalkyAnswer> {
  if (await fromAgentPane(service, markers, targets)) {
    service.noteRefusal("agent pane");
    return { ok: false, error: HILL_PERSON_ONLY, hill: true, code: "person_only" };
  }
  const cleared = hill.clearSpoken("terminal");
  if (!cleared.ok) return cleared.notLead ? { ok: false, error: cleared.error, hill: true, code: "not_on_lead" } : { ok: false, error: cleared.error, hill: true };
  return { ok: true, cleared: cleared.cleared };
}

/**
 * One hill operation (M96), from the pane the markers placed, never from a pane an argument names. The
 * sender is that pane's walky address with its instance token, as a walky send names its sender. A
 * decision this bridge does not hold from the sender answers `not here` with the sentence in `missing`,
 * so the CLI asks the next bridge on the machine, as it does for a walky message id.
 */
async function answerHill(service: WalkyService, request: Extract<WalkyRequest, { op: "hill.post" | "hill.status" | "hill.withdraw" | "hill.list" }>, pane: WalkyPane | null, hill: HillSocket | undefined): Promise<WalkyAnswer> {
  if (hill === undefined) return { ok: false, error: unknownOp(request.op) };
  if (pane === null || !pane.agent) {
    service.noteRefusal("no pane");
    return { ok: false, error: HILL_NEEDS_A_PANE, hill: true };
  }
  const sender = hill.agentSender(pane, service.addressOf(pane.paneId, pane.instance));
  switch (request.op) {
    case "hill.post": {
      const answer = await hill.postFields(sender, request.fields);
      if (answer.ok) return answer;
      return answer.code === null ? { ok: false, error: answer.error, hill: true } : { ok: false, error: answer.error, hill: true, code: answer.code };
    }
    case "hill.status":
    case "hill.withdraw": {
      const answer = request.op === "hill.status" ? await hill.askStatus(sender, request.id) : await hill.askWithdraw(sender, request.id);
      if (answer.ok) return answer;
      return answer.missing ? { ok: false, error: "not here", hill: true, missing: answer.error } : { ok: false, error: answer.error, hill: true };
    }
    case "hill.list": {
      const answer = await hill.askList(sender);
      return answer.ok ? { ok: true, decisions: answer.decisions } : { ok: false, error: answer.error, hill: true };
    }
  }
}

/**
 * Answer a request this bridge cannot read (added 2026-10-30). Markers that name no pane here answer
 * `not here`, as a readable request's do: the CLI then asks the next bridge, which may be newer and the
 * pane's own. Several bridges of different releases share a machine (the release lane beside a dev
 * lane), and the CLI asks its own install's first. Anything else answers the reason, never the bare word.
 */
export async function answerUnread(service: WalkyService, read: Extract<WalkyRequestRead, { ok: false }>, targets: readonly PlaceTarget[]): Promise<WalkyAnswer> {
  if (read.markers.length === 0) return { ok: false, error: read.reason };
  const placed = await placeMarkers(read.markers, targets);
  if (placed === null || service.paneAt(placed.session, placed.paneId) === null) return { ok: false, error: "not here" };
  return { ok: false, error: read.reason };
}

export class WalkyServer {
  private server: Server | null = null;
  private readonly log: (line: string) => void;
  /** `trick.propose` lines being read now. */
  private bigLines = 0;

  constructor(private readonly deps: WalkyServerDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** Listen. False on Windows, when another live bridge holds the path, or when it cannot be made safe. */
  async start(): Promise<boolean> {
    const path = this.deps.socketPath;
    const dir = dirname(path);
    if ((this.deps.host ?? HOST).platform === "win32") {
      this.log("[walky] no socket: walky talky needs a Unix socket on this host");
      return false;
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      if (existsSync(path)) {
        if (!lstatSync(path).isSocket()) {
          this.log(`[walky] no socket: ${path} exists and is not a socket`);
          return false;
        }
        if (await answers(path)) {
          this.log(`[walky] no socket: another bridge listens on ${path}`);
          return false;
        }
        unlinkSync(path);
      }
      const server = createServer((socket) => this.accept(socket));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.off("error", reject);
          resolve();
        });
      });
      chmodSync(path, 0o600);
      server.unref();
      this.server = server;
      return true;
    } catch (err) {
      this.log(`[walky] no socket: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  stop(): void {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    server.close();
    try {
      if (existsSync(this.deps.socketPath) && lstatSync(this.deps.socketPath).isSocket()) unlinkSync(this.deps.socketPath);
    } catch {
      // A socket file left behind is unlinked by the next start.
    }
  }

  /** One connection: one request line, one answer line. Never throws. */
  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let taken = false;
    // A `trick.propose` line may be long (crew slice 8): it gets its own cap and time, two at a time.
    let big = false;
    let decided = false;
    // The slot of a long line is held only while that line is read: given back once the line is taken or
    // refused, or the connection goes, whichever is first. Never twice.
    const release = (): void => {
      if (big) this.bigLines -= 1;
      big = false;
    };
    let timer = setTimeout(() => {
      if (!taken) socket.destroy();
    }, REQUEST_LINE_MS);
    timer.unref?.();
    socket.on("error", () => undefined);
    socket.on("close", release);
    socket.on("data", (chunk: string) => {
      if (taken) return;
      const from = buffer.length;
      buffer += chunk;
      if (!decided && (buffer.length >= PROPOSE_LINE_PREFIX.length || buffer.includes("\n"))) {
        decided = true;
        if (buffer.startsWith(PROPOSE_LINE_PREFIX)) {
          if (this.bigLines >= PROPOSE_LINES_MAX) {
            taken = true;
            clearTimeout(timer);
            this.reply(socket, { ok: false, error: "another proposal is being read; try again in a moment", code: "failed", propose: true });
            return;
          }
          big = true;
          this.bigLines += 1;
          clearTimeout(timer);
          // A slot holder that stops sending is cut off: the slot comes back with the close.
          timer = setTimeout(() => {
            if (!taken) socket.destroy();
          }, this.deps.proposeLineMs ?? PROPOSE_LINE_MS);
          timer.unref?.();
        }
      }
      const at = buffer.indexOf("\n", from);
      if (at < 0) {
        if (buffer.length > (big ? PROPOSE_LINE_MAX : WALKY_LINE_MAX)) {
          taken = true;
          clearTimeout(timer);
          release();
          this.reply(socket, { ok: false, error: "too long" });
        }
        return;
      }
      taken = true;
      clearTimeout(timer);
      const long = big;
      release();
      void this.route(socket, buffer.slice(0, at), long);
    });
  }

  /** Write the one answer, then close the connection once it is flushed, whatever the client does. */
  private reply(socket: Socket, answer: WalkyAnswer): void {
    if (socket.destroyed || !socket.writable) return;
    socket.end(`${JSON.stringify(answer)}\n`, () => socket.destroy());
  }

  private async route(socket: Socket, line: string, big = false): Promise<void> {
    try {
      // A long line is counted before `JSON.parse` builds it (review S3).
      if (big && !proposalParseable(line)) return this.reply(socket, { ok: false, error: PROPOSE_TOO_MANY_PARTS, code: "bad_request", propose: true });
      const read = readWalkyRequest(line, big ? PROPOSE_LINE_MAX : WALKY_LINE_MAX);
      if (!read.ok) return this.reply(socket, await answerUnread(this.deps.service, read, this.deps.targets()));
      // A long line is a proposal's, or nothing: a second `op` key cannot turn it into another request.
      if (big && read.request.op !== "trick.propose") return this.reply(socket, { ok: false, error: "bad request: a long line is a trick proposal only" });
      this.reply(socket, await answerRequest(this.deps.service, read.request, this.deps.targets(), this.deps.hill, this.deps.morph, this.deps.propose));
    } catch (err) {
      this.log(`[walky] request failed: ${err instanceof Error ? err.message : String(err)}`);
      this.reply(socket, { ok: false, error: "failed" });
    }
  }
}

/** Whether something accepts on `path` within 200 ms: a live bridge already holds it. */
async function answers(path: string): Promise<boolean> {
  const conn = createConnection({ path });
  conn.on("error", () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((done) => {
    timer = setTimeout(() => done(false), 200);
  });
  const accepted = await Promise.race([once(conn, "connect").then(() => true, () => false), late]);
  clearTimeout(timer);
  conn.destroy();
  return accepted;
}
