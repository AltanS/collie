// The wire of the hill (M96): the shapes the bridge stores and serves, and the shapes the phone
// sends back. The bridge and the web app both import this file, so it holds types, constants and
// small pure helpers only. No I/O, no React, no runtime dependency.

import { isHiddenChar } from "../hidden-chars";
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
/**
 * The fixed answer every ask takes besides its options (Asks, 2026-11-22): "I need more context", with an
 * optional note. It closes the ask as answered, as an option does; the agent then sends the ask again
 * with a better background and `--replaces <id>`.
 */
export const HILL_MORE_CONTEXT = "more-context";
/** The label the stored answer of {@link HILL_MORE_CONTEXT} carries. */
export const HILL_MORE_CONTEXT_LABEL = "I need more context";
/** Intents the hill itself uses. A poster may not name an option with one of them. */
export const HILL_RESERVED_INTENTS: readonly string[] = ["answer", "dismiss", HILL_MORE_CONTEXT];
/** A device id on an answer: "dv_" and 16 hex characters, derived by the bridge from a pairing record. */
export const HILL_DEVICE_ID_RE = /^dv_[0-9a-f]{16}$/;
/**
 * A decision id: "dc_" and 12 characters, minted by the bridge; an ask's id is "ak_" and 12 characters
 * (Asks, 2026-11-22). Every place that tells a Decision id from a WalkyTalky message id (`wt_`) takes both.
 */
export const HILL_ID_RE = /^(?:dc|ak)_[a-z0-9]{12}$/;
/** An ask's id: "ak_" and 12 characters, minted by the bridge for a post from `collie walky ask`. */
export const HILL_ASK_ID_RE = /^ak_[a-z0-9]{12}$/;
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

// ── ASKS (2026-11-22): the limits of a post from `collie walky ask`. The Hill's own limits above stay
// for every other Decision; an ask is checked against these instead.

/** The question (`title`), in characters. It ends with `?`. */
export const HILL_ASK_QUESTION_MAX = 90;
/** The fact that decides it (`summary`), in characters. */
export const HILL_ASK_FACT_MAX = 240;
/** The background (`body`), Markdown, in characters. */
export const HILL_ASK_BODY_MAX = 20_000;
/** An ask with options has 2 to 5 of them; a `--words` ask has none. */
export const HILL_ASK_OPTIONS_MIN = 2;
export const HILL_ASK_OPTIONS_MAX = 5;
/** An option's label, in characters. Never a bare word of {@link HILL_ASK_BARE_LABELS}. */
export const HILL_ASK_LABEL_MAX = 60;
/** What an option does (its `detail`, required on an ask), in characters. */
export const HILL_ASK_DOES_MAX = 300;
/** The reason for the recommendation, in characters. */
export const HILL_ASK_WHY_MAX = 200;
/** Linked files one ask may carry. */
export const HILL_ASK_FILES_MAX = 10;
/** The longest path `--file` may name, in UTF-8 bytes. */
export const HILL_ASK_FILE_PATH_MAX = 4096;
/** A linked file's `#heading`, in characters. */
export const HILL_ASK_HEADING_MAX = 120;
/** Open asks one session may hold at once. The machine and total caps of the Hill stay beside it. */
export const HILL_ASK_OPEN_MAX = 5;
/** The agent's reason on a take back (`collie walky cancel <id> --because`), in characters. */
export const HILL_ASK_BECAUSE_MAX = 200;
/** Labels an ask's option may not be, compared lowercase with a trailing period dropped: they say nothing. */
export const HILL_ASK_BARE_LABELS: readonly string[] = ["yes", "no", "ok", "cancel"];
/** The answers one `POST /api/hill/answers` may carry: one Send per session, at most its open asks. */
export const HILL_ANSWERS_MAX = HILL_ASK_OPEN_MAX;
/**
 * The longest message one Send may type, in characters (code points): a WalkyTalky message's body
 * (bridge/walky/types.ts `WALKY_BODY_MAX`; bridge/hill/answers.test.ts holds the two equal).
 */
export const HILL_ANSWERS_MESSAGE_MAX = 4000;

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
 * 8), a carried trick that did not start after a takeover (crew slice 10, OK only), or a trick stopped
 * because it asks for a right its approval did not hold (fault B, bridge/tricks/rights-card.ts, OK only), or
 * the test Decision the person sends from the Hill's page (bridge/hill/test-card.ts, "It works" only).
 */
export type HillCollieRefType = "version" | "proposal" | "carried" | "rights" | "test";
export const HILL_COLLIE_REF_TYPES: readonly HillCollieRefType[] = ["version", "proposal", "carried", "rights", "test"];

/**
 * THE CARDS THAT WORK WITH THE HILL OFF (M96 spec 14, 2026-11-16). The Hill's switch gates what agents
 * and tricks ASK. A card of Collie's own about a trick is an approval, and it is posted, served and
 * answered with the Hill on or off. Every kind is listed here on purpose: a new kind of Collie card is a
 * compile error until someone decides whether it is about a trick. An agent's post and a trick's own
 * Decision are never in this table (they are no kind of Collie's own card), so the Hill off still refuses
 * them (bridge/hill/service.ts `postAny`, `answer`, `list`).
 */
export const HILL_OFF_TRICK_CARDS = {
  proposal: true,
  version: true,
  rights: true,
  carried: true,
  // The test Decision is about no trick: with the Hill off nothing posts, serves or answers it (the page
  // disables its button then), so it is no approval that must stay reachable.
  test: false,
} as const satisfies { readonly [K in HillCollieRefType]: boolean };

/**
 * Whether a sender or a decision's `from` is a card of Collie's own about a trick: kind `collie` with a
 * `ref` of a kind {@link HILL_OFF_TRICK_CARDS} lists. False for an agent and for a trick, always.
 */
export function isTrickCard(from: { readonly kind: string; readonly ref?: { readonly type: string } | undefined }): boolean {
  if (from.kind !== "collie" || from.ref === undefined) return false;
  const type = HILL_COLLIE_REF_TYPES.find((candidate) => candidate === from.ref?.type);
  return type !== undefined && HILL_OFF_TRICK_CARDS[type];
}

/**
 * Why Collie's card about a trick's changed rights closed (bridge/tricks/rights-card.ts), as the bridge
 * writes it into `closedReason` when it withdraws the card. One list for both sides: the phone says each
 * in its own words (lib/hill/words.ts `closedWord`), never "Withdrawn by the poster".
 */
export const RIGHTS_CLOSED = {
  /** The trick runs again: a switch on approved the rights it asks for now. */
  approved: "It runs again with the rights it asks for now.",
  /** The trick is off. */
  off: "The trick is off.",
  /** The trick's folder is gone. */
  removed: "The trick was removed.",
  /** It asks for other rights again: a new card says so. */
  moved: "Its rights changed again; a new card says so.",
} as const;
export type RightsClosed = keyof typeof RIGHTS_CLOSED;

/**
 * Why an agent's card closed `withdrawn` with nothing typed: the person wrote in the session (the second
 * Clear, or a phone send that started the session's next turn, M96 spec 10). It says only that they wrote,
 * never that the message answered the card: Collie cannot know what the message was about. The phone
 * says it in its own words, never "Withdrawn by the poster". The name stays for its callers.
 */
export const HILL_ANSWERED_IN_SESSION = "your person wrote in the session";

/** The closed reason of a Decision its poster took back (`collie hill withdraw`, `collie walky cancel`). */
export const HILL_BY_THE_POSTER = "by the poster";
/**
 * The closed reason of an ask the agent closed with `collie walky cancel <id> --answered`: the person gave
 * the answer in the session itself (Asks, 2026-11-22). Its own reason, state `withdrawn`, so the phone says
 * "answered in the session" and never "taken back". Not {@link HILL_ANSWERED_IN_SESSION}, which Collie
 * sets when it only saw the person write.
 */
export const HILL_ASK_ANSWERED_HERE = "answered in the session";
/** The prefix of an ask's closed reason when the agent gave a reason for its take back. */
const BECAUSE_PREFIX = `${HILL_BY_THE_POSTER}: `;

/** The closed reason of a take back: {@link HILL_BY_THE_POSTER}, with the agent's reason after it when it gave one. */
export function askTakenBack(because: string | null): string {
  return because === null || because === "" ? HILL_BY_THE_POSTER : `${BECAUSE_PREFIX}${because}`;
}

/** The agent's reason inside a take back's closed reason (`--because`), or null when it gave none. */
export function askTakenBackBecause(closedReason: string | null): string | null {
  if (closedReason === null || !closedReason.startsWith(BECAUSE_PREFIX)) return null;
  const because = closedReason.slice(BECAUSE_PREFIX.length);
  return because === "" ? null : because;
}
export const RIGHTS_CLOSED_KEYS: readonly RightsClosed[] = ["approved", "off", "removed", "moved"];
/** The id inside a Collie Decision's `ref`: a trick id for `version`. */
export const HILL_COLLIE_REF_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The hash inside a Collie Decision's `ref`: the sha256 of the code the answer is about, in hex. */
export const HILL_COLLIE_REF_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * A GROUP OF CARDS (crew slice 8): one Decision of Collie's own whose code does not fit one card shows as
 * 2 to 8 cards in a fixed order. Card 1 is Collie's facts, never code; cards 2 to n hold the code. The
 * answer that switches on carries the group's digest the phone was given (ADR 0156); its `opened` field is
 * a legacy field for an older bridge ({@link HillGroupAnswer}).
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

/**
 * What a phone sends with a yes to Collie's own card of code (a group, or a single card): the digest it was
 * given, so the yes approves exactly the code it showed. Since ADR 0156 this bridge asks only for the digest.
 */
export interface HillGroupAnswer {
  digest: string;
  /**
   * LEGACY FIELD (ADR 0156): every card number, 1 to n. A bridge of 1.29.0-edge.1 to edge.4 (a crew member, or a
   * lead not yet updated) still refuses a yes that does not name every card here, so the phone always sends it
   * whole. This bridge reads it and ignores it. Drop it once no supported bridge asks for it.
   */
  opened?: number[];
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

/** The longest display name a card of Collie's own carries, in characters (an ellipsis counts as one). */
export const HILL_CARD_NAME_MAX = 40;

/**
 * A trick's display name for a card of Collie's own (`from.name`): one line of plain text. White space runs
 * become one space, every control and hidden character (hidden-chars.ts) is taken out, and a name longer than
 * {@link HILL_CARD_NAME_MAX} ends in an ellipsis. The name comes from a manifest an agent may have written,
 * so it is only ever drawn as text. Undefined when nothing is left, so a card then falls back to its id. Both
 * sides run this one function: the bridge before it stores a card, the phone before it draws one.
 */
export function cardName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const chars = [...raw.replace(/\s+/gu, " ")].filter((ch) => !isHiddenChar(ch));
  const text = chars.join("").trim();
  if (text === "") return undefined;
  const cut = [...text];
  return cut.length <= HILL_CARD_NAME_MAX ? text : `${cut.slice(0, HILL_CARD_NAME_MAX - 1).join("").trimEnd()}…`;
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

/** One linked file of an ask: a pointer, never a copy. The bridge never reads, copies or serves its content. */
export interface HillAskFile {
  /** Relative to the ask's `root`, `/`-separated, as the Files routes take it in `?path=`. */
  path: string;
  /** `path#heading` as the agent gave it: at most {@link HILL_ASK_HEADING_MAX} characters. Stored, never used to read. */
  heading?: string;
  /** `path:line` as the agent gave it: a positive integer. Stored, never used to read. */
  line?: number;
}

/** What makes a Decision an ask (`collie walky ask`, 2026-11-22). */
export interface HillAsk {
  /** The ask takes its answer in words and has no options. */
  words: boolean;
  /** Linked files: a pointer, never a copy. `path` is relative to `root`. At most {@link HILL_ASK_FILES_MAX}. */
  files: HillAskFile[];
  /**
   * What the phone needs to open a linked file in Files: the PANE ID of the poster's pane at post time, as
   * `GET /api/pane/<pane id>/files?path=<path>` takes it. The paths hang under that pane's Files root (its
   * workspace root as the pane sees it, else its own bounded folder), the same root the bridge measured
   * them against. Null when the pane had no Files root, and on an ask a crew member forwarded (the lead
   * cannot see the member's disk). The phone adds `?host=<from.memberId>` for a crew member's pane.
   */
  root: string | null;
  /** Part B fills this: ms of the agent's last keep. Absent until then. */
  confirmedAt?: number;
}

/** Whether a Decision is an ask. */
export function isAsk(decision: Pick<HillDecision, "ask">): decision is Pick<HillDecision, "ask"> & { ask: HillAsk } {
  return decision.ask !== undefined;
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
    /**
     * Collie's own card about a trick only (proposal, version, rights, carried): the trick's display name from
     * its approved or proposed manifest, cleaned by {@link cardName}. Optional on the wire: a card from an
     * older bridge has none and the phone falls back to `ref.id`. Display only, never a key.
     */
    name?: string;
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
    /**
     * Set when the typed line ended with its write not confirmed: walky's receipt said `unknown`, stayed a
     * bare `accepted` past the wait, or the send threw. Never for typed, held, or a line that waits in the
     * inbox (typed, not submitted). The answer is not sent again; the phone says it may not have arrived.
     */
    unconfirmed?: true;
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
  /**
   * When the person last sent into the posting session from the phone's composer after this Decision was
   * posted (1.29.0), ms since the epoch. Set on an open agent Decision only, by the lead whose session it
   * is; absent until then. The card says "You wrote to this session after it asked." and sorts below the
   * fresh cards of its priority, and it stays open and answerable.
   */
  spokeAfter?: number;
  /**
   * Present on an ask (`collie walky ask`); absent on every other Decision. An ask is stored with priority
   * `today` and no expiry, never pushes, and never gets `spokeAfter`.
   */
  ask?: HillAsk;
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

/** One `--file` as the CLI sends it: the absolute real path it resolved, and the place as the agent gave it. */
export interface HillAskFileInput {
  path: string;
  heading?: string;
  line?: number;
}

/** What a post from `collie walky ask` adds to the post's fields. */
export interface HillAskInput {
  words: boolean;
  files: HillAskFileInput[];
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
  /** Present on a post from `collie walky ask`: the post is an ask, checked against the `HILL_ASK_*` limits. */
  ask?: HillAskInput;
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
  /** The crew state asked of a member whose lead runs a release too old to say it (1.29.0); an ask forwarded to a lead that does not know asks. */
  | "lead_too_old"
  /** An ask's `--file` that names no file the Files view would open under the pane's root (Asks). */
  | "bad_file";

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

/** 1 for a card the person wrote to the session about (`spokeAfter`), 0 for a fresh one. */
function sunk(decision: HillDecision): number {
  return decision.spokeAfter === undefined ? 0 : 1;
}

/**
 * Open decisions in the order the phone shows them: now, today, later; inside one priority the fresh ones
 * first, then those the person wrote to the session about (`spokeAfter`), each oldest first. Does not mutate.
 */
export function sortOpenDecisions(list: HillDecision[]): HillDecision[] {
  const rank = (p: HillPriority): number => HILL_PRIORITIES.indexOf(p);
  return list.toSorted((a, b) => rank(a.priority) - rank(b.priority) || sunk(a) - sunk(b) || a.at - b.at);
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

/**
 * What "Tell all sessions now" types into each session: the bare line. WalkyTalky puts the one head
 * (`from operator`) in front of it, so the body carries no second head (C-A3, review 8).
 */
export function crewStateTellLine(state: HillCrewState): string {
  return crewStateLine(state);
}

/** The most sessions one "Tell all sessions now" reaches. */
export const HILL_TELL_MAX = 20;
/** A session that posted a Decision this long ago or less is told, even when that Decision closed. */
export const HILL_TELL_RECENT_MS = 60 * 60 * 1000;

// ── ONE SEND PER SESSION (Asks, 2026-11-22): `POST /api/hill/answers` ───────────────────────────────
// The same gate as `POST /api/hill/answer` (a paired device with the write right). The bridge claims each
// ask in the answer lane, closes each as answered with its own receipt, and types ONE WalkyTalky message
// from the operator into the session (answers-message.ts `answersMessage`, which the phone shows first).

/** One answer of a Send: an open ask's id, and `intent` one of its options, `more-context`, or `answer` for a `--words` ask. */
export interface HillAnswersEntry {
  id: string;
  intent: string;
  /** The note (optional on every answer), or the words of a `--words` ask (required there). */
  text?: string | null;
}

/** What the phone sends for one Send: 1 to {@link HILL_ANSWERS_MAX} answers, all to asks of one session. */
export interface HillAnswersRequest {
  /** A UUID the phone minted. A repeat answers with the stored result and runs nothing. */
  rid: string;
  answers: HillAnswersEntry[];
}

/** What one ask of a Send came to: `ok` (closed as answered), or `gone` (it closed before the Send) and why. */
export interface HillAnswersItem {
  id: string;
  code: "ok" | "gone";
  /** Plain words for a `gone` one, for example "the decision is withdrawn"; null for `ok`. */
  reason: string | null;
  /** The ask's state after this Send. */
  state: HillState | null;
}

/** The 200 answer of `POST /api/hill/answers`. */
export interface HillAnswersResult {
  rid: string;
  /** One entry per answer the request named, in its order. */
  items: HillAnswersItem[];
  /** What walky reported of the one message; `none` when every ask had closed and nothing was typed. */
  delivery: "typed" | "held" | "unknown" | "none";
  /** Set when the typed message's write was not confirmed (see `HillDecision.answer.unconfirmed`). */
  unconfirmed?: true;
  at: number;
}

/** Why a whole Send was refused: nothing closed and nothing typed. */
export type HillAnswersRefusalCode =
  /** The message would be longer than a WalkyTalky message may be; `over` says by how many characters. */
  | "too_long"
  /** The answers name asks of more than one session (sender address). */
  | "mixed_sessions"
  /** An id that is not an ask this bridge holds; `id` names it. */
  | "not_an_ask"
  /** An answer this ask does not take (not one of its options, text missing on a `--words` ask); `id` names it. */
  | "bad_answer"
  /** The session's machine is not answering now (a crew member); `machine` names it. */
  | "not_answering"
  /** WalkyTalky refused to type the message now (a rate limit, the pane busy); the asks stay open. */
  | "not_typed"
  /** The `rid` was used for another Send. */
  | "rid_reused";

/** The 409 body of a refused Send. */
export interface HillAnswersRefusal {
  code: HillAnswersRefusalCode;
  error: string;
  /** On `too_long`: how many characters over {@link HILL_ANSWERS_MESSAGE_MAX}. */
  over?: number;
  /** On `not_an_ask` and `bad_answer`: the id. */
  id?: string;
  /** On `not_answering`: the machine's name. */
  machine?: string;
}
