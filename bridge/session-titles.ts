// What each harness session is called in its own records. The bridge-owned ledger of session names.
//
// One name for one session in every client: a session renamed in Claude Code (`/rename`), titled by
// Oh My Pi, or titled by OpenCode reads the same on the phone as in the terminal and in any other
// client that reads the same records. The harness's journal is the source (JournalAdapter.nameProbe,
// one small reader per harness), and this tracker is the one place that asks it, cleans the answer
// (session-title.ts `normalizeTitle`) and remembers it.
//
// IT IS THE CACHE TRACKER'S SHAPE, ON PURPOSE (bridge/cache/tracker.ts). The state engine's poll drives
// `refresh`; the engine reads `get` from memory, so a poll never waits on a disk read. STATE IS KEYED BY
// THE HARNESS SESSION ID, never the pane id: pane ids churn, and a name is a fact about the session. A
// session is looked at at most once every `floorMs`, and past the floor `source.stat` decides whether
// anything was written; only a moved file is read. A query-backed adapter takes the longer floor.
//
// A READ THAT SAYS NOTHING KEEPS THE LAST NAME. A failed stat or probe, or a window that holds no name
// row, keeps what the last successful read found (a 128 KB tail is a window, not the log). Only an
// explicit `null` from the probe drops a name: the records prove it was cleared. The last names also
// outlive the bridge: with a store (session-titles-store.ts), a session the tracker has not read since
// it started is seeded from the file, and each change is written back.
//
// ONE LOOK AT A TIME PER MULTIPLEXER SESSION. The poll fires `refresh` and does not wait, so a slow disk
// could start a second look before the first ended and read every log twice inside the floor. A
// refresh for a session whose last refresh is still running returns at once. The cache tracker reads
// the same tail on its own schedule; sharing one read between them would tie the two floors together,
// so each keeps its own read.
//
// OWNERSHIP AND THE REAP are the cache tracker's too: each entry remembers the multiplexer session and
// the pane it was read for, and a poll forgets only its own session's entries whose pane left the list
// or named another harness session.
//
// No harness name lives here. Which rows name a session is each adapter's business.

import { QUERY_BACKED_AGENTS } from "./cache/tracker.ts";
import { adapterFor } from "./journal/registry.ts";
import type { AgentSessionRef, JournalAdapter } from "./journal/types.ts";
import { normalizeTitle, type NameReading, type SessionTitles } from "./session-title.ts";
import type { RememberedTitles, SessionTitleStore } from "./session-titles-store.ts";
import { journalAgentOf, type AgentView } from "./types.ts";

export const DEFAULT_TITLE_FLOOR_MS = 5000;
export const DEFAULT_TITLE_QUERY_FLOOR_MS = 10_000;

export interface SessionTitleTrackerOptions {
  floorMs?: number;
  queryFloorMs?: number;
  /** Where the last names outlive a restart. None: memory only. */
  store?: Pick<SessionTitleStore, "load" | "save">;
}

interface Entry {
  session: string | undefined;
  paneId: string;
  lastProbedAt: number;
  /** The stat the names were read at; null before a read succeeded. */
  seen: { size: number; mtimeMs: number } | null;
  titles: SessionTitles;
}

export class SessionTitleTracker {
  private readonly bySession = new Map<string, Entry>();

  private readonly floorMs: number;

  private readonly queryFloorMs: number;

  private readonly store: Pick<SessionTitleStore, "load" | "save"> | undefined;

  /** The last names of every session, by session id, as the store keeps them. */
  private remembered = new Map<string, RememberedTitles>();

  /** The multiplexer sessions whose refresh is running now. */
  private readonly running = new Set<string>();

  constructor(
    private readonly registry: Record<string, JournalAdapter>,
    private readonly now: () => number,
    options: SessionTitleTrackerOptions = {},
  ) {
    this.floorMs = options.floorMs ?? DEFAULT_TITLE_FLOOR_MS;
    this.queryFloorMs = options.queryFloorMs ?? DEFAULT_TITLE_QUERY_FLOOR_MS;
    this.store = options.store;
  }

  /** Read the store once, at boot, before the first refresh. Never throws. */
  async restore(): Promise<void> {
    if (this.store === undefined) return;
    const kept = await this.store.load();
    for (const [id, row] of kept) if (!this.remembered.has(id)) this.remembered.set(id, row);
  }

  /** The cleaned names of one harness session, or undefined. A synchronous map read. */
  get(sessionKey: string): SessionTitles | undefined {
    const titles = this.bySession.get(sessionKey)?.titles;
    return titles === undefined || (titles.person === undefined && titles.agent === undefined) ? undefined : titles;
  }

  /** The names of the session a pane names, or undefined. */
  forPane(pane: Pick<AgentView, "agentSession">): SessionTitles | undefined {
    const key = pane.agentSession?.value;
    return key === undefined ? undefined : this.get(key);
  }

  /** Walk the agent panes and bring their names up to date. NEVER THROWS. */
  async refresh(panes: readonly AgentView[], scope: { session?: string } = {}): Promise<void> {
    const slot = scope.session ?? "";
    if (this.running.has(slot)) return;
    this.running.add(slot);
    try {
      await this.refreshNow(panes, scope.session);
    } finally {
      this.running.delete(slot);
    }
  }

  private async refreshNow(panes: readonly AgentView[], session: string | undefined): Promise<void> {
    const at = this.now();
    let changed = false;
    const named = new Map<string, string | undefined>();
    for (const pane of panes) {
      const ref = pane.agentSession;
      named.set(pane.paneId, ref?.value);
      if (ref === undefined) continue;
      const adapter = adapterFor(this.registry, journalAgentOf(pane));
      if (adapter?.nameProbe === undefined) continue;
      const owner = { session, paneId: pane.paneId };
      const entry = this.bySession.get(ref.value);
      const floor = QUERY_BACKED_AGENTS.has(adapter.agent) ? this.queryFloorMs : this.floorMs;
      if (entry !== undefined && at - entry.lastProbedAt < floor) {
        this.bySession.set(ref.value, { ...entry, ...owner });
        continue;
      }
      const seeded = entry ?? this.seed(ref.value);
      await this.look(adapter, ref, at, owner, seeded);
      if (this.remember(ref.value, at)) changed = true;
    }
    for (const [key, entry] of this.bySession) {
      if (entry.session === session && departed(named, key, entry.paneId)) this.bySession.delete(key);
    }
    if (changed && this.store !== undefined) await this.store.save(this.remembered);
  }

  /** A first look's starting point: the names the store kept, never read against a stat. */
  private seed(key: string): Entry | undefined {
    const kept = this.remembered.get(key);
    return kept === undefined ? undefined : { session: undefined, paneId: "", lastProbedAt: Number.NEGATIVE_INFINITY, seen: null, titles: kept.titles };
  }

  /** Copy a session's names into the kept map; true when they differ from what was kept. */
  private remember(key: string, at: number): boolean {
    const titles = this.bySession.get(key)?.titles ?? {};
    const kept = this.remembered.get(key)?.titles ?? {};
    if (titles.person === kept.person && titles.agent === kept.agent) return false;
    if (titles.person === undefined && titles.agent === undefined) this.remembered.delete(key);
    else this.remembered.set(key, { titles, at });
    return true;
  }

  /** One session's look: stat it, and read its names only when the stat moved. */
  private async look(
    adapter: JournalAdapter,
    ref: AgentSessionRef,
    at: number,
    owner: { session: string | undefined; paneId: string },
    previous: Entry | undefined,
  ): Promise<void> {
    const kept = previous?.titles ?? {};
    const stat = await statOf(adapter, ref);
    const unchanged = stat !== null && previous?.seen !== null && previous?.seen !== undefined && previous.seen.size === stat.size && previous.seen.mtimeMs === stat.mtimeMs;
    if (stat === null || unchanged) {
      this.bySession.set(ref.value, { ...owner, lastProbedAt: at, seen: previous?.seen ?? null, titles: kept });
      return;
    }
    let reading: NameReading | null;
    try {
      reading = (await adapter.nameProbe?.(ref)) ?? null;
    } catch {
      reading = null;
    }
    // A read that failed keeps its last `seen`, so the next stat that succeeds is still compared with
    // the file the names came from, and the read is tried again.
    if (reading === null) {
      this.bySession.set(ref.value, { ...owner, lastProbedAt: at, seen: previous?.seen ?? null, titles: kept });
      return;
    }
    this.bySession.set(ref.value, { ...owner, lastProbedAt: at, seen: stat, titles: mergeTitles(kept, reading) });
  }
}

/**
 * The names after one read: a field the read names replaces the last one (cleaned), an explicit null
 * clears it, and a field the read left out keeps the last one. Pure, and exported for the table test.
 */
export function mergeTitles(previous: SessionTitles, reading: NameReading): SessionTitles {
  const out: SessionTitles = {};
  const person = pick(previous.person, reading.person);
  const agent = pick(previous.agent, reading.agent);
  if (person !== undefined) out.person = person;
  if (agent !== undefined) out.agent = agent;
  return out;
}

function pick(previous: string | undefined, read: string | null | undefined): string | undefined {
  if (read === undefined) return previous;
  if (read === null) return undefined;
  return normalizeTitle(read) ?? previous;
}

/** Has the pane this entry was read for left the session's list, or named another harness session? */
function departed(named: Map<string, string | undefined>, key: string, paneId: string): boolean {
  if (!named.has(paneId)) return true;
  const now = named.get(paneId);
  return now !== undefined && now !== key;
}

/** `resolve` then `stat`, through the adapter's own source. Null for anything unreadable. */
async function statOf(adapter: JournalAdapter, ref: AgentSessionRef): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const path = await adapter.source.resolve(ref);
    if (path === null) return null;
    return await adapter.source.stat(path);
  } catch {
    return null;
  }
}
