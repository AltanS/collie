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
//     match [A-Za-z0-9_-] and be ≤32 chars ("collie-herd" is valid).
//   • `TTL` (seconds) bounds how long the service holds an undelivered message: 6h is long enough to
//     reach a briefly-offline phone but short enough that a day-old "needs you" doesn't resurface.
const SEND_OPTIONS = { TTL: 21_600, topic: "collie-herd" } as const;
// Update-available pushes ride their OWN collapse topic (and a longer TTL). The `topic` — NOT the
// client-side `tag` — is the push service's collapse key: sharing "collie-herd" would make an offline
// device's queued herd summary and an update push silently overwrite each other. 3-day TTL, since an
// update stays relevant far longer than a transient "needs you".
const UPDATE_SEND_OPTIONS = { TTL: 259_200, topic: "collie-update" } as const;

/** web-push delivery options (collapse topic + TTL), derived per message from its `type`. */
export type SendOptions = { TTL: number; topic: string };

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
    await Promise.all(
      [...this.subs.values()].map(async (sub) => {
        try {
          await this.sender(sub, payload, options);
        } catch (err) {
          // 404/410 mean the subscription is gone — prune it. Anything else (network, 5xx) is a
          // real failure worth a log line rather than vanishing silently.
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) {
            dead.push(sub.endpoint);
          } else {
            console.warn(
              `[push] send failed for ${sub.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }),
    );
    if (dead.length) {
      for (const e of dead) this.subs.delete(e);
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
