import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";

// When did each pane last DO something, and when did you last LOOK at it? Herdr answers neither —
// its pane records carry no timestamps at all (HERDR_API.md) — so Collie derives and owns both.
//
// Two numbers per pane are enough for the whole dashboard:
//   • activeAt — the last agent status transition this bridge observed
//   • seenAt   — the last time you opened or drove the pane THROUGH COLLIE
//
// "Unseen" is then a comparison, not a stored fact: an agent is newly-finished-and-unread exactly
// when `status === "done" && activeAt > seenAt`. Opening the pane sets seenAt = now, and the row
// leaves the section on its own — nothing to mark read, nothing to keep in sync.
//
// Bridge-side and shared across devices on purpose, and deliberately blind to what you do at the
// desk in Herdr itself — see .adr/0003-one-shared-seen.md. Persisted to the state dir like Snooze
// and NotifyPrefsStore, so it survives the `systemctl restart` every backend change needs.

/** The two timestamps Collie keeps for a pane. Epoch ms. */
export interface PaneActivity {
  /** Last agent status transition observed by the state engine. */
  activeAt: number;
  /** Last time you opened or drove this pane through Collie. */
  seenAt: number;
}

/** Disk shape: session name → pane id → activity. */
export type ActivityFile = Record<string, Record<string, PaneActivity>>;

/** Entries untouched for this long are dropped when the file loads — a backstop for panes whose
 *  removal we missed (an unclean shutdown), since {@link ActivityLedger.forget} is the real reaper. */
export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** At most one disk write per this window. An open pane polls ~1/s and every poll marks it seen;
 *  in memory that's free, on disk it would be a write per second forever. Losing ≤10s of "seen"
 *  precision to a crash is imperceptible in a feature whose finest unit is "just now". */
export const FLUSH_DEBOUNCE_MS = 10_000;

/**
 * A tab label worth putting on screen. Herdr labels an unlabelled tab **positionally** — it returns
 * `"1"`, `"2"` (HERDR_API.md § Rename methods) — so a naive join renders `moonward_os · 1`, which
 * reads as a bug rather than a name. When the space has only one tab there is nothing to
 * disambiguate, so the positional default is dropped and the row shows the project alone.
 *
 * With two or more tabs the number is kept: it's weak, but it's the only thing telling two panes in
 * the same project apart, and it matches what the desktop TUI shows.
 *
 * Pure + exported so the rule is unit-tested and lives in ONE place — every client surface then
 * only has to know "render `tabLabel` if it's there".
 */
export function meaningfulTabLabel(
  label: string | undefined,
  tabCount: number,
): string | undefined {
  const trimmed = label?.trim();
  if (!trimmed) return undefined;
  if (tabCount <= 1 && /^\d+$/.test(trimmed)) return undefined;
  return trimmed;
}

// A leading status glyph on an OSC title, e.g. Claude's `◐ Reviewing the diff`. The classes are the
// symbol blocks a harness draws a spinner from — Geometric Shapes (◐◑◒◓), Miscellaneous Symbols,
// Dingbats (✳✻✽✢), Misc Symbols and Arrows, emoji — plus the bare `*` and `·` some use.
//
// The trailing `\s` is the safety, and it is why this is a whitelist of BLOCKS rather than of
// individual frames: a status glyph is always followed by a space before the title text, so
// requiring one lets this strip spinner frames nobody has observed yet without eating a title that
// merely OPENS with punctuation (`(main) vim`, `— draft`). Bounded to 2 glyphs; no real prefix is
// longer, and an unbounded run on hostile input would scan the whole string.
const STATUS_GLYPH_CLASS = "■-◿☀-⛿✀-➿⬀-⯿\\u{1F300}-\\u{1FAFF}*·";
const LEADING_STATUS_GLYPH = new RegExp(`^[${STATUS_GLYPH_CLASS}]{1,2}\\s+`, "u");
/** A title with no prose in it at all — a bare spinner frame, which names nothing. Needed separately
 *  because the strip above requires trailing whitespace, so `"◐"` alone would otherwise survive. */
const GLYPHS_ONLY = new RegExp(`^[${STATUS_GLYPH_CLASS}\\s]+$`, "u");

/**
 * A terminal title worth putting on screen, or `undefined` when it says nothing.
 *
 * Herdr reports the pane's OSC title and its own stripped form. The stripped form is NOT usable
 * directly: it removes the settled `✳` but leaves Claude's rotating spinner frames (live-observed
 * 2026-08-15 in one snapshot — `✳ Read Notes From Underground` stripped, `◐ Custom UI for Collie…`
 * not). Since those frames advance on every poll, binding a row's label to it makes every working
 * agent's name flicker. So Collie strips the glyph itself, on whichever of the two strings is
 * already the shorter — Herdr having done the job is a fine head start, it just can't be trusted to
 * have finished it.
 *
 * A title is dropped when it repeats what the row already shows: the agent's own name (Herdr falls
 * back to the process name, so an agent that sets no title reports `claude`), or the workspace
 * label that is line one of every row. Case-insensitive, because neither comparison is about case.
 *
 * Pure + exported so the rule is unit-tested and lives in ONE place, exactly as
 * {@link meaningfulTabLabel} is.
 */
export function meaningfulTerminalTitle(
  title: string | null | undefined,
  stripped: string | null | undefined,
  agent: string,
  workspaceLabel: string,
): string | undefined {
  // Prefer whichever string is shorter once trimmed — that is Herdr's strip when it fired, and the
  // raw title when it didn't. Comparing length rather than trusting `stripped` to exist keeps an
  // older server (which omits it entirely) on the same path.
  const candidates = [title, stripped]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s)
    .sort((a, b) => a.length - b.length);
  const shortest = candidates[0];
  if (!shortest) return undefined;
  if (GLYPHS_ONLY.test(shortest)) return undefined;

  const cleaned = shortest.replace(LEADING_STATUS_GLYPH, "").trim();
  if (!cleaned) return undefined;

  const fold = cleaned.toLowerCase();
  if (fold === agent.trim().toLowerCase()) return undefined;
  if (fold === workspaceLabel.trim().toLowerCase()) return undefined;
  return cleaned;
}

/**
 * Coerce an untrusted parsed value into an {@link ActivityFile}, dropping anything malformed and
 * anything older than {@link PRUNE_AFTER_MS}. Pure + exported so the file-shape and prune handling
 * are unit-testable without touching disk.
 */
export function coerceActivityFile(raw: unknown, now: number): ActivityFile {
  const out: ActivityFile = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [session, panes] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof panes !== "object" || panes === null) continue;
    const kept: Record<string, PaneActivity> = {};
    for (const [paneId, entry] of Object.entries(panes as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.activeAt !== "number" || typeof e.seenAt !== "number") continue;
      if (!Number.isFinite(e.activeAt) || !Number.isFinite(e.seenAt)) continue;
      if (now - Math.max(e.activeAt, e.seenAt) > PRUNE_AFTER_MS) continue;
      kept[paneId] = { activeAt: e.activeAt, seenAt: e.seenAt };
    }
    if (Object.keys(kept).length > 0) out[session] = kept;
  }
  return out;
}

export class ActivityLedger {
  private readonly bySession = new Map<string, Map<string, PaneActivity>>();
  private readonly file: string;
  private readonly dir: string;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    cfg: Pick<Config, "stateDir">,
    private readonly now: () => number = Date.now,
    private readonly debounceMs: number = FLUSH_DEBOUNCE_MS,
  ) {
    this.dir = cfg.stateDir;
    this.file = join(cfg.stateDir, "activity.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = coerceActivityFile(await Bun.file(this.file).json(), this.now());
      for (const [session, panes] of Object.entries(parsed)) {
        this.bySession.set(session, new Map(Object.entries(panes)));
      }
    } catch {
      /* none saved yet, or unreadable — start empty */
    }
  }

  /**
   * First sighting of a pane: seed `activeAt = seenAt = now`, so it starts out exactly "seen".
   * No-op once the pane is known.
   *
   * A fresh install must not open on a screen full of unread alerts, and only transitions observed
   * AFTER we first saw a pane should be able to mark it unread. This is the same rule the state
   * engine already applies to notifications — a first sighting never fires a transition, so we
   * don't notify for agents that were already blocked when the bridge started.
   */
  ensure(session: string, paneId: string): void {
    const panes = this.panesFor(session);
    if (panes.has(paneId)) return;
    const t = this.now();
    panes.set(paneId, { activeAt: t, seenAt: t });
    this.markDirty();
  }

  /** The agent moved (a status transition). This is the only thing that can make a pane unread. */
  noteActive(session: string, paneId: string): void {
    const panes = this.panesFor(session);
    const t = this.now();
    const prev = panes.get(paneId);
    panes.set(paneId, { activeAt: t, seenAt: prev?.seenAt ?? t });
    this.markDirty();
  }

  /** You opened or drove the pane through Collie. Clears its unread state by construction. */
  noteSeen(session: string, paneId: string): void {
    const panes = this.panesFor(session);
    const t = this.now();
    const prev = panes.get(paneId);
    panes.set(paneId, { activeAt: prev?.activeAt ?? t, seenAt: t });
    this.markDirty();
  }

  get(session: string, paneId: string): PaneActivity | undefined {
    return this.bySession.get(session)?.get(paneId);
  }

  /**
   * Bring a session's entries in line with the panes that actually exist: seed anything new
   * ({@link ensure}) and drop anything gone ({@link forget}).
   *
   * Reconciling wholesale — rather than listening for per-pane removals — is what makes this
   * correct for BARE SHELL panes too. The state engine's removal event is derived from its agent
   * status map, so it never fires for a shell; a shell's entry would otherwise linger until the
   * 30-day prune. Only ever called from a SUCCESSFUL poll, so a transient Herdr outage (which
   * skips the update listeners entirely) can't be mistaken for "every pane closed".
   */
  reconcile(session: string, livePaneIds: Iterable<string>): void {
    const live = new Set(livePaneIds);
    for (const paneId of live) this.ensure(session, paneId);
    const panes = this.bySession.get(session);
    if (!panes) return;
    for (const paneId of [...panes.keys()]) {
      if (!live.has(paneId)) this.forget(session, paneId);
    }
  }

  /** The pane is gone. Drop it so a reused pane id can never inherit a dead pane's history. */
  forget(session: string, paneId: string): void {
    const panes = this.bySession.get(session);
    if (!panes?.delete(paneId)) return;
    if (panes.size === 0) this.bySession.delete(session);
    this.markDirty();
  }

  /** The current in-memory state as the on-disk shape. Exposed for tests and for {@link flush}. */
  snapshot(): ActivityFile {
    const out: ActivityFile = {};
    for (const [session, panes] of this.bySession) {
      out[session] = Object.fromEntries(panes);
    }
    return out;
  }

  /**
   * Write now, cancelling any pending debounce. Writes are serialised through `this.writing` so two
   * flushes can't interleave their temp-file rename. Called on shutdown; otherwise the debounce
   * timer drives it.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const payload = JSON.stringify(this.snapshot());
    this.writing = this.writing.then(() => this.write(payload)).catch(() => {});
    return this.writing;
  }

  /** Stop the debounce timer without writing. For tests and disposal paths. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private panesFor(session: string): Map<string, PaneActivity> {
    let panes = this.bySession.get(session);
    if (!panes) {
      panes = new Map();
      this.bySession.set(session, panes);
    }
    return panes;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    // Never hold the process open just to persist a "last seen" — shutdown flushes explicitly.
    this.timer.unref?.();
  }

  private async write(payload: string): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, payload, { mode: 0o600 });
      await rename(tmp, this.file);
    } catch (err) {
      console.warn(`[activity] could not persist ${this.file}: ${(err as Error).message}`);
    }
  }
}
