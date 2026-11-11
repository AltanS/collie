// The wire of the hill (M96): the shapes the bridge stores and serves, and the shapes the phone
// sends back. The bridge and the web app both import this file, so it holds types, constants and
// small pure helpers only. No I/O, no React, no runtime dependency.

import type { JsonValue } from "../json";
import type { View } from "../tricks/schema";

/** How soon the poster wants a person to look. */
export type HillPriority = "now" | "today" | "later";

/** Where a decision is in its life. Only "open" waits for a person. */
export type HillState =
  | "open"
  | "answered"
  | "dismissed"
  | "expired"
  | "withdrawn"
  | "superseded"
  | "undeliverable";

/** Whether the person may, or must, add free text to the answer. */
export type HillTextMode = "none" | "optional" | "required";

export const HILL_PRIORITIES: readonly HillPriority[] = ["now", "today", "later"];
export const HILL_STATES: readonly HillState[] = [
  "open",
  "answered",
  "dismissed",
  "expired",
  "withdrawn",
  "superseded",
  "undeliverable",
];
export const HILL_TEXT_MODES: readonly HillTextMode[] = ["none", "optional", "required"];

/** An option's intent: a short lowercase word the poster reads back. */
export const HILL_INTENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Intents the hill itself uses. A poster may not name an option with one of them. */
export const HILL_RESERVED_INTENTS: readonly string[] = ["answer", "dismiss"];
/** A device id on an answer: "dv_" and 16 hex characters, derived by the bridge from a pairing record. */
export const HILL_DEVICE_ID_RE = /^dv_[0-9a-f]{16}$/;
/** A decision id: "dc_" and 12 characters, minted by the bridge. */
export const HILL_ID_RE = /^dc_[a-z0-9]{12}$/;
/** The node name a decision has in an answer request: "hill/<decision id>". */
export const HILL_NODE_PREFIX = "hill/";

export const HILL_TITLE_MAX = 120;
export const HILL_SUMMARY_MAX = 280;
export const HILL_BODY_MAX = 4000;
export const HILL_OPTIONS_MAX = 5;
export const HILL_OPTION_LABEL_MAX = 40;
export const HILL_OPTION_DETAIL_MAX = 120;
export const HILL_OPTION_CONFIRM_MAX = 24;
export const HILL_WHY_MAX = 200;
export const HILL_LINKS_MAX = 5;
export const HILL_LINK_LABEL_MAX = 40;
export const HILL_LINK_HREF_MAX = 500;
export const HILL_ANSWER_TEXT_MAX = 4000;
/** Open decisions one sender may hold at once. */
export const HILL_OPEN_MAX = 20;
/** Open "now" decisions one sender may hold at once. A further one is shown as "today". */
export const HILL_NOW_MAX = 3;
/** How many closed decisions the list serves, newest first. */
export const HILL_CLOSED_SERVED = 20;

/** Images one decision may carry. */
export const HILL_MEDIA_MAX = 4;
/** The largest image the bridge keeps, in bytes. */
export const HILL_MEDIA_BYTES_MAX = 2 * 1024 * 1024;
/** An image's caption, in characters. */
export const HILL_MEDIA_CAPTION_MAX = 80;
/** An image id: "im_" and 16 characters, minted by the bridge. Never a name the poster chose. */
export const HILL_MEDIA_ID_RE = /^im_[a-z0-9]{16}$/;
/** The image types the hill keeps, decided by the file's leading bytes, never by its name. */
export type HillMediaMime = "image/png" | "image/jpeg" | "image/webp";
export const HILL_MEDIA_MIMES: readonly HillMediaMime[] = ["image/png", "image/jpeg", "image/webp"];
/** The longest path a post may name for an image. */
export const HILL_IMAGE_PATH_MAX = 4096;
/** Where the phone reads an image's bytes: `${HILL_MEDIA_ROUTE}<decision id>/<media id>`. */
export const HILL_MEDIA_ROUTE = "/api/hill/media/";

/**
 * What a Decision of Collie's own is about: a trick's new version (crew slice 3), a proposal (crew slice
 * 8), or a carried trick that did not start after a takeover (crew slice 10, OK only).
 */
export type HillCollieRefType = "version" | "proposal" | "carried";
export const HILL_COLLIE_REF_TYPES: readonly HillCollieRefType[] = ["version", "proposal", "carried"];
/** The id inside a Collie Decision's `ref`: a trick id for `version`. */
export const HILL_COLLIE_REF_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The hash inside a Collie Decision's `ref`: the sha256 of the code the answer is about, in hex. */
export const HILL_COLLIE_REF_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * A GROUP OF CARDS (crew slice 8): one Decision of Collie's own whose code does not fit one card shows as
 * 2 to 8 cards in a fixed order. Card 1 is Collie's facts, never code; cards 2 to n hold the code. The
 * answer that switches on carries the group's digest the phone was given and which cards the phone
 * opened. The opened list is the phone's DISPLAY check: it says what this phone showed, it proves
 * nothing about what the person read.
 */
export const HILL_GROUP_PARTS = { min: 2, max: 8 } as const;
/** A group's digest and a card's hash: SHA-256, hex. */
export const HILL_GROUP_HASH_RE = /^[0-9a-f]{64}$/;

/** One card of a group: its view, and the SHA-256 of the view's JSON text as the bridge stored it. */
export interface HillGroupPart {
  view: View;
  sha256: string;
}

/** The cards of a group, on a Decision of Collie's own only. */
export interface HillGroup {
  /** SHA-256 over the Decision's `ref` and the cards' hashes in order. An answer that switches on names it. */
  digest: string;
  /** The option that declines ("Not now", "Keep the old version"): it needs no card opened, and shows on every card. */
  decline: string;
  /** 2 to 8 cards in order. Card 1 is Collie's facts. */
  parts: HillGroupPart[];
}

/** What a phone sends with an answer to a group: the digest it was given and the cards it opened (1-based). */
export interface HillGroupAnswer {
  digest: string;
  /** A DISPLAY check, never proof: the cards this phone showed. */
  opened: number[];
}

/**
 * What a Collie Decision is about. Only code inside the bridge mints one (bridge/hill/service.ts
 * `postCollie`); the answer acts on exactly this `hash` and refuses when the thing moved since.
 */
export interface HillCollieRef {
  type: HillCollieRefType;
  id: string;
  hash: string;
}

/** A Collie Decision's `ref` from its three read fields, or null when any is missing or malformed. */
export function hillCollieRef(type: string | undefined, id: string | undefined, hash: string | undefined): HillCollieRef | null {
  const kind = HILL_COLLIE_REF_TYPES.find((candidate) => candidate === type);
  if (kind === undefined || id === undefined || hash === undefined) return null;
  if (!HILL_COLLIE_REF_ID_RE.test(id) || !HILL_COLLIE_REF_HASH_RE.test(hash)) return null;
  return { type: kind, id, hash };
}

/** One button on a decision card. */
export interface HillOption {
  /** What the poster reads back. Lowercase, see HILL_INTENT_RE. */
  intent: string;
  /** The words on the button. */
  label: string;
  /** One line of explanation under the label. */
  detail?: string;
  /** A short word for a second tap that confirms the choice. */
  confirm?: string;
}

/** One image on a decision, as the bridge stored it. The bytes are served at {@link hillMediaPath}. */
export interface HillMedia {
  /** "im_" and 16 characters, the bridge's own name for the file. */
  id: string;
  kind: "image";
  mime: HillMediaMime;
  bytes: number;
  /** Read from the image's header when the bridge could; null when it could not. */
  width: number | null;
  height: number | null;
  /** At most {@link HILL_MEDIA_CAPTION_MAX} characters, cleaned like every text field. */
  caption?: string;
}

/** A decision as the bridge stores it and serves it (wire version 1). */
export interface HillDecision {
  v: 1;
  /** "dc_" and 12 characters, minted by the bridge. */
  id: string;
  /** A UUID the poster minted. A repeat of the same one returns this decision. */
  requestId: string;
  /** Who posted it. The bridge fills this from the socket, never from the post. */
  from: {
    /**
     * "agent" posts on the socket. "trick" posts only through code inside the bridge. "collie" is
     * Collie itself (a trick's new version): only bridge code mints it, and its answer types nothing.
     */
    kind: "agent" | "trick" | "collie";
    /** The poster's walky address. Null for a trick. */
    address: string | null;
    trickId: string | null;
    /** The decision's `key` in the trick's document. Null for an agent. */
    trickKey: string | null;
    /**
     * The bridge the poster runs on (bridge/bridge-id.ts): its crew member id, or its install id on a
     * solo install. Null only on a decision stored before every bridge had an id.
     */
    memberId: string | null;
    harness: string | null;
    /** The session's name as walky shows it. Display only. */
    label: string;
    /** The machine's display name, for every sender kind. Display only, never a key. */
    host: string | null;
    /**
     * The member id of the bridge a trick runs on: where its answer's tap is routed. Always set on a
     * trick's decision, and the same value as `memberId` there; null for an agent.
     */
    trickHost: string | null;
    /** What a Collie Decision is about. Present on kind `collie` only, and required there. */
    ref?: HillCollieRef;
  };
  /** A walky address. The card opens that session's Chat. */
  about: string | null;
  /** The priority as shown. */
  priority: HillPriority;
  /** The priority as the poster asked for it. */
  priorityAsked: HillPriority;
  title: string;
  summary: string;
  /** Markdown. */
  body: string;
  options: HillOption[];
  text: HillTextMode;
  /** The option the poster suggests, and why. The intent names one of the options. */
  recommends: { intent: string; why: string } | null;
  /** Up to {@link HILL_MEDIA_MAX} images, in the order the poster gave them. */
  media: HillMedia[];
  /** Links on the card. Only http and https. */
  links: Array<{ label: string; href: string }>;
  /**
   * A small display-only view under the summary, in the trick node vocabulary, checked by
   * `parseDecisionView` (lib/tricks/schema.ts) at post time and again on the phone. Absent: none.
   */
  view?: View;
  /**
   * The cards of a group, instead of `view`: only a Decision of Collie's own carries one (a trick
   * proposal or a new version whose code does not fit one card). Absent: one card.
   */
  group?: HillGroup;
  /** A walky address. Null means the answer goes to the poster's own address. */
  replyTo: string | null;
  /** Where the answer goes, resolved at post time for the card's "goes to" line. */
  target: {
    label: string;
    host: string | null;
    /** The session runs in bypass or auto-approve mode, when the bridge knows it. */
    unattended: boolean;
  } | null;
  /** The id of an older decision this one replaces. */
  supersedes: string | null;
  supersededBy: string | null;
  /** Epoch milliseconds. */
  expiresAt: number | null;
  /** Epoch milliseconds when the bridge accepted it. */
  at: number;
  state: HillState;
  closedAt: number | null;
  /** Plain words, for example "by the poster" or "target session ended". */
  closedReason: string | null;
  /** Set when the state is answered or dismissed. */
  answer: {
    rid: string;
    /** An option's intent, or "answer" or "dismiss". */
    intent: string;
    /** The option's label at the time of the answer. */
    label: string | null;
    text: string | null;
    /** The phone's name as operator walky uses it. */
    by: string;
    /**
     * The paired device the answer came from, as an opaque id (`dv_` and 16 hex characters) the bridge
     * derives from that device's pairing record; `by` is only its label. Attribution, not a signature.
     * Absent when the bridge knew no pairing record (the header gate alone, or an older answer).
     */
    deviceId?: string;
    at: number;
    /** What walky reported. "none" for a dismiss with nothing to type. */
    delivery: "typed" | "held" | "unknown" | "none";
    /** What the trick's program did with the answer, as a tap. "none" for an agent's decision. */
    trick: HillTrickDelivery;
  } | null;
  /**
   * The SHA-256 of what the post asked for, hex, so a repeat of `requestId` with another payload is
   * refused (`request_id_reused`) instead of answered with this decision. Absent on a decision stored
   * before it existed: a repeat of that one is answered as stored.
   */
  postDigest?: string;
  /**
   * The phone notification slot this decision holds (bridge/hill/push.ts), stored only and never served,
   * as `postDigest`. Set in the write that stores the decision when its `now` push went, or carried over
   * from the decision it superseded; a close clears the slot unless a successor holds it. Its presence is
   * also why a decision id is never pushed twice. Absent: no notification.
   */
  pushTag?: string;
}

/**
 * What a trick's program made of an answer: "ran" (the tap's run succeeded), "failed" (the run failed,
 * timed out, or the trick was off or busy; nothing retries), "none" (an agent's decision, no trick).
 */
export type HillTrickDelivery = "ran" | "failed" | "none";
export const HILL_TRICK_DELIVERIES: readonly HillTrickDelivery[] = ["ran", "failed", "none"];

/** What the bridge serves at the hill read route. */
export interface HillList {
  /** The hill revision. It also rides on the snapshot as `hillRev`. */
  rev: number;
  /** True when the caller's `since` equals `rev`. Then `open` and `closed` are absent. */
  unchanged?: true;
  /** Every open decision, in any order. The phone sorts. */
  open: HillDecision[];
  /** The newest closed decisions, newest first. */
  closed: HillDecision[];
  /**
   * How many closed decisions the bridge holds, which may be more than `closed` carries. What Clear
   * says it will remove. Absent from a bridge before Clear: the phone counts `closed`.
   */
  closedTotal?: number;
  /** The crew state on this lead (1.29.0). Absent from an older bridge: the phone draws no control. */
  crewState?: HillCrewStateView;
}

/** What the phone sends to answer a decision. */
export interface HillAnswerRequest {
  /** A UUID the phone minted. A known one returns its stored receipt and runs nothing. */
  rid: string;
  /** "hill/<decision id>", see hillNode. */
  node: string;
  /** An option's intent, "answer" (text only) or "dismiss". */
  intent: string;
  value: { text: string | null };
  /** On a group: the digest and the opened cards. Needed for every option but the group's decline and a dismiss. */
  group?: HillGroupAnswer;
}

/** What the bridge answers to an answer request. */
export interface HillReceipt {
  rid: string;
  code: "ok" | "rejected" | "gone" | "denied" | "unknown";
  /** Plain words, for example "not an option of this decision" or "text is required". */
  reason: string | null;
  /** The decision's state after this call. */
  state: HillState | null;
  delivery: "typed" | "held" | "unknown" | "none" | null;
  /** What the trick's program made of the answer. Null where `delivery` is null. */
  trick: HillTrickDelivery | null;
  at: number;
  /** On an `ok` receipt: the paired device it came from, as the stored answer's `deviceId`. Absent when unknown. */
  deviceId?: string;
  /**
   * The crew machine the answer goes to, which is not answering (1.29.0). On a `rejected` receipt:
   * nothing was sent and the Decision stays open. On an `ok` dismiss: the card closed and nothing was
   * typed, so the session was not told. Absent from an older bridge, which never answers so.
   */
  machine?: string;
}

/** One image a post names: a file on the bridge's own machine, read by the bridge. */
export interface HillImageInput {
  /** An absolute path with no symlink in it. The bridge reads the file itself and checks it. */
  path: string;
  caption?: string;
}

/** The fields an agent sends to post a decision. */
export interface HillPostInput {
  requestId: string;
  title: string;
  summary: string;
  body?: string;
  options?: HillOption[];
  text?: HillTextMode;
  recommends?: { intent: string; why: string } | null;
  links?: Array<{ label: string; href: string }>;
  priority?: HillPriority;
  about?: string | null;
  replyTo?: string | null;
  supersedes?: string | null;
  expiresAt?: number | null;
  /** Up to {@link HILL_MEDIA_MAX} images. */
  images?: HillImageInput[];
  /** A display-only view under the summary (`parseDecisionView`). */
  view?: View;
  /** The cards of a group, instead of `view`: Collie's own Decision only (`HillService.postCollie`). */
  group?: { decline: string; parts: View[] };
}

/** Why the bridge refuses a post. */
export type HillRefusalCode =
  | "bad_title"
  | "bad_summary"
  | "bad_body"
  | "bad_option"
  | "bad_recommends"
  | "bad_link"
  | "bad_text_mode"
  | "bad_target"
  | "bad_supersedes"
  | "too_many_open"
  | "not_on_lead"
  | "walky_off"
  | "hill_off"
  | "bad_image"
  | "too_many_images"
  | "image_too_large"
  | "request_id_reused"
  /** A crew member's post that did not reach its lead (CREW_PROTOCOL §22, 1.29.0): nothing was posted. */
  | "lead_unreachable"
  /** A person's verb (the crew state, Clear of the cards answered in the session) asked from an agent's pane (1.29.0). */
  | "person_only"
  /** The crew state asked of a member whose lead runs a release too old to say it (1.29.0). */
  | "lead_too_old";

/** The node name of a decision: "hill/<id>". */
export function hillNode(id: string): string {
  return `${HILL_NODE_PREFIX}${id}`;
}

/** The decision id inside a node name, or null when the node is not a well-formed hill node. */
export function hillIdOfNode(node: string): string | null {
  if (!node.startsWith(HILL_NODE_PREFIX)) return null;
  const id = node.slice(HILL_NODE_PREFIX.length);
  return HILL_ID_RE.test(id) ? id : null;
}

/** The route an image's bytes are read at. Both ids are checked by the bridge before any path is built. */
export function hillMediaPath(decisionId: string, mediaId: string): string {
  return `${HILL_MEDIA_ROUTE}${encodeURIComponent(decisionId)}/${encodeURIComponent(mediaId)}`;
}

/** True when `s` may be an option's intent: it matches the pattern and is not a reserved intent. */
export function isHillOptionIntent(s: string): boolean {
  return HILL_INTENT_RE.test(s) && !HILL_RESERVED_INTENTS.includes(s);
}

/** Open decisions in the order the phone shows them: now, today, later; oldest first inside one priority. Does not mutate. */
export function sortOpenDecisions(list: HillDecision[]): HillDecision[] {
  const rank = (p: HillPriority): number => HILL_PRIORITIES.indexOf(p);
  return list.toSorted((a, b) => rank(a.priority) - rank(b.priority) || a.at - b.at);
}

// ── THE CREW STATE (1.29.0) ─────────────────────────────────────────────────────────────────────────
// One value on the lead, set by the person: `here` (as always), `quiet` (no push; agents post but do not
// wait for a fast answer) or `away` (no push; agents hold questions that need an answer now). The bridge
// never refuses a post for it: it is information for agents, read with `collie hill state`, and carried on
// the typed answer and the post result as one line, `Crew state: away.`, whenever it is not `here`.

export type HillCrewState = "here" | "quiet" | "away";
export const HILL_CREW_STATES: readonly HillCrewState[] = ["here", "quiet", "away"];

export function isHillCrewState(value: JsonValue | undefined): value is HillCrewState {
  return HILL_CREW_STATES.some((state) => state === value);
}

/** The crew state as the bridge serves it on `GET /api/hill`. */
export interface HillCrewStateView {
  state: HillCrewState;
  /** When it was set, epoch milliseconds; null for the default (`here`, never set). */
  at: number | null;
  /** Who set it: a device's label or "terminal"; null for the default. */
  by: string | null;
  /** How many sessions "Tell all sessions now" told since this state was set; null while not told. */
  told: number | null;
}

/** The one line a typed answer and a post result end with while the state is not `here`. */
export function crewStateLine(state: HillCrewState): string {
  return `Crew state: ${state}.`;
}

/** What "Tell all sessions now" types into each session: one line. */
export function crewStateTellLine(state: HillCrewState): string {
  return `[hill] from operator: ${crewStateLine(state)}`;
}

/** The most sessions one "Tell all sessions now" reaches. */
export const HILL_TELL_MAX = 20;
/** A session that posted a Decision this long ago or less is told, even when that Decision closed. */
export const HILL_TELL_RECENT_MS = 60 * 60 * 1000;
