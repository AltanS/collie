// When a machine's load earns a push: one rule per metric per machine, judged on minute buckets.
//
// ── THE JUDGEMENT IS PURE ─────────────────────────────────────────────────────
// {@link judgeAlert} and {@link evaluateMachineAlerts} take the minutes, the rules, the open episodes
// and a clock reading, and return what opened and what closed. No timer, no file, no push: the owner
// (`bridge/machines.ts`) calls them from the engine tick once a minute and does the sending and the
// saving. The cache warning set this shape (`bridge/cache/warn.ts`, ADR 0042) and the reason is the
// same: `bun test` drives every rule below as data.
//
// ── FOUR RULES ───────────────────────────────────────────────────────────────
// 1. A rule FIRES when every complete minute in its last `forMin` that has data is at or above
//    `above`, and at least 80 % of those minutes have data. CPU is judged on the minute's average,
//    so one busy second does not count as a busy minute. Disk is judged on the fullest filesystem's
//    fraction, and a minute without a disk reading is a minute without data. The open minute is never judged: it is
//    still filling.
// 2. ONE PUSH PER EPISODE. A fired rule opens an episode, and nothing more is sent until it closes.
// 3. An episode CLOSES after five straight complete minutes, each with data, below `above - 0.05`.
//    The gap is hysteresis: a value hovering at the threshold must not open and close an episode
//    every few minutes, which would be a push every few minutes.
// 4. An UNREACHABLE machine neither fires nor closes. Its minutes are missing, and missing is not
//    low: an episode on a machine that dropped off the network is still open when it comes back.
//
// Open episodes are persisted with the rules, so a restart in the middle of one does not push again.

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "./json.ts";
import { MINUTE_MS, minuteOf, type MinuteReading } from "./machine-history.ts";
import { coerceAlertsFile, type StoredMachineAlerts } from "./machine-parse.ts";
import { pushTitle } from "./push-titles.ts";
import { machineTopic, type PushMessage } from "./push.ts";
import type { AlertMetric, AlertRule, MachineAlerts } from "./types.ts";

/** The file in the state folder. Named here so `solo-baseline.test.ts`'s scan can read it. */
export const MACHINE_ALERTS_FILE = "machine-alerts.json";

/** At least this share of a rule's window must have data before it may fire. */
export const ALERT_COVERAGE = 0.8;
/** Straight minutes below the line that close an episode. */
export const ALERT_CLOSE_MINUTES = 5;
/** How far below `above` a minute must be to count towards closing. */
export const ALERT_HYSTERESIS = 0.05;

const METRICS: readonly AlertMetric[] = ["cpu", "mem", "disk"];

/** What one rule says about one machine right now. */
export type AlertVerdict =
  | { readonly kind: "fire"; readonly value: number }
  | { readonly kind: "close" }
  | { readonly kind: "hold" };

const HOLD: AlertVerdict = { kind: "hold" };

/** The value a rule reads off a minute, `null` where the minute has none (disk only). */
function valueOf(metric: AlertMetric, minute: MinuteReading): number | null {
  if (metric === "cpu") return minute.cpu;
  if (metric === "mem") return minute.mem;
  return minute.disk;
}

/** The complete minutes in `[open - count, open)`, where `open` is the minute `now` falls in. */
function windowOf(minutes: readonly MinuteReading[], count: number, now: number): MinuteReading[] {
  const open = minuteOf(now);
  const from = open - count * MINUTE_MS;
  return minutes.filter((m) => m.t >= from && m.t < open);
}

/**
 * One rule against one machine's minutes. `minutes` must reach back at least
 * `max(rule.forMin, ALERT_CLOSE_MINUTES)` complete minutes; anything older is ignored.
 */
export function judgeAlert(
  metric: AlertMetric,
  rule: AlertRule,
  open: boolean,
  minutes: readonly MinuteReading[],
  now: number,
): AlertVerdict {
  // A minute with no value for this metric (a disk not reported) is a missing minute, exactly like a
  // minute with no reading at all.
  const valued = (count: number): number[] =>
    windowOf(minutes, count, now).flatMap((m) => {
      const v = valueOf(metric, m);
      return v === null ? [] : [v];
    });
  if (open) {
    const recent = valued(ALERT_CLOSE_MINUTES);
    if (recent.length < ALERT_CLOSE_MINUTES) return HOLD;
    const line = rule.above - ALERT_HYSTERESIS;
    return recent.every((v) => v < line) ? { kind: "close" } : HOLD;
  }
  const window = valued(rule.forMin);
  if (window.length < rule.forMin * ALERT_COVERAGE) return HOLD;
  if (!window.every((v) => v >= rule.above)) return HOLD;
  const value = window.reduce((sum, v) => sum + v, 0) / window.length;
  return { kind: "fire", value };
}

/** One machine as the evaluator sees it. */
export interface AlertSubject {
  readonly id: string;
  readonly name: string;
  readonly reachable: boolean;
  readonly rules: MachineAlerts;
  readonly open: readonly AlertMetric[];
}

/** An episode that opened on this pass, with what the push says about it. */
export interface AlertOpened {
  readonly id: string;
  readonly name: string;
  readonly metric: AlertMetric;
  readonly rule: AlertRule;
  readonly value: number;
}

export interface AlertPass {
  readonly opened: AlertOpened[];
  readonly closed: { readonly id: string; readonly metric: AlertMetric }[];
}

/**
 * Judge every rule of every machine. `mayOpen` is false while the bridge is snoozed or the operator
 * turned machine alerts off: nothing opens then, so nothing is recorded either, and a high value that
 * outlasts the snooze still pushes once it ends. Closing runs either way, because it sends nothing.
 */
export function evaluateMachineAlerts(
  subjects: readonly AlertSubject[],
  minutesOf: (id: string, from: number) => readonly MinuteReading[],
  now: number,
  mayOpen: boolean,
): AlertPass {
  const opened: AlertOpened[] = [];
  const closed: { id: string; metric: AlertMetric }[] = [];
  for (const subject of subjects) {
    if (!subject.reachable) continue;
    const reach = Math.max(ALERT_CLOSE_MINUTES, ...METRICS.map((m) => subject.rules[m]?.forMin ?? 0));
    const minutes = minutesOf(subject.id, minuteOf(now) - reach * MINUTE_MS);
    for (const metric of METRICS) {
      const rule = subject.rules[metric];
      if (rule === undefined) continue;
      const isOpen = subject.open.includes(metric);
      if (!isOpen && !mayOpen) continue;
      const verdict = judgeAlert(metric, rule, isOpen, minutes, now);
      if (verdict.kind === "fire") opened.push({ id: subject.id, name: subject.name, metric, rule, value: verdict.value });
      else if (verdict.kind === "close") closed.push({ id: subject.id, metric });
    }
  }
  return { opened, closed };
}

const percent = (fraction: number): number => Math.round(fraction * 100);

/**
 * The push for one opened episode. The title is a catalogue code (ADR 0074), so the phone says it in
 * its own language; the body stays English like every push body and names the machine, the metric,
 * the value and the minutes.
 *
 * One tag per machine and metric, with `renotify`: the next episode on the same machine replaces this
 * one on a platform that collapses by tag, and still alerts. One collapse topic per machine and metric
 * too ({@link machineTopic}), so the push service keeps one queued alert of each instead of one in all.
 * `machine` and `target` are what a tap reads (`web/src/lib/push-decision.ts`), and `machine` is set
 * for the lead's own machine too, because the page it opens is addressed by machine id. There is no
 * `host`: an old service worker would open `/?h=<id>` with it, broken on a solo Collie (`local`), and
 * without it opens the dashboard.
 */
export function machineAlertMessage(opened: AlertOpened, mount?: string): PushMessage {
  const label = opened.metric === "cpu" ? "CPU" : opened.metric === "mem" ? "memory" : mount === undefined ? "disk" : `disk ${mount}`;
  const code = opened.metric === "cpu" ? "machine.cpu" : opened.metric === "mem" ? "machine.mem" : "machine.disk";
  return {
    type: "machine",
    tag: `collie:machine:${opened.id}:${opened.metric}`,
    ...pushTitle(code, { machine: opened.name }),
    body: `${opened.name}: ${label} ${percent(opened.value)}% for ${opened.rule.forMin} min (alert at ${percent(opened.rule.above)}%).`,
    machine: opened.id,
    target: "machine",
    topic: machineTopic(opened.id, opened.metric),
    renotify: true,
  };
}

/**
 * The rules and the open episodes, per machine, on disk in `machine-alerts.json`.
 *
 * Written on a change only: a rule set from the phone, an episode opening, an episode closing. A
 * bridge nobody gave a rule never writes the file, and the evaluator then has nothing to judge.
 */
export class MachineAlertStore {
  private readonly file: string;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateDir: string,
    private readonly entries: Map<string, StoredMachineAlerts> = new Map(),
  ) {
    this.file = join(this.stateDir, MACHINE_ALERTS_FILE);
  }

  /** The store as the file holds it. A missing or unreadable file is no rule at all. */
  static async load(stateDir: string): Promise<MachineAlertStore> {
    let raw: JsonValue | undefined;
    try {
      raw = await Bun.file(join(stateDir, MACHINE_ALERTS_FILE)).json();
    } catch {
      raw = undefined;
    }
    return new MachineAlertStore(stateDir, coerceAlertsFile(raw));
  }

  rules(id: string): MachineAlerts {
    const rules = this.entries.get(id)?.rules;
    return rules === undefined ? {} : { ...rules };
  }

  open(id: string): AlertMetric[] {
    return [...(this.entries.get(id)?.open ?? [])];
  }

  /**
   * Replace one machine's rules. An episode stays open only while its metric still has a rule: a
   * removed rule has nothing left that could close it.
   */
  async set(id: string, rules: MachineAlerts): Promise<MachineAlerts> {
    const open = this.open(id).filter((m) => rules[m] !== undefined);
    if (METRICS.every((m) => rules[m] === undefined)) this.entries.delete(id);
    else this.entries.set(id, { rules: { ...rules }, open });
    await this.save();
    return this.rules(id);
  }

  /** Record what one evaluator pass opened and closed. Writes only when something did. */
  async apply(pass: AlertPass): Promise<void> {
    if (pass.opened.length === 0 && pass.closed.length === 0) return;
    for (const { id, metric } of pass.opened) this.mark(id, metric, true);
    for (const { id, metric } of pass.closed) this.mark(id, metric, false);
    await this.save();
  }

  /**
   * Forget one machine's rules and open episodes: a member that left the crew takes them with it.
   * Writes only when it held any.
   */
  async drop(id: string): Promise<void> {
    if (!this.entries.delete(id)) return;
    await this.save();
  }

  /** Keep only the machines in `ids`. A member removed while this bridge was down goes here. */
  async retain(ids: ReadonlySet<string>): Promise<void> {
    let changed = false;
    // Deleting the entry being visited is safe in a Map iteration; the walk skips nothing.
    for (const id of this.entries.keys()) {
      if (ids.has(id)) continue;
      this.entries.delete(id);
      changed = true;
    }
    if (changed) await this.save();
  }

  /** Resolves when every write handed to the chain so far is done. The shutdown path awaits it. */
  settled(): Promise<void> {
    return this.saveChain;
  }

  private mark(id: string, metric: AlertMetric, open: boolean): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    const rest = entry.open.filter((m) => m !== metric);
    this.entries.set(id, { rules: entry.rules, open: open ? [...rest, metric] : rest });
  }

  /** Atomic, owner-only, and one write at a time: a fresh 0600 temp file renamed over the target. */
  private save(): Promise<void> {
    const machines: Record<string, StoredMachineAlerts> = {};
    for (const [id, entry] of this.entries) machines[id] = { rules: entry.rules, open: [...entry.open] };
    const data = JSON.stringify({ version: 1, machines }, null, 2);
    const write = async () => {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, this.file);
    };
    const run = this.saveChain.then(write, write);
    this.saveChain = run.catch(() => {});
    return run;
  }
}
