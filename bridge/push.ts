import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";

// Optional Web Push (VAPID). Zero hard dependency: if `web-push` isn't installed or VAPID keys
// aren't configured, push is silently disabled and the rest of the bridge works unchanged.
// Subscriptions are persisted to the state dir so they survive restarts.

type WebPushModule = typeof import("web-push");
export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

/**
 * A notification instruction for the service worker (see web/src/sw.ts). `type:"clear"` closes the
 * notification on `tag` instead of showing one; otherwise the SW renders `{ title, body }` into the
 * `tag` slot, deep-links to `paneId` on tap, and re-alerts when `renotify` is set.
 */
export interface PushMessage {
  type?: "clear";
  title?: string;
  body?: string;
  /** Notification slot. Same tag replaces (rather than stacks) the previous notification. */
  tag?: string;
  paneId?: string;
  renotify?: boolean;
}

export class Push {
  private lib: WebPushModule | null = null;
  private subs = new Map<string, PushSubscription>();
  private readonly file: string;
  private _enabled = false;

  constructor(private readonly cfg: Config) {
    this.file = join(cfg.stateDir, "push-subscriptions.json");
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

  /** Send a notification instruction (render or clear) to every subscribed device. */
  async send(msg: PushMessage): Promise<void> {
    await this.broadcast(JSON.stringify({ ...msg, data: { paneId: msg.paneId } }));
  }

  /** Convenience for a one-off render (used by the manual push-test script). */
  async notify(title: string, body: string, data: { paneId?: string } = {}): Promise<void> {
    await this.send({ title, body, paneId: data.paneId });
  }

  private async broadcast(payload: string): Promise<void> {
    if (!this.enabled || !this.lib) return;
    const dead: string[] = [];
    await Promise.all(
      [...this.subs.values()].map(async (sub) => {
        try {
          await this.lib!.sendNotification(sub, payload);
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

  private async save(): Promise<void> {
    await mkdir(this.cfg.stateDir, { recursive: true });
    await Bun.write(this.file, JSON.stringify([...this.subs.values()], null, 2));
  }
}
