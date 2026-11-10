import type { JsonObject, JsonValue } from "./json.ts";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { PushTitleCode, PushTitleDetail } from "./push-titles.ts";
import { redactText } from "./redact.ts";

// Optional Web Push (VAPID). Zero hard dependency: if `web-push` isn't installed or VAPID keys
// aren't configured, push is silently disabled and the rest of the bridge works unchanged.
// Subscriptions are persisted to the state dir so they survive restarts, and there are exactly three
// ways a row leaves that file: the push service disowns it mid-send (404/410, or EVICT_AFTER
// same-origin-witnessed failures — see broadcast()), the device that owns it registers a successor
// (SubscriptionMeta.replaces), or an operator drops it by hand (`collie push forget`). The first
// alone is not enough, which is issue #104: a subscription orphaned by a service-worker
// re-registration was never `unsubscribe()`d, so the push service has no reason to reject it and it
// accumulates forever, answering 201 to nobody. Hence the other two.

type WebPushModule = typeof import("web-push");
export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

/**
 * A persisted row: the subscription web-push needs, plus metadata that exists only so an OPERATOR
 * can tell two rows apart. Both fields are optional in every direction — a file written before they
 * existed loads unchanged, and a row that never learned a user agent simply hasn't got one.
 *
 * They are deliberately NOT part of {@link PushSubscription}: what reaches `sendNotification` is
 * rebuilt as `{ endpoint, keys }`, because web-push signs and serialises what it is handed and an
 * extra field there is a wire change nobody asked for.
 */
export interface StoredSubscription extends PushSubscription {
  /** When this endpoint was FIRST seen. Preserved across a re-subscribe of the same endpoint —
   *  "since when has this device been subscribed" is the question it answers, not "when last". */
  createdAt?: string;
  /** The `User-Agent` of the request that registered it, trimmed and capped. The only thing that
   *  tells "my iPhone" from "the Mac I used once" in a list of opaque Apple endpoints. */
  userAgent?: string;
  /**
   * The pairing label of the device that registered it, taken from the request's bearer token and
   * never from the body (`pairedLabel`, bridge/server.ts). It is what joins a subscription to the
   * polls of the page on the same device, so {@link Push} can tell a device that is looking at
   * Collie now from one in a pocket. A row without it (registered before the field existed, or by
   * the host's own CLI) gets every push, which is the behaviour before 1.27.1.
   */
  device?: string;
  /**
   * The page that registered this row closes its own notification for a pane whenever it reads that
   * pane (`web/src/lib/pane-notifications.ts`). Only then may a seen read stand in for the clear
   * ({@link Push.noteSeen}). A row from an older page never says so and keeps getting the clear.
   */
  closesOwn?: boolean;
  /**
   * Whether the page that registered this row has the Badging API (`navigator.setAppBadge`).
   * Information only, for the log and `push list`: no rule reads it. It once gated rule 2, until a
   * live Android Chrome 156 reported `true` (2026-11-06); the page now zeroes the slot's count
   * itself on a seen read, so the clear owes the badge nothing either way.
   */
  badges?: boolean;
}

/** What a registration knows about itself beyond the subscription — see {@link Push.addSubscription}. */
export interface SubscriptionMeta {
  /**
   * An endpoint this registration SUPERSEDES: the one the same device last registered with. A
   * service worker re-registration (a reinstall, a rejected push topic, a restart-triggered
   * re-subscribe) mints a brand-new endpoint without `unsubscribe()`ing the old one, so the push
   * service keeps answering 201 for a row nothing will ever read — invisible to the send-time
   * 404/410 prune, and the whole of issue #104. The device is the only party that knows the two are
   * the same device, so it is the device that says so.
   */
  replaces?: string;
  userAgent?: string;
  /** The pairing label of the requesting device ({@link StoredSubscription.device}). */
  device?: string;
  /** The page closes its own pane notifications on a read ({@link StoredSubscription.closesOwn}). */
  closesOwn?: boolean;
  /** Whether the page has the Badging API ({@link StoredSubscription.badges}). */
  badges?: boolean;
}

/**
 * What a delivery answers with. Structurally `web-push`'s own `SendResult`, restated here so the
 * seam does not drag the library's types into every fake — and optional throughout, because nothing
 * on the send path reads it: a FAILED delivery throws, and that is the only outcome that matters.
 */
export type PushDeliveryResult = { statusCode?: number; body?: string; headers?: unknown } | void;

/** One row of {@link PushStore.listSubscriptions} — metadata only, never the sending keys. */
export type SubscriptionRow = { endpoint: string; createdAt?: string; userAgent?: string; device?: string };

/** The deep-link fields the service worker reads off a push payload (see web/src/sw.ts). */
type PushPayloadData = {
  paneId?: string;
  session?: string;
  host?: string;
  machine?: string;
  target?: "settings" | "machine";
};

/** The HTTP status a `web-push` rejection carries, or undefined when it carries none. */
function sendErrorStatus<T>(err: T): number | undefined {
  if (err === null || typeof err !== "object" || !("statusCode" in err)) return undefined;
  return typeof err.statusCode === "number" ? err.statusCode : undefined;
}

/** Longer than this and a user agent is padding a terminal column, not identifying a device. */
const USER_AGENT_MAX = 160;

/** One row off disk. Anything that isn't a usable subscription is dropped; the two metadata fields
 *  are carried only when they are strings, so a file written before they existed loads unchanged. */
function coerceStored(v: JsonValue | undefined): StoredSubscription | null {
  if (typeof v !== "object" || v === null || v === undefined || Array.isArray(v)) return null;
  const o: JsonObject = v;
  const keys = o.keys;
  if (typeof o.endpoint !== "string" || typeof keys !== "object" || keys === null || keys === undefined || Array.isArray(keys)) {
    return null;
  }
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return null;
  const row: StoredSubscription = {
    endpoint: o.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
  if (typeof o.createdAt === "string") row.createdAt = o.createdAt;
  if (typeof o.userAgent === "string") row.userAgent = o.userAgent.slice(0, USER_AGENT_MAX);
  if (typeof o.device === "string" && o.device !== "") row.device = o.device;
  if (o.closesOwn === true) row.closesOwn = true;
  if (typeof o.badges === "boolean") row.badges = o.badges;
  return row;
}

// Delivery options passed to web-push on every send. Without them a message gets web-push's 4-week
// default TTL and NO collapse key, so an offline device replays every queued herd update on reconnect.
//   • `topic` is a collapse key — the push service keeps only the LATEST message per device with this
//     topic, so a reconnecting phone gets one current summary instead of a burst of stale ones. Must
//     match [A-Za-z0-9_-] and be ≤32 chars ("collie-herd" is valid) — and, for Apple, must also be a
//     LENGTH BASE64 CAN PRODUCE: never ≡ 1 (mod 4). RFC 8030 §5.4 only calls the topic URL-safe
//     base64; Apple enforces that by decoding it, while FCM and Mozilla treat it as opaque. A
//     13-character topic decodes nowhere (base64 turns 3 bytes into 4 chars, so a trailing group of
//     one is impossible) and APNs answers 400 `{"reason":"BadWebPushTopic"}` for every endpoint.
//     Measured, not inferred: "collie-update" (13) and "collie-herdab" (13) both fail, while
//     "collie-updat" (12), "collie-herd" (11) and "collie-updates" (14) all succeed — so it is the
//     arithmetic, not a length cap and not the wording. `topicIsSendable` pins this below.
//   • `TTL` (seconds) bounds how long the service holds an undelivered message: 6h is long enough to
//     reach a briefly-offline phone but short enough that a day-old "needs you" doesn't resurface.
//   • `urgency: "high"` is load-bearing on Android, and its absence was a silent alert-eater:
//     web-push defaults to `normal` (RFC 8030), FCM maps that to normal priority, and Android is then
//     free to hold the message until the next Doze maintenance window — or to defer it by the PWA's
//     App Standby bucket, which DEEPENS the less you open the app. That degrades into a vicious
//     circle rather than a clean break: fewer alerts → fewer opens → deeper bucket → fewer alerts.
//     Live-diagnosed by sending one endpoint the same payload at both urgencies minutes apart: normal
//     never arrived, high arrived at once. Retractions ride this too, deliberately — a deferred
//     `clear` leaves a handled alert on your lock screen, the exact thing the coordinator exists to
//     prevent. It costs battery (high urgency punches through power-saving), which is the right trade
//     for "an agent is waiting on you" and NOT for the update notice below.
const SEND_OPTIONS = { TTL: 21_600, topic: "collie-herd", urgency: "high" } as const;
// Update-available pushes ride their OWN collapse topic (and a longer TTL). The `topic` — NOT the
// client-side `tag` — is the push service's collapse key: sharing "collie-herd" would make an offline
// device's queued herd summary and an update push silently overwrite each other. 3-day TTL, since an
// update stays relevant far longer than a transient "needs you". The trailing "s" is not a typo:
// "collie-update" is 13 characters, which Apple refuses outright — see the base64 note above.
const UPDATE_SEND_OPTIONS = { TTL: 259_200, topic: "collie-updates" } as const;
// A machine's sustained load (ADR 0084) rides its own topics, for the update push's reason: sharing
// "collie-herd" would let a queued load alert and a queued herd summary overwrite each other. One hour
// of TTL, because a load alert older than that describes a minute the Machines page shows better, and
// `high` urgency for the herd's reason: it is one push per episode, and a deferred one is late for the
// only thing it is for. The topic is one per machine and metric ({@link machineTopic}), carried on the
// message's `topic`; "collie-machines" (15 characters, which base64 can produce) is only the fallback
// for a machine message that names none.
const MACHINE_SEND_OPTIONS = { TTL: 3_600, topic: "collie-machines", urgency: "high" } as const;

/** The fixed start of every per-machine topic. 16 characters, plus {@link MACHINE_TOPIC_HASH} = 28. */
const MACHINE_TOPIC_PREFIX = "collie-machines-";
/** Base64url characters of the hash kept: 72 bits, so two machines' topics do not meet by chance. */
const MACHINE_TOPIC_HASH = 12;

/**
 * The collapse topic of one machine's alert on one metric: `collie-machines-` and the first 12
 * base64url characters of the SHA-256 of `<id>:<metric>`. One topic per machine and metric, so a
 * phone that is offline while two machines (or CPU and memory on one) alert gets both, where one
 * shared topic kept only the last. A machine id is free text and can be longer than a topic may be,
 * which is why it is hashed and not spelled. 28 characters, inside RFC 8030's alphabet and 32-char
 * ceiling and a length base64 can produce ({@link topicIsSendable}).
 */
export function machineTopic(id: string, metric: string): string {
  const hash = createHash("sha256").update(`${id}:${metric}`).digest("base64url");
  return `${MACHINE_TOPIC_PREFIX}${hash.slice(0, MACHINE_TOPIC_HASH)}`;
}

/** The fixed start of every per-pane topic: 5 characters, plus {@link PANE_TOPIC_HASH} = 20. */
const PANE_TOPIC_PREFIX = "herd-";
/** Base64url characters of the hash kept: 90 bits. 5 + 15 = 20 characters, a length base64 can produce
 *  (12 would make 17, which is 1 mod 4, and Apple refuses it; see the topic note above). */
const PANE_TOPIC_HASH = 15;

/**
 * The collapse topic of one pane's own notification, for the "one notification per agent" preference:
 * `herd-` and the first 15 base64url characters of the SHA-256 of the pane's notification tag. One
 * topic per pane, so a phone that is offline while two panes alert gets both, where the shared
 * `collie-herd` topic kept only the last. A tag holds a host and a pane id, free text of any length,
 * which is why it is hashed and not spelled. Its `clear` rides the same topic, so a queued alert and
 * its retraction replace each other. 20 characters, inside RFC 8030's alphabet and ceiling
 * ({@link topicIsSendable}).
 */
export function paneTopic(tag: string): string {
  const hash = createHash("sha256").update(tag).digest("base64url");
  return `${PANE_TOPIC_PREFIX}${hash.slice(0, PANE_TOPIC_HASH)}`;
}

/** Whether a collapse topic is one every push service will accept: RFC 8030's alphabet and 32-char
 *  ceiling, plus the length base64 can actually produce (Apple decodes it; ≡ 1 mod 4 is impossible).
 *  Exported for the test that guards the constants above — a topic edited for tidiness would
 *  otherwise break Apple delivery silently, since nothing surfaces it but the push service's log. */
export function topicIsSendable(topic: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(topic) && topic.length <= 32 && topic.length % 4 !== 1;
}

// How many consecutive same-origin-witnessed failures retire a subscription (see broadcast()).
// Broadcasts are event-driven — several in an active hour — so five clears a stale device within a
// day of normal use while still absorbing a run of transients that slipped past the origin guard.
const EVICT_AFTER = 5;

/** The push service an endpoint belongs to, used to tell "this device is dead" from "this service
 *  is rejecting us". Falls back to the raw endpoint if it won't parse — an unparseable endpoint is
 *  then its own origin, which can never witness a sibling's success, so it is never evicted. */
function pushServiceOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

/** What actually went wrong, for the log. `web-push` throws a WebPushError whose `message` is the
 *  constant "Received unexpected response code" — useless on its own — while the status and the
 *  service's own reason (Apple's `{"reason":"BadDeviceToken"}`, FCM's text) sit unread on the error.
 *  Surfacing them is what makes a transient 5xx distinguishable from a permanent rejection. */
function describeSendError<T>(err: T): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = sendErrorStatus(err);
  const status = code === undefined ? "" : ` status=${code}`;
  const bodyField = err !== null && typeof err === "object" && "body" in err ? err.body : undefined;
  const raw = typeof bodyField === "string" ? bodyField.replace(/\s+/g, " ").trim() : "";
  const body = raw ? ` body=${raw.length > 200 ? `${raw.slice(0, 200)}…` : raw}` : "";
  return `${message}${status}${body}`;
}

/** web-push delivery options (collapse topic + TTL + urgency), derived per message from its `type`.
 *  `topic` is absent only on a clear that names several slots ({@link Push} § one clear per burst). */
export type SendOptions = { TTL: number; topic?: string; urgency?: "very-low" | "low" | "normal" | "high" };

// ── WHY A PUSH IS NOW ADDRESSED PER DEVICE (1.27.1) ─────────────────────────────────────────────
// Every subscription is `userVisibleOnly`. Chrome holds a site to that with a budget, read in
// Chromium's `push_messaging_notification_manager.cc` and `budget_database.cc`: a push that ends
// with NO notification of this service worker on screen, and no visible tab of the origin, costs 2
// points; points accrue only from site engagement, at most 0.5 an hour, kept for 4 days (so about 6
// silent pushes a day for a site used every day). A notification shown does not refill it. When the
// budget is spent Chrome shows its own "This site has been updated in the background". Whether an
// installed PWA in its own window passes the "visible tab" exemption is not settled by that code, so
// a push the service worker suppresses is treated as one that may cost. `Urgency` and `TTL` are not
// inputs to the rule.
//
// 1.27.0's "one notification per agent" turned one shared slot into one render and one clear per
// agent, sent to every device, so the silent count followed the number of agents. Three rules cut it
// here, at the one place every push passes through, and nothing about what a person sees changes:
//
//   1. A render is HELD from a device that is looking at Collie now ({@link LOOKING_MS}). Its
//      service worker would suppress it, and its page shows the state. If the device stops polling
//      before it could have seen it, the render goes out late instead of never.
//   2. A clear is skipped for a slot this bridge knows is closed on that device: the render was
//      held, the clear already went, or the device's own page read the pane, closed its notification
//      and zeroed its icon count ({@link Push.noteSeen}). A slot it knows nothing about (after a restart) still gets the clear.
//   3. Clears that land in one burst go to each device as ONE push naming every slot.
//
// A fourth rule, since 2026-11-09, trades a little of what a person sees for the budget:
//
//   4. A subscription gets at most {@link SILENT_CLEAR_BUDGET} silent clears in any rolling day, a
//      burst of rule 3 counting as one. Rules 1 to 3 do not reach a phone in a pocket while its panes
//      come and go (measured on 2026-11-09: 24 clears to one phone in a day, nearly none skipped), so
//      past the budget a clear is skipped and never queued. The notification it would have closed
//      goes another way that costs no push: the slot's next render replaces it (same tag), or the
//      page sweeps its own notifications against the snapshot when it is next open
//      (`web/src/lib/notification-sweep.ts`). Unlike rules 1 to 3 this one is kept on disk, because
//      the release lane restarts on every update and Chrome's count does not.
/**
 * How long after its last poll a device still counts as looking. The page polls `/api/snapshot`
 * (and the open pane) only while it is visible, and its longest gap is `IDLE_MS`, 6 s, in
 * `web/src/hooks/use-polling.ts`; the retry backoff only shortens it. 5 s of slack covers a slow
 * answer and the timer's own drift. A case in `push.test.ts` reads the web constant, so a slower
 * cadence there fails here first.
 */
export const LOOKING_MS = 6_000 + 5_000;

/** How long clears wait for company before they go: the burst rule 3 coalesces. One poll's retract
 *  across every session and the snooze route's fan both land well inside it. */
export const CLEAR_BURST_MS = 400;

/** Slots remembered per subscription. A tag is a session and a pane id, so this bounds a ledger that
 *  would otherwise grow with every pane ever opened; the oldest goes first, and a slot forgotten is
 *  only a slot whose clear is sent again. */
const SLOT_MEMORY = 512;

/** What a subscription's notification slot holds, as far as this bridge knows. Absent = unknown. */
type SlotState = "open" | "closed";

/** A push's JSON body before it is serialised for one device ({@link Push} § deliver): the message
 *  less its topic, its tap data, and a clear's slots. */
type PushBody = Omit<PushMessage, "topic"> & { data: PushPayloadData; tags?: readonly string[] };

/** One push to one subscription. `names` are the slots its own body sets, so a badge correction for
 *  the same slot is not sent beside it. */
type Delivery = { sub: StoredSubscription; body: PushBody; options: SendOptions; names: readonly string[] };

/** A render held from a looking device, when it was held, and the badge count its slot carried. */
type HeldRender = {
  body: PushBody;
  options: SendOptions;
  at: number;
  label: string;
  kind: string;
  badge: number | undefined;
};

/** The timer and clock {@link Push} schedules held renders and clear bursts against. Nothing it
 *  schedules is ever cancelled: each callback checks whether it is still wanted when it runs. */
export interface PushClock {
  now(): number;
  schedule(fn: () => void, delayMs: number): void;
}

const realClock: PushClock = {
  now: () => Date.now(),
  schedule: (fn, delayMs) => void setTimeout(fn, delayMs),
};

/** How {@link Push} is wired beyond its config. Absent in a test or a CLI: real time, and clears that
 *  coalesce only within one tick. */
export interface PushOptions {
  clock?: PushClock;
  /** {@link CLEAR_BURST_MS} in the bridge; 0 = flush on the next microtask. */
  clearBurstMs?: number;
}

/** One tally line's counters for one device. `clear` is the silent count: every clear sent ends
 *  with no notification shown by design. */
type Tally = { render: number; clear: number; held: number; late: number; dropped: number; skipped: number; overBudget: number };
const emptyTally = (): Tally => ({ render: 0, clear: 0, held: 0, late: 0, dropped: 0, skipped: 0, overBudget: 0 });
const HOUR_MS = 3_600_000;

/**
 * Rule 4: at most `clears` silent clears reach one subscription in any rolling `windowMs`. Chrome's
 * rule (the note above rule 1): a push that ends with no notification on screen costs 2 points, a site
 * earns at most 0.5 an hour from engagement and keeps 4 days of it, so a site used every day affords
 * about 6 silent pushes a day before Chrome shows "This site has been updated in the background".
 * Four leaves room for the renders a visible app suppresses, which the bridge cannot always see.
 */
export const SILENT_CLEAR_BUDGET = { clears: 4, windowMs: 24 * HOUR_MS } as const;

/** Rule 4's memory, beside `push-subscriptions.json`: endpoint → when its silent clears went. */
const CLEAR_BUDGET_FILE = "push-clear-budget.json";

/** Delivers one payload to one subscription with the given options. Injectable so the prune/log
 *  logic is testable. */
export type PushSender = (
  sub: PushSubscription,
  payload: string,
  options: SendOptions,
) => Promise<PushDeliveryResult>;

/**
 * A notification instruction for the service worker (see web/src/sw.ts). `type:"clear"` closes the
 * notification on `tag` instead of showing one; `type:"update"` is an update-available alert (its own
 * collapse topic; taps open Settings); `type:"machine"` is a sustained-load alert (its own topic; taps
 * open that machine's page); otherwise the SW renders `{ title, body }` into the `tag` slot,
 * deep-links to `paneId` on tap, and re-alerts when `renotify` is set.
 */
export interface PushMessage {
  type?: "clear" | "update" | "machine";
  title?: string;
  /**
   * The stable code `title` was rendered from, and the values it was filled with (`push-titles.ts`).
   * The service worker shows its own translation of the code when it has one and `title` otherwise,
   * so an older cached SW — which ignores both — keeps showing exactly what it did. A title the
   * operator typed (`collie push-test "…"`) is not Collie's to translate and carries no code.
   */
  titleCode?: PushTitleCode;
  titleDetail?: PushTitleDetail;
  body?: string;
  /** Notification slot. Same tag replaces (rather than stacks) the previous notification. */
  tag?: string;
  paneId?: string;
  /**
   * The herdr session this alert belongs to (registry name). Threaded into the payload `data` so the
   * service worker deep-links to the right session. Absent for the primary session, whose payload
   * then stays byte-identical to the single-session case (an older cached SW keeps working).
   */
  session?: string;
  /**
   * The crew member the alerting session lives on (`?h=`, CREW_PROTOCOL.md §4). Threaded into the
   * payload `data` alongside `session` so a tap deep-links to the right machine. Absent for the
   * collie that is sending — i.e. always absent on a solo instance, and always absent for the lead's
   * own sessions — which is the same omitted-not-null discipline `session` follows and what keeps
   * the solo payload byte-identical (§11).
   */
  host?: string;
  /** Where a tap should land instead of the default pane deep-link. `"settings"` for update alerts;
   *  absent = today's pane deep-link (so the agent-alert payload is unchanged).
   *
   *  The client resolves this name to `/settings/updates` (web/src/lib/push-decision.ts). The name
   *  itself is frozen: an old cached service worker resolves it to `/settings` and lands one row
   *  away from the page it wanted, which renaming the field would have turned into `/`.
   *
   *  `"machine"` opens `/machines/<machine>` (ADR 0084). An old service worker does not know it and
   *  reads only `host`, which a machine push never carries, so it takes the pane path with no pane
   *  and no `?h=`: the dashboard. */
  target?: "settings" | "machine";
  /**
   * The machine a load alert is about (ADR 0084), threaded into the payload `data` as `machine`. It
   * is deliberately NOT `host`: an old cached service worker reads `host` as a crew member and opens
   * `/?h=<id>`, which on a solo Collie (id `local`) names no member at all.
   */
  machine?: string;
  /**
   * The push service's collapse topic for this one message ({@link machineTopic}), in place of the
   * type's own. Never sent to the device. A topic {@link topicIsSendable} refuses is ignored.
   */
  topic?: string;
  renotify?: boolean;
  /** How many alerts a herd slot holds: the phone adds every slot's up for the app icon's badge. */
  badge?: number;
}

/**
 * A push message with its words masked (`bridge/redact.ts`): the body, and the title. A push crosses
 * a third-party push service and shows on a lock screen, so it is the last place a secret should be.
 *
 * A title is a catalogue sentence filled from `titleDetail` (`push-titles.ts`), and the phone renders
 * its own translation from the code and the detail when it has one. So a title the mask CHANGED drops
 * its code and detail and travels as the masked English: a translated title rebuilt from the raw
 * detail would put back exactly what was masked. A title the mask left alone keeps both.
 *
 * Pure and exported for the test; {@link Push.send} calls it when `COLLIE_REDACT` is on.
 */
export function redactPushMessage(message: PushMessage): PushMessage {
  const out: PushMessage = { ...message };
  if (message.body !== undefined) out.body = redactText(message.body);
  if (message.title === undefined) return out;
  const title = redactText(message.title);
  if (title === message.title) return out;
  const { titleCode: _titleCode, titleDetail: _titleDetail, ...plain } = out;
  return { ...plain, title };
}

/** What a log line and a tally call a subscription: its device's pairing label, or its endpoint's tail. */
function deviceName(sub: StoredSubscription): string {
  return sub.device ?? `…${sub.endpoint.slice(-8)}`;
}

/** One device's share of a clear burst, before it is addressed. */
type ClearDelivery = Omit<Delivery, "sub">;

/** The payload and options of one device's share of a clear burst ({@link Push} § flushClears). */
function clearDelivery(
  due: readonly string[],
  burst: ReadonlyMap<string, string | undefined>,
): ClearDelivery {
  const [first] = due;
  if (due.length === 1 && first !== undefined) {
    // Byte for byte the clear every earlier bridge sent, on the slot's own topic.
    const topic = burst.get(first);
    const options = topic === undefined ? SEND_OPTIONS : { ...SEND_OPTIONS, topic };
    return { body: { type: "clear", tag: first, data: {} }, options, names: due };
  }
  return {
    body: { type: "clear", tag: first, tags: due, data: {} },
    options: { TTL: SEND_OPTIONS.TTL, urgency: SEND_OPTIONS.urgency },
    names: due,
  };
}

export class Push {
  private lib: WebPushModule | null = null;
  private subs = new Map<string, StoredSubscription>();
  private readonly file: string;
  private readonly sender: PushSender;
  private _enabled = false;
  // Consecutive delivery failures per endpoint, for the eviction pass in broadcast(). Deliberately
  // in-memory and NOT part of the persisted subscription shape: a restart forgives, which is the
  // right bias for a counter whose whole job is spotting a *sustained* pattern — broadcasts vastly
  // outnumber restarts, so a genuinely dead device re-earns its eviction within EVICT_AFTER rounds.
  private failures = new Map<string, number>();
  // Saves are funnelled through this chain so concurrent writes never interleave (last enqueued
  // wins deterministically); a failed write is swallowed here so it can't poison later saves.
  private saveChain: Promise<void> = Promise.resolve();
  // ── Per-device state for the three rules above. All of it in memory: a restart forgets, and every
  // forgotten fact falls back to sending, which is the behaviour before the rules existed. ──
  /** Pairing label → when that device's page last polled ({@link notePoll}). */
  private polls = new Map<string, number>();
  /** Endpoint → slot tag → what that slot holds on the device, as far as this bridge knows. */
  private slots = new Map<string, Map<string, SlotState>>();
  /** Endpoint → slot tag → the render held from it while it was looking (rule 1). */
  private held = new Map<string, Map<string, HeldRender>>();
  /** Endpoint → slot tag → the icon count its service worker missed, owed on the next push there. */
  private badgeDue = new Map<string, Map<string, number>>();
  /** The clears waiting for their burst to close (rule 3), in arrival order, one per tag. */
  private burst: Map<string, string | undefined> | null = null;
  private burstDone: Promise<void> = Promise.resolve();
  /** Device → this hour's counters, and when this hour started. */
  private tally = new Map<string, Tally>();
  /** Device → what its page said about the Badging API, for the hourly line only. */
  private tallyBadges = new Map<string, boolean | undefined>();
  private tallySince: number;
  private readonly clock: PushClock;
  private readonly clearBurstMs: number;
  // ── Rule 4's state, the one rule kept on disk ({@link CLEAR_BUDGET_FILE}). ──
  /** Endpoint → when its silent clears went, oldest first, at most {@link SILENT_CLEAR_BUDGET}`.clears`. */
  private clearSpends = new Map<string, number[]>();
  private readonly budgetFile: string;
  /** A row left the map since the file was written: the next {@link save} writes the budget too. */
  private budgetDirty = false;
  private budgetChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly cfg: Config,
    sender?: PushSender,
    opts: PushOptions = {},
  ) {
    this.file = join(cfg.stateDir, "push-subscriptions.json");
    this.budgetFile = join(cfg.stateDir, CLEAR_BUDGET_FILE);
    this.sender = sender ?? ((sub, payload, options) => this.lib!.sendNotification(sub, payload, options));
    this.clock = opts.clock ?? realClock;
    this.clearBurstMs = opts.clearBurstMs ?? 0;
    this.tallySince = this.clock.now();
  }

  /** Whether push is live (VAPID keys configured and `web-push` installed). Set once in init(). */
  get enabled(): boolean {
    return this._enabled;
  }

  get publicKey(): string {
    return this.enabled ? this.cfg.vapidPublic : "";
  }

  async init(): Promise<void> {
    if (!this.cfg.vapidPublic || !this.cfg.vapidPrivate) {
      console.log("[push] disabled (no VAPID keys configured)");
      return;
    }
    try {
      this.lib = await import("web-push");
    } catch {
      console.warn("[push] `web-push` not installed — run `bun add web-push` to enable push");
      return;
    }
    this.lib.setVapidDetails(this.cfg.vapidSubject, this.cfg.vapidPublic, this.cfg.vapidPrivate);
    this._enabled = true;
    await this.loadStore();
    console.log(`[push] enabled (${this.subs.size} saved subscription(s))`);
  }

  async addSubscription(sub: PushSubscription, meta: SubscriptionMeta = {}): Promise<void> {
    if (!this.enabled) return;
    // The row this one supersedes (SubscriptionMeta.replaces). Dropped BEFORE the new one is stored,
    // and only when it is a different endpoint — a device re-registering the endpoint it already
    // holds is naming itself, not a predecessor.
    if (meta.replaces !== undefined && meta.replaces !== sub.endpoint) {
      if (this.subs.has(meta.replaces)) {
        console.log(`[push] replaced superseded subscription: ${meta.replaces}`);
      }
      this.drop(meta.replaces);
    }
    const previous = this.subs.get(sub.endpoint);
    const userAgent = meta.userAgent?.trim().slice(0, USER_AGENT_MAX) ?? previous?.userAgent;
    const row: StoredSubscription = { endpoint: sub.endpoint, keys: sub.keys };
    // Re-subscribing does not restart the clock: `createdAt` is when this endpoint first appeared.
    row.createdAt = previous?.createdAt ?? new Date().toISOString();
    if (userAgent !== undefined && userAgent !== "") row.userAgent = userAgent;
    // The device and its page's promise are what THIS registration says, never carried over: a row
    // re-registered by an older page, or by a request no device token resolved, goes back to
    // getting every push.
    if (meta.device !== undefined && meta.device !== "") row.device = meta.device;
    if (meta.closesOwn === true && row.device !== undefined) row.closesOwn = true;
    if (meta.badges !== undefined) row.badges = meta.badges;
    this.subs.set(sub.endpoint, row);
    // A re-subscribe is fresh evidence even when the endpoint string is unchanged — the device just
    // told us it wants pushes, so it doesn't inherit the failure history of its predecessor.
    this.failures.delete(sub.endpoint);
    await this.save();
  }

  /**
   * The persisted rows, for the operator-facing `collie push list`. Read-only and metadata-only:
   * the keys are a sending credential and have no business on a terminal.
   */
  listSubscriptions(): readonly SubscriptionRow[] {
    return [...this.subs.values()].map(({ endpoint, createdAt, userAgent, device }) => {
      const row: SubscriptionRow = { endpoint };
      if (createdAt !== undefined) row.createdAt = createdAt;
      if (userAgent !== undefined) row.userAgent = userAgent;
      if (device !== undefined) row.device = device;
      return row;
    });
  }

  /**
   * Drop every row whose endpoint CONTAINS `match` (or all of them for `"*"`), and persist. Returns
   * how many went. This is the hand-operated counterpart to the automatic prune in {@link broadcast}
   * — which can only ever catch an endpoint the push service has disowned, and an orphan the device
   * never `unsubscribe()`d is not one (issue #104).
   *
   * Nothing matched means nothing is written: asking the question must not create the file.
   */
  async forget(match: string): Promise<number> {
    const doomed = [...this.subs.keys()].filter((e) => match === "*" || e.includes(match));
    if (doomed.length === 0) return 0;
    for (const endpoint of doomed) this.drop(endpoint);
    await this.save();
    return doomed.length;
  }

  /**
   * A paired device's page polled (`/api/snapshot`, or the open pane's read). Only a visible page
   * polls, so for {@link LOOKING_MS} after this the device counts as looking at Collie.
   */
  notePoll(device: string): void {
    this.polls.set(device, this.clock.now());
  }

  /**
   * A paired device's own page read the pane whose notification sits in `tag`, as the pane view's
   * poll does. That page closes its own notification for the pane on such a read
   * (`web/src/lib/pane-notifications.ts`) and sets the slot's share of the icon count to zero, which
   * is everything the clear would have done there. So the slot is closed on every row of that device
   * whose page said it does, and the clear for it is not sent there (rule 2). A render held for the
   * slot is dropped: the page that is reading the pane is showing it.
   */
  noteSeen(device: string, tag: string): void {
    for (const sub of this.subs.values()) {
      if (sub.device !== device || sub.closesOwn !== true) continue;
      this.setSlot(sub.endpoint, tag, "closed");
      this.unhold(sub.endpoint, tag);
    }
  }

  /** Whether `device` polled within {@link LOOKING_MS} of `at`. */
  private looking(device: string | undefined, at: number): boolean {
    if (device === undefined) return false;
    const last = this.polls.get(device);
    return last !== undefined && at - last < LOOKING_MS;
  }

  /**
   * Send a notification instruction (render, clear, update or machine alert) to the subscribed
   * devices, each by its own rules (the note above {@link LOOKING_MS}). A clear resolves once its
   * burst has gone out.
   */
  async send(message: PushMessage): Promise<void> {
    // The SW reads deep-link fields from `data`. `session` is omitted for the primary and `host` for
    // this collie's own sessions (both absent on the message), keeping that payload identical to the
    // pre-multi-session, pre-crew shape.
    const { topic, ...raw } = message;
    const msg = this.cfg.redact ? redactPushMessage(raw) : raw;
    const data: PushPayloadData = { paneId: msg.paneId };
    if (msg.session !== undefined) data.session = msg.session;
    if (msg.host !== undefined) data.host = msg.host;
    if (msg.machine !== undefined) data.machine = msg.machine;
    if (msg.target !== undefined) data.target = msg.target;
    // Per-message collapse topic — update and load alerts must not share the herd slot (see above).
    const base =
      msg.type === "update" ? UPDATE_SEND_OPTIONS : msg.type === "machine" ? MACHINE_SEND_OPTIONS : SEND_OPTIONS;
    const options = topic !== undefined && topicIsSendable(topic) ? { ...base, topic } : base;
    if (!this.enabled) return;
    // A clear with a slot waits for its burst (rule 3). One without a slot names nothing a ledger
    // could hold, so it goes to everyone at once, as every push did before.
    if (msg.type === "clear" && msg.tag !== undefined) return this.queueClear(msg.tag, options.topic);
    const body = { ...msg, data };
    // A machine alert is the one push a visible app does not stand in for (web/src/lib/push-decision.ts),
    // so it is never held; a clear without a slot has nothing to hold.
    if (msg.type === "machine") {
      this.log(msg.type, msg.tag, [...this.subs.values()].map((sub) => `${deviceName(sub)} sent`));
      for (const sub of this.subs.values()) this.count(sub, "render");
      await this.broadcast(body, options, msg.tag);
      return;
    }
    if (msg.type === "clear") {
      // Silent like every clear, so it spends rule 4's budget like one.
      const verdicts: string[] = [];
      const out: Delivery[] = [];
      for (const sub of this.subs.values()) {
        if (!this.spendClear(sub.endpoint)) {
          this.count(sub, "overBudget");
          verdicts.push(`${deviceName(sub)} skipped (over the daily budget)`);
          continue;
        }
        this.count(sub, "clear");
        verdicts.push(`${deviceName(sub)} sent`);
        out.push({ sub, body, options, names: [] });
      }
      this.log(msg.type, msg.tag, verdicts);
      await Promise.all([this.deliver(out), out.length > 0 ? this.saveBudget() : undefined]);
      return;
    }
    await this.sendRender(body, options, msg.tag ?? "", msg.type ?? "render", msg.badge);
  }

  /** Convenience for a one-off render (used by the manual push-test script). */
  async notify(title: string, body: string, data: { paneId?: string } = {}): Promise<void> {
    await this.send({ title, body, paneId: data.paneId });
  }

  /** Rule 1: every device gets the render now, except one that is looking, which has it held. */
  private async sendRender(
    body: PushBody,
    options: SendOptions,
    tag: string,
    kind: string,
    badge: number | undefined,
  ): Promise<void> {
    const now = this.clock.now();
    const out: StoredSubscription[] = [];
    const verdicts: string[] = [];
    for (const sub of this.subs.values()) {
      if (sub.device !== undefined && this.looking(sub.device, now)) {
        this.hold(sub.endpoint, tag, { body, options, at: now, label: sub.device, kind, badge });
        this.count(sub, "held");
        verdicts.push(`${deviceName(sub)} held (looking)`);
        continue;
      }
      this.unhold(sub.endpoint, tag);
      // Open from the moment it is sent, not from a 201: a clear racing this send must still go.
      if (tag !== "") this.setSlot(sub.endpoint, tag, "open");
      this.count(sub, "render");
      verdicts.push(`${deviceName(sub)} sent`);
      out.push(sub);
    }
    this.log(kind, tag, verdicts);
    await this.deliver(out.map((sub) => ({ sub, body, options, names: tag === "" ? [] : [tag] })));
  }

  /**
   * Hold a render from a looking device, and look again once the device would have polled. A poll
   * since means its page showed the state, which is all its service worker would have done with the
   * push, so the render is dropped. No poll means the page went away first (the phone locked a
   * moment before), and the render goes out late rather than never.
   */
  private hold(endpoint: string, tag: string, held: HeldRender): void {
    let perSub = this.held.get(endpoint);
    if (perSub === undefined) {
      perSub = new Map();
      this.held.set(endpoint, perSub);
    }
    perSub.set(tag, held);
    const last = this.polls.get(held.label) ?? held.at;
    // +1: the look runs strictly after the window has closed, never on its edge.
    this.clock.schedule(() => void this.lookAgain(endpoint, tag, held), Math.max(0, last + LOOKING_MS - held.at) + 1);
  }

  private async lookAgain(endpoint: string, tag: string, held: HeldRender): Promise<void> {
    const perSub = this.held.get(endpoint);
    // Superseded by a newer render or a clear for the slot, or seen: someone else decided.
    if (perSub?.get(tag) !== held) return;
    perSub.delete(tag);
    const sub = this.subs.get(endpoint);
    if (sub === undefined) return;
    const last = this.polls.get(held.label);
    if (last !== undefined && last > held.at) {
      // Its service worker never counted this slot's alerts (`web/src/lib/app-badge.ts`), which a
      // suppressed push used to do, so the count rides the next push this device gets.
      if (held.badge !== undefined && tag !== "") this.oweBadge(endpoint, tag, held.badge);
      this.count(sub, "dropped");
      this.log(held.kind, tag, [`${deviceName(sub)} dropped (seen in the app)`]);
      return;
    }
    if (tag !== "") this.setSlot(endpoint, tag, "open");
    this.count(sub, "late");
    this.log(held.kind, tag, [`${deviceName(sub)} sent late (stopped looking)`]);
    await this.deliver([{ sub, body: held.body, options: held.options, names: tag === "" ? [] : [tag] }]);
  }

  private unhold(endpoint: string, tag: string): void {
    this.held.get(endpoint)?.delete(tag);
  }

  /** Rule 3: a clear joins the open burst, or opens one. Resolves when that burst has gone out. */
  private queueClear(tag: string, topic: string | undefined): Promise<void> {
    if (this.burst === null) {
      const burst = new Map<string, string | undefined>();
      this.burst = burst;
      this.burstDone = new Promise<void>((resolve) => {
        const flush = () => {
          if (this.burst === burst) this.burst = null;
          this.flushClears(burst).then(resolve, resolve);
        };
        if (this.clearBurstMs <= 0) queueMicrotask(flush);
        else this.clock.schedule(flush, this.clearBurstMs);
      });
    }
    // One entry per slot, at its latest position: two clears of one slot are one clear.
    this.burst.delete(tag);
    this.burst.set(tag, topic);
    return this.burstDone;
  }

  /**
   * Send one burst of clears: to each device, the slots it may still show (rule 2), as one push.
   * One slot keeps the exact shape and collapse topic a clear always had, so an older service
   * worker and an offline phone see no change. Several go as `tags`, with the first also in `tag`,
   * so an older service worker closes that one and the newer one closes all.
   *
   * Several slots ride NO collapse topic: a topic is one slot's, and putting this push on one of
   * them would let that slot's next render replace it in an offline phone's queue, taking the other
   * slots' clears with it. The cost is that the push service no longer drops a queued render this
   * clear makes stale; the phone shows it and closes it on the same reconnect.
   */
  private async flushClears(burst: Map<string, string | undefined>): Promise<void> {
    const tags = [...burst.keys()];
    const out: Delivery[] = [];
    const verdicts: string[] = [];
    for (const sub of this.subs.values()) {
      const due = tags.filter((tag) => this.slotOf(sub.endpoint, tag) !== "closed");
      // A slot whose count is owed and whose clear is skipped is owed a zero instead.
      for (const tag of tags) if (!due.includes(tag) && this.badgeDue.get(sub.endpoint)?.has(tag)) this.oweBadge(sub.endpoint, tag, 0);
      for (const tag of tags) {
        this.unhold(sub.endpoint, tag);
        this.setSlot(sub.endpoint, tag, "closed");
      }
      if (due.length === 0) {
        this.count(sub, "skipped");
        verdicts.push(`${deviceName(sub)} skipped (closed)`);
        continue;
      }
      // Rule 4, after rules 2 and 3: the whole burst is one spend, and only a push that would go spends.
      if (!this.spendClear(sub.endpoint)) {
        // The slots stay on that phone until a render replaces them or its page sweeps them. Their
        // share of the icon count rides the next push it gets, as zero, which costs nothing.
        for (const tag of due) this.oweBadge(sub.endpoint, tag, 0);
        this.count(sub, "overBudget");
        verdicts.push(`${deviceName(sub)} skipped ${due.length} (over the daily budget)`);
        continue;
      }
      this.count(sub, "clear");
      verdicts.push(`${deviceName(sub)} sent ${due.length}`);
      out.push({ sub, ...clearDelivery(due, burst) });
    }
    this.log("clear", tags.length === 1 ? tags[0] : `${tags.length} slots`, verdicts);
    await Promise.all([this.deliver(out), out.length > 0 ? this.saveBudget() : undefined]);
  }

  /**
   * Rule 4: spend one silent clear of this subscription's budget, or answer false when the last
   * {@link SILENT_CLEAR_BUDGET}`.windowMs` already holds the whole budget. A refusal is final: the
   * clear is skipped, never queued. The caller writes the file once per round ({@link saveBudget}).
   */
  private spendClear(endpoint: string): boolean {
    const now = this.clock.now();
    const spent = (this.clearSpends.get(endpoint) ?? []).filter((at) => now - at < SILENT_CLEAR_BUDGET.windowMs);
    if (spent.length >= SILENT_CLEAR_BUDGET.clears) {
      this.clearSpends.set(endpoint, spent);
      return false;
    }
    spent.push(now);
    this.clearSpends.set(endpoint, spent);
    return true;
  }

  private slotOf(endpoint: string, tag: string): SlotState | undefined {
    return this.slots.get(endpoint)?.get(tag);
  }

  private setSlot(endpoint: string, tag: string, state: SlotState): void {
    let perSub = this.slots.get(endpoint);
    if (perSub === undefined) {
      perSub = new Map();
      this.slots.set(endpoint, perSub);
    }
    // Re-inserted, so the Map's order is last-touched and the oldest slot is the first key.
    perSub.delete(tag);
    perSub.set(tag, state);
    if (perSub.size <= SLOT_MEMORY) return;
    const oldest = perSub.keys().next().value;
    if (oldest !== undefined) perSub.delete(oldest);
  }

  /** Forget a subscription and everything kept about it. */
  private drop(endpoint: string): void {
    this.subs.delete(endpoint);
    this.failures.delete(endpoint);
    this.slots.delete(endpoint);
    this.held.delete(endpoint);
    this.badgeDue.delete(endpoint);
    // Every caller saves after a drop; the budget file follows only when it held a row for this one.
    if (this.clearSpends.delete(endpoint)) this.budgetDirty = true;
  }

  /** Owe one device the icon count of one slot, to ride its next push. */
  private oweBadge(endpoint: string, tag: string, count: number): void {
    let perSub = this.badgeDue.get(endpoint);
    if (perSub === undefined) {
      perSub = new Map();
      this.badgeDue.set(endpoint, perSub);
    }
    perSub.delete(tag);
    perSub.set(tag, count);
    if (perSub.size <= SLOT_MEMORY) return;
    const oldest = perSub.keys().next().value;
    if (oldest !== undefined) perSub.delete(oldest);
  }

  /**
   * The JSON one device receives: the body, plus `badgeSlots` when that device is owed counts its
   * service worker missed. A slot the body itself sets is not owed any more, its own push says it.
   * An older service worker ignores the field, and its icon count is what it was before.
   */
  private payloadFor(endpoint: string, body: PushBody, names: readonly string[]): string {
    const owed = this.badgeDue.get(endpoint);
    if (owed === undefined) return JSON.stringify(body);
    for (const name of names) owed.delete(name);
    this.badgeDue.delete(endpoint);
    if (owed.size === 0) return JSON.stringify(body);
    return JSON.stringify({ ...body, badgeSlots: Object.fromEntries(owed) });
  }

  /**
   * One line per push decision, for the journal: what kind, which slot, and each device's verdict.
   * Named by the pairing label where the row has one, else by the endpoint's tail.
   */
  private log(kind: string, tag: string | undefined, verdicts: readonly string[]): void {
    if (verdicts.length === 0) return;
    console.log(`[push] ${kind} ${tag === undefined || tag === "" ? "-" : tag} → ${verdicts.join(", ")}`);
  }

  /**
   * Count one outcome for one device, and once an hour print the last hour's counts, one line per
   * device: the line to read for "how many silent pushes did this phone get". Every clear sent is
   * silent by design; a render can be silent too when the app was open and the bridge did not know.
   */
  private count(sub: StoredSubscription, outcome: keyof Tally): void {
    const now = this.clock.now();
    if (now - this.tallySince >= HOUR_MS) {
      for (const [name, t] of this.tally) {
        const badges = this.tallyBadges.get(name);
        const said = badges === undefined ? "" : badges ? " (badges)" : " (no badges)";
        console.log(
          `[push] last hour, ${name}${said}: ${t.render} rendered, ${t.clear} silent clears, ${t.skipped} clears skipped, ` +
            `${t.overBudget} over the daily budget, ${t.held} held (${t.dropped} seen in the app, ${t.late} sent late)`,
        );
      }
      this.tally.clear();
      this.tallyBadges.clear();
      this.tallySince = now;
    }
    const name = deviceName(sub);
    const t = this.tally.get(name) ?? emptyTally();
    t[outcome] += 1;
    this.tally.set(name, t);
    this.tallyBadges.set(name, sub.badges);
  }

  /** This hour's counts so far, per device, for the tests and for a future reader. */
  tallies(): ReadonlyMap<string, Readonly<Tally>> {
    return this.tally;
  }

  private async broadcast(body: PushBody, options: SendOptions, tag: string | undefined): Promise<void> {
    const names = tag === undefined ? [] : [tag];
    await this.deliver([...this.subs.values()].map((sub) => ({ sub, body, options, names })));
  }

  /** Deliver each body to its subscription, then prune and evict from what came back. */
  private async deliver(deliveries: readonly Delivery[]): Promise<void> {
    if (!this.enabled || deliveries.length === 0) return;
    const dead: string[] = [];
    // Serialised per device now, before anything is awaited, so an owed count is taken exactly once.
    const sends = deliveries.map((d) => ({ ...d, payload: this.payloadFor(d.sub.endpoint, d.body, d.names) }));
    // One entry per subscription attempted this round, so the eviction pass below can ask which
    // push services proved themselves healthy before it holds a failure against any one device.
    const results = await Promise.all(
      sends.map(async ({ sub, payload, options }) => {
        try {
          // `{ endpoint, keys }` and nothing else: the stored row also carries operator metadata,
          // and web-push serialises what it is handed.
          await this.sender({ endpoint: sub.endpoint, keys: sub.keys }, payload, options);
          return { sub, err: null };
        } catch (err) {
          return { sub, err };
        }
      }),
    );

    // A push service that delivered to SOMEBODY this round has a working VAPID/JWT/network path,
    // so a sibling's failure on that same origin is about that subscription and nothing else.
    const healthy = new Set(
      results.filter((r) => r.err === null).map((r) => pushServiceOrigin(r.sub.endpoint)),
    );

    for (const { sub, err } of results) {
      if (err === null) {
        // Consecutive means consecutive: one delivery wipes the slate.
        this.failures.delete(sub.endpoint);
        continue;
      }
      // 404/410 are the only statuses RFC 8030 blesses as "this subscription is gone". Everything
      // else — 400, 401, 403, 429, 5xx — is either transient or about the SENDER (a VAPID key slip
      // makes a whole push service reject perfectly live devices), so it must never prune on sight.
      const code = sendErrorStatus(err);
      if (code === 404 || code === 410) {
        console.log(`[push] pruning gone subscription (${code}): ${sub.endpoint}`);
        dead.push(sub.endpoint);
        continue;
      }
      console.warn(`[push] send failed for ${sub.endpoint}: ${describeSendError(err)}`);

      // Some failures are permanent without ever being 404/410 (Apple answers a dead token with
      // 400 BadDeviceToken), and retried forever they accumulate into the log spam of issue #68.
      // Counting only same-origin-witnessed failures is what keeps this from becoming a 403-storm
      // foot-gun: during a global rejection nothing on that origin succeeds, so nothing is counted.
      // The single-subscription operator therefore never evicts — deliberately. Eviction exists to
      // garbage-collect stale duplicates, which needs a healthy sibling to prove the token is at
      // fault; dropping someone's only subscription would trade a loud log for silent no-push.
      if (!healthy.has(pushServiceOrigin(sub.endpoint))) continue;
      // Overlapping broadcasts aren't serialised, so two in-flight rounds can each land a count on
      // the same endpoint. EVICT_AFTER is slack enough to absorb that; a mutex isn't worth it.
      const n = (this.failures.get(sub.endpoint) ?? 0) + 1;
      this.failures.set(sub.endpoint, n);
      if (n < EVICT_AFTER) continue;
      console.warn(
        `[push] evicting subscription after ${n} consecutive failures (last: ${describeSendError(err)}): ${sub.endpoint}`,
      );
      dead.push(sub.endpoint);
    }

    if (dead.length) {
      for (const e of dead) this.drop(e);
      await this.save();
    }
  }

  /**
   * Read the persisted file into memory. `init()` calls this once push is known to be live; the CLI
   * calls it DIRECTLY, without VAPID, because `collie push list` / `push forget` are precisely what
   * an operator runs when push is off or misconfigured — the store is a file, not a capability.
   *
   * This and {@link save} are the only reader and the only writer of `push-subscriptions.json`.
   */
  async loadStore(): Promise<void> {
    try {
      const raw: unknown = await Bun.file(this.file).json();
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        const row = coerceStored(item);
        if (row !== null) this.subs.set(row.endpoint, row);
      }
    } catch {
      /* no saved subs yet */
    }
    await this.loadBudget();
  }

  /**
   * Read rule 4's spends back, for the subscriptions just loaded only, and only the ones still inside
   * the window, at most the budget per row. Writes nothing: a row for a subscription that is gone
   * leaves the file at the next {@link save}, so `collie push list` stays a read.
   */
  private async loadBudget(): Promise<void> {
    let raw: unknown;
    try {
      raw = await Bun.file(this.budgetFile).json();
    } catch {
      return; // never written: no clear has gone yet
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
    const now = this.clock.now();
    for (const [endpoint, value] of Object.entries(raw)) {
      if (!this.subs.has(endpoint)) {
        this.budgetDirty = true;
        continue;
      }
      if (!Array.isArray(value)) continue;
      const spent = value
        .filter((at): at is number => typeof at === "number" && Number.isFinite(at) && now - at < SILENT_CLEAR_BUDGET.windowMs)
        .toSorted((a, b) => a - b)
        .slice(-SILENT_CLEAR_BUDGET.clears);
      if (spent.length > 0) this.clearSpends.set(endpoint, spent);
    }
  }

  private save(): Promise<void> {
    // Snapshot now (subs mutate synchronously before each save call), then serialise the write
    // behind any in-flight one. `then(write, write)` runs regardless of a prior failure; the
    // chain itself is reset to a swallowed promise so one bad write doesn't wedge future saves.
    const snapshot = JSON.stringify([...this.subs.values()], null, 2);
    const write = () => this.writeState(this.file, snapshot);
    const run = this.saveChain.then(write, write);
    this.saveChain = run.catch(() => {});
    if (!this.budgetDirty) return run;
    const budget = this.saveBudget();
    return run.then(() => budget);
  }

  /**
   * Write rule 4's spends, the same way and through a chain of its own. A failed write is logged and
   * swallowed: the budget then counts from memory until the next restart, which is a smaller harm than
   * failing a send over it. Written only after a clear went or a row left, so a bridge with nobody to
   * push to never creates the file.
   */
  private saveBudget(): Promise<void> {
    this.budgetDirty = false;
    const snapshot = JSON.stringify(Object.fromEntries(this.clearSpends));
    const write = async () => {
      try {
        await this.writeState(this.budgetFile, snapshot);
      } catch (err) {
        console.warn(`[push] could not save the clear budget: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    this.budgetChain = this.budgetChain.then(write, write);
    return this.budgetChain;
  }

  /** Atomic, owner-only write: fresh temp file (mode 0600) then rename over the target. */
  private async writeState(file: string, data: string): Promise<void> {
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, file);
  }
}
