// The lead's watch over every machine's load: the last sample each one gave, a day of minutes, and
// the alert rules (ADR 0084). A solo collie runs the same watch over its one machine.
//
// ── NO TIMER, AND NOTHING HERE DIALS ─────────────────────────────────────────
// Samples arrive two ways and both are hooks that already run: this machine's own sampler, read from
// the state engine's tick, and each member's `machineStats`, read off the answer the lead's sweep
// already parsed (CREW_PROTOCOL.md §10.1). {@link MachineWatch.tick} runs from that same engine tick,
// judges the alert rules once a minute and saves the history at most every five minutes. The class
// arms nothing, which is the rule `CacheWarden` and `CrewLead` keep for the same reason.
//
// ── WHAT THE PHONE READS IS ALREADY HERE ─────────────────────────────────────
// `rows()` and `history()` read memory. The roster comes from the same closure `GET /api/crew` reads,
// so asking about machines can no more make the lead dial a member than asking about the crew can.

import type { MachineAlertStore } from "./machine-alerts.ts";
import { evaluateMachineAlerts, machineAlertMessage } from "./machine-alerts.ts";
import { minuteOf, type MachineHistory } from "./machine-history.ts";
import type { PushMessage } from "./push.ts";
import type {
  CrewStatusResponse,
  MachineAlerts,
  MachineHistoryResponse,
  MachineRow,
  MachineSample,
  MachinesResponse,
} from "./types.ts";

/** The longest the history goes unsaved while it is changing. */
export const HISTORY_SAVE_EVERY_MS = 5 * 60_000;

/** The machine id of a solo collie that never enrolled: it has no member id to use. */
export const SOLO_MACHINE_ID = "local";

/** One machine as the roster names it. The lead first; a solo collie is one entry. */
export interface MachineRosterEntry {
  readonly id: string;
  readonly name: string;
  readonly isLead: boolean;
  readonly health: MachineRow["health"];
}

/**
 * The machines a lead or a solo collie answers for. A lead's list IS the crew overview's rows — the
 * same `GET /api/crew` body, so a machine's id here is its `CrewMemberStatus.id`, the lead's own row
 * included, and the crew page's link to `/machines/<id>` lands on the right machine by construction.
 * With no crew to report (`status` null) the one row is this collie itself.
 */
export function machineRosterOf(
  status: CrewStatusResponse | null,
  self: { readonly id: string; readonly name: string },
): MachineRosterEntry[] {
  if (status !== null) {
    return status.members.map((m) => ({ id: m.id, name: m.name, isLead: m.isLead, health: m.health }));
  }
  return [{ id: self.id, name: self.name, isLead: true, health: "reachable" }];
}

export interface MachineWatchDeps {
  readonly now: () => number;
  /** Every machine this collie answers for, read on every call: a member can join or leave live. */
  readonly roster: () => readonly MachineRosterEntry[];
  readonly history: MachineHistory;
  readonly alerts: MachineAlertStore;
  /** `saveMachineHistory` in production, a recorder in the test. */
  readonly saveHistory: (history: MachineHistory, now: number) => Promise<void>;
  /** `snooze.isMuted()`, read live. */
  readonly muted: () => boolean;
  /** `notifyPrefs.current().machines`, read live. */
  readonly enabled: () => boolean;
  /** `push.send`. */
  readonly send: (msg: PushMessage) => void;
  /**
   * Whether this collie still answers for its machines, read live. False once it is deposed
   * (CREW_PROTOCOL.md §18.12): a deposed lead's roster is void, so it records, judges and pushes
   * nothing. Absent means always.
   */
  readonly active?: () => boolean;
  readonly log?: (line: string) => void;
}

/** What `bridge/server.ts` asks of the watch. Structural, so a route test can pass a small object. */
export interface MachineSurface {
  rows(): MachinesResponse;
  history(id: string): MachineHistoryResponse | null;
  entry(id: string): MachineRosterEntry | undefined;
  setAlerts(id: string, alerts: MachineAlerts): Promise<MachineAlerts | null>;
}

export class MachineWatch implements MachineSurface {
  private readonly latest = new Map<string, { readonly sample: MachineSample; readonly at: number }>();
  private lastJudgedMinute: number | null = null;
  private lastSave: number;
  private judging = false;
  /** Every history write, one after another: a tick's save and the shutdown flush never interleave. */
  private saveChain: Promise<void> = Promise.resolve();
  private readonly log: (line: string) => void;

  constructor(private readonly deps: MachineWatchDeps) {
    this.lastSave = deps.now();
    this.log = deps.log ?? ((line) => console.warn(line));
  }

  /**
   * One sample for one machine, stamped with THIS bridge's clock (CREW_PROTOCOL.md §10.2).
   *
   * A sample equal in every field to the last one taken for that machine is skipped: not recorded,
   * and `sampledAt` does not move. It is the same reading served again. That is the ordinary case when
   * the lead sweeps faster than a member samples (the member serves the sample it holds), and the
   * only signature a member whose sampler hangs leaves: it keeps answering with its last sample, and
   * stamping that fresh on every sweep would draw a live, flat machine forever and let an alert judge
   * a minute nobody measured.
   *
   * A real reading that repeats another in every field is not expected. `cpu` and the network rates
   * are ratios of counters over the time between two reads, and memory is counted in bytes. The
   * likeliest real repeat is a machine pinned at 100 % CPU (`cpu` is exactly 1) on a host with no
   * network counters, whose memory also held still to the byte; skipping that one sample costs a
   * point, and the next one that differs records as usual.
   */
  observe(id: string, sample: MachineSample, at: number): void {
    if (!this.isActive()) return;
    const previous = this.latest.get(id);
    if (previous !== undefined && sameSample(previous.sample, sample)) return;
    this.latest.set(id, { sample, at });
    this.deps.history.record(id, sample, at);
  }

  /** A member that left the crew takes its last sample, its history and its alert rules with it. */
  forget(id: string): void {
    this.latest.delete(id);
    this.deps.history.drop(id);
    void this.deps.alerts
      .drop(id)
      .catch((err) => this.log(`[machines] could not save the alert rules: ${String(err)}`));
  }

  /**
   * The engine tick's share: judge the rules when a minute has closed, save the history when it is
   * due. Never throws and never awaits: the poll it rides must not wait on a file.
   */
  tick(): void {
    if (!this.isActive()) return;
    const now = this.deps.now();
    const minute = minuteOf(now);
    if (minute !== this.lastJudgedMinute && !this.judging) {
      this.lastJudgedMinute = minute;
      this.judge(now);
    }
    if (this.deps.history.dirty() && now - this.lastSave >= HISTORY_SAVE_EVERY_MS) void this.save(now);
  }

  /**
   * Save now, whatever the clock says, after any write already under way. The shutdown path; a store
   * with nothing new writes nothing. The alert store's pending write is waited for too.
   */
  async flush(): Promise<void> {
    if (this.deps.history.dirty()) void this.save(this.deps.now());
    await this.saveChain;
    await this.deps.alerts.settled();
  }

  /** `GET /api/machines`. */
  rows(): MachinesResponse {
    const now = this.deps.now();
    const machines = this.deps.roster().map((entry): MachineRow => {
      const row: MachineRow = {
        id: entry.id,
        name: entry.name,
        isLead: entry.isLead,
        health: entry.health,
        alerts: this.deps.alerts.rules(entry.id),
        firing: this.deps.alerts.open(entry.id),
      };
      // Assigned, never spread from undefined: an absent sample is an absent pair of keys.
      const last = this.latest.get(entry.id);
      if (last !== undefined) {
        row.sample = last.sample;
        row.sampledAt = last.at;
      }
      return row;
    });
    return { ts: now, machines };
  }

  /** `GET /api/machines/:id/history`, or `null` for a machine this collie does not answer for. */
  history(id: string): MachineHistoryResponse | null {
    if (!this.known(id)) return null;
    const now = this.deps.now();
    return { ts: now, stepMs: 60_000, points: this.deps.history.points(id, now) };
  }

  /** `POST /api/machines/:id/alerts`, or `null` for an unknown machine. Written before it answers. */
  async setAlerts(id: string, alerts: MachineAlerts): Promise<MachineAlerts | null> {
    if (!this.known(id)) return null;
    return this.deps.alerts.set(id, alerts);
  }

  /** The roster's entry for `id`, or `undefined` for a machine this collie does not answer for. */
  entry(id: string): MachineRosterEntry | undefined {
    return this.deps.roster().find((entry) => entry.id === id);
  }

  private known(id: string): boolean {
    return this.entry(id) !== undefined;
  }

  private judge(now: number): void {
    const subjects = this.deps.roster().map((entry) => ({
      id: entry.id,
      name: entry.name,
      reachable: entry.health === "reachable",
      rules: this.deps.alerts.rules(entry.id),
      open: this.deps.alerts.open(entry.id),
    }));
    const mayOpen = this.deps.enabled() && !this.deps.muted();
    const pass = evaluateMachineAlerts(
      subjects,
      (id, from) => this.deps.history.minutes(id, from, now),
      now,
      mayOpen,
    );
    if (pass.opened.length === 0 && pass.closed.length === 0) return;
    for (const opened of pass.opened) this.deps.send(machineAlertMessage(opened));
    // Recorded after the sends are handed over, and not awaited by the tick. `judging` holds the next
    // minute's pass until the episodes are on disk, so a slow write cannot make one episode push twice.
    this.judging = true;
    void this.deps.alerts
      .apply(pass)
      .catch((err) => this.log(`[machines] could not save the alert episodes: ${String(err)}`))
      .finally(() => {
        this.judging = false;
      });
  }

  private isActive(): boolean {
    return this.deps.active?.() ?? true;
  }

  /**
   * Prune to the roster and queue one history write behind the last. Never rejects: a failed write is
   * logged, and the chain goes on.
   */
  private save(now: number): Promise<void> {
    this.lastSave = now;
    const ids = new Set(this.deps.roster().map((entry) => entry.id));
    this.deps.history.retain(ids);
    void this.deps.alerts
      .retain(ids)
      .catch((err) => this.log(`[machines] could not save the alert rules: ${String(err)}`));
    this.deps.history.markSaved();
    const write = async (): Promise<void> => {
      try {
        await this.deps.saveHistory(this.deps.history, now);
      } catch (err) {
        this.log(`[machines] could not save the history: ${String(err)}`);
      }
    };
    this.saveChain = this.saveChain.then(write);
    return this.saveChain;
  }
}

/** Whether two samples say the same thing in every field, absent fields included. */
export function sameSample(a: MachineSample, b: MachineSample): boolean {
  return (
    a.cpu === b.cpu &&
    a.cores === b.cores &&
    a.memUsed === b.memUsed &&
    a.memTotal === b.memTotal &&
    a.load1 === b.load1 &&
    a.rxBps === b.rxBps &&
    a.txBps === b.txBps
  );
}
