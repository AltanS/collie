import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { AgentStatus } from "./types.ts";

// Which agent lifecycle events are worth a push. A companion to Snooze (the do-not-disturb deadline):
// where Snooze mutes everything for a while, this decides which *kinds* of alert ever fire. By default
// only "agent needs your input" (blocked) pushes; a "done" push is off — most people don't want a buzz
// for every completed task. Bridge-wide (not per-device), like Snooze, because a push fans out to
// every subscribed device. Persisted to the state dir so a preference survives the `systemctl restart`
// that backend changes require. Missing file / missing keys fall back to defaults.

/** Notification type preferences: which notifiable statuses actually push. */
export interface NotifyPrefs {
  /** Push when an agent becomes blocked (waiting on your input). Default on. */
  blocked: boolean;
  /** Push when an agent finishes its task. Default off. */
  done: boolean;
  /** Push when a newer Collie release is available. Default on — the off-switch for update alerts,
   *  which otherwise bypass snooze (an update isn't quiet-hours material). Not an agent status, so it
   *  never flows through {@link isNotifiable}; the update monitor reads it directly. */
  updates: boolean;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { blocked: true, done: false, updates: true };

/**
 * Coerce an untrusted parsed value into a {@link NotifyPrefs}, filling any missing or non-boolean key
 * from the defaults. Pure + exported so the file-shape handling is unit-testable.
 */
export function coerceNotifyPrefs(raw: unknown): NotifyPrefs {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    blocked: typeof o.blocked === "boolean" ? o.blocked : DEFAULT_NOTIFY_PREFS.blocked,
    done: typeof o.done === "boolean" ? o.done : DEFAULT_NOTIFY_PREFS.done,
    updates: typeof o.updates === "boolean" ? o.updates : DEFAULT_NOTIFY_PREFS.updates,
  };
}

export class NotifyPrefsStore {
  private prefs: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS };
  private readonly file: string;

  constructor(private readonly cfg: Config) {
    this.file = join(cfg.stateDir, "notify-prefs.json");
  }

  async load(): Promise<void> {
    try {
      this.prefs = coerceNotifyPrefs(await Bun.file(this.file).json());
    } catch {
      /* none saved yet — keep defaults */
    }
  }

  /** A copy of the current prefs (never the internal object, so callers can't mutate our state). */
  current(): NotifyPrefs {
    return { ...this.prefs };
  }

  /**
   * Whether a transition into `status` should notify, per the current prefs. Any status that isn't a
   * notifiable kind (idle/working/unknown) is always false — mirrors the coordinator's old static set.
   */
  isNotifiable(status: AgentStatus): boolean {
    if (status === "blocked") return this.prefs.blocked;
    if (status === "done") return this.prefs.done;
    return false;
  }

  /** Merge a partial patch (only booleans are applied), persist, and return the updated prefs. */
  async set(patch: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
    if (typeof patch.blocked === "boolean") this.prefs.blocked = patch.blocked;
    if (typeof patch.done === "boolean") this.prefs.done = patch.done;
    if (typeof patch.updates === "boolean") this.prefs.updates = patch.updates;
    await this.save();
    return this.current();
  }

  /** Atomic, owner-only write: fresh temp file (mode 0600) then rename over the target. */
  private async save(): Promise<void> {
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.prefs, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
