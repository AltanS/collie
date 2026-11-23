// The hill (M96): an agent posts a Decision, a person answers it on the phone, and the answer is typed
// into the agent's pane as that person's own WalkyTalky message.
//
// What the walky socket (bridge/walky/socket.ts) and the phone's routes (bridge/server.ts) both call.
// Pure where it can be: the clock, the id mint, the walky send and the "is this address live" probe are
// injected, so `bun test` drives every rule with fakes.
//
// WHO POSTS. The bridge names the poster from the socket's pane binding, exactly as a walky send names
// its sender: the poster's walky address with its instance token. The socket can only ever make
// `from.kind: "agent"`. `postDecision` also takes `"trick"`, for code inside the bridge.
//
// WHERE THE ANSWER GOES. To `replyTo` when set, else to the poster's own address, resolved at post time
// to one live session and kept with its instance token. At answer time that token must still match, or
// the decision closes `undeliverable` and nothing is typed. The answer is typed through the operator
// walky send (`WalkyService.send` with `{ kind: "operator", label }`), as `POST /api/walky` does it.
// The hill has no path of its own into a pane.
//
// NO POSTER WORDS WITH THE PERSON'S AUTHORITY IN ANOTHER SESSION. The answer is typed as the operator.
// Into the poster's own session it may quote the title and the option's label: the poster wrote them for
// itself. Into another session (`replyTo` names someone else, and always for a trick) it carries only the
// id, the option's intent word, the person's own text and one fixed line (`answerMessage`); that session
// reads the decision itself with `collie hill status <id>`, which answers the poster and the `replyTo`
// session, nobody else.
//
// THE NAMES ON THE CARD. `from.label` and `target.label` are the session's name as the Dashboard's row
// shows it (`sessionName`, injected; hill/walky.ts `hillSessionName`), with the walky label (folder
// and branch) only when the bridge has no name for the pane. Several sessions often share one folder
// and branch, so the walky label alone does not say which session asked. An open decision is served
// with the name the pane has NOW, while that pane is live; a closed one keeps the name it had. The
// walky address stays the routing key and is never renamed.
//
// ORDER ON AN ANSWER. Write the receipt, close the decision, then send. A send that fails or throws
// after the close leaves the decision answered with `delivery: "unknown"`, and nothing is sent again;
// one `hill.undelivered` audit line says so, and the session reads the answer with `collie hill status`.
// A bridge that stopped between the receipt and the close left an `ok` receipt the decision does not
// show: a retry of that `rid` settles it once, in the claim lane, instead of answering the stale `ok`.
// An answer to an id this bridge never held, or one past its expiry, is `gone`; the first stores no
// receipt, so junk cannot push real receipts out of the capped file.
//
// A TRICK'S DECISION (M94). A trick posts through `postDecision` from the tricks runner
// (bridge/tricks/hill.ts). The answer reaches the trick's program as a tap, after the walky message
// when `replyTo` is set, with the answer's own `rid`, through the injected `tap` (this file never
// imports the tricks service; bridge/index.ts wires the two). The receipt and the answer record what
// the tap came to in `trick`: `ran`, or `failed` (written first, so a bridge that stops before the tap
// says so), never retried. A `gone` target runs no tap: one outcome, not half of one.
//
// A `now` DECISION RINGS THE PHONE ONCE (push.ts). Decided at the fresh post or supersede and recorded as
// `pushTag` in the same write; every write goes through `save`, which closes the notification of a
// decision that closed holding a slot no successor took.
//
// CLEAR (the phone's and the CLI's Clear). A person clears the closed decisions: `clear` removes them from
// the store with their images, bumps the revision so every phone updates, writes one `hill.clear` audit
// line, and never touches an open decision. It works with the Hill off, because it types nothing, posts
// nothing and rings nothing, as status, list and withdraw do. What stays of a cleared decision is a
// tombstone (store.ts): a repeated post request id is refused instead of posting twice, a late answer
// reads `gone` with the state it closed in, and a trick's answered key stays closed. The answer receipts
// are a file of their own and are not touched, so a retried answer `rid` still gets its stored receipt.
//
// THE SWITCH (switch.ts). The Hill is an experiment, off until the person switches it on; no file reads off.
// A crew member with no file follows its lead (`refusesHere`). With the Hill off, a post from an agent or a trick is refused (`hill_off`) and
// an answer from the phone is refused too (`off`), so nothing pushes, nothing is typed and no tap runs.
// The open decisions stay as they are: nothing withdraws or closes them, and they show again when the
// Hill is back on.
//
// ONE EXCEPTION, AND ONLY ONE (M96 spec 14, 2026-11-16): a card of Collie's own about a trick (wire.ts
// `isTrickCard`: a proposal, a new version, a trick's rights, a carried trick) is an approval, not a
// question an agent or a trick asks. With the Hill off it is still posted (`postAny`), answered (`answer`)
// and read (`list`, which then serves ONLY those cards), exactly as with the Hill on. Its sender is built
// only by code inside the bridge (`postCollie`); no door makes one, so an agent's `collie hill post`, a
// crew member's forwarded post and a trick's own Decision stay refused. An answer opens only for a
// decision the store holds as such a card. The sweep still closes an expired one, or one whose target ended. Status, list and
// withdraw keep working, so an agent can clean up. When the switch is seen to go off, the notification
// of every open `now` decision is closed once, so the phone does not keep a question it cannot open.
//
// THE CREW STATE (crew-state.ts, 1.29.0). `here`, `quiet` or `away`, set by the person. It never refuses
// a post. With `quiet` or `away` a new Decision pushes nothing (`pushPlan`), and the typed answer ends
// with `Crew state: away.` (`withCrewLine`), as the post's result does (`postFields`). "Tell all sessions
// now" (`tellAll`) types one operator line through the same send an answer uses, once per change, into
// at most 20 sessions of this machine that hold an open Decision or posted one in the last hour.

import { randomBytes } from "node:crypto";

import type { AuditEntry } from "../audit.ts";
import { HILL_DEFAULT_EXPIRY_DAYS, HILL_DEFAULT_EXPIRY_MS, HILL_MAX_EXPIRY_DAYS, HILL_MAX_EXPIRY_MS } from "../../web/src/lib/tricks/limits.ts";
import type { JsonObject } from "../json.ts";
import {
  HILL_ANSWER_TEXT_MAX,
  HILL_ANSWERED_IN_SESSION,
  HILL_DEVICE_ID_RE,
  HILL_LINK_HREF_MAX,
  HILL_LINK_LABEL_MAX,
  HILL_LINKS_MAX,
  HILL_MEDIA_CAPTION_MAX,
  HILL_MEDIA_MAX,
  HILL_NOW_MAX,
  HILL_OPEN_MAX,
  HILL_OPTION_CONFIRM_MAX,
  HILL_OPTIONS_MAX,
  crewStateLine,
  cardName,
  crewStateTellLine,
  HILL_TELL_MAX,
  HILL_TELL_RECENT_MS,
  hillNode,
  isHillOptionIntent,
  isTrickCard,
  sortOpenDecisions,
  HILL_ASK_ANSWERED_HERE,
  HILL_ASK_BECAUSE_MAX,
  HILL_ASK_OPEN_MAX,
  HILL_BY_THE_POSTER,
  HILL_MORE_CONTEXT,
  HILL_MORE_CONTEXT_LABEL,
  askTakenBack,
  type HillAsk,
  type HillAskFileInput,
  type HillAnswersRefusal,
  type HillAnswersRequest,
  type HillAnswersResult,
  type HillAnswerRequest,
  type HillCollieRef,
  type HillCrewState,
  type HillCrewStateView,
  type HillDecision,
  type HillImageInput,
  type HillMedia,
  type HillOption,
  type HillPostInput,
  type HillReceipt,
  type HillRefusalCode,
  type HillState,
} from "../../web/src/lib/hill/wire.ts";
import { singleCodeCard, trickCardDecline } from "../../web/src/lib/hill/code-card.ts";
import { parseAddress } from "../walky/address.ts";
import { cleanBody } from "../walky/clean.ts";
import type { WalkyPane } from "../walky/deliver.ts";
import { headerField, WALKY_BODY_MAX, WALKY_LABEL_MAX } from "../walky/types.ts";
import { digestDiffers, payloadDigest, withDigest } from "../worktree-receipts.ts";
import { HILL_GROUP_NOT_YOURS, readPostFields } from "./parse.ts";
import { makeGroup } from "./group.ts";
import { mintMediaId, type HillImageBytes, type HillMediaFile, type HillMediaStore } from "./media.ts";
import { HILL_PUSH_RATE, hillPushTag, hillRingBlock, type HillPushPort, type HillRingBlock, type HillRingFacts } from "./push.ts";
import { HILL_TEST_DELAY_MS, testCard, testSender, type HillTestTimer } from "./test-card.ts";
import { hillAnswerDigest, type HillAnswerOutcome, type HillReceiptRecord, type HillReceiptSurface } from "./receipts.ts";
import type { HillStore, HillTombstone } from "./store.ts";
import type { HillLeadForward, HillListAnswer } from "./crew.ts";
import { HILL_CREW_STATE_DEFAULT, type HillCrewStateFile } from "./crew-state.ts";
import type { HillSwitchReading } from "./switch.ts";
import { askRuleRefusal, HILL_ASK_LIMITS, HILL_LIMITS, tooManyAsks, type HillPostLimits } from "./ask-rules.ts";
import type { HillAskFilesAnswer } from "./ask-files.ts";
import type { AskCheckBook, AskCheckDecision } from "./check.ts";
import { askAnswerRid, resultOf, sendDigest, sendRecord } from "./answers.ts";
import { answersMessage, ASKS_ANSWERS_SUBJECT } from "../../web/src/lib/hill/answers-message.ts";

/**
 * A session's or a trick's name, never Collie's own (crew slice 8 review Q1, Q2): a name that reads
 * "Collie" once case, width and compatibility forms are set aside gets `(a session)` or `(a trick)` after
 * it. The card's mark (the agent's logo or the trick's glyph, never the app's) says the rest.
 */
export function notCollie(label: string, what: "a session" | "a trick"): string {
  return label.normalize("NFKC").trim().toLowerCase() === "collie" ? `${label} (${what})` : label;
}

/** An agent in a pane this bridge placed: what the socket can name. */
export interface HillAgentSender {
  readonly kind: "agent";
  /** The poster's walky address, `<member>/<pane>#<token>`. The sender's identity. */
  readonly address: string;
  readonly memberId: string | null;
  readonly harness: string | null;
  readonly label: string;
  readonly host: string | null;
}

/** A trick, posting through the tricks runner inside the bridge. Never reachable from the socket. */
export interface HillTrickSender {
  readonly kind: "trick";
  readonly trickId: string;
  /** The decision's `key` in the trick's document; the answer comes back to the trick as `hill/<key>`. */
  readonly trickKey: string;
  /** The trick's name, as its manifest gives it. Display only. */
  readonly label: string;
  /**
   * The member id of the bridge the trick runs on (bridge/bridge-id.ts); the tap goes there. It is
   * stored as the decision's `from.trickHost`; `from.host` is the machine's display name.
   */
  readonly memberId: string;
  /**
   * The trick's own folder, its real path, from the runner: the one root inside the config folder this
   * trick's images may come from (media.ts, "A TRICK'S OWN FOLDER"). Absent: the images take the agent's rules.
   */
  readonly imageRoot?: string;
}

/** The tap an answer to a trick's decision becomes: the answer's `rid`, `hill/<key>`, the intent, the words. */
export interface HillTrickTap {
  readonly rid: string;
  readonly node: string;
  readonly intent: string;
  readonly value: { readonly text: string | null };
}

export type HillSender = HillAgentSender | HillTrickSender;

/**
 * Collie itself (crew slice 3): a Decision about a trick's new version. Only code inside the bridge
 * builds one (bridge/tricks/version-card.ts), through `postCollie` and `withdrawCollie`, which no door
 * reaches: the walky socket and the crew post build an agent's sender, the trick runner a trick's.
 */
export interface HillCollieSender {
  readonly kind: "collie";
  readonly ref: HillCollieRef;
  /** The name the card shows as its sender, such as the trick's name. Display only. */
  readonly label: string;
  /** The trick's display name from its manifest (`from.name`); {@link cardName} cleans it as the card is made. Optional. */
  readonly name?: string;
}

/** What `requestTest` answers: the seconds until the card is posted and the first reason no notification would be sent, or a refusal. */
export type HillTestAnswer = { readonly ok: true; readonly inSeconds: number; readonly rings: HillRingBlock | null } | { readonly ok: false; readonly code: "hill_off" | "not_on_lead"; readonly error: string };

/** What the answer to a Collie Decision did: done, or refused in plain words (the card then stays open). */
/**
 * What Collie's own handler made of an answer. `told`: one plain line of what happened (installed, nothing
 * installed), typed into the session Collie tells, after the option line (the first full trick run,
 * 2026-11-16, decision 9). Agent-facing English, never a phone string.
 */
export type HillCollieVerdict = { readonly ok: true; readonly told?: string } | { readonly ok: false; readonly reason: string };

/** Every sender a decision can have; the public doors take only {@link HillSender}. */
type AnySender = HillSender | HillCollieSender;

/** One live session a walky address names now, as the probe resolves it. */
export interface HillPlace {
  /** The address with the session's instance token, as `who` lists it. */
  readonly address: string;
  readonly label: string;
  readonly host: string | null;
  /** The session runs in bypass or auto-approve mode, when the bridge knows it. */
  readonly unattended: boolean;
  /**
   * False when the session is on a crew machine the lead cannot reach now (the crew's targets list it
   * `unreachable`, walky's `crewTargets`). Absent or true: reachable, as every session on this machine is.
   */
  readonly reachable?: boolean;
}

/** What the walky send reported: typed, held by walky's hold rule, or not confirmed. */
export type HillDelivery = "typed" | "held" | "unknown";
/** What one send came to: a delivery, or `refused` when walky typed nothing (a rate limit, a pane gone). */
/**
 * What a send reports. `inbox-only`: the line waits in the session's inbox (typed but not submitted, a
 * dialog); the answer shows it as `unknown`, but its write is known, so it is not marked `unconfirmed`.
 */
export type HillSendResult = HillDelivery | "refused" | "inbox-only";

/** The crew role of this bridge, as `crew.mode` names it in bridge/index.ts. */
export type HillCrewMode = "solo" | "lead" | "peer";

export interface HillServiceDeps {
  readonly store: HillStore;
  readonly receipts: HillReceiptSurface;
  /** The one live session a walky pane address names now, or null (gone, a shell, not an address). */
  place(address: string): HillPlace | null;
  /** Type `body` into the session at `to` as an operator walky message under the label `by`, with a subject when given (an ask's answers). */
  send(to: string, body: string, by: string, subject?: string): Promise<HillSendResult>;
  /**
   * The send "Tell all sessions now" uses (1.29.0): the same operator message, counted in a rate bucket of
   * its own (`hill-tell`), so a tell never spends the bucket the typed answers use. Absent: `send`.
   */
  readonly tell?: (to: string, body: string, by: string) => Promise<HillSendResult>;
  crewMode(): HillCrewMode;
  /**
   * True while this bridge is a deposed lead (CREW_PROTOCOL §18.12): another machine took the crown, so
   * a post here would sit on a Hill nobody leads. Refused like a peer's (§25). Absent: never deposed.
   */
  readonly deposed?: () => boolean;
  /** False with COLLIE_WALKY=off: no answer could be typed, so no decision is taken. */
  walkyOn(): boolean;
  /**
   * This bridge's stable id (bridge/bridge-id.ts): the crew member id, or the install id on a solo
   * install. Every decision's `from.memberId`. Not the walky member (`local` on a solo install).
   */
  readonly memberId: string;
  /** Write `memberId` to the state folder before the first Decision stores it (bridge-id.ts `keep`). Absent in a test. */
  readonly keepId?: () => void;
  /** This machine's name, as walky's `who` prints it. */
  readonly machine: string;
  readonly now?: () => number;
  readonly mintId?: () => string;
  /** The id mint of an ask (`ak_`). Absent: {@link mintDecisionId} with the `ak_` prefix. */
  readonly mintAskId?: () => string;
  /**
   * The linked files of an ask from a pane of THIS machine (ask-files.ts `askFilesResolver`): the root the
   * phone opens them under, and each path relative to it, checked by the Files view's own rules. Absent: an
   * ask records no root, and a `--file` is refused.
   */
  readonly askFiles?: (address: string, files: readonly HillAskFileInput[]) => Promise<HillAskFilesAnswer>;
  /**
   * The check at the end of a turn (check.ts, .adr/0177): the turn each pane is in, the brake, and the lift of
   * a pane while its check runs. Absent: `ask.check` answers "none" and nothing is counted.
   */
  readonly checks?: AskCheckBook;
  readonly audit?: (entry: AuditEntry) => void;
  /**
   * Run a trick's program with an answer as its tap (bridge/index.ts wires it to the tricks runner).
   * True when the run succeeded. Absent: no tricks runner, so every trick's answer is `failed`.
   */
  readonly tap?: (host: string, trickId: string, tap: HillTrickTap, decisionId: string) => Promise<boolean>;
  /** Where a decision's images are read and kept (media.ts). Absent: a post with images is refused. */
  readonly media?: HillMediaStore;
  readonly mintMediaId?: () => string;
  /** The session's Dashboard name for the live pane a walky address names now, or null to keep the walky label. */
  readonly sessionName?: (address: string) => string | null;
  /**
   * Run `fn` with one look at the live sessions: every `place` and `sessionName` inside it reads the
   * same `who` list (bridge/index.ts, hill/walky.ts `OneLook`). Absent: each call looks for itself.
   */
  readonly look?: <T>(fn: () => T) => T;
  /**
   * Whether this bridge holds a census of the machine `address` is on that was read with success (M96
   * spec 10): on this machine, every multiplexer it drives answered its last read since the bridge
   * started; on a crew member, the lead's sweep reached it and that machine's own reads answered. An
   * EMPTY list from a good census is a fact (every agent left). False is unknown: right after boot, a
   * read that failed, a multiplexer that does not answer. Then the sweep closes nothing for that
   * address, and the row of absent sweeps starts again. Absent: always true.
   */
  readonly censusKnown?: (address: string) => boolean;
  /**
   * Whether `address` is on a crew machine that this bridge's roster, read with success, no longer lists
   * (M96 spec 10): the member was removed (`collie crew remove`, or its own `collie leave`). Never this
   * machine, never a machine that merely does not answer, and false when the roster could not be read.
   * Then the sweep closes every open card whose answer would go there. Absent: never.
   */
  readonly removed?: (address: string) => boolean;
  /** The phone push of a `now` decision (push.ts). Absent: no decision pushes. */
  readonly push?: HillPushPort;
  /**
   * The facts of the push gates that only the bridge knows (push.ts `hillRingBlock`), read on each use, for
   * the test Decision's verdict of why a notification would not be sent. Absent: every gate is open and a
   * device is subscribed (a test seam; bridge/index.ts always wires it).
   */
  readonly ringFacts?: () => Pick<HillRingFacts, "push" | "pref" | "snoozed" | "member" | "devices">;
  /** The timer of the test Decision's delay. Absent: `setTimeout`. A test seam. */
  readonly timer?: { set(fn: () => void, ms: number): HillTestTimer };
  /**
   * The Hill's own switch (switch.ts `HillSwitch`), read on each use, and written by the phone's route
   * (`set`, true when written). `reading` tells unset (no file) from off; a switch that gives none reads
   * `on` or `off` by `on()`. Absent: always on, and the switch cannot be moved. That absence is a TEST SEAM
   * only: the one production construction (bridge/index.ts `new HillService`) always wires the file switch.
   */
  readonly hillSwitch?: { on(): boolean; reading?(): HillSwitchReading; set?(on: boolean): boolean };
  /**
   * Whether tricks as a whole are switched on on this machine (bridge/tricks/feature-switch.ts), read on each
   * use. While off, a trick's own Decisions follow the rule of the Hill's own switch: they stay in the store
   * untouched (their expiry still runs), the list does not serve them, an answer to one is refused before
   * anything closes, and their notifications close once at the move to off. They show again once tricks are
   * on. Collie's own cards about a trick are not a trick's Decisions and stay as they are. Absent: always on
   * (a test seam; bridge/index.ts always wires the file switch).
   */
  readonly tricksOn?: () => boolean;
  /**
   * The crew state (crew-state.ts `HillCrewStateFile`), read on each use. Absent: always `here`, and it
   * cannot be set.
   */
  readonly crewState?: Partial<Pick<HillCrewStateFile, "set" | "markTold" | "setTold">> & Pick<HillCrewStateFile, "read">;
  /**
   * On a crew member (CREW_PROTOCOL §22, 1.29.0): the forward to its lead, which holds the one Hill. With
   * it, an agent's post, status, withdraw and list from this machine go to the lead. Absent: a member
   * refuses a post with `not_on_lead`, as before 1.29.0.
   */
  readonly forward?: HillLeadForward;
  /**
   * On a lead: the name of the crew machine a walky address is on, when that machine is not answering
   * now (unreachable, or not swept yet since this bridge started), else null. An answer for a session
   * there is refused before the decision closes, and the sweep never closes one for it. Absent: none.
   */
  readonly offline?: (address: string) => string | null;
  /**
   * Act on the answer to a Collie Decision (crew slice 3; bridge/index.ts wires it to the version card).
   * It checks `ref.hash` against the thing as it is now and refuses when it moved. Called once per answer,
   * in the claim lane, before the decision closes; a refusal keeps the card open. Absent: refused.
   */
  readonly onCollieAnswer?: (ref: HillCollieRef, intent: string) => Promise<HillCollieVerdict>;
}

/** What a new decision does about the phone: the slot it holds, whether it sends, and why a rate held it. */
interface HillPushPlan {
  readonly tag: string | undefined;
  readonly send: boolean;
  readonly skipped: string | null;
}

/** How a post came about, beyond its input. Only code inside the bridge sets it. */
export interface HillPostOptions {
  /**
   * A trick posts a key again, unchanged, after its decision closed without the person (tricks/hill.ts
   * `mayReask`). It shows as any post does, and never pushes: the phone heard of that question once.
   */
  readonly reask?: boolean;
  /**
   * The poster's own session as its crew member claims it (crew.ts, CREW_PROTOCOL §22): used when this
   * bridge's `place` does not list the pane yet, for a pane opened since the last sweep.
   */
  readonly own?: HillPlace;
  /**
   * The post's images, already read and checked: a crew member's upload, in the order of `input.images`,
   * whose paths then only name them. Absent: each image is read from its path on this machine.
   */
  readonly images?: readonly HillImageBytes[];
  /**
   * Collie's own Decision only (crew slice 8, a trick proposal): the live session told of the answer, as
   * a courtesy. It is stored as `replyTo`, so that session may read the Decision with `collie hill
   * status`; the card names no target, so the session ending or its machine going away never closes the
   * card, never holds the person's answer, and the answer is typed there only while it is live.
   */
  readonly tellOf?: string;
  /**
   * An ask's linked files and root, already resolved on this machine under the Files rules (ask-files.ts).
   * Absent: the ask records no root, and an ask that names files is refused (a crew member's forwarded ask,
   * whose files the lead cannot check).
   */
  readonly askFiles?: { readonly root: string | null; readonly files: HillAsk["files"] };
}

/** The sentence a `--file` gets where the bridge cannot check the files: a crew member's ask, in this build. */
/** What a crew member answers `ask.keep` with: its asks are on the lead, and the crew wire carries no keep yet. */
export const ASK_KEEP_MEMBER = "keep works on the lead's own sessions in this build; the asks of this machine stay as they are";
export const ASK_FILES_LEAD_ONLY = "linked files work on the lead's own sessions in this build; send the ask again without --file";

/**
 * A post's answer: the stored decision, or a refusal with its code and plain words the CLI prints. A
 * post taken from a session also carries the crew state at that moment (`crewState`), which the CLI
 * prints as one line when it is not `here`; absent from a lead before the crew state.
 */
export type HillPostAnswer = { readonly ok: true; readonly decision: HillDecision; readonly crewState?: HillCrewState } | { readonly ok: false; readonly code: HillRefusalCode | null; readonly error: string };

/** What "Tell all sessions now" came to: how many sessions it typed the line into, or why it did not. */
export type HillTellAnswer = { readonly ok: true; readonly told: number } | { readonly ok: false; readonly error: string };

/** The refusal of a tell for a state the phone did not see: it moved since. */
export const HILL_TELL_MOVED = "the crew state changed since this phone showed it; look again";
/** The refusal of a second tell for one change of the state. */
export const HILL_TELL_DONE = "the sessions were told of this crew state already";
/** The refusal of a crew state set on a machine that is not the crew's lead. */
export const HILL_STATE_ON_LEAD = "the crew state lives on the crew's lead; set it there, on the phone or with collie hill state";
/**
 * The reason an answer walky refused to type is rejected with (C-S1): nothing was typed, and the card is
 * open again. The phone shows it as "Not accepted: <reason>".
 */
export const HILL_NOT_TYPED = "it could not be typed into the session now, so the Decision stays open; answer again in a few minutes";

/** The reason a card the person answered in its session closes with (wire.ts): the second Clear, or a send that started the turn. */
export { HILL_ANSWERED_IN_SESSION };
/** What the second Clear answers when the Hill could not be saved: nothing changed. */
export const HILL_SPOKEN_UNSAVED = "the Hill could not be saved on this machine; nothing was cleared";
/** The refusal of a crew state set whose file could not be written. */
export const HILL_STATE_UNSAVED = "the crew state could not be saved on this machine; nothing changed";
/** The refusal of a tell while the state is `here`: there is nothing to tell. */
export const HILL_TELL_HERE = "the crew state is here; there is nothing to tell";

/** A status or withdraw answer. `missing`: this bridge holds no such decision from this sender. */
export type HillOneAnswer = { readonly ok: true; readonly decision: HillDecision } | { readonly ok: false; readonly missing: true; readonly error: string } | { readonly ok: false; readonly missing: false; readonly error: string };

/** What a lead carries of its Hill to its deputy (CREW_PROTOCOL §25, `HillService.carryView`). */
export interface HillCarryView {
  readonly on: boolean;
  readonly open: HillDecision[];
  readonly closed: string[];
  /** The crew state (1.29.0), when the person ever set one; null for the default, which is not carried. */
  readonly crewState?: HillCarriedCrewState | null;
}

/** The crew state as it crosses to the deputy: the value, when and by whom; never whether it was told. */
export interface HillCarriedCrewState {
  readonly state: HillCrewState;
  readonly at: number;
  readonly by: string;
}

/**
 * Merge carried Decisions into a Hill store (§25): each under its own id, its pictures first, in one
 * write; an id the store holds or cleared is left alone. No post, no push. Answers the ids stored. The
 * bridge's Hill (`HillService.adoptCarried`) and `collie promote` share it.
 */
export function adoptCarriedInto(
  store: HillStore,
  mediaStore: HillMediaStore | undefined,
  decisions: readonly HillDecision[],
  media: ReadonlyMap<string, readonly HillMediaFile[]>,
): string[] {
  const kept: HillDecision[] = [];
  for (const decision of decisions) {
    if (store.taken(decision.id)) continue;
    const files = media.get(decision.id) ?? [];
    // A picture this Hill could not keep leaves the card without it rather than pointing at nothing.
    kept.push(files.length === 0 || mediaStore?.save(decision.id, files) === true ? decision : { ...decision, media: [] });
  }
  if (kept.length === 0 || !store.put(...kept)) return [];
  return kept.map((decision) => decision.id);
}

/** What an answer on a deposed lead is refused with (§25): the Decisions moved with the crown. */
export const HILL_DEPOSED = "This machine is not the crew's lead any more. Answer on the new lead.";
/** The sentence a crew member answers a post with. */
export const NOT_ON_LEAD = "the hill is not merged across the crew yet; post from a session on the lead machine";
/** What a post says when its request id already posted a decision that a person has since cleared. */
export function clearedRepost(id: string): string {
  return `this request id already posted ${id}, which was cleared from the Hill; post with a new --request-id to ask again`;
}

/** What a clear came to: the ids removed, and the ids it left alone with why. */
export interface HillClearAnswer {
  readonly cleared: readonly string[];
  readonly skipped: ReadonlyArray<{ readonly id: string; readonly reason: "open" | "missing" }>;
}

/** The sentence a bridge with the Hill switched off answers a post with: what is off, and the way back on. */
export const HILL_OFF = "the Hill is off on this Collie; your person can switch it on in Settings, Tricks, on the phone, or with: collie hill on";
/** What the lead of a crew answers a member's post or image with while its own Hill is off (the lead's switch decides). */
export const HILL_OFF_ON_LEAD = "the Hill is off on the lead of this crew; your person can switch it on in Settings, Tricks, on the phone";
/** The sentence a bridge with WalkyTalky off answers a post with. */
export const HILL_WALKY_OFF = "WalkyTalky is off on this machine (COLLIE_WALKY=off), so no answer could reach you";
/** The closed reason of a withdrawn decision. */
export const BY_THE_POSTER = HILL_BY_THE_POSTER;
/** The closed reason of a decision its trick no longer lists, or replaced while closed. */
export const BY_THE_TRICK = "by the trick";
/** The closed reason of every open decision of a trick switched off or removed. */
export const TRICK_OFF = "the trick is off";
/** The closed reason of a decision whose target session ended, and the receipt's reason. */
export const TARGET_ENDED = "target session ended";
/** The closed reason of an expired decision. */
export const EXPIRED = "expired";
/** The closed reason of a decision whose answer would go to a crew machine the roster no longer lists. */
export const LEFT_THE_CREW = "its machine left the crew";
/**
 * How long a card that closed without the person stays on the Hill with its closing line (M96 spec 10):
 * then the sweep clears it as Clear does. The sweep runs every 15 seconds, so it leaves 60 to 75 s after.
 */
export const HILL_SELF_CLEAR_MS = 60_000;
/**
 * The closed states that leave by themselves. An answer and a dismiss were the person's; those stay. So
 * does a card closed {@link HILL_ANSWERED_IN_SESSION}: the person's own message closed it, and it stays
 * under Answered with that line until the person clears it.
 */
const SELF_CLEARING: ReadonlySet<HillState> = new Set<HillState>(["expired", "withdrawn", "superseded", "undeliverable"]);

/** Whether a closed card leaves by itself: it closed without the person, and not by their own message. */
function selfClears(decision: HillDecision): boolean {
  return SELF_CLEARING.has(decision.state) && decision.from.kind !== "collie" && decision.closedReason !== HILL_ANSWERED_IN_SESSION && decision.closedReason !== HILL_ASK_ANSWERED_HERE;
}
/** What `status` and `withdraw` answer the poster for a decision that left the Hill: the state it closed in. */
export function leftTheHill(id: string, state: HillState): string {
  return `${id} is ${state}; it has left the Hill`;
}
/** The first line of a dismiss's message carries this as its second line. */
export const DISMISSED = "Dismissed.";
/** How many characters of the title the answer message's first line keeps, the `…` included. */
export const MESSAGE_TITLE_MAX = 80;
/** How many characters of a session's name a card shows, the `…` included. */
export const SESSION_LABEL_MAX = 80;
/** Open decisions the hill holds at once, across every sender. A further post is refused `too_many_open`. */
export const HILL_OPEN_TOTAL_MAX = 200;
/**
 * Open decisions from the agents of one crew member (one bridge id other than this bridge's own), across
 * all its sessions, so one machine cannot fill the lead's hill (CREW_PROTOCOL §22). Beside the session
 * cap (`HILL_OPEN_MAX`, 20) and the total above. This bridge's own sessions keep those two alone.
 */
export const HILL_OPEN_MEMBER_MAX = 40;
/** The words an answer to a session on an unreachable crew machine is refused with: nothing was sent. */
export function notAnswering(machine: string): string {
  return `${machine} is not answering. Your answer was not sent.`;
}
// The expiry days live in web/src/lib/tricks/limits.ts, which the tricks catalogue reads too.
export { HILL_DEFAULT_EXPIRY_DAYS, HILL_DEFAULT_EXPIRY_MS, HILL_MAX_EXPIRY_DAYS, HILL_MAX_EXPIRY_MS };

/** Mint a decision id: `dc_` and 12 characters of [a-z0-9], from a uniform random source. */
export function mintDecisionId(random: (n: number) => Uint8Array = (n) => randomBytes(n), prefix: "dc_" | "ak_" = "dc_"): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  // 252 is the largest multiple of 36 below 256: a byte at or above it is skipped, so no letter is likelier.
  while (out.length < 12) {
    for (const byte of random(16)) {
      if (byte >= 252) continue;
      out += alphabet[byte % 36];
      if (out.length === 12) break;
    }
  }
  return `${prefix}${out}`;
}

/** A string as the hill keeps it, and whether it is past its field's cap (then it is refused, never cut). */
export interface HillCleanText {
  readonly text: string;
  readonly over: boolean;
}

function codePoints(text: string): number {
  return [...text].length;
}

/**
 * One line of text as the hill keeps it: the walky body cleaning (control and invisible characters
 * dropped, a header-like line escaped), then every line break a space. Never cut: `over` says it is
 * past `max`, and the caller refuses it.
 */
export function cleanLine(raw: string, max: number): HillCleanText {
  const text = cleanBody(raw, Number.MAX_SAFE_INTEGER)
    .body.split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
  return { text, over: codePoints(text) > max };
}

/** Text that may hold line breaks, cleaned as a walky body is. Never cut: `over` says it is past `max`. */
export function cleanText(raw: string, max: number): HillCleanText {
  const text = cleanBody(raw, Number.MAX_SAFE_INTEGER).body;
  return { text, over: codePoints(text) > max };
}

/** A link address the card may open: http or https, printable ASCII, at most {@link HILL_LINK_HREF_MAX}. */
export function isLinkHref(raw: string): boolean {
  if (raw.length === 0 || raw.length > HILL_LINK_HREF_MAX || !/^[\x21-\x7e]+$/u.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

/** The title as the answer message's first line quotes it: at most {@link MESSAGE_TITLE_MAX} characters, cut with `…`. */
export function messageTitle(title: string): string {
  const points = [...title];
  return points.length <= MESSAGE_TITLE_MAX ? title : `${points.slice(0, MESSAGE_TITLE_MAX - 1).join("")}…`;
}

/** The fixed last line of an answer typed into a session other than the poster's: where the decision can be read. */
export function readItLine(id: string): string {
  return `Read the decision with: collie hill status ${id}`;
}

/**
 * The walky message an answer types. It is typed with the person's authority, so it carries words the
 * poster wrote only when it goes back into the poster's own session.
 *
 * To the poster (`toPoster`, the default): `Answer to <id> "<title>"`, then `Option: <intent> (<label>)`
 * for an option, then the person's text when there is one. A dismiss is the first line and `Dismissed.`.
 *
 * To another session (`replyTo` names someone else, always so for a trick): no title and no label, only
 * `Answer to <id>`, `Option: <intent>` (a pattern-checked word, `isHillOptionIntent`), the person's text,
 * and {@link readItLine}. A dismiss is `Answer to <id>` and `Dismissed.` only.
 */
export function answerMessage(decision: Pick<HillDecision, "id" | "title">, intent: string, label: string | null, text: string | null, toPoster = true): string {
  const lines = [toPoster ? `Answer to ${decision.id} "${messageTitle(decision.title)}"` : `Answer to ${decision.id}`];
  if (intent === "dismiss") return [...lines, DISMISSED].join("\n");
  if (intent !== "answer") lines.push(toPoster ? `Option: ${intent} (${label ?? intent})` : `Option: ${intent}`);
  if (text !== null && text !== "") lines.push(text);
  if (!toPoster) lines.push(readItLine(decision.id));
  return lines.join("\n");
}

/** A typed answer with the crew state's line at its end while the state is not `here` (1.29.0). */
export function withCrewLine(body: string, state: HillCrewState): string {
  return state === "here" ? body : `${body}\n${crewStateLine(state)}`;
}

/** A session's name as the hill keeps it: one cleaned line, cut with `…` past {@link SESSION_LABEL_MAX}. */
export function sessionLabel(raw: string): string {
  const { text } = cleanLine(raw, SESSION_LABEL_MAX);
  const points = [...text];
  return points.length <= SESSION_LABEL_MAX ? text : `${points.slice(0, SESSION_LABEL_MAX - 1).join("")}…`;
}

/**
 * What a post asks for, as a digest (`payloadDigest`), defaults filled: the words, the options, the
 * links, the priority, the addresses, the images as named and the view. Not `expiresAt` (a retried
 * `collie hill post --expires 2h` counts it again from its own clock) and not `supersedes` (a trick
 * names it from the state it reads, which a first post that went through has moved).
 */
export function hillPostDigest(input: HillPostInput): string {
  const options = (input.options ?? []).map((option) => [option.intent, option.label, option.detail ?? null, option.confirm ?? null]);
  const recommends = input.recommends === undefined || input.recommends === null ? null : [input.recommends.intent, input.recommends.why];
  const links = (input.links ?? []).map((link) => [link.label, link.href]);
  const images = (input.images ?? []).map((image) => [image.path, image.caption ?? null]);
  const parts = [input.title, input.summary, input.body ?? "", options, input.text ?? "optional", recommends, links, input.priority ?? "today", input.about ?? null, input.replyTo ?? null, images];
  // The view joins only when there is one, so a post without one keeps the digest it always had; a group too.
  const withView = input.view === undefined ? parts : [...parts, input.view];
  const withGroup = input.group === undefined ? withView : [...withView, { group: input.group }];
  // An ask joins only when it is one, so every other post keeps the digest it always had.
  const ask = input.ask === undefined ? null : { ask: [input.ask.words, input.ask.files.map((file) => [file.path, file.heading ?? null, file.line ?? null])] };
  return payloadDigest([JSON.stringify(ask === null ? withGroup : [...withGroup, ask])]);
}

/** A decision as the phone and the socket get it: without `postDigest` and `pushTag`, which only the bridge needs. */
function served(decision: HillDecision): HillDecision {
  if (decision.postDigest === undefined && decision.pushTag === undefined) return decision;
  const copy = { ...decision };
  delete copy.postDigest;
  delete copy.pushTag;
  return copy;
}

/**
 * The id an answer records for the paired device it came from: `dv_` and 16 hex characters of a SHA-256
 * over the device's pairing record (its token hash, which the token's owner cannot change and a re-pair
 * replaces). One-way: it names the record and opens nothing. Attribution, never a signature.
 */
export function hillDeviceId(tokenHash: string): string {
  return `dv_${payloadDigest(["collie hill device", tokenHash]).slice(0, 16)}`;
}

/** The key a sender's decisions are filed under: its address, the trick's id, or what Collie asks about. */
function senderKey(sender: AnySender): string {
  if (sender.kind === "agent") return sender.address;
  if (sender.kind === "trick") return `trick:${sender.trickId}`;
  return collieKey(sender.ref);
}

function collieKey(ref: Pick<HillCollieRef, "type" | "id">): string {
  return `collie:${ref.type}:${ref.id}`;
}

function keyOf(decision: HillDecision): string {
  const { from } = decision;
  if (from.kind === "agent") return from.address ?? "";
  if (from.kind === "trick") return `trick:${from.trickId ?? ""}`;
  // A collie decision without its ref files under a key no sender has.
  return from.ref === undefined ? "collie:" : collieKey(from.ref);
}

/** The message a Collie answer refused with, when no handler is wired. */
export const HILL_NO_ANSWER_HANDLER = "Collie cannot act on this answer here.";
/** The reason a withdraw is refused while that Collie Decision's answer runs. */
export const HILL_ANSWER_RUNNING = "the decision is being answered";

/** The refusal of a yes to a group from a phone that was given other cards: they changed since. */
export const HILL_GROUP_CHANGED = "These cards changed since this phone showed them. Look at them again and answer again.";
/** The refusal of a yes to a group from an app that does not send the digest it was shown. */
export const HILL_GROUP_OLD_APP = "This app does not show a group of cards yet. Reload Collie on this phone and answer again.";
/** The refusal of a yes to a single card of code from an app that does not send the digest it was shown (C-A2). */
export const HILL_CODE_OLD_APP = "This app does not show this card's code yet. Reload Collie on this phone and answer again.";
/** The refusal of a yes to a trick card that holds no code: it cannot show what the yes would approve. */
export const HILL_CODE_NONE = "This card shows no code, so it cannot be approved here.";

function refuse(code: HillRefusalCode | null, error: string): HillPostAnswer {
  return { ok: false, code, error };
}

/** The cleaned fields of a post, or the refusal of the first that fails. */
type Cleaned = Pick<HillDecision, "title" | "summary" | "body" | "options" | "text" | "recommends" | "links">;

function cleanPost(input: HillPostInput, limits: HillPostLimits = HILL_LIMITS): { readonly ok: true; readonly fields: Cleaned } | Extract<HillPostAnswer, { ok: false }> {
  const title = cleanLine(input.title, limits.title);
  if (title.text === "") return { ok: false, code: "bad_title", error: "a decision needs a title" };
  if (title.over) return { ok: false, code: "bad_title", error: `the title is longer than ${String(limits.title)} characters` };
  const summary = cleanText(input.summary, limits.summary);
  if (summary.text === "") return { ok: false, code: "bad_summary", error: "a decision needs a summary in plain words" };
  if (summary.over) return { ok: false, code: "bad_summary", error: `the summary is longer than ${String(limits.summary)} characters` };
  const body = cleanText(input.body ?? "", limits.body);
  if (body.over) return { ok: false, code: "bad_body", error: `the body is longer than ${String(limits.body)} characters` };
  const rawOptions = input.options ?? [];
  if (rawOptions.length > HILL_OPTIONS_MAX) return { ok: false, code: "bad_option", error: `a decision has at most ${String(HILL_OPTIONS_MAX)} options` };
  const options: HillOption[] = [];
  for (const raw of rawOptions) {
    if (!isHillOptionIntent(raw.intent)) return { ok: false, code: "bad_option", error: `\`${headerField(raw.intent, 40)}\` is not an option intent: a lowercase word of at most 32 characters, not answer or dismiss` };
    if (options.some((option) => option.intent === raw.intent)) return { ok: false, code: "bad_option", error: `two options share the intent \`${raw.intent}\`` };
    const label = cleanLine(raw.label, limits.label);
    if (label.text === "" || label.over) return { ok: false, code: "bad_option", error: `the label of \`${raw.intent}\` is 1 to ${String(limits.label)} characters` };
    const detail = cleanLine(raw.detail ?? "", limits.detail);
    if (detail.over) return { ok: false, code: "bad_option", error: `the detail of \`${raw.intent}\` is longer than ${String(limits.detail)} characters` };
    const confirm = raw.confirm === undefined ? null : cleanLine(raw.confirm, HILL_OPTION_CONFIRM_MAX);
    if (confirm !== null && (confirm.text === "" || confirm.over)) return { ok: false, code: "bad_option", error: `the confirm word of \`${raw.intent}\` is 1 to ${String(HILL_OPTION_CONFIRM_MAX)} characters` };
    const base: HillOption = { intent: raw.intent, label: label.text };
    const withDetail = detail.text === "" ? base : { ...base, detail: detail.text };
    options.push(confirm === null ? withDetail : { ...withDetail, confirm: confirm.text });
  }
  const text = input.text ?? "optional";
  if (text === "none" && options.length === 0) return { ok: false, code: "bad_text_mode", error: "a decision with no options takes text: use --text optional or required" };
  let recommends: HillDecision["recommends"] = null;
  if (input.recommends !== undefined && input.recommends !== null) {
    const named = input.recommends.intent;
    if (!options.some((option) => option.intent === named)) return { ok: false, code: "bad_recommends", error: `the recommendation \`${headerField(named, 40)}\` names no option` };
    const why = cleanLine(input.recommends.why, limits.why);
    if (why.text === "" || why.over) return { ok: false, code: "bad_recommends", error: `the why is 1 to ${String(limits.why)} characters` };
    recommends = { intent: named, why: why.text };
  }
  const rawLinks = input.links ?? [];
  if (rawLinks.length > HILL_LINKS_MAX) return { ok: false, code: "bad_link", error: `a decision has at most ${String(HILL_LINKS_MAX)} links` };
  const links: Array<{ label: string; href: string }> = [];
  for (const raw of rawLinks) {
    const label = cleanLine(raw.label, HILL_LINK_LABEL_MAX);
    if (label.text === "" || label.over) return { ok: false, code: "bad_link", error: `a link label is 1 to ${String(HILL_LINK_LABEL_MAX)} characters` };
    const href = raw.href.trim();
    if (!isLinkHref(href)) return { ok: false, code: "bad_link", error: `a link is an http or https address of at most ${String(HILL_LINK_HREF_MAX)} characters` };
    links.push({ label: label.text, href });
  }
  return { ok: true, fields: { title: title.text, summary: summary.text, body: body.text, options, text, recommends, links } };
}

/** The receipt an answer writes, before or instead of any send. */
function receiptOf(rid: string, at: number, code: HillReceipt["code"], reason: string | null, state: HillState | null, delivery: HillReceipt["delivery"], trick: HillReceipt["trick"] = null): HillReceipt {
  return { rid, code, reason, state, delivery, trick, at };
}

/** The trick a decision came from, when it came from one: where its tap goes. */
function trickOf(decision: HillDecision): { readonly host: string; readonly trickId: string; readonly trickKey: string } | null {
  const { kind, trickId, trickKey, trickHost } = decision.from;
  return kind === "trick" && trickHost !== null && trickId !== null && trickKey !== null ? { host: trickHost, trickId, trickKey } : null;
}

/** What the claim step of an answer hands the send step, or the receipt that ends it. */
type Claim =
  | { readonly kind: "done"; readonly outcome: HillAnswerOutcome }
  | {
      readonly kind: "deliver";
      readonly decision: HillDecision;
      readonly record: HillReceiptRecord;
      /** The walky message, or null when nothing is typed (a trick with no `replyTo`). */
      readonly send: { readonly to: string; readonly body: string; readonly subject?: string } | null;
      /** The trick's tap, or null for an agent's decision. */
      readonly tap: { readonly host: string; readonly trickId: string; readonly decisionId: string; readonly tap: HillTrickTap } | null;
    };

/** How `collie walky cancel` closes an ask: `--answered`, or a take back with `--because "<reason>"`. */
export interface HillAskCancel {
  readonly answered: boolean;
  readonly because: string | null;
}

/** What the lead of a crew whose member sent an ask answers when it is older than asks. */
export const ASK_LEAD_TOO_OLD = "the lead of this crew runs a Collie that does not know asks; the post was taken back. Update the lead, or ask from a session on the lead";

/** What one Send came to (`POST /api/hill/answers`). */
export type HillAnswersOutcome =
  | { readonly kind: "done"; readonly result: HillAnswersResult }
  | { readonly kind: "refused"; readonly refusal: HillAnswersRefusal }
  | { readonly kind: "unsaved" }
  | { readonly kind: "off" }
  | { readonly kind: "denied"; readonly error: string };

function refusedSend(code: HillAnswersRefusal["code"], error: string, extra: Pick<HillAnswersRefusal, "over" | "id" | "machine"> = {}): HillAnswersOutcome {
  return { kind: "refused", refusal: { code, error, ...extra } };
}

/** What a Send's claim hands its send step, or the outcome that ends it. */
type SendClaim =
  | { readonly kind: "done"; readonly outcome: HillAnswersOutcome }
  | { readonly kind: "deliver"; readonly to: string; readonly body: string; readonly closed: readonly HillDecision[]; readonly gone: ReadonlyMap<string, HillReceipt>; readonly now: number };

/**
 * Why `--replaces` cannot take `old`, or null. It takes an ask of the same session (the caller checked the
 * sender) that is open, or one answered with "I need more context": then it closes nothing and the new ask
 * records it.
 */
function replaceRefusal(old: HillDecision): string | null {
  if (old.ask === undefined) return `--replaces ${old.id}: that is not an ask; it takes an ask of this session`;
  if (old.state === "open") return null;
  if (old.state === "answered" && old.answer?.intent === HILL_MORE_CONTEXT) return null;
  return `--replaces ${old.id}: that ask is ${old.state}; it takes an open ask, or one answered with "I need more context"`;
}

export class HillService {
  private readonly now: () => number;
  private readonly mint: () => string;
  /** The names of the open decisions at the last `rev()`, and how often they changed since the start. */
  private namesSeen: string | null = null;
  private namesMoved = 0;
  /** The answers' claim steps run one after another, so two taps cannot both find a decision open. */
  private lane: Promise<void> = Promise.resolve();
  /** The open decisions whose target the last sweep found gone. Gone at two sweeps in a row closes one. */
  private absent = new Set<string>();
  /** The switch as last seen, so the move to off closes the open notifications once. */
  private wasOn = true;
  /** The switch for tricks as a whole as last seen, so the move to off closes a trick's notifications once, and how often it moved. */
  private tricksWereOn = true;
  private tricksMoved = 0;
  /** The crew state at the last `rev()`, and how often it changed since the start. */
  private crewSeen: string | null = null;
  private crewMoved = 0;
  /** The Collie Decisions whose answer runs now: no withdraw or supersede closes one under its answer. */
  private answering = new Set<string>();
  /** How many answers to each decision run now, from the tap to the receipt: no quiet close takes one under its answer. */
  private claiming = new Map<string, number>();
  /** The test Decision that waits to be posted: when, and its timer. One at a time; a restart drops it. */
  private testPending: { readonly at: number } | null = null;
  /** The Sends (`answerAsks`) that run now, by `rid`, with their digest: a second call with one rid joins the first. */
  private sends = new Map<string, { readonly digest: string; readonly work: Promise<HillAnswersOutcome> }>();

  constructor(private readonly deps: HillServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.mint = deps.mintId ?? (() => mintDecisionId());
  }

  /**
   * The revision on the snapshot, on every snapshot while the Hill is on: with no decisions file yet it is
   * the crew state's own count (0 until the person sets one), so the phone shows the Hill in the bar as
   * soon as the Hill is on, before the first Decision (the first full trick run, 2026-11-16, decision 6;
   * `docs/hill.md`, spec 09: off, "the Hill leaves the bar"). It also moves when a session behind an open decision is renamed, so the phone refetches the
   * list and shows the new name, and when the crew state changes (from the phone, the terminal or the file).
   */
  rev(): number {
    const crew = this.deps.crewState?.read() ?? HILL_CREW_STATE_DEFAULT;
    const stamp = `${crew.state}|${String(crew.at)}|${String(crew.told)}`;
    if (this.crewSeen !== null && stamp !== this.crewSeen) this.crewMoved += 1;
    this.crewSeen = stamp;
    const stored = this.deps.store.rev();
    // A Hill with no decisions file yet still has a page: an empty list and the crew state.
    if (stored === undefined) return this.crewMoved;
    if (this.deps.sessionName !== undefined) {
      const names = this.look(() => JSON.stringify(this.deps.store.list().open.map((decision) => this.named(decision)).map((decision) => [decision.id, decision.from.label, decision.target?.label ?? null])));
      if (this.namesSeen !== null && names !== this.namesSeen) this.namesMoved += 1;
      this.namesSeen = names;
    }
    return stored + this.namesMoved + this.crewMoved + this.tricksSwitchMoves();
  }

  /**
   * Whether a trick's own Decisions are held back now: tricks as a whole are switched off on this machine
   * (`deps.tricksOn`). Each call reads the switch; the first call that sees it go off closes the notification
   * of every open Decision of a trick, as {@link isOn} does for the Hill's own switch. The Decisions stay open.
   */
  tricksOff(): boolean {
    const on = this.deps.tricksOn?.() ?? true;
    if (on !== this.tricksWereOn) this.tricksMoved += 1;
    if (this.tricksWereOn && !on) {
      const tags = new Set(this.deps.store.all().flatMap((decision) => (decision.state === "open" && decision.from.kind === "trick" && decision.pushTag !== undefined ? [decision.pushTag] : [])));
      for (const tag of tags) this.deps.push?.clear(tag);
      if (tags.size > 0) this.deps.audit?.({ action: "hill.push.cleared", detail: { why: "tricks are off", count: tags.size } });
    }
    this.tricksWereOn = on;
    return !on;
  }

  /** How often the switch for tricks as a whole moved: the list's revision moves with it, so a phone refetches. */
  private tricksSwitchMoves(): number {
    this.tricksOff();
    return this.tricksMoved;
  }

  /** Whether `decision` is a trick's own Decision held back while tricks are switched off. */
  private heldBack(decision: Pick<HillDecision, "from">, tricksOff: boolean): boolean {
    return tricksOff && decision.from.kind === "trick";
  }

  /**
   * The person sent into one of this bridge's sessions from the phone's composer (1.29.0). Every open agent
   * Decision posted from exactly that address before `at`, and not marked yet, gets `spokeAfter: at`: the
   * card says the person wrote to the session after it asked, and sinks below the fresh cards of its
   * priority. It stays open and answerable; nothing is typed and nothing pushes. A member's Hill is not
   * here, so a member marks nothing.
   *
   * `started` (M96 spec 10): the send started the session's next turn, read by the route as a positive
   * fact (server.ts `sendStartedTurn`: the session waited, and the send was neither a steer nor queued
   * behind a turn). Then each of those cards whose answer would go into this very session closes
   * `withdrawn` with {@link HILL_ANSWERED_IN_SESSION}, and NOTHING IS TYPED for it: the person's own
   * message started the turn the answer would have started. A card whose answer runs now is left to that
   * answer, as the second Clear leaves it. A card whose answer goes to another session takes the mark only.
   * One `hill.spoke.closed` audit line with the count. Answers how many cards were marked or closed.
   */
  noteSpoke(address: string, at: number = this.now(), started = false): number {
    if (this.deps.crewMode() === "peer" || this.deps.deposed?.() === true) return 0;
    const changed: HillDecision[] = [];
    let closed = 0;
    for (const decision of this.deps.store.all()) {
      if (decision.state !== "open" || decision.from.kind !== "agent" || decision.from.address !== address || decision.at >= at) continue;
      // An ask stays open, unmarked, when the person writes in the session (Asks, 2026-11-22): it closes
      // only by an answer, the agent's take back or replace, or the sweep.
      if (decision.ask !== undefined) continue;
      if (this.busy(decision.id)) continue;
      if (started && this.answersThePoster(decision)) {
        changed.push({ ...decision, state: "withdrawn", closedAt: at, closedReason: HILL_ANSWERED_IN_SESSION });
        closed += 1;
        continue;
      }
      if (decision.spokeAfter === undefined) changed.push({ ...decision, spokeAfter: at });
    }
    if (changed.length === 0 || !this.save(...changed)) return 0;
    if (closed > 0) this.deps.audit?.({ action: "hill.spoke.closed", detail: { count: closed } });
    return changed.length;
  }

  /** Whether an answer to this decision runs now: its claim (any sender), or a Collie Decision's act. */
  private busy(id: string): boolean {
    return this.answering.has(id) || this.claiming.has(id);
  }

  /** The crew state now (crew-state.ts): `here` when this bridge keeps none. */
  crewState(): HillCrewStateView {
    return this.deps.crewState?.read() ?? HILL_CREW_STATE_DEFAULT;
  }

  /**
   * The crew state as the phone may read it from this bridge: null on a crew member and on a deposed
   * lead, whose own file is not the crew's state (C-N4, review 8), as a set there is refused.
   */
  servedCrewState(): HillCrewStateView | null {
    if (this.deps.crewMode() === "peer" || this.deps.deposed?.() === true) return null;
    return this.crewState();
  }

  /**
   * Set the crew state, from the phone (`device` its label) or the person's terminal (`device` null,
   * `by` "terminal"). Answers the state as it reads now, or why nothing changed: a member and a deposed
   * lead hold no crew state of their own (`notLead`), or the file could not be written. One `hill.state`
   * audit line for a write.
   */
  setCrewState(state: HillCrewState, by: string, device: string | null = null): { readonly ok: true; readonly crewState: HillCrewStateView } | { readonly ok: false; readonly error: string; readonly notLead: boolean } {
    if (this.deps.crewMode() === "peer" || this.deps.deposed?.() === true) return { ok: false, error: HILL_STATE_ON_LEAD, notLead: true };
    const set = this.deps.crewState?.set;
    const now = set === undefined ? null : set.call(this.deps.crewState, state, by);
    if (now === null) return { ok: false, error: HILL_STATE_UNSAVED, notLead: false };
    this.deps.audit?.({ action: "hill.state", device, detail: { state } });
    return { ok: true, crewState: now };
  }

  /**
   * "Tell all sessions now": one operator line, `Crew state: away.` under WalkyTalky's own head, typed through
   * the answer's own send (`deps.send`, the operator walky send) into every live agent session of THIS
   * machine that holds an open Decision or posted one in the last hour, newest first, at most
   * {@link HILL_TELL_MAX}. A session that is busy gets it held as an answer is. Once per change of the
   * state: `at` must be the change the phone showed, and the tell is recorded on the state before any line
   * goes, so a second tap (or a second phone) is refused. The sends run in the background; the answer is
   * how many sessions were asked. One `hill.state.told` audit line with the count.
   */
  async tellAll(at: number, by: string, device: string | null = null): Promise<HillTellAnswer> {
    if (this.refusesHere()) return { ok: false, error: HILL_OFF };
    if (!this.deps.walkyOn()) return { ok: false, error: HILL_WALKY_OFF };
    if (this.deps.crewMode() === "peer" || this.deps.deposed?.() === true) return { ok: false, error: NOT_ON_LEAD };
    const crew = this.crewState();
    if (crew.state === "here") return { ok: false, error: HILL_TELL_HERE };
    if (crew.at !== at) return { ok: false, error: HILL_TELL_MOVED };
    if (crew.told !== null) return { ok: false, error: HILL_TELL_DONE };
    const targets = this.tellTargets();
    // SYNCHRONOUS from the read above to here: the mark is what makes a second tap a refusal.
    const file = this.deps.crewState;
    if (file?.markTold === undefined || !file.markTold(at, targets.length)) return { ok: false, error: HILL_TELL_DONE };
    const line = crewStateTellLine(crew.state);
    const send = this.deps.tell ?? this.deps.send;
    // Never sent again: a send that fails is a session that was not told. Told counts the sends walky
    // typed or held, not the targets (C-S1), and is written over the first mark once they settled.
    const results = await Promise.all(targets.map((to) => send(to, line, by).catch((): HillSendResult => "unknown")));
    const told = results.filter((result) => result === "typed" || result === "held").length;
    file.setTold?.(at, told);
    this.deps.audit?.({ action: "hill.state.told", device, detail: { state: crew.state, count: told, asked: targets.length } });
    return { ok: true, told };
  }

  /** The sessions a tell reaches: this machine's agents with an open Decision or one posted in the last hour, live now. */
  private tellTargets(): string[] {
    const since = this.now() - HILL_TELL_RECENT_MS;
    const recent = this.deps.store
      .all()
      .filter((decision) => decision.from.kind === "agent" && decision.from.memberId === this.deps.memberId && decision.from.address !== null && (decision.state === "open" || decision.at >= since))
      .toSorted((a, b) => b.at - a.at);
    const out: string[] = [];
    this.look(() => {
      for (const decision of recent) {
        const address = decision.from.address;
        if (address === null || out.includes(address)) continue;
        // The very session that posted: the instance token must still match, as for a typed answer.
        if (this.deps.place(address)?.address !== address) continue;
        out.push(address);
        if (out.length >= HILL_TELL_MAX) break;
      }
    });
    return out;
  }

  /**
   * Whether the Hill is on (switch.ts). Each call reads the switch; the first call that sees it go off
   * closes the notification of every open decision that holds one. The decisions themselves stay open.
   */
  isOn(): boolean {
    const on = this.reading() === "on";
    if (this.wasOn && !on) {
      const tags = new Set(this.deps.store.all().flatMap((decision) => (decision.state === "open" && decision.pushTag !== undefined ? [decision.pushTag] : [])));
      for (const tag of tags) this.deps.push?.clear(tag);
      if (tags.size > 0) this.deps.audit?.({ action: "hill.push.cleared", detail: { why: "the Hill is off", count: tags.size } });
    }
    this.wasOn = on;
    return on;
  }

  /** What the switch holds now (switch.ts): on, off or unset. With no switch wired (a test seam) it is on. */
  reading(): HillSwitchReading {
    const sw = this.deps.hillSwitch;
    if (sw === undefined) return "on";
    return sw.reading?.() ?? (sw.on() ? "on" : "off");
  }

  /**
   * Whether THIS machine refuses a Hill call on its own switch. A lead, a solo bridge: anything but `on`
   * (unset is off). A crew MEMBER with no switch file follows its lead: it refuses only on an explicit off,
   * and otherwise forwards, and the lead's switch decides. Reads the switch through {@link isOn}, so the
   * move to off still closes the open notifications.
   */
  refusesHere(): boolean {
    const on = this.isOn();
    if (on) return false;
    return this.deps.crewMode() !== "peer" || this.reading() === "off";
  }

  /**
   * Move the switch from the phone. Answers whether the Hill is on now, or null when the switch could not
   * be written (nothing changed). One `hill.switch` audit line for a write.
   */
  switchTo(on: boolean, device: string | null = null): boolean | null {
    if (this.deps.hillSwitch?.set?.(on) !== true) return null;
    this.deps.audit?.({ action: "hill.switch", device, detail: { on } });
    return this.isOn();
  }

  /** `fn` under one look at the live sessions, when the bridge gives one. */
  private look<T>(fn: () => T): T {
    return this.deps.look === undefined ? fn() : this.deps.look(fn);
  }

  /** Whether the store holds `id` as a card of Collie's own about a trick (wire.ts `isTrickCard`). */
  private isHeldTrickCard(id: string): boolean {
    const decision = this.deps.store.get(id);
    return decision !== undefined && isTrickCard(decision.from);
  }

  /** One decision by id, any sender (the tricks runner reads its own decisions' states). */
  decision(id: string): HillDecision | undefined {
    return this.deps.store.get(id);
  }

  /**
   * What `GET /api/hill` serves: every open decision with the names its sessions have now. With the Hill
   * off, only Collie's own cards about a trick (spec 14): an agent's or a trick's stored decision stays
   * hidden until the Hill is on again.
   */
  list(): ReturnType<HillStore["list"]> {
    const off = this.refusesHere();
    const tricksOff = this.tricksOff();
    return this.look(() => {
      const whole = this.deps.store.list();
      // A trick's own Decisions wait, unserved, while tricks are switched off (`tricksOff`).
      const list = tricksOff ? { ...whole, open: whole.open.filter((decision) => !this.heldBack(decision, true)), closed: whole.closed.filter((decision) => !this.heldBack(decision, true)) } : whole;
      // The same revision the snapshot carries, so a phone that holds it reads `unchanged`.
      const rev = this.rev();
      if (off) {
        const closedCards = this.deps.store.all().filter((decision) => decision.state !== "open" && isTrickCard(decision.from));
        return { rev, open: list.open.filter((decision) => isTrickCard(decision.from)).map((decision) => served(this.named(decision))), closed: list.closed.filter((decision) => isTrickCard(decision.from)).map(served), closedTotal: closedCards.length };
      }
      return { ...list, rev, open: list.open.map((decision) => served(this.named(decision))), closed: list.closed.map(served) };
    });
  }

  /**
   * The revision the snapshot carries while the Hill is off (`trickCardsRev`, spec 14), so the phone reads
   * Collie's own cards about a trick: the Hill's revision while the store holds at least one such card,
   * open or closed, else undefined (no key, and the snapshot of an install that never had one keeps its bytes).
   */
  trickCardsRev(): number | undefined {
    if (!this.deps.store.all().some((decision) => isTrickCard(decision.from))) return undefined;
    return this.rev();
  }

  /** The session's name for a walky address, or `fallback` when the bridge has none. */
  private nameOf(address: string | null, fallback: string): string {
    const name = address === null ? null : (this.deps.sessionName?.(address) ?? null);
    const label = name === null ? "" : sessionLabel(name);
    return notCollie(label === "" ? fallback : label, "a session");
  }

  /** An open decision with the names its sessions have now, while they are live. A closed one, as stored. */
  private named(decision: HillDecision): HillDecision {
    if (decision.state !== "open" || this.deps.sessionName === undefined) return decision;
    const fromLabel = decision.from.kind === "agent" ? this.nameOf(decision.from.address, decision.from.label) : decision.from.label;
    const to = decision.replyTo ?? decision.from.address;
    const target = decision.target === null ? null : { ...decision.target, label: this.nameOf(to, decision.target.label) };
    if (fromLabel === decision.from.label && target?.label === decision.target?.label) return decision;
    return { ...decision, from: { ...decision.from, label: fromLabel }, target };
  }

  /** The sender a pane of this bridge stands for, at its walky address (`WalkyService.addressOf`). */
  agentSender(pane: Pick<WalkyPane, "harness" | "label">, address: string): HillAgentSender {
    return { kind: "agent", address, memberId: this.deps.memberId, harness: pane.harness, label: headerField(pane.label, WALKY_LABEL_MAX), host: this.deps.machine };
  }

  /**
   * A `hill.post` request's raw fields, from the socket: read, then posted. On a crew member with a
   * forward (CREW_PROTOCOL §22) the post goes to the lead: the images are read here, under every rule of
   * this machine, and uploaded; the lead mints the id and holds the decision.
   */
  async postFields(from: HillAgentSender, fields: JsonObject): Promise<HillPostAnswer> {
    const read = readPostFields(fields);
    if (!read.ok) return refuse(read.code, read.error);
    const forward = this.forwardOf();
    // The result carries the crew state at this moment; a member's carries its lead's (crew.ts).
    if (forward === null) return this.withCrewState(this.post(from, read.input));
    // This machine's own switches still hold: the person who switched its Hill or WalkyTalky off meant it.
    // A member with no switch file of its own follows the lead: the lead's switch answers below.
    if (this.refusesHere()) return refuse("hill_off", HILL_OFF);
    if (!this.deps.walkyOn()) return refuse("walky_off", HILL_WALKY_OFF);
    const images = this.readImages(read.input.images ?? [], null);
    if (!images.ok) return images;
    const answer = await forward.post(from, fields, read.input.requestId, images.images);
    this.deps.audit?.({ action: "hill.forward", detail: answer.ok ? { decisionId: answer.decision.id, images: images.images.length } : { refused: answer.code ?? "plain" } });
    return answer;
  }

  /**
   * A post's answer with the crew state at this moment, when it posted and the state is not `here`; a
   * post under `here` answers exactly as before the crew state.
   */
  withCrewState(answer: HillPostAnswer): HillPostAnswer {
    const state = this.crewState().state;
    return answer.ok && state !== "here" ? { ...answer, crewState: state } : answer;
  }

  /**
   * `hill.state` from the socket, a read: this bridge's own state, or on a crew member its lead's (crew.ts
   * `HillMemberForward.state`). A member whose lead is too old to say answers the error.
   */
  async askCrewState(): Promise<{ readonly ok: true; readonly crewState: HillCrewStateView } | { readonly ok: false; readonly error: string; readonly older?: true }> {
    const forward = this.forwardOf();
    if (forward === null) return { ok: true, crewState: this.crewState() };
    return forward.state();
  }

  /** The forward to the lead, on a crew member that has one; null everywhere else. */
  private forwardOf(): HillLeadForward | null {
    return this.deps.crewMode() === "peer" && this.deps.forward !== undefined ? this.deps.forward : null;
  }

  /** `hill.status` from the socket: this bridge's own answer, or on a crew member its lead's. */
  async askStatus(sender: HillAgentSender, id: string): Promise<HillOneAnswer> {
    const forward = this.forwardOf();
    return forward === null ? this.status(sender, id) : forward.one("status", sender, id);
  }

  /** `hill.withdraw` from the socket: this bridge's own answer, or on a crew member its lead's. */
  async askWithdraw(sender: HillAgentSender, id: string): Promise<HillOneAnswer> {
    const forward = this.forwardOf();
    return forward === null ? this.withdraw(sender, id) : forward.one("withdraw", sender, id);
  }

  /** `hill.list` from the socket: this bridge's own list, or on a crew member its lead's. */
  async askList(sender: HillAgentSender): Promise<HillListAnswer> {
    const forward = this.forwardOf();
    return forward === null ? { ok: true, decisions: this.mineList(sender) } : forward.list(sender);
  }

  /** One post from an agent's pane. The socket's only entry; it can never make a trick's post. */
  post(from: HillAgentSender, input: HillPostInput): HillPostAnswer {
    return this.postDecision(from, input);
  }

  /** One post, from an agent or from a trick inside the bridge. */
  postDecision(from: HillSender, input: HillPostInput, opts: HillPostOptions = {}): HillPostAnswer {
    return this.postAny(from, input, opts);
  }

  /**
   * One Decision of Collie's own (crew slice 3), from code inside the bridge only. It types nothing, so
   * WalkyTalky being off does not stop it; it names no session and carries no image. Its answer runs
   * `onCollieAnswer`. Supersede an older one of the same `ref` type and id with `input.supersedes`.
   */
  postCollie(from: HillCollieSender, input: HillPostInput, opts: Pick<HillPostOptions, "tellOf"> = {}): HillPostAnswer {
    if ((input.images ?? []).length > 0) return refuse("too_many_images", "a Collie decision carries no image");
    if (input.supersedes !== undefined && input.supersedes !== null && this.answering.has(input.supersedes)) return refuse("bad_supersedes", HILL_ANSWER_RUNNING);
    return this.postAny(from, { ...input, about: null, replyTo: null, images: [] }, opts.tellOf === undefined ? {} : { tellOf: opts.tellOf });
  }

  /**
   * What a lead carries to its deputy (CREW_PROTOCOL §25): the switch, the crew state, every open Decision newest first
   * without its notification slot (the deputy's phone was never told by it), and the ids of the closed
   * and cleared ones, newest first, so the deputy never holds one of them as open again.
   */
  carryView(closedMax: number): HillCarryView {
    const all = this.deps.store.all();
    const open = all
      .filter((decision) => decision.state === "open")
      .toSorted((a, b) => b.at - a.at)
      .map(({ pushTag: _slot, ...decision }) => decision);
    const closedHeld = all
      .filter((decision) => decision.state !== "open")
      .toSorted((a, b) => (b.closedAt ?? b.at) - (a.closedAt ?? a.at))
      .map((decision) => decision.id);
    const crew = this.crewState();
    const crewState = crew.at === null || crew.by === null ? null : { state: crew.state, at: crew.at, by: crew.by };
    return { on: this.isOn(), open, closed: [...new Set([...closedHeld, ...this.deps.store.clearedIds()])].slice(0, closedMax), crewState };
  }

  /** The bytes of one kept picture, for the copy to the deputy (§25), or null. */
  carryMedia(decisionId: string, media: Pick<HillMedia, "id" | "mime" | "bytes">): Uint8Array | null {
    return this.deps.media?.bytesOf(decisionId, media) ?? null;
  }

  /**
   * The person's takeover tap merges the carried Decisions into this Hill (§25): each under its own id,
   * with its own pictures, in one write. An id this Hill already holds or cleared is left as it is here.
   * Nothing is posted: no push, no tell, no request-id check; they are not new. Answers the ids stored.
   */
  adoptCarried(decisions: readonly HillDecision[], media: ReadonlyMap<string, readonly HillMediaFile[]>): string[] {
    return adoptCarriedInto(this.deps.store, this.deps.media, decisions, media);
  }

  /**
   * The test Decision (test-card.ts): the person pressed "Send a test Decision". It is posted
   * HILL_TEST_DELAY_MS later, so the phone that pressed can leave the app first and is no longer "looking" when
   * the push is decided (bridge/push.ts `LOOKING_MS`). Answers at once with the seconds to wait and why the
   * notification would not be sent, if it would not (push.ts `hillRingBlock`, evaluated now). One test waits at
   * a time: a second press schedules nothing and answers with the seconds that remain. Refused with the Hill off
   * and on a machine that is not the lead. One `hill.test` audit line for a press that scheduled the post.
   */
  requestTest(device: string | null = null): HillTestAnswer {
    if (this.refusesHere()) return { ok: false, code: "hill_off", error: HILL_OFF };
    if (this.deps.crewMode() === "peer" || this.deps.deposed?.() === true) return { ok: false, code: "not_on_lead", error: NOT_ON_LEAD };
    const now = this.now();
    const rings = this.testRings();
    if (this.testPending !== null) return { ok: true, inSeconds: Math.max(1, Math.ceil((this.testPending.at - now) / 1000)), rings };
    const timer = this.deps.timer ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms) };
    // A bridge that has nothing else to do may exit: the test is not worth holding it open.
    timer.set(() => this.postTest(), HILL_TEST_DELAY_MS).unref?.();
    this.testPending = { at: now + HILL_TEST_DELAY_MS };
    this.deps.audit?.({ action: "hill.test", device, detail: { rings: rings ?? "yes" } });
    return { ok: true, inSeconds: Math.ceil(HILL_TEST_DELAY_MS / 1000), rings };
  }

  /** Why a Decision marked Now from the test sender would send no notification now, or null. */
  private testRings(): HillRingBlock | null {
    if (this.deps.push === undefined) return "push_off";
    const facts = this.deps.ringFacts?.() ?? { push: true, pref: true, snoozed: false, member: false, devices: 1 };
    const state = this.crewState().state;
    return hillRingBlock({ ...facts, crewState: state, verdict: this.deps.push.check(collieKey(testSender().ref), null) });
  }

  /** The delay is over: post the card, replacing an open test card. Posts nothing with the Hill off. */
  private postTest(): void {
    this.testPending = null;
    if (this.refusesHere()) return;
    const old = this.collieDecisions("test").find((decision) => decision.state === "open");
    let posted = this.postCollie(testSender(), testCard(this.now(), old?.id ?? null));
    // The old card's answer runs now: it closes by itself, so post without replacing it.
    if (!posted.ok && posted.code === "bad_supersedes") posted = this.postCollie(testSender(), testCard(this.now(), null));
    if (!posted.ok) this.deps.audit?.({ action: "hill.test.refused", detail: { reason: posted.code ?? "plain" } });
  }

  /** Whether the Decision `id` is being answered right now (its claim runs). */
  isAnswering(id: string): boolean {
    return this.answering.has(id);
  }

  /** Collie takes back one of its open Decisions: it closes `withdrawn` with `reason`. Never while its answer runs. */
  withdrawCollie(from: HillCollieSender, id: string, reason: string): HillOneAnswer {
    if (this.answering.has(id)) return { ok: false, missing: false, error: HILL_ANSWER_RUNNING };
    return this.withdrawAny(from, id, reason);
  }

  /** Collie's own Decisions of one `ref` type, open and closed, as stored. */
  collieDecisions(type: HillCollieRef["type"]): HillDecision[] {
    return this.deps.store.all().filter((decision) => decision.from.kind === "collie" && decision.from.ref?.type === type);
  }

  private postAny(from: AnySender, input: HillPostInput, opts: HillPostOptions): HillPostAnswer {
    // First: with the Hill off nothing is taken, not even a repeat of a post it once took. A member with
    // no switch file is not refused here: it answers `not_on_lead` below, as it always did. A card of
    // Collie's own about a trick is the one sender the Hill off lets through (spec 14); only `postCollie`
    // makes that sender, and every check below still holds for it.
    if (this.refusesHere() && !isTrickCard(from)) return refuse("hill_off", HILL_OFF);
    // Collie's own answer types nothing, so only a post whose answer is typed needs WalkyTalky.
    if (from.kind !== "collie" && !this.deps.walkyOn()) return refuse("walky_off", HILL_WALKY_OFF);
    if (this.deps.crewMode() === "peer" || this.deps.deposed?.() === true) return refuse("not_on_lead", NOT_ON_LEAD);
    // A group of cards is Collie's own (crew slice 8): no session, crew member or trick posts one.
    if (input.group !== undefined && from.kind !== "collie") return refuse("bad_body", HILL_GROUP_NOT_YOURS);
    if (input.group !== undefined && input.view !== undefined) return refuse("bad_body", "a group of cards carries no view of its own");
    const key = senderKey(from);
    const digest = hillPostDigest(input);
    // A repeated request id from the same sender with the same payload is the same decision: answered as
    // stored, nothing checked again. With another payload it is refused, as a reused answer `rid` is (409).
    const repeat = this.deps.store.all().find((decision) => decision.requestId === input.requestId && keyOf(decision) === key);
    if (repeat !== undefined && repeat.postDigest !== undefined && repeat.postDigest !== digest) return refuse("request_id_reused", `this request id already posted ${repeat.id} with other content; post with a new --request-id`);
    if (repeat !== undefined) return { ok: true, decision: served(repeat) };
    // A decision a person cleared: the same request id must not post it a second time.
    const cleared = this.deps.store.tombstoneOfRequest(input.requestId, key);
    if (cleared !== undefined && cleared.digest !== null && cleared.digest !== digest) return refuse("request_id_reused", `this request id already posted ${cleared.id} with other content; post with a new --request-id`);
    if (cleared !== undefined) return refuse(null, clearedRepost(cleared.id));
    const ask = input.ask;
    const cleaned = cleanPost(input, ask === undefined ? HILL_LIMITS : HILL_ASK_LIMITS);
    if (!cleaned.ok) return cleaned;
    if (ask !== undefined) {
      const refusal = this.askPostRefusal(from, input, cleaned.fields, opts);
      if (refusal !== null) return refuse(refusal.code, refusal.error);
    }
    // An ask with options takes an optional note; a `--words` ask takes the words and nothing else.
    const fields: Cleaned = ask === undefined ? cleaned.fields : { ...cleaned.fields, text: ask.words ? "required" : "optional" };
    const now = this.now();
    if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt <= now) return refuse(null, "bad request: the expiry is in the past");

    const about = this.resolveAbout(from, input.about ?? null, opts.own ?? null);
    if (about === undefined) return refuse("bad_target", `\`${headerField(input.about ?? "", 80)}\` is not a live session's walky address`);
    let replyTo: HillPlace | null = null;
    if (input.replyTo !== undefined && input.replyTo !== null) {
      replyTo = this.deps.place(input.replyTo);
      if (replyTo === null) return refuse("bad_target", `\`${headerField(input.replyTo, 80)}\` is not a live session's walky address`);
    }
    // A crew member's claim about its own pane stands in only while this bridge does not list the pane yet.
    const own = from.kind === "agent" ? (this.deps.place(from.address) ?? (opts.own?.address === from.address ? opts.own : null)) : null;
    if (from.kind === "agent" && own === null && replyTo === null) return refuse("bad_target", "this session is not a live walky address: run it inside an agent's pane");
    const target = replyTo ?? own;
    // Collie's own card tells a live session of its answer, without naming it as the card's target.
    const told = from.kind === "collie" && opts.tellOf !== undefined ? (this.deps.place(opts.tellOf)?.address ?? null) : null;

    let superseded: HillDecision | null = null;
    // An ask that replaces one answered with "I need more context" records it and closes nothing.
    let replaces: string | null = null;
    if (input.supersedes !== undefined && input.supersedes !== null) {
      const old = this.deps.store.get(input.supersedes);
      if (old === undefined || keyOf(old) !== key) return refuse("bad_supersedes", ask === undefined ? `no decision ${input.supersedes} from this session` : `--replaces ${input.supersedes}: no ask of this session has that id`);
      if (ask !== undefined) {
        const replace = replaceRefusal(old);
        if (replace !== null) return refuse("bad_supersedes", replace);
        replaces = old.id;
        superseded = old.state === "open" ? old : null;
      } else {
        if (old.state !== "open") return refuse("bad_supersedes", `${old.id} is ${old.state}, only an open decision can be replaced`);
        superseded = old;
      }
    }
    const allOpen = this.deps.store.all().filter((decision) => decision.state === "open" && decision.id !== superseded?.id);
    const open = allOpen.filter((decision) => keyOf(decision) === key);
    if (open.length >= HILL_OPEN_MAX) return refuse("too_many_open", `this session has ${String(HILL_OPEN_MAX)} open decisions; withdraw one, or wait for answers`);
    // At most five open asks per session: the list stays short enough to answer.
    const openAsks = ask === undefined ? [] : open.filter((decision) => decision.ask !== undefined);
    if (openAsks.length >= HILL_ASK_OPEN_MAX) return refuse("too_many_open", tooManyAsks(openAsks));
    // A crew member's agents, posting through their lead: one machine's share of the hill. This
    // bridge's own sessions keep the solo caps alone.
    const crewMember = from.kind === "agent" && from.memberId !== this.deps.memberId ? from.memberId : null;
    const machineOpen = crewMember === null ? [] : allOpen.filter((decision) => decision.from.kind === "agent" && decision.from.memberId === crewMember);
    if (machineOpen.length >= HILL_OPEN_MEMBER_MAX) return refuse("too_many_open", `this machine's sessions have ${String(HILL_OPEN_MEMBER_MAX)} open decisions; withdraw one, or wait for answers`);
    if (allOpen.length >= HILL_OPEN_TOTAL_MAX) return refuse("too_many_open", `the hill holds ${String(HILL_OPEN_TOTAL_MAX)} open decisions; withdraw one, or wait for answers`);
    // An ask has no priority and rings nothing: it is stored as `today`, which never pushes.
    const asked = ask === undefined ? (input.priority ?? "today") : "today";
    const priority = asked === "now" && open.filter((decision) => decision.priority === "now").length >= HILL_NOW_MAX ? "today" : asked;
    // A trick's own folder is a root for a trick's images only; an agent's post never has one.
    const images = opts.images === undefined ? this.readImages(input.images ?? [], from.kind === "trick" ? (from.imageRoot ?? null) : null) : this.heldImages(input.images ?? [], opts.images);
    if (!images.ok) return images;

    const mint = ask === undefined ? this.mint : (this.deps.mintAskId ?? (() => mintDecisionId(undefined, "ak_")));
    let id = mint();
    for (let tries = 0; this.deps.store.taken(id) && tries < 8; tries += 1) id = mint();
    if (this.deps.store.taken(id)) return refuse(null, "could not mint a decision id; try again");
    // The Decision stores this bridge's id: it is written down before the first one does.
    this.deps.keepId?.();
    const media = this.keepImages(id, images.images);
    if (media === null) return refuse(null, "the images could not be saved on this machine; nothing was posted");
    const decision: HillDecision = {
      v: 1,
      id,
      requestId: input.requestId,
      from: this.fromOf(from),
      about: about?.address ?? null,
      priority,
      priorityAsked: asked,
      ...fields,
      media,
      replyTo: replyTo?.address ?? told,
      target: target === null ? null : { label: this.nameOf(target.address, target.label), host: target.host, unattended: target.unattended },
      supersedes: replaces ?? superseded?.id ?? null,
      supersededBy: null,
      // No expiry asked for: it closes `expired` after the default, so a forgotten decision does not stay
      // forever; and none stays past the cap, whatever it asked for. An ask has none: it stays open across
      // turns, and closes by an answer, a take back, a replace, or the sweep when its session is gone.
      expiresAt: ask === undefined ? Math.min(input.expiresAt ?? now + HILL_DEFAULT_EXPIRY_MS, now + HILL_MAX_EXPIRY_MS) : null,
      at: now,
      state: "open",
      closedAt: null,
      closedReason: null,
      answer: null,
      postDigest: digest,
    };
    if (input.view !== undefined) decision.view = input.view;
    if (ask !== undefined) decision.ask = { words: ask.words, files: opts.askFiles?.files ?? [], root: opts.askFiles?.root ?? null };
    // A replace is the agent saying what is true now: the new ask is confirmed at its post (.adr/0177).
    if (decision.ask !== undefined && decision.supersedes !== null) decision.ask.confirmedAt = now;
    if (input.group !== undefined && from.kind === "collie") {
      const made = makeGroup(input.group, from.ref, decision.options);
      if (!made.ok) return refuse("bad_body", made.error);
      decision.group = made.group;
    }
    const push = this.pushPlan(key, crewMember, priority, opts, superseded, id);
    if (push.tag !== undefined) decision.pushTag = push.tag;
    const replaced: HillDecision[] = superseded === null ? [] : [{ ...superseded, state: "superseded", supersededBy: id, closedAt: now, closedReason: `superseded by ${id}` }];
    if (!this.save(decision, ...replaced)) {
      if (media.length > 0) this.deps.media?.remove(id);
      return refuse(null, "the decision could not be saved on this machine; nothing was posted");
    }
    const plain = superseded === null ? { decisionId: id, options: decision.options.length } : { decisionId: id, options: decision.options.length, supersedes: superseded.id };
    // An ask says so, with how many files it links: a count, never a path.
    const base = decision.ask === undefined ? plain : { ...plain, ask: true, files: decision.ask.files.length };
    // The images as a count and a byte sum, never a path or a caption.
    const detail = media.length === 0 ? base : { ...base, images: media.length, imageBytes: media.reduce((sum, item) => sum + item.bytes, 0) };
    this.deps.audit?.({ action: "hill.post", detail });
    if (push.skipped !== null) this.deps.audit?.({ action: "hill.push.skipped", detail: { decisionId: id, why: push.skipped } });
    // Only while it is still open: nothing between the write and here closes it, and a push is never late.
    if (push.send && this.deps.store.get(id)?.state === "open") this.deps.push?.send(key, decision, crewMember);
    return { ok: true, decision: served(decision) };
  }

  /**
   * Why an ask's post breaks a rule of an ask, or null: only an agent's session asks; an ask names no other
   * session, carries no link, view or group (its background is the body, its files are `--file`); its own
   * rules (ask-rules.ts); and its files must have been resolved on this machine.
   */
  private askPostRefusal(from: AnySender, input: HillPostInput, fields: Cleaned, opts: HillPostOptions): { readonly code: HillRefusalCode; readonly error: string } | null {
    const ask = input.ask;
    if (ask === undefined) return null;
    if (from.kind !== "agent") return { code: "bad_body", error: "an ask comes from an agent's session" };
    if ((input.about ?? null) !== null || (input.replyTo ?? null) !== null) return { code: "bad_target", error: "an ask is about its own session, and the answer goes there" };
    if (fields.links.length > 0 || input.view !== undefined) return { code: "bad_body", error: "an ask carries no links and no view: put the background in --body, and link files with --file" };
    const rule = askRuleRefusal(fields, ask.words);
    if (rule !== null) return rule;
    if (ask.files.length > 0 && opts.askFiles === undefined) return { code: "bad_file", error: ASK_FILES_LEAD_ONLY };
    return null;
  }

  /** The `from` a new decision stores for its sender. */
  private fromOf(from: AnySender): HillDecision["from"] {
    if (from.kind === "agent") {
      return { kind: "agent", address: from.address, trickId: null, trickKey: null, memberId: from.memberId, harness: from.harness, label: this.nameOf(from.address, from.label), host: from.host, trickHost: null };
    }
    if (from.kind === "trick") {
      return { kind: "trick", address: null, trickId: from.trickId, trickKey: from.trickKey, memberId: from.memberId, harness: null, label: notCollie(headerField(from.label, WALKY_LABEL_MAX), "a trick"), host: this.deps.machine, trickHost: from.memberId };
    }
    const ref = { type: from.ref.type, id: from.ref.id, hash: from.ref.hash };
    const name = cardName(from.name);
    const base = { kind: "collie" as const, address: null, trickId: null, trickKey: null, memberId: this.deps.memberId, harness: null, label: headerField(from.label, WALKY_LABEL_MAX), host: this.deps.machine, trickHost: null, ref };
    return name === undefined ? base : { ...base, name };
  }

  /**
   * Whether a new decision pushes, and the slot it holds (push.ts). A `now` decision that may push opens
   * a slot, or keeps the one of the decision it supersedes, so the new notification replaces the old. A
   * `now` decision held by a gate sends nothing, and still keeps a superseded one's slot: the notification
   * on the phone stays until the question closes. Anything else holds no slot.
   */
  private pushPlan(key: string, member: string | null, priority: HillDecision["priority"], opts: HillPostOptions, superseded: HillDecision | null, id: string): HillPushPlan {
    const inherited = superseded?.pushTag;
    if (priority !== "now" || this.deps.push === undefined) return { tag: undefined, send: false, skipped: null };
    if (opts.reask === true) return { tag: inherited, send: false, skipped: null };
    // The person said quiet or away: nothing rings. The Decision is posted all the same.
    const crew = this.crewState().state;
    if (crew !== "here") return { tag: inherited, send: false, skipped: `the crew state is ${crew}` };
    const verdict = this.deps.push.check(key, member);
    if (verdict === "send") return { tag: inherited ?? hillPushTag(id), send: true, skipped: null };
    if (verdict === "off") return { tag: inherited, send: false, skipped: null };
    const why =
      verdict === "sender"
        ? `more than ${String(HILL_PUSH_RATE.perSender)} an hour from this sender`
        : verdict === "member"
          ? `more than ${String(HILL_PUSH_RATE.perMember)} an hour from this machine`
          : verdict === "crew"
            ? `more than ${String(HILL_PUSH_RATE.crew)} an hour from the crew's other machines`
            : `more than ${String(HILL_PUSH_RATE.total)} an hour in total`;
    return { tag: inherited, send: false, skipped: why };
  }

  /**
   * Every write of the hill. After it, a decision that closed holding a notification slot that no decision
   * left open in the same write holds gets one clear, so the phone does not keep a closed question.
   */
  private save(...changed: HillDecision[]): boolean {
    const before = new Map(changed.map((decision) => [decision.id, this.deps.store.get(decision.id)?.state]));
    if (!this.deps.store.put(...changed)) return false;
    const held = new Set(changed.filter((decision) => decision.state === "open").map((decision) => decision.pushTag));
    for (const decision of changed) {
      if (decision.state === "open" || before.get(decision.id) !== "open" || decision.pushTag === undefined || held.has(decision.pushTag)) continue;
      this.deps.push?.clear(decision.pushTag);
    }
    return true;
  }

  /** Read and check every image a post names, in order, before anything is kept. The first that fails refuses the post. */
  private readImages(raw: readonly HillImageInput[], trickRoot: string | null): { readonly ok: true; readonly images: Array<HillImageBytes & { readonly caption: string | null }> } | Extract<HillPostAnswer, { ok: false }> {
    if (raw.length === 0) return { ok: true, images: [] };
    if (raw.length > HILL_MEDIA_MAX) return { ok: false, code: "too_many_images", error: `a decision has at most ${String(HILL_MEDIA_MAX)} images` };
    const store = this.deps.media;
    if (store === undefined) return { ok: false, code: "bad_image", error: "this bridge keeps no images" };
    const images: Array<HillImageBytes & { readonly caption: string | null }> = [];
    for (const image of raw) {
      const caption = cleanLine(image.caption ?? "", HILL_MEDIA_CAPTION_MAX);
      if (caption.over) return { ok: false, code: "bad_image", error: `an image caption is at most ${String(HILL_MEDIA_CAPTION_MAX)} characters` };
      const read = store.read(image.path, trickRoot);
      if (!read.ok) return { ok: false, code: read.code, error: read.error };
      images.push({ mime: read.mime, bytes: read.bytes, width: read.width, height: read.height, caption: caption.text === "" ? null : caption.text });
    }
    return { ok: true, images };
  }

  /**
   * A crew member's images, already read and checked on the lead (crew.ts), with the captions the post
   * names, cleaned as a caption read here is. The counts must match: one held image per named one.
   */
  private heldImages(raw: readonly HillImageInput[], held: readonly HillImageBytes[]): { readonly ok: true; readonly images: Array<HillImageBytes & { readonly caption: string | null }> } | Extract<HillPostAnswer, { ok: false }> {
    if (raw.length > HILL_MEDIA_MAX || held.length > HILL_MEDIA_MAX) return { ok: false, code: "too_many_images", error: `a decision has at most ${String(HILL_MEDIA_MAX)} images` };
    if (raw.length !== held.length) return { ok: false, code: "bad_image", error: "the images do not match the post" };
    if (this.deps.media === undefined && held.length > 0) return { ok: false, code: "bad_image", error: "this bridge keeps no images" };
    const images: Array<HillImageBytes & { readonly caption: string | null }> = [];
    for (const [i, image] of raw.entries()) {
      const caption = cleanLine(image.caption ?? "", HILL_MEDIA_CAPTION_MAX);
      if (caption.over) return { ok: false, code: "bad_image", error: `an image caption is at most ${String(HILL_MEDIA_CAPTION_MAX)} characters` };
      const bytes = held[i]!;
      images.push({ mime: bytes.mime, bytes: bytes.bytes, width: bytes.width, height: bytes.height, caption: caption.text === "" ? null : caption.text });
    }
    return { ok: true, images };
  }

  /** Keep a new decision's images under ids the bridge mints. The media entries, or null when the write failed. */
  private keepImages(decisionId: string, images: ReadonlyArray<HillImageBytes & { readonly caption: string | null }>): HillMedia[] | null {
    if (images.length === 0) return [];
    const store = this.deps.media;
    if (store === undefined) return null;
    const mint = this.deps.mintMediaId ?? (() => mintMediaId());
    const ids: string[] = [];
    for (let tries = 0; ids.length < images.length && tries < images.length + 8; tries += 1) {
      const next = mint();
      if (!ids.includes(next)) ids.push(next);
    }
    if (ids.length < images.length) return null;
    const files = images.map((image, i) => ({ id: ids[i]!, bytes: image.bytes }));
    if (!store.save(decisionId, files)) return null;
    return images.map((image, i): HillMedia => {
      const entry: HillMedia = { id: ids[i]!, kind: "image", mime: image.mime, bytes: image.bytes.length, width: image.width, height: image.height };
      return image.caption === null ? entry : { ...entry, caption: image.caption };
    });
  }

  /** The bytes and type of one image of a held decision, for the phone's read route. Null for any id this bridge does not hold. */
  mediaFile(decisionId: string, mediaId: string): { readonly mime: HillMedia["mime"]; readonly bytes: Uint8Array<ArrayBuffer> } | null {
    const store = this.deps.media;
    if (store === undefined) return null;
    const media = this.deps.store.get(decisionId)?.media.find((item) => item.id === mediaId);
    if (media === undefined) return null;
    const bytes = store.bytesOf(decisionId, media);
    return bytes === null ? null : { mime: media.mime, bytes };
  }

  /**
   * Remove the image folders of decisions the store no longer holds. Run at start and from the sweep.
   * Never after the decisions file was set aside, and never while an entry this build cannot read has
   * no id it can tell (store.ts `mediaKeep`): a folder it cannot tie to a decision may still be one's.
   */
  pruneMedia(): number {
    const keep = this.deps.store.mediaKeep();
    if (keep === null) return 0;
    return this.deps.media?.prune(keep) ?? 0;
  }

  /** `about` as the post named it: none, `here` (the poster's own session) or an address. Undefined: not a live one. */
  private resolveAbout(from: AnySender, about: string | null, claimed: HillPlace | null = null): HillPlace | null | undefined {
    if (about === null || about.trim() === "") return null;
    if (about.trim() === "here") return from.kind === "agent" ? (this.deps.place(from.address) ?? (claimed?.address === from.address ? claimed : undefined)) : undefined;
    return this.deps.place(about) ?? undefined;
  }

  private mine(sender: AnySender, id: string): HillDecision | null {
    const decision = this.deps.store.get(id);
    return decision === undefined || keyOf(decision) !== senderKey(sender) ? null : decision;
  }

  /** Whether the walky address `address` is the live session `replyTo` names (the instance token included). */
  private isReplyTo(replyTo: string | null, address: string | null): boolean {
    if (replyTo === null || address === null) return false;
    return replyTo === address || this.deps.place(address)?.address === replyTo;
  }

  /**
   * Whether an answer to `decision` goes back into the poster's own session. Not so when `replyTo` names
   * another session, and never for a trick: then the typed message carries no word the poster wrote.
   */
  private answersThePoster(decision: HillDecision): boolean {
    if (decision.replyTo === null) return true;
    return decision.from.kind === "agent" && this.isReplyTo(decision.replyTo, decision.from.address);
  }

  /**
   * One decision, for its poster or for the session its `replyTo` names: the one an answer is typed into
   * reads it with `collie hill status`. Anybody else's id answers as not found.
   */
  status(sender: HillSender, id: string): HillOneAnswer {
    const decision = this.mine(sender, id) ?? this.addressedTo(sender, id);
    if (decision !== null) return { ok: true, decision: served(this.named(decision)) };
    return this.left(sender, id) ?? { ok: false, missing: true, error: `no decision ${id} from this session` };
  }

  /**
   * The answer for one of the sender's decisions that a clear removed (the person's or the sweep's), from
   * its tombstone: the state it closed in. Null when the sender posted no such decision, or its tombstone aged out.
   */
  private left(sender: AnySender, id: string): HillOneAnswer | null {
    if (this.deps.store.get(id) !== undefined) return null;
    const stone = this.deps.store.tombstone(id);
    if (stone === undefined || stone.key !== senderKey(sender)) return null;
    return { ok: false, missing: false, error: leftTheHill(id, stone.state) };
  }

  /** A decision whose `replyTo` is the asking agent's live session, or null. */
  private addressedTo(sender: HillSender, id: string): HillDecision | null {
    if (sender.kind !== "agent") return null;
    const decision = this.deps.store.get(id);
    return decision !== undefined && this.isReplyTo(decision.replyTo, sender.address) ? decision : null;
  }

  /**
   * The second Clear (1.29.0): withdraw and clear every OPEN agent Decision the person already answered in
   * its session (`spokeAfter`). Each closes `withdrawn` with {@link HILL_ANSWERED_IN_SESSION}, then leaves
   * the Hill as Clear removes a closed one, with a tombstone. NOTHING IS TYPED: the person already spoke
   * to that session, and a line from the Hill now would be a second, stale answer. One `hill.clear.spoken`
   * audit line with the count. Refused on a member and a deposed lead, which hold no Hill.
   */
  clearSpoken(device: string | null = null, ids: readonly string[] | null = null): { readonly ok: true; readonly cleared: number } | { readonly ok: false; readonly error: string; readonly notLead: boolean } {
    if (this.deps.crewMode() === "peer" || this.deps.deposed?.() === true) return { ok: false, error: NOT_ON_LEAD, notLead: true };
    const now = this.now();
    // With `ids` (the phone's), only the cards it showed: one marked since stays for the next look (C-N5).
    const shown = ids === null ? null : new Set(ids);
    const closed: HillDecision[] = [];
    for (const decision of this.deps.store.all()) {
      if (decision.state !== "open" || decision.spokeAfter === undefined) continue;
      if (shown !== null && !shown.has(decision.id)) continue;
      // An answer in flight for it finishes first; the card is left to that answer (C-A7).
      if (this.busy(decision.id)) continue;
      closed.push({ ...decision, state: "withdrawn", closedAt: now, closedReason: HILL_ANSWERED_IN_SESSION });
    }
    if (closed.length === 0) return { ok: true, cleared: 0 };
    if (!this.save(...closed)) return { ok: false, error: HILL_SPOKEN_UNSAVED, notLead: false };
    // Withdrawn and saved: they left the open list. A removal that fails leaves them closed under
    // Answered, where the first Clear takes them.
    this.clear(closed.map((decision) => decision.id), device);
    this.deps.audit?.({ action: "hill.clear.spoken", device, detail: { count: closed.length } });
    return { ok: true, cleared: closed.length };
  }

  /** The poster takes an open decision back. It closes `withdrawn`, "by the poster" (a trick's runner names its own reason). */
  withdraw(sender: HillSender, id: string, reason: string = BY_THE_POSTER): HillOneAnswer {
    return this.withdrawAny(sender, id, reason);
  }

  private withdrawAny(sender: AnySender, id: string, reason: string): HillOneAnswer {
    const decision = this.mine(sender, id);
    if (decision === null) return this.left(sender, id) ?? { ok: false, missing: true, error: `no decision ${id} from this session` };
    if (decision.state !== "open") return { ok: false, missing: false, error: `${id} is ${decision.state}, nothing to withdraw` };
    const closed: HillDecision = { ...decision, state: "withdrawn", closedAt: this.now(), closedReason: reason };
    if (!this.save(closed)) return { ok: false, missing: false, error: "the change could not be saved on this machine; the decision stays open" };
    this.deps.audit?.({ action: "hill.withdraw", detail: { decisionId: id } });
    return { ok: true, decision: served(closed) };
  }

  /**
   * The state a cleared decision closed in, or undefined when this id was never cleared (or its
   * tombstone aged out). The tricks runner reads it, so an answered key stays closed after a clear.
   */
  clearedState(id: string): HillState | undefined {
    return this.deps.store.tombstone(id)?.state;
  }

  /**
   * Clear closed decisions from the Hill: `ids` names them, null means every closed one. An open
   * decision is never removed: its id comes back in `skipped` as `open`, an id this bridge does not hold
   * as `missing`. Removal deletes the decision and its images, leaves a tombstone, and moves the
   * revision. One `hill.clear` audit line for a clear that removed something, with counts and no words.
   * Answers null when the write failed: nothing was removed.
   */
  clear(ids: readonly string[] | null, device: string | null = null): HillClearAnswer | null {
    const held = this.deps.store.all();
    const skipped: Array<{ id: string; reason: "open" | "missing" }> = [];
    let chosen: HillDecision[];
    if (ids === null) chosen = held.filter((decision) => decision.state !== "open");
    else {
      chosen = [];
      for (const id of new Set(ids)) {
        const decision = held.find((candidate) => candidate.id === id);
        if (decision === undefined) skipped.push({ id, reason: "missing" });
        else if (decision.state === "open") skipped.push({ id, reason: "open" });
        else chosen.push(decision);
      }
    }
    if (chosen.length === 0) return { cleared: [], skipped };
    const removed = this.forgetClosed(chosen);
    if (removed === null) return null;
    this.deps.audit?.({ action: "hill.clear", device, detail: { count: removed.length, all: ids === null, skipped: skipped.length } });
    return { cleared: removed, skipped };
  }

  /** The sender's own decisions: open first (as the phone sorts them), then closed, newest first. */
  mineList(sender: HillSender): HillDecision[] {
    const key = senderKey(sender);
    const own = this.deps.store.all().filter((decision) => keyOf(decision) === key);
    const open = this.look(() => sortOpenDecisions(own.filter((decision) => decision.state === "open")).map((decision) => this.named(decision)));
    const closed = own.filter((decision) => decision.state !== "open").toSorted((a, b) => (b.closedAt ?? b.at) - (a.closedAt ?? a.at));
    return [...open, ...closed].map(served);
  }

  /**
   * The bridge's slow timer (every 15 s): close every open decision past its `expiresAt` as `expired`,
   * and every one whose target session has ended as `undeliverable` ("target session ended"), so a
   * poster that is gone does not leave its decisions on the hill. Answers how many closed.
   *
   * A decision whose answer would go to a crew machine the roster no longer lists closes `undeliverable`
   * ({@link LEFT_THE_CREW}) at once: a removal is a fact of the roster, not a reading of a census.
   *
   * A target counts as ended only when it is absent at two sweeps in a row, each from a census read
   * with success (`censusKnown`): an empty list from a good read closes the cards of a machine whose
   * last agent left, and a failed or unknown read closes nothing. A trick's decision with no `replyTo`
   * has no session to end; its runner owns it.
   */
  sweep(now: number = this.now()): number {
    // A switch the CLI moved is seen here within one sweep, so its notifications close without a phone.
    this.isOn();
    this.pruneMedia();
    this.selfClear(now);
    const due = this.deps.store.all().filter((decision) => decision.state === "open" && decision.expiresAt !== null && decision.expiresAt <= now);
    const expired = due.map((decision): HillDecision => Object.assign({}, decision, { state: "expired" as const, closedAt: now, closedReason: EXPIRED }));
    const left = this.leftTheCrew(new Set(due.map((decision) => decision.id)));
    const ended = this.look(() => this.endedTargets(new Set([...due, ...left].map((decision) => decision.id))));
    const closed = [
      ...expired,
      ...left.map((decision): HillDecision => Object.assign({}, decision, { state: "undeliverable" as const, closedAt: now, closedReason: LEFT_THE_CREW })),
      ...ended.map((decision): HillDecision => Object.assign({}, decision, { state: "undeliverable" as const, closedAt: now, closedReason: TARGET_ENDED })),
    ];
    if (closed.length === 0) return 0;
    if (this.save(...closed)) return closed.length;
    // Not saved: the ended ones are still absent, and the next sweep tries them again.
    for (const decision of ended) this.absent.add(decision.id);
    return 0;
  }

  /**
   * Clear every agent's or trick's decision that closed without the person ({@link SELF_CLEARING}) at
   * least {@link HILL_SELF_CLEAR_MS} ago, as Clear does: removed with its images, a tombstone kept, the
   * revision moved, one `hill.clear.self` audit line with the count. A card the person's own message
   * closed ({@link HILL_ANSWERED_IN_SESSION}) is theirs, as an answer is, and stays. Collie's own cards are left to the
   * person: the version card reads an expired card as seen, and a cleared one would ask again. A write
   * that fails leaves them for the next sweep.
   */
  private selfClear(now: number): void {
    const due = this.deps.store.all().filter((decision) => selfClears(decision) && (decision.closedAt ?? decision.at) + HILL_SELF_CLEAR_MS <= now);
    if (due.length === 0) return;
    const removed = this.forgetClosed(due);
    if (removed !== null && removed.length > 0) this.deps.audit?.({ action: "hill.clear.self", detail: { count: removed.length } });
  }

  /** Remove closed decisions with a tombstone each. The ids removed, or null when the write failed. */
  private forgetClosed(chosen: readonly HillDecision[]): string[] | null {
    const stones = chosen.map((decision): HillTombstone => ({
      id: decision.id,
      requestId: decision.requestId,
      key: keyOf(decision),
      digest: decision.postDigest ?? null,
      // Only closed decisions are chosen.
      state: decision.state === "open" ? "withdrawn" : decision.state,
      closedAt: decision.closedAt ?? decision.at,
    }));
    return this.deps.store.forget(stones);
  }

  /**
   * The open decisions whose answer would go to a crew machine the roster no longer lists (`removed`). A
   * fact of the roster, not of a census, so one sweep is enough. Only on the bridge that holds the crew's
   * Hill (a lead, or a lead whose last member went and is solo now); never on a peer or a deposed lead.
   */
  private leftTheCrew(skip: ReadonlySet<string>): HillDecision[] {
    const removed = this.deps.removed;
    if (removed === undefined || this.deps.crewMode() === "peer" || this.deps.deposed?.() === true) return [];
    return this.deps.store.all().filter((decision) => {
      if (decision.state !== "open" || skip.has(decision.id) || decision.target === null) return false;
      const to = decision.replyTo ?? decision.from.address;
      return to !== null && removed(to);
    });
  }

  /** The open decisions whose target was gone at this sweep and the last one. Moves the memory of who was gone. */
  private endedTargets(skip: ReadonlySet<string>): HillDecision[] {
    const gone: string[] = [];
    const ended: HillDecision[] = [];
    for (const decision of this.deps.store.all()) {
      if (decision.state !== "open" || skip.has(decision.id)) continue;
      const to = decision.replyTo ?? decision.from.address;
      // A trick's decision with no `replyTo` types into nothing: the trick runner owns it.
      if (decision.target === null || to === null) continue;
      // A crew machine that is not answering ends none of its sessions: the decision waits for it (§22).
      if (this.away(to) !== null) continue;
      // Not sure is not a fact: absent from a census this bridge could not read with success says nothing,
      // and leaving it out of `gone` starts its row again.
      if (!(this.deps.censusKnown?.(to) ?? true)) continue;
      if (this.deps.place(to)?.address === to) continue;
      if (this.absent.has(decision.id)) ended.push(decision);
      else gone.push(decision.id);
    }
    this.absent = new Set(gone);
    return ended;
  }

  /**
   * One answer from a phone, by the receipt rules of the contract, in this order: a known `rid`, the
   * decision open, the intent, the text rule, the target still live; then the receipt, the close and
   * the send. `id` is the decision id the node named. `by` is the device's label, as operator walky uses it;
   * `deviceId` its pairing record's id ({@link hillDeviceId}), kept beside it on the receipt and the answer.
   *
   * A known `rid` with the same payload answers its stored receipt and runs nothing, with one exception:
   * an `ok` receipt the decision does not show (the bridge stopped between the receipt and the close, or
   * a close the receipt never heard of). That answer is settled once, in the claim lane: closed and
   * delivered when the decision is still open, else answered `gone` with the state it has.
   */
  answer(request: HillAnswerRequest, id: string, by: string, deviceId: string | null = null): Promise<HillAnswerOutcome> {
    // With the Hill off nothing is typed and no tap runs; the decision stays open for when it is back. The
    // one exception is a card of Collie's own about a trick, as the store holds it (spec 14).
    if (this.refusesHere() && !this.isHeldTrickCard(id)) return Promise.resolve({ kind: "off" });
    // Tricks switched off as a whole: a trick's own Decision stays open, nothing closes and no program runs.
    const held = this.deps.store.get(id);
    if (held !== undefined && this.heldBack(held, this.tricksOff())) return Promise.resolve({ kind: "tricks-off" });
    // §25: a deposed lead's Decisions went to the machine that took over, and a peer's Hill is not the
    // crew's; an answer here could be a second one. Refused, nothing typed, nothing closed, nothing stored.
    if (this.deps.crewMode() === "peer" || this.deps.deposed?.() === true) {
      const state = this.deps.store.get(id)?.state ?? null;
      return Promise.resolve({ kind: "receipt", receipt: { rid: request.rid, code: "denied", reason: HILL_DEPOSED, state, delivery: null, trick: null, at: this.now() } });
    }
    const digest = hillAnswerDigest(request.node, request.intent, request.value.text);
    // SYNCHRONOUS from here to `track`: two requests with one rid must not both get past the look.
    const stored = this.deps.receipts.get(request.rid);
    if (stored !== undefined) {
      if (stored.payloadDigest !== digest) return Promise.resolve({ kind: "reused" });
      if (!this.unsettled(stored, id)) return Promise.resolve({ kind: "receipt", receipt: stored.receipt });
    }
    const running = this.deps.receipts.inflight(request.rid);
    if (running !== undefined) return digestDiffers(running, digest) ? Promise.resolve({ kind: "reused" }) : running;
    const work = withDigest(this.run(request, id, by, digest, deviceId), digest);
    this.deps.receipts.track(request.rid, work);
    return work;
  }

  /**
   * Whether a stored receipt says `ok` for an answer its decision does not show: the decision is held and
   * its answer is not this `rid`'s. A decision the store no longer holds left the closed list after it
   * closed, so its `ok` stands.
   */
  private unsettled(stored: HillReceiptRecord, id: string): boolean {
    if (stored.receipt.code !== "ok") return false;
    const decision = this.deps.store.get(id);
    return decision !== undefined && decision.answer?.rid !== stored.requestId;
  }

  private async run(request: HillAnswerRequest, id: string, by: string, digest: string, deviceId: string | null): Promise<HillAnswerOutcome> {
    // SYNCHRONOUS up to the first await: the answer counts as running from the tap on.
    this.claiming.set(id, (this.claiming.get(id) ?? 0) + 1);
    try {
      return await this.runClaimed(request, id, by, digest, deviceId);
    } finally {
      const left = (this.claiming.get(id) ?? 1) - 1;
      if (left <= 0) this.claiming.delete(id);
      else this.claiming.set(id, left);
    }
  }

  private async runClaimed(request: HillAnswerRequest, id: string, by: string, digest: string, deviceId: string | null): Promise<HillAnswerOutcome> {
    const claimed = this.lane.then(() => this.guarded(id, () => this.claim(request, id, by, digest, deviceId)));
    this.lane = claimed.then(
      () => undefined,
      () => undefined,
    );
    const claim = await claimed;
    if (claim.kind === "done") return claim.outcome;
    let delivery: NonNullable<HillReceipt["delivery"]> = "none";
    let threw = false;
    // The write of the typed line was not confirmed: walky said `unknown`, or the send threw.
    let unconfirmed = false;
    if (claim.send !== null) {
      let sent: HillSendResult;
      try {
        sent = await this.deps.send(claim.send.to, claim.send.body, by, claim.send.subject);
      } catch {
        // Not confirmed, and never sent again: the decision stays answered with `unknown`.
        sent = "unknown";
        threw = true;
      }
      // Walky typed nothing (C-S1, review 8): the answer did not happen, so the Decision opens again.
      if (sent === "refused" && claim.decision.from.kind !== "collie") return await this.unclaim(claim, request, by);
      delivery = sent === "refused" || sent === "inbox-only" ? "unknown" : sent;
      unconfirmed = sent === "unknown";
    }
    // One line of its own: the answer is kept on the decision, and the session reads it with `collie hill status`.
    if (claim.send !== null && delivery === "unknown") this.deps.audit?.({ action: "hill.undelivered", device: by, detail: { decisionId: id, why: threw ? "the send failed" : "not confirmed" } });
    let trick: NonNullable<HillReceipt["trick"]> = "none";
    if (claim.tap !== null) trick = (await this.runTap(claim.tap)) ? "ran" : "failed";
    const receipt: HillReceipt = { ...claim.record.receipt, delivery, trick };
    await this.deps.receipts.record({ ...claim.record, receipt });
    const now = this.deps.store.get(id);
    if (now?.answer?.rid === request.rid && (now.answer.delivery !== delivery || now.answer.trick !== trick || (now.answer.unconfirmed === true) !== unconfirmed)) {
      const { unconfirmed: _was, ...kept } = now.answer;
      this.save({ ...now, answer: unconfirmed ? { ...kept, delivery, trick, unconfirmed: true } : { ...kept, delivery, trick } });
    }
    this.auditAnswer(claim.decision, request, by, receipt);
    return { kind: "receipt", receipt };
  }

  /**
   * Undo a claim whose answer walky refused to type: the Decision is open again as it was (no answer, no
   * close), no trick tap runs, and the receipt this `rid` keeps is `rejected` with {@link HILL_NOT_TYPED},
   * so the card stays answerable and says why. Collie's own card is never undone: its act already ran.
   */
  private async unclaim(claim: Extract<Claim, { kind: "deliver" }>, request: HillAnswerRequest, by: string): Promise<HillAnswerOutcome> {
    const id = claim.decision.id;
    const held = this.deps.store.get(id);
    if (held !== undefined && held.state === claim.decision.state && held.answer?.rid === request.rid) {
      this.save({ ...held, state: "open", closedAt: null, closedReason: null, answer: null });
    }
    const receipt = receiptOf(request.rid, this.now(), "rejected", HILL_NOT_TYPED, this.deps.store.get(id)?.state ?? null, "none");
    await this.deps.receipts.record({ ...claim.record, receipt });
    this.deps.audit?.({ action: "hill.undelivered", device: by, detail: { decisionId: id, why: "refused, the Decision is open again" } });
    return { kind: "receipt", receipt };
  }

  /**
   * Why a yes to a group of cards is refused, or null. The yes names the digest this phone was given, so it
   * approves exactly the cards it showed. Which cards the phone opened is no longer asked (ADR 0156, the
   * operator's decision of 2026-11-17: the yes is a hold of three seconds, reading is offered and not
   * required). An older phone still sends `opened`; it is read and ignored.
   */
  private groupRule(decision: HillDecision, request: HillAnswerRequest): string | null {
    const group = decision.group;
    if (group === undefined) return this.singleCodeRule(decision, request);
    if (request.intent === "dismiss" || request.intent === group.decline) return null;
    const asked = request.group;
    if (asked === undefined) return HILL_GROUP_OLD_APP;
    return asked.digest === group.digest ? null : HILL_GROUP_CHANGED;
  }

  /**
   * Why a yes to a single card of code is refused, or null (C-A2, review 8): the group's rule for one card.
   * The answer names the ref's hash as its digest; the decline and a dismiss need none.
   */
  private singleCodeRule(decision: HillDecision, request: HillAnswerRequest): string | null {
    const single = singleCodeCard(decision);
    // A trick card whose stored view holds no code part offers no yes (2026-11-17): the bridge makes none
    // (version-card.ts `keepOnly`), the phone shows none, and a yes that comes anyway is refused here, so
    // nothing installs or switches on from a card that showed no code. The decline and a dismiss still go.
    if (single === null) {
      const decline = trickCardDecline(decision);
      return decline === null || request.intent === "dismiss" || request.intent === decline ? null : HILL_CODE_NONE;
    }
    if (request.intent === "dismiss" || request.intent === single.decline) return null;
    const asked = request.group;
    if (asked === undefined) return HILL_CODE_OLD_APP;
    return asked.digest === single.digest ? null : HILL_GROUP_CHANGED;
  }

  /** Run one claim; while it runs, a Collie Decision it answers cannot be withdrawn or superseded. */
  private async guarded<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.deps.store.get(id)?.from.kind !== "collie") return fn();
    this.answering.add(id);
    try {
      return await fn();
    } finally {
      this.answering.delete(id);
    }
  }

  /**
   * Act on an answer to a Collie Decision before it closes: null when done, else the plain line the
   * refusal shows. A throw, or no handler, refuses; the card stays open for another tap.
   */
  private async actForCollie(decision: HillDecision, intent: string): Promise<HillCollieVerdict> {
    const ref = decision.from.ref;
    if (ref === undefined || this.deps.onCollieAnswer === undefined) return { ok: false, reason: HILL_NO_ANSWER_HANDLER };
    try {
      return await this.deps.onCollieAnswer(ref, intent);
    } catch {
      return { ok: false, reason: HILL_NO_ANSWER_HANDLER };
    }
  }

  /** The trick's tap, run once. A throw, or no tricks runner, is a failed tap; nothing retries. */
  private async runTap(tap: NonNullable<Extract<Claim, { kind: "deliver" }>["tap"]>): Promise<boolean> {
    if (this.deps.tap === undefined) return false;
    try {
      return await this.deps.tap(tap.host, tap.trickId, tap.tap, tap.decisionId);
    } catch {
      return false;
    }
  }

  private auditAnswer(decision: Pick<HillDecision, "id">, request: HillAnswerRequest, by: string, receipt: HillReceipt): void {
    const detail = { decisionId: decision.id, intent: request.intent, textLength: request.value.text?.length ?? 0, receiptCode: receipt.code, delivery: receipt.delivery ?? "none", trick: receipt.trick ?? "none" };
    this.deps.audit?.({ action: "hill.answer", device: by, detail: receipt.deviceId === undefined ? detail : { ...detail, deviceId: receipt.deviceId } });
  }

  /**
   * A receipt that ends the answer before any send: written (unless `keep` is false), audited, answered.
   * It replaces a stored `ok` for the same `rid` that the decision never showed.
   */
  private async final(request: HillAnswerRequest, id: string, by: string, digest: string, receipt: HillReceipt, keep = true): Promise<Claim> {
    if (keep) await this.deps.receipts.record({ requestId: request.rid, payloadDigest: digest, receipt });
    this.auditAnswer({ id }, request, by, receipt);
    return { kind: "done", outcome: { kind: "receipt", receipt } };
  }

  private async claim(request: HillAnswerRequest, id: string, by: string, digest: string, deviceId: string | null): Promise<Claim> {
    const { rid, intent } = request;
    // A retry of an unsettled `ok` (see `answer`) waited in the lane: another may have settled it meanwhile.
    const known = this.deps.receipts.get(rid);
    if (known !== undefined && !this.unsettled(known, id)) return { kind: "done", outcome: { kind: "receipt", receipt: known.receipt } };
    const now = this.now();
    const decision = this.deps.store.get(id);
    // No receipt for an id this bridge never held: junk ids must not push real receipts out of the capped file.
    if (decision === undefined) {
      // A cleared decision answers as it did while it was held: gone, with the state it closed in.
      const stone = this.deps.store.tombstone(id);
      if (stone !== undefined) return this.final(request, id, by, digest, receiptOf(rid, now, "gone", `the decision is ${stone.state}`, stone.state, null));
      return this.final(request, id, by, digest, receiptOf(rid, now, "gone", "no such decision", null, null), false);
    }
    if (decision.state !== "open") return this.final(request, id, by, digest, receiptOf(rid, now, "gone", `the decision is ${decision.state}`, decision.state, null));
    // Past its expiry and not swept yet: it is expired now, as the sweep would close it.
    if (decision.expiresAt !== null && decision.expiresAt <= now) {
      const expired = await this.final(request, id, by, digest, receiptOf(rid, now, "gone", "the decision is expired", "expired", null));
      this.closeAs(id, now, "expired", EXPIRED);
      return expired;
    }
    const option = decision.options.find((candidate) => candidate.intent === intent);
    // The intent is typed into the session; only a word the post rules let through ever is (a stored file is not re-checked on load).
    if (option !== undefined && !isHillOptionIntent(option.intent)) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", "not an option of this decision", "open", null));
    if (option === undefined && intent !== "answer" && intent !== "dismiss" && !(decision.ask !== undefined && intent === HILL_MORE_CONTEXT)) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", "not an option of this decision", "open", null));
    // An ask with options takes one of them or "I need more context"; only a `--words` ask takes words alone.
    if (decision.ask !== undefined && intent === "answer" && !decision.ask.words) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", "not an option of this decision", "open", null));
    // A yes to a trick's code needs the digest this phone was given (the code it showed), so a yes never
    // approves other code than the card showed. Its decline and a dismiss need none. Nothing is kept for
    // these refusals, so the same answer may go again from a phone that shows the card as it is now.
    const groupRule = this.groupRule(decision, request);
    if (groupRule !== null) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", groupRule, "open", null), false);
    const cleaned = cleanText(request.value.text ?? "", HILL_ANSWER_TEXT_MAX);
    if (cleaned.over) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", `text is longer than ${String(HILL_ANSWER_TEXT_MAX)} characters`, "open", null));
    const text = cleaned.text === "" ? null : cleaned.text;
    const textRule = this.textRule(decision, intent, text);
    if (textRule !== null) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", textRule, "open", null));
    // Collie's own card carries Collie's own title and labels (a trick's id, fixed words), so the session
    // it tells gets them as a poster does.
    // The crew state at this moment rides on the typed answer as one last line, while it is not `here`.
    // An ask's answer is the one-line form of a Send (answers-message.ts); a dismiss of one says only that.
    const message =
      decision.ask !== undefined && intent !== "dismiss" ? answersMessage([{ ask: decision, intent, text }]) : answerMessage(decision, intent, option?.label ?? null, text, this.answersThePoster(decision) || decision.from.kind === "collie");
    let body = withCrewLine(message, this.crewState().state);
    if (codePoints(body) > WALKY_BODY_MAX) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", "text is too long for one message", "open", null));

    // Where the answer goes: `replyTo`, else the poster. A trick with no `replyTo` has nothing to type into.
    const to = decision.replyTo ?? decision.from.address;
    // A session on a crew machine that is not answering: refused BEFORE anything is closed or written, so
    // the card stays open and the same tap may go once the machine is back. Nothing is queued (§10.3).
    // A dismiss is the exception: it always closes the card, typing nothing, and its receipt names the
    // machine, so the phone says the session was not told (a card no tap could close would stay forever).
    const away = decision.target !== null && to !== null ? this.away(to) : null;
    const untold = away !== null && intent === "dismiss";
    if (away !== null && !untold) return this.final(request, id, by, digest, { ...receiptOf(rid, now, "rejected", notAnswering(away), "open", null), machine: away }, false);
    if (!untold && decision.target !== null && to !== null && this.deps.place(to)?.address !== to) {
      const gone = await this.final(request, id, by, digest, receiptOf(rid, now, "gone", TARGET_ENDED, "undeliverable", null));
      this.closeAs(id, now, "undeliverable", TARGET_ENDED);
      return gone;
    }
    // Collie's own Decision acts here, once, before anything is written: a refusal (the code moved since
    // the card was made) keeps the card open, and a dismiss closes it with no act at all.
    if (decision.from.kind === "collie" && intent !== "dismiss") {
      const verdict = await this.actForCollie(decision, intent);
      if (!verdict.ok) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", verdict.reason, "open", null));
      // What Collie did rides after the option line, when it still fits one message.
      const told = verdict.told === undefined ? body : withCrewLine(`${message}\n${verdict.told}`, this.crewState().state);
      if (codePoints(told) <= WALKY_BODY_MAX) body = told;
    }
    const state: HillState = intent === "dismiss" ? "dismissed" : "answered";
    // Collie's own card with a session to tell (a trick proposal's proposer): typed only while that session
    // is live and its machine answers. Never a dismiss, and never a reason to hold the answer.
    const courtesy = decision.from.kind === "collie" && decision.target === null && decision.replyTo !== null && intent !== "dismiss" && this.deps.walkyOn() && this.deps.place(decision.replyTo)?.address === decision.replyTo && this.away(decision.replyTo) === null;
    const typed = (decision.target !== null && to !== null && !untold) || courtesy;
    const trick = trickOf(decision);
    // Written first, as not confirmed: a bridge that stops after this line never types the answer twice,
    // and never runs the trick's tap twice (it reads `failed`, the tap that did not run).
    const firstTrick = trick === null ? "none" : "failed";
    const plain = receiptOf(rid, now, "ok", null, state, typed ? "unknown" : "none", firstTrick);
    const first = untold && away !== null ? { ...plain, machine: away } : plain;
    const device = deviceId !== null && HILL_DEVICE_ID_RE.test(deviceId) ? deviceId : null;
    const record: HillReceiptRecord = { requestId: rid, payloadDigest: digest, receipt: device === null ? first : { ...first, deviceId: device } };
    if (!(await this.deps.receipts.recordFirst(record))) return { kind: "done", outcome: { kind: "unsaved" } };
    // A withdraw or an expiry may have closed it while the receipt was written.
    const fresh = this.deps.store.get(id);
    if (fresh === undefined || fresh.state !== "open") {
      const late = receiptOf(rid, now, "gone", `the decision is ${fresh?.state ?? "gone"}`, fresh?.state ?? null, null);
      return this.final(request, id, by, digest, late);
    }
    const label = intent === HILL_MORE_CONTEXT ? HILL_MORE_CONTEXT_LABEL : (option?.label ?? null);
    const answer: NonNullable<HillDecision["answer"]> = { rid, intent, label, text, by: headerField(by, WALKY_LABEL_MAX), at: now, delivery: typed ? "unknown" : "none", trick: firstTrick };
    const closed: HillDecision = { ...fresh, state, closedAt: now, closedReason: null, answer: device === null ? answer : { ...answer, deviceId: device } };
    if (!this.save(closed)) {
      const unsaved = receiptOf(rid, now, "unknown", "the answer could not be saved on this machine; nothing was typed", "open", null);
      return this.final(request, id, by, digest, unsaved);
    }
    const send = typed && to !== null ? (decision.ask !== undefined && intent !== "dismiss" ? { to, body, subject: ASKS_ANSWERS_SUBJECT } : { to, body }) : null;
    const tap = trick === null ? null : { host: trick.host, trickId: trick.trickId, decisionId: id, tap: { rid, node: hillNode(trick.trickKey), intent, value: { text } } };
    if (send === null && tap === null) {
      this.auditAnswer(closed, request, by, record.receipt);
      return { kind: "done", outcome: { kind: "receipt", receipt: record.receipt } };
    }
    return { kind: "deliver", decision: closed, record, send, tap };
  }

  // ── ASKS (2026-11-22): the socket's `ask.*` ops, and one Send per session ─────────────────────────

  /**
   * `ask.post` from the socket: an ask from an agent's pane. On this machine its linked files are resolved
   * under the pane's Files root first (deps `askFiles`, the Files view's own checks), then it is posted as a
   * Decision with the `ask` field. On a crew member it goes to the lead without files (`--file` is refused
   * here, {@link ASK_FILES_LEAD_ONLY}); a lead that does not know asks posts a plain Decision, which the
   * member takes back at once and refuses `lead_too_old`.
   */
  async askPost(from: HillAgentSender, fields: JsonObject): Promise<HillPostAnswer> {
    const read = readPostFields(fields);
    if (!read.ok) return refuse(read.code, read.error);
    const ask = read.input.ask;
    if (ask === undefined) return refuse(null, "bad request: an ask names its `ask` field");
    const forward = this.forwardOf();
    if (forward !== null) {
      if (ask.files.length > 0) return refuse("bad_file", ASK_FILES_LEAD_ONLY);
      const answer = await this.postFields(from, fields);
      if (!answer.ok || answer.decision.ask !== undefined) return answer;
      // The lead is older than asks: it posted a plain Decision. Take it back, and say so.
      await forward.one("withdraw", from, answer.decision.id);
      return refuse("lead_too_old", ASK_LEAD_TOO_OLD);
    }
    // The switch first, so a Hill that is off says so before any file is looked at.
    if (this.refusesHere()) return refuse("hill_off", HILL_OFF);
    const files = this.deps.askFiles === undefined ? null : await this.deps.askFiles(from.address, ask.files);
    if (files !== null && !files.ok) return refuse("bad_file", files.error);
    const posted = this.withCrewState(this.postDecision(from, read.input, files === null ? {} : { askFiles: { root: files.root, files: files.files } }));
    if (posted.ok) this.deps.checks?.noteVerb(senderKey(from));
    return posted;
  }

  /** `ask.list` from the socket: the sender's own OPEN asks, oldest first, from this bridge or the lead. */
  async askOpen(sender: HillAgentSender): Promise<HillListAnswer> {
    const listed = await this.askList(sender);
    if (!listed.ok) return listed;
    return { ok: true, decisions: listed.decisions.filter((decision) => decision.state === "open" && decision.ask !== undefined).toSorted((a, b) => a.at - b.at) };
  }

  /** `ask.cancel` from the socket: {@link cancelAsk} here, or on a crew member the lead's. */
  async askCancel(sender: HillAgentSender, id: string, how: HillAskCancel): Promise<HillOneAnswer> {
    const forward = this.forwardOf();
    if (forward !== null) return forward.one("withdraw", sender, id, how);
    const answer = this.cancelAsk(sender, id, how);
    if (answer.ok) this.deps.checks?.noteVerb(senderKey(sender));
    return answer;
  }

  /**
   * `ask.keep` from the socket (.adr/0177): the agent says "still true" for one or more of its own open asks,
   * and each gets `ask.confirmedAt` now. All or nothing: an id that is not an open ask of this session refuses
   * the whole call, with a sentence that names it. Works with the Hill off, as a take back does: it types
   * nothing and rings nothing. On a crew member it is refused: the asks are on the lead, and the crew wire
   * carries no keep in this build.
   */
  askKeep(sender: HillAgentSender, ids: readonly string[]): HillListAnswer {
    if (this.forwardOf() !== null) return { ok: false, error: ASK_KEEP_MEMBER };
    if (this.deps.crewMode() === "peer" || this.deps.deposed?.() === true) return { ok: false, error: NOT_ON_LEAD };
    const unique = [...new Set(ids)];
    if (unique.length === 0 || unique.length > HILL_ASK_OPEN_MAX) return { ok: false, error: `keep takes 1 to ${String(HILL_ASK_OPEN_MAX)} ask ids` };
    const kept: HillDecision[] = [];
    const now = this.now();
    for (const id of unique) {
      const decision = this.mine(sender, id);
      if (decision === null || decision.ask === undefined) return { ok: false, error: `${id} is not an ask of this session` };
      if (decision.state !== "open") return { ok: false, error: `${id} is ${decision.state}, only an open ask can be kept` };
      kept.push({ ...decision, ask: { ...decision.ask, confirmedAt: now } });
    }
    if (!this.save(...kept)) return { ok: false, error: "the change could not be saved on this machine; nothing was kept" };
    this.deps.checks?.noteVerb(senderKey(sender));
    this.deps.audit?.({ action: "hill.ask.keep", detail: { asks: kept.length } });
    return { ok: true, decisions: kept.map((decision) => served(this.named(decision))) };
  }

  /**
   * `ask.check` from the socket (.adr/0177): whether the session in the pane `where` looks at its open asks at
   * the end of this turn. "check" only when the Hill is on here, the session has open asks, the bridge knows
   * the turn, no check ran in it, the brake allows it and an ask was left untouched in it (check.ts). Then the
   * pane reads as working until the check's turn ends. Every error, and a crew member, is "none".
   */
  askCheck(sender: HillAgentSender, where: { readonly session: string; readonly paneId: string }): AskCheckDecision {
    try {
      const book = this.deps.checks;
      if (book === undefined) return { kind: "none", why: "off" };
      if (this.forwardOf() !== null || this.deps.crewMode() === "peer" || this.deps.deposed?.() === true) return { kind: "none", why: "off" };
      if (this.refusesHere()) return { kind: "none", why: "off" };
      const key = senderKey(sender);
      const open = this.deps.store.all().filter((decision) => decision.state === "open" && decision.ask !== undefined && keyOf(decision) === key);
      const decided = book.decide(key, book.turn(where.session, where.paneId), open);
      if (decided.kind !== "check") return decided;
      book.lift(where.session, where.paneId);
      this.deps.audit?.({ action: "hill.ask.check", detail: { asks: decided.asks.length } });
      return decided;
    } catch {
      return { kind: "none", why: "error" };
    }
  }

  /**
   * The poster takes an ask (or any Decision of its own) back. `answered`: the person answered it in the
   * session, closed {@link HILL_ASK_ANSWERED_HERE}, never "taken back". `because`: the agent's reason,
   * kept in the closed reason ({@link askTakenBack}). Both are for an ask only.
   */
  cancelAsk(sender: HillSender, id: string, how: HillAskCancel): HillOneAnswer {
    const decision = this.mine(sender, id);
    const special = how.answered || how.because !== null;
    if (special && decision !== null && decision.ask === undefined) return { ok: false, missing: false, error: `${id} is not an ask: --answered and --because close an ask; take a Decision back with no flag` };
    if (how.answered && how.because !== null) return { ok: false, missing: false, error: "--answered and --because do not go together: an ask answered in the session needs no reason" };
    if (how.answered) return this.withdrawAny(sender, id, HILL_ASK_ANSWERED_HERE);
    if (how.because === null) return this.withdrawAny(sender, id, BY_THE_POSTER);
    const because = cleanLine(how.because, HILL_ASK_BECAUSE_MAX);
    if (because.text === "" || because.over) return { ok: false, missing: false, error: `--because is 1 to ${String(HILL_ASK_BECAUSE_MAX)} characters` };
    return this.withdrawAny(sender, id, askTakenBack(because.text));
  }

  /**
   * One Send per session (`POST /api/hill/answers`): 1 to 5 answers to open asks of ONE session. Each ask is
   * claimed in the answer lane and closed as answered with its own receipt, and ONE operator message is
   * typed into the session (answers-message.ts), the session's other open asks last. A repeat of `rid`
   * answers its stored result and runs nothing. The whole Send is refused, nothing closed and nothing typed,
   * when an id is not an ask, the asks are of two sessions, an answer does not fit its ask, the session's
   * machine is not answering, or the message is longer than a WalkyTalky message (`too_long`). An ask that
   * closed before the Send is skipped and reported; with none left, nothing is typed.
   */
  answerAsks(request: HillAnswersRequest, by: string, deviceId: string | null = null): Promise<HillAnswersOutcome> {
    if (this.refusesHere()) return Promise.resolve({ kind: "off" });
    if (this.deps.crewMode() === "peer" || this.deps.deposed?.() === true) return Promise.resolve({ kind: "denied", error: HILL_DEPOSED });
    const digest = sendDigest(request);
    // SYNCHRONOUS from here to the `set`: two requests with one rid must not both get past the look.
    const stored = this.deps.receipts.get(request.rid);
    if (stored !== undefined) return Promise.resolve(stored.payloadDigest === digest ? this.storedSend(request, stored.receipt) : refusedSend("rid_reused", "this rid was used for another Send"));
    const running = this.sends.get(request.rid);
    if (running !== undefined) return running.digest === digest ? running.work : Promise.resolve(refusedSend("rid_reused", "this rid was used for another Send"));
    const work = this.runSend(request, by, digest, deviceId).finally(() => this.sends.delete(request.rid));
    this.sends.set(request.rid, { digest, work });
    return work;
  }

  /** A Send answered from its records, for a repeat of its `rid`. */
  private storedSend(request: HillAnswersRequest, send: HillReceipt): HillAnswersOutcome {
    if (send.code !== "ok") return refusedSend("not_typed", send.reason ?? HILL_NOT_TYPED);
    return { kind: "done", result: resultOf(request, send, (rid) => this.deps.receipts.get(rid)?.receipt) };
  }

  private async runSend(request: HillAnswersRequest, by: string, digest: string, deviceId: string | null): Promise<HillAnswersOutcome> {
    const ids = request.answers.map((answer) => answer.id);
    // The answers count as running from the tap on, so no quiet close takes one under them.
    for (const id of ids) this.claiming.set(id, (this.claiming.get(id) ?? 0) + 1);
    try {
      const claimed = this.lane.then(() => this.claimSend(request, by, digest, deviceId));
      this.lane = claimed.then(
        () => undefined,
        () => undefined,
      );
      const claim = await claimed;
      if (claim.kind === "done") return claim.outcome;
      return await this.deliverSend(request, by, digest, claim);
    } finally {
      for (const id of ids) {
        const left = (this.claiming.get(id) ?? 1) - 1;
        if (left <= 0) this.claiming.delete(id);
        else this.claiming.set(id, left);
      }
    }
  }

  /** The claim step of a Send, in the lane: every check, then the receipts, then the close of every ask at once. */
  private async claimSend(request: HillAnswersRequest, by: string, digest: string, deviceId: string | null): Promise<SendClaim> {
    const known = this.deps.receipts.get(request.rid);
    if (known !== undefined) return { kind: "done", outcome: known.payloadDigest === digest ? this.storedSend(request, known.receipt) : refusedSend("rid_reused", "this rid was used for another Send") };
    const now = this.now();
    const live: Array<{ readonly decision: HillDecision; readonly intent: string; readonly text: string | null }> = [];
    const gone = new Map<string, HillReceipt>();
    const senders = new Set<string>();
    for (const answer of request.answers) {
      const decision = this.deps.store.get(answer.id);
      if (decision === undefined) {
        // A cleared ask answers as it did while it was held: gone, with the state it closed in.
        const stone = this.deps.store.tombstone(answer.id);
        if (stone === undefined) return { kind: "done", outcome: refusedSend("not_an_ask", `${answer.id} is not an ask on this machine`, { id: answer.id }) };
        senders.add(stone.key);
        gone.set(answer.id, receiptOf(askAnswerRid(request.rid, answer.id), now, "gone", `the decision is ${stone.state}`, stone.state, null));
        continue;
      }
      if (decision.ask === undefined || decision.from.kind !== "agent") return { kind: "done", outcome: refusedSend("not_an_ask", `${answer.id} is not an ask`, { id: answer.id }) };
      senders.add(keyOf(decision));
      if (decision.state !== "open") {
        gone.set(answer.id, receiptOf(askAnswerRid(request.rid, answer.id), now, "gone", `the decision is ${decision.state}`, decision.state, null));
        continue;
      }
      const checked = this.askAnswerCheck(decision, answer.intent, answer.text ?? null);
      if (!checked.ok) return { kind: "done", outcome: refusedSend("bad_answer", `${answer.id}: ${checked.reason}`, { id: answer.id }) };
      live.push({ decision, intent: answer.intent, text: checked.text });
    }
    if (senders.size > 1) return { kind: "done", outcome: refusedSend("mixed_sessions", "one Send answers the asks of one session; these are of more than one") };
    const address = [...senders][0] ?? null;
    if (live.length === 0 || address === null) return { kind: "done", outcome: await this.settleSend(request, digest, now, gone, "none", false) };
    // The session's other open asks, oldest first, close the message as "no answer yet".
    const answered = new Set(live.map((entry) => entry.decision.id));
    const others = this.deps.store
      .all()
      .filter((decision) => decision.state === "open" && decision.ask !== undefined && keyOf(decision) === address && !answered.has(decision.id))
      .toSorted((a, b) => a.at - b.at);
    const message = answersMessage(
      live.map((entry) => ({ ask: entry.decision, intent: entry.intent, text: entry.text })),
      others,
    );
    const body = withCrewLine(message, this.crewState().state);
    const over = codePoints(body) - WALKY_BODY_MAX;
    if (over > 0) return { kind: "done", outcome: refusedSend("too_long", `the message is ${String(over)} characters longer than a WalkyTalky message may be (${String(WALKY_BODY_MAX)}); answer fewer asks in this Send, or shorten a note`, { over }) };
    const away = this.away(address);
    if (away !== null) return { kind: "done", outcome: refusedSend("not_answering", notAnswering(away), { machine: away }) };
    if (this.deps.place(address)?.address !== address) {
      // The session ended: every live ask closes as the sweep would close it, and nothing is typed.
      for (const entry of live) {
        this.closeAs(entry.decision.id, now, "undeliverable", TARGET_ENDED);
        gone.set(entry.decision.id, receiptOf(askAnswerRid(request.rid, entry.decision.id), now, "gone", TARGET_ENDED, "undeliverable", null));
      }
      return { kind: "done", outcome: await this.settleSend(request, digest, now, gone, "none", false) };
    }
    const device = deviceId !== null && HILL_DEVICE_ID_RE.test(deviceId) ? deviceId : null;
    // Each ask's receipt first, as not confirmed: a bridge that stops after these lines never types twice.
    for (const entry of live) {
      const rid = askAnswerRid(request.rid, entry.decision.id);
      const plain = receiptOf(rid, now, "ok", null, "answered", "unknown", "none");
      const record: HillReceiptRecord = { requestId: rid, payloadDigest: hillAnswerDigest(hillNode(entry.decision.id), entry.intent, entry.text), receipt: device === null ? plain : { ...plain, deviceId: device } };
      if (!(await this.deps.receipts.recordFirst(record))) return { kind: "done", outcome: { kind: "unsaved" } };
    }
    // A take back or the sweep may have closed one while the receipts were written: it is gone then.
    const closed: HillDecision[] = [];
    for (const entry of live) {
      const fresh = this.deps.store.get(entry.decision.id);
      if (fresh === undefined || fresh.state !== "open") {
        gone.set(entry.decision.id, receiptOf(askAnswerRid(request.rid, entry.decision.id), now, "gone", `the decision is ${fresh?.state ?? "gone"}`, fresh?.state ?? null, null));
        continue;
      }
      const label = entry.intent === HILL_MORE_CONTEXT ? HILL_MORE_CONTEXT_LABEL : (fresh.options.find((option) => option.intent === entry.intent)?.label ?? null);
      const answer: NonNullable<HillDecision["answer"]> = { rid: askAnswerRid(request.rid, fresh.id), intent: entry.intent, label, text: entry.text, by: headerField(by, WALKY_LABEL_MAX), at: now, delivery: "unknown", trick: "none" };
      closed.push({ ...fresh, state: "answered", closedAt: now, closedReason: null, answer: device === null ? answer : { ...answer, deviceId: device } });
    }
    if (closed.length === 0) return { kind: "done", outcome: await this.settleSend(request, digest, now, gone, "none", false) };
    // One closed while the receipts were written (a take back, the sweep): it is reported gone, its receipt
    // is written again as gone, and the message is built again from the ones still to answer. Shorter, so
    // it still fits.
    const typed =
      closed.length === live.length
        ? body
        : withCrewLine(
            answersMessage(
              live.filter((entry) => closed.some((decision) => decision.id === entry.decision.id)).map((entry) => ({ ask: entry.decision, intent: entry.intent, text: entry.text })),
              this.deps.store.all().filter((decision) => decision.state === "open" && decision.ask !== undefined && keyOf(decision) === address && !answered.has(decision.id)).toSorted((a, b) => a.at - b.at),
            ),
            this.crewState().state,
          );
    if (!this.save(...closed)) return { kind: "done", outcome: { kind: "unsaved" } };
    return { kind: "deliver", to: address, body: typed, closed, gone, now };
  }

  /** Write the records of a Send that typed nothing (every ask gone) and answer its result. */
  private async settleSend(request: HillAnswersRequest, digest: string, now: number, gone: ReadonlyMap<string, HillReceipt>, delivery: HillAnswersResult["delivery"], unconfirmed: boolean): Promise<HillAnswersOutcome> {
    for (const [id, receipt] of gone) await this.deps.receipts.record({ requestId: askAnswerRid(request.rid, id), payloadDigest: digest, receipt });
    const send = sendRecord(request.rid, digest, now, "ok", delivery, unconfirmed);
    await this.deps.receipts.record(send);
    this.deps.audit?.({ action: "hill.answers", detail: { answered: 0, gone: gone.size, delivery } });
    return { kind: "done", result: resultOf(request, send.receipt, (rid) => this.deps.receipts.get(rid)?.receipt) };
  }

  /** The send step of a Send: the one message, then every receipt and answer with what walky said. */
  private async deliverSend(request: HillAnswersRequest, by: string, digest: string, claim: Extract<SendClaim, { kind: "deliver" }>): Promise<HillAnswersOutcome> {
    let sent: HillSendResult;
    try {
      sent = await this.deps.send(claim.to, claim.body, by, ASKS_ANSWERS_SUBJECT);
    } catch {
      sent = "unknown";
    }
    if (sent === "refused") {
      // Walky typed nothing: the asks open again as they were, and the Send says why.
      const reopened = claim.closed.flatMap((decision) => {
        const held = this.deps.store.get(decision.id);
        return held !== undefined && held.state === "answered" && held.answer?.rid === decision.answer?.rid ? [{ ...held, state: "open" as const, closedAt: null, closedReason: null, answer: null }] : [];
      });
      if (reopened.length > 0) this.save(...reopened);
      for (const decision of claim.closed) {
        const rid = askAnswerRid(request.rid, decision.id);
        await this.deps.receipts.record({ requestId: rid, payloadDigest: digest, receipt: receiptOf(rid, this.now(), "rejected", HILL_NOT_TYPED, this.deps.store.get(decision.id)?.state ?? null, "none") });
      }
      await this.deps.receipts.record(sendRecord(request.rid, digest, this.now(), "rejected", "none", false, HILL_NOT_TYPED));
      this.deps.audit?.({ action: "hill.undelivered", device: by, detail: { asks: claim.closed.length, why: "refused, the asks are open again" } });
      return refusedSend("not_typed", HILL_NOT_TYPED);
    }
    const delivery: HillAnswersResult["delivery"] = sent === "inbox-only" ? "unknown" : sent;
    const unconfirmed = sent === "unknown";
    const settled: HillDecision[] = [];
    for (const decision of claim.closed) {
      const rid = askAnswerRid(request.rid, decision.id);
      const held = this.deps.receipts.get(rid);
      if (held !== undefined) await this.deps.receipts.record({ ...held, receipt: { ...held.receipt, delivery } });
      const now = this.deps.store.get(decision.id);
      if (now?.answer?.rid !== rid) continue;
      const { unconfirmed: _was, ...kept } = now.answer;
      settled.push({ ...now, answer: unconfirmed ? { ...kept, delivery, unconfirmed: true } : { ...kept, delivery } });
    }
    if (settled.length > 0) this.save(...settled);
    for (const [id, receipt] of claim.gone) await this.deps.receipts.record({ requestId: askAnswerRid(request.rid, id), payloadDigest: digest, receipt });
    const send = sendRecord(request.rid, digest, claim.now, "ok", delivery, unconfirmed);
    await this.deps.receipts.record(send);
    if (delivery === "unknown") this.deps.audit?.({ action: "hill.undelivered", device: by, detail: { asks: claim.closed.length, why: unconfirmed ? "not confirmed" : "in the inbox" } });
    this.deps.audit?.({ action: "hill.answers", device: by, detail: { answered: claim.closed.length, gone: claim.gone.size, delivery } });
    return { kind: "done", result: resultOf(request, send.receipt, (rid) => this.deps.receipts.get(rid)?.receipt) };
  }

  /** Whether one answer fits its open ask, as the single answer's rules say it, and the cleaned text. */
  private askAnswerCheck(decision: HillDecision, intent: string, raw: string | null): { readonly ok: true; readonly text: string | null } | { readonly ok: false; readonly reason: string } {
    const option = decision.options.find((candidate) => candidate.intent === intent);
    const words = decision.ask?.words === true;
    const fits = intent === HILL_MORE_CONTEXT || (intent === "answer" && words) || (option !== undefined && isHillOptionIntent(option.intent));
    if (!fits) return { ok: false, reason: "not an option of this decision" };
    const cleaned = cleanText(raw ?? "", HILL_ANSWER_TEXT_MAX);
    if (cleaned.over) return { ok: false, reason: `text is longer than ${String(HILL_ANSWER_TEXT_MAX)} characters` };
    const text = cleaned.text === "" ? null : cleaned.text;
    const rule = this.textRule(decision, intent, text);
    return rule === null ? { ok: true, text } : { ok: false, reason: rule };
  }

  /**
   * The name of the crew machine a session address is on, when that machine is not answering now: the
   * live session's own `reachable`, else the bridge's word for a machine it has not swept. Null otherwise.
   */
  private away(address: string): string | null {
    const placed = this.deps.place(address);
    if (placed !== null && placed.reachable === false) {
      const at = parseAddress(placed.address);
      return placed.host ?? (at?.kind === "pane" ? at.memberId : "that machine");
    }
    return this.deps.offline?.(address) ?? null;
  }

  /** Why the text breaks the decision's rule, or null when it keeps it. */
  private textRule(decision: HillDecision, intent: string, text: string | null): string | null {
    if (intent === "dismiss") return text === null ? null : "a dismiss carries no text";
    // "I need more context" takes an optional note, on every ask, a `--words` one too.
    if (intent === HILL_MORE_CONTEXT) return null;
    if (intent === "answer") {
      if (decision.text === "none") return "this decision takes no text";
      return text === null ? "text is required" : null;
    }
    if (decision.text === "required" && text === null) return "text is required";
    if (decision.text === "none" && text !== null) return "this decision takes no text";
    return null;
  }

  /** Close an open decision with no answer, as the sweep would: `undeliverable` or `expired`, with its reason. */
  private closeAs(id: string, now: number, state: "undeliverable" | "expired", reason: string): void {
    const decision = this.deps.store.get(id);
    if (decision === undefined || decision.state !== "open") return;
    this.save({ ...decision, state, closedAt: now, closedReason: reason });
  }
}
