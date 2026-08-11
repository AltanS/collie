import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";

// Optional Web Push (VAPID). Zero hard dependency: if `web-push` isn't installed or VAPID keys
// aren't configured, push is silently disabled and the rest of the bridge works unchanged.
// Subscriptions are persisted to the state dir so they survive restarts.

type WebPushModule = typeof import("web-push");
export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

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
function describeSendError(err: unknown): string {
  const e = err as { statusCode?: number; body?: unknown };
  const message = err instanceof Error ? err.message : String(err);
  const status = typeof e.statusCode === "number" ? ` status=${e.statusCode}` : "";
  const raw = typeof e.body === "string" ? e.body.replace(/\s+/g, " ").trim() : "";
  const body = raw ? ` body=${raw.length > 200 ? `${raw.slice(0, 200)}…` : raw}` : "";
  return `${message}${status}${body}`;
}

/** web-push delivery options (collapse topic + TTL + urgency), derived per message from its `type`. */
export type SendOptions = { TTL: number; topic: string; urgency?: "very-low" | "low" | "normal" | "high" };

/** Delivers one payload to one subscription with the given options. Injectable so the prune/log
 *  logic is testable. */
export type PushSender = (
  sub: PushSubscription,
  payload: string,
  options: SendOptions,
) => Promise<unknown>;

/**
 * A notification instruction for the service worker (see web/src/sw.ts). `type:"clear"` closes the
 * notification on `tag` instead of showing one; `type:"update"` is an update-available alert (its own
 * collapse topic; taps open Settings); otherwise the SW renders `{ title, body }` into the `tag` slot,
 * deep-links to `paneId` on tap, and re-alerts when `renotify` is set.
 */
export interface PushMessage {
  type?: "clear" | "update";
  title?: string;
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
  /** Where a tap should land instead of the default pane deep-link. `"settings"` for update alerts;
   *  absent = today's pane deep-link (so the agent-alert payload is unchanged). */
  target?: "settings";
  renotify?: boolean;
}

export class Push {
  private lib: WebPushModule | null = null;
  private subs = new Map<string, PushSubscription>();
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

  constructor(
    private readonly cfg: Config,
    sender?: PushSender,
  ) {
    this.file = join(cfg.stateDir, "push-subscriptions.json");
    this.sender = sender ?? ((sub, payload, options) => this.lib!.sendNotification(sub, payload, options));
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
    await this.load();
    console.log(`[push] enabled (${this.subs.size} saved subscription(s))`);
  }

  async addSubscription(sub: PushSubscription): Promise<void> {
    if (!this.enabled) return;
    this.subs.set(sub.endpoint, sub);
    // A re-subscribe is fresh evidence even when the endpoint string is unchanged — the device just
    // told us it wants pushes, so it doesn't inherit the failure history of its predecessor.
    this.failures.delete(sub.endpoint);
    await this.save();
  }

  /** Send a notification instruction (render, clear, or update) to every subscribed device. */
  async send(msg: PushMessage): Promise<void> {
    // The SW reads deep-link fields from `data`. `session` is omitted for the primary (absent on the
    // message), keeping that payload identical to the pre-multi-session shape.
    const data: { paneId?: string; session?: string; target?: "settings" } = { paneId: msg.paneId };
    if (msg.session !== undefined) data.session = msg.session;
    if (msg.target !== undefined) data.target = msg.target;
    // Per-message collapse topic — update alerts must not share the herd slot (see UPDATE_SEND_OPTIONS).
    const options = msg.type === "update" ? UPDATE_SEND_OPTIONS : SEND_OPTIONS;
    await this.broadcast(JSON.stringify({ ...msg, data }), options);
  }

  /** Convenience for a one-off render (used by the manual push-test script). */
  async notify(title: string, body: string, data: { paneId?: string } = {}): Promise<void> {
    await this.send({ title, body, paneId: data.paneId });
  }

  private async broadcast(payload: string, options: SendOptions): Promise<void> {
    if (!this.enabled) return;
    const dead: string[] = [];
    // One entry per subscription attempted this round, so the eviction pass below can ask which
    // push services proved themselves healthy before it holds a failure against any one device.
    const results = await Promise.all(
      [...this.subs.values()].map(async (sub) => {
        try {
          await this.sender(sub, payload, options);
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
      const code = (err as { statusCode?: number }).statusCode;
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
      for (const e of dead) {
        this.subs.delete(e);
        this.failures.delete(e);
      }
      await this.save();
    }
  }

  private async load(): Promise<void> {
    try {
      const raw = await Bun.file(this.file).json();
      if (Array.isArray(raw)) for (const s of raw as PushSubscription[]) this.subs.set(s.endpoint, s);
    } catch {
      /* no saved subs yet */
    }
  }

  private save(): Promise<void> {
    // Snapshot now (subs mutate synchronously before each save call), then serialise the write
    // behind any in-flight one. `then(write, write)` runs regardless of a prior failure; the
    // chain itself is reset to a swallowed promise so one bad write doesn't wedge future saves.
    const snapshot = JSON.stringify([...this.subs.values()], null, 2);
    const write = () => this.writeState(snapshot);
    const run = this.saveChain.then(write, write);
    this.saveChain = run.catch(() => {});
    return run;
  }

  /** Atomic, owner-only write: fresh temp file (mode 0600) then rename over the target. */
  private async writeState(data: string): Promise<void> {
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
