import { join } from "node:path";
import type { DoctorRowSource } from "../bridge/report.ts";
import { parseHeldEntry, type HeldEntry } from "../bridge/surface/holds.ts";
import { parseSendRecord, type SendRecord } from "../bridge/surface/requests.ts";
import { parseJson } from "../web/src/lib/json.ts";
import { troubleStep } from "../web/src/lib/report/trouble.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";
import { REQUEST_ID, SEND_OUTCOMES, STALE_SCREEN, type HeldCause, type HeldState, type SendOutcome, type SendReceipt } from "../web/src/lib/surface/send.ts";
import type { CliContext } from "./context.ts";
import { bad, ok, warn, type Finding } from "./finding.ts";
import type { Files } from "./sys.ts";

// ── Whether sends reach each harness (M71 spec 01) ───────────────────────────
//
// One `sends-<harness>` row per harness: the outcomes of its recent sends, read from the receipts the
// bridge keeps in `<stateDir>/sends/<request id>.json` (bridge/surface/requests.ts). The receipts are
// per send and in order, and each names the harness, the outcome and the reason, which the day
// counters behind the `surface-*` rows cannot give.
//
// It is a READ. It lists the folder and reads the files through the `Files` seam, and never builds a
// `RequestStore`: that constructor creates the folder and its salt, and `collie doctor` writes
// nothing (scripts/collie-cli.test.sh holds it to that). A missing folder is no receipts.
//
// "Points at Collie" is ADR 0123's table, reached through `troubleStep` (web/src/lib/report/trouble.ts),
// the same rule that offers Report a problem on the phone. This module keeps no list of reasons.
//
// Spec 02 adds two row kinds over the same window and the same read-only seam: `holds-<harness>` (the
// held sends still open, read from `<stateDir>/held/*.json`) and `screen-<harness>` (how often a send met
// a screen it could not type into). The held files hold the person's TEXT in plain form, because the
// bridge must type it later. Nothing here prints it, its length or any part of it.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The newest receipts per harness the rules read. */
export const SENDS_WINDOW_COUNT = 50;
/** The oldest receipt the rules read. The window is the smaller of this and {@link SENDS_WINDOW_COUNT}. */
export const SENDS_WINDOW_MS = 7 * DAY_MS;
/** Received sends with none succeeded at or above which a row is an error. */
export const SENDS_ERROR_MIN = 10;
/** Received sends with none succeeded at or above which a row warns. */
export const SENDS_NONE_WARN_MIN = 3;
/** Received sends at or above which the lost rate counts. */
export const SENDS_LOST_WARN_MIN = 5;
/** The share of received sends lost (`unknown` or `typed_not_submitted` that count) at which a row warns. */
export const SENDS_LOST_WARN_RATE = 0.3;

/** The group of a receipt with an empty harness, as the `surface-*` rows name it. */
const NO_HARNESS = "-";
/**
 * The `-` group is informational only: its `sends--`, `holds--` and `screen--` rows always print `ok`
 * with their counts, and no warn or error rule reads it. A receipt with no harness comes from a shell
 * pane, and a shell has no agent to confirm a submit, so its outcomes (mostly `unknown`) say nothing
 * about whether sends reach a harness.
 */
const informational = (harness: string): boolean => harness === NO_HARNESS;
/** Outcomes that are the person's own choice: the send never asked the harness for anything. */
const NOT_RECEIVED: ReadonlySet<SendOutcome> = new Set(["discarded", "cancelled"]);
const SUCCEEDED: ReadonlySet<SendOutcome> = new Set(["sent", "effective", "steered"]);
const LOST: ReadonlySet<SendOutcome> = new Set(["unknown", "typed_not_submitted"]);

const REMEDY =
  "open the pane on the phone, tap Report a problem in the pane menu, and paste `collie doctor --json` into the issue";

/** A finding for one harness's sends. The extra fields are what a script reads from `--json`. */
export interface SendsFinding extends Finding {
  /** The harness as the receipts name it, or `-` for a receipt with none. */
  readonly harness: string;
  /** `count`: the receipts in this harness's window; `days`: the window's age limit. */
  readonly window: { readonly count: number; readonly days: number };
  /** Receipts in the window by outcome. An outcome with none is left out. */
  readonly counts: Partial<Record<SendOutcome, number>>;
}

/** What this section reaches: the state dir, one directory listing and file reads, and the clock. */
export interface SendsDeps {
  readonly ctx: Pick<CliContext, "stateDir">;
  readonly files: Pick<Files, "list" | "read">;
  readonly now: () => number;
}

/** Every send record in `<stateDir>/sends/`, unsorted. Ask answers, temp files and files that do not parse are skipped. */
export function readSendRecords(deps: Pick<SendsDeps, "ctx" | "files">): SendRecord[] {
  const dir = join(deps.ctx.stateDir, "sends");
  const out: SendRecord[] = [];
  for (const name of deps.files.list(dir)) {
    if (name.startsWith("ask.") || !name.endsWith(".json")) continue;
    if (!REQUEST_ID.test(name.slice(0, -".json".length))) continue;
    const text = deps.files.read(join(dir, name));
    const record = text === null ? null : parseSendRecord(parseJson(text));
    if (record !== null) out.push(record);
  }
  return out;
}

/** A record that has a receipt (settled or held), with it. One still in flight has none and is left out. */
type Receipted = SendRecord & { readonly receipt: SendReceipt };

const hasReceipt = (record: SendRecord): record is Receipted => record.receipt !== undefined;
const harnessOf = (record: Receipted): string => (record.receipt.harness === "" ? NO_HARNESS : record.receipt.harness);

/** The bridge asked the harness for something and the send ended. A held send has not ended yet. */
const received = (record: Receipted): boolean => record.phase === "settled" && !NOT_RECEIVED.has(record.receipt.outcome);

/** Lost: the text may be in the box or Collie lost track, and ADR 0123's table says that points at Collie. */
function lost(record: Receipted): boolean {
  const { outcome, reason, cap } = record.receipt;
  return LOST.has(outcome) && troubleStep({ outcome, reason: reason ?? null, cap: cap !== undefined }) === "count";
}

/** A row's outcome counts, and the words the detail prints for them. */
interface Counted {
  readonly counts: Partial<Record<SendOutcome, number>>;
  readonly words: readonly string[];
}

/** The words of a row's counts, for example `12 sent · 3 unknown (no_evidence 2, crash 1)`: most frequent first, ties in `SEND_OUTCOMES` order. */
function countWords(records: readonly Receipted[]): Counted {
  const counts: Partial<Record<SendOutcome, number>> = {};
  const reasons = new Map<SendOutcome, Map<string, number>>();
  for (const { receipt } of records) {
    counts[receipt.outcome] = (counts[receipt.outcome] ?? 0) + 1;
    if (receipt.reason === undefined) continue;
    const byReason = reasons.get(receipt.outcome) ?? new Map<string, number>();
    byReason.set(receipt.reason, (byReason.get(receipt.reason) ?? 0) + 1);
    reasons.set(receipt.outcome, byReason);
  }
  const order = SEND_OUTCOMES.filter((outcome) => (counts[outcome] ?? 0) > 0).toSorted((a, b) => counts[b]! - counts[a]!);
  const words = order.map((outcome) => {
    const byReason = [...(reasons.get(outcome) ?? new Map<string, number>())].toSorted(([, a], [, b]) => b - a);
    const why = byReason.length === 0 ? "" : ` (${byReason.map(([reason, n]) => `${reason} ${String(n)}`).join(", ")})`;
    return `${String(counts[outcome])} ${outcome}${why}`;
  });
  return { counts: Object.fromEntries(order.map((outcome) => [outcome, counts[outcome]!])), words };
}

/** One harness's row from the receipts in its window, newest first. */
function row(harness: string, records: readonly Receipted[], capped: boolean): SendsFinding {
  const check = `sends-${harness}`;
  const days = SENDS_WINDOW_MS / DAY_MS;
  const window = { count: records.length, days };
  if (records.length === 0) return { ...ok(check, `no sends in the last ${String(days)} days`), harness, window, counts: {} };
  const { counts, words } = countWords(records);
  const detail = [...words, capped ? `last ${String(SENDS_WINDOW_COUNT)}` : `last ${String(days)} days`].join(" · ");
  const base = { harness, window, counts };
  if (informational(harness)) return { ...ok(check, detail), ...base };
  const got = records.filter(received);
  const n = got.length;
  const none = n > 0 && !got.some((record) => SUCCEEDED.has(record.receipt.outcome));
  // (c), then (a), then (b): the first rule that holds decides.
  if (none && n >= SENDS_ERROR_MIN) return { ...bad(check, detail, `none of the last ${String(n)} sends to ${harness} went through; ${REMEDY}`), ...base };
  if (none && n >= SENDS_NONE_WARN_MIN) return { ...warn(check, detail, `none of the last ${String(n)} sends to ${harness} went through; ${REMEDY}`), ...base };
  const gone = got.filter(lost).length;
  if (n >= SENDS_LOST_WARN_MIN && gone / n >= SENDS_LOST_WARN_RATE) {
    const remedy = `${String(gone)} of the last ${String(n)} sends to ${harness} ended unknown or typed but not submitted; ${REMEDY}`;
    return { ...warn(check, detail, remedy), ...base };
  }
  return { ...ok(check, detail), ...base };
}

/** Receipts of one harness, newest first, and whether the window was cut at {@link SENDS_WINDOW_COUNT}. */
interface Window {
  readonly harness: string;
  readonly records: readonly Receipted[];
  readonly capped: boolean;
}

/** Every harness's window: one per harness with a profile, in the order of the profile files, then one per other harness a receipt names, by name. */
function windowsOf(deps: SendsDeps): Window[] {
  const since = deps.now() - SENDS_WINDOW_MS;
  const recent = readSendRecords(deps)
    .filter(hasReceipt)
    .filter((record) => record.acceptedAt >= since)
    .toSorted((a, b) => b.acceptedAt - a.acceptedAt);
  const byHarness = new Map<string, Receipted[]>();
  for (const record of recent) {
    const group = byHarness.get(harnessOf(record));
    if (group === undefined) byHarness.set(harnessOf(record), [record]);
    else group.push(record);
  }
  return harnessOrder(byHarness.keys()).map((harness) => {
    const all = byHarness.get(harness) ?? [];
    return { harness, records: all.slice(0, SENDS_WINDOW_COUNT), capped: all.length > SENDS_WINDOW_COUNT };
  });
}

/** The harnesses with a profile in the order of the profile files, then the others the data names, by name. */
function harnessOrder(named: Iterable<string>): string[] {
  const profiled = [...loadProfiles().keys()];
  const others = [...new Set(named)].filter((harness) => !profiled.includes(harness)).toSorted();
  return [...profiled, ...others];
}

/**
 * The sends table: one row per harness with a profile, in the order of the profile files, then one per
 * other harness a receipt names, by name. A harness with no receipt in its window is one `ok` row.
 */
export function sendFindings(deps: SendsDeps): SendsFinding[] {
  return windowsOf(deps).map(({ harness, records, capped }) => row(harness, records, capped));
}

// ── Holds and screen rows (M71 spec 02) ──────────────────────────────────────

/** Age at which an open hold warns: past this the person has had time to look at it. */
export const HOLD_WARN_MS = 10 * 60 * 1000;
/** `probe_failed` receipts in a row, with no other receipt of the harness between, at which a screen row warns. */
export const PROBE_RUN_WARN = 3;

/**
 * The phone's words for what holds a send (`heldKey` in web/src/components/composer-held.tsx). A new
 * {@link HeldCause} fails `tsc` here until it has words.
 */
export const HELD_CAUSE_WORDS = {
  turn_running: "a running turn",
  not_free: "something open at the box",
  bound: "something open at the box",
  draft_present: "a draft in the box",
  probe_failed: "something open at the box",
} as const satisfies Record<HeldCause, string>;

/** The words for a hold with this cause: no cause is a running turn, as on the phone. */
export function heldCauseWords(cause: HeldCause | undefined, versionUnread: boolean): string {
  const words = HELD_CAUSE_WORDS[cause ?? "turn_running"];
  return versionUnread ? `${words}, version unread` : words;
}

/** One open hold as `--json` carries it. No text, no length. */
export interface HoldJson {
  readonly requestId: string;
  readonly cause: HeldCause | null;
  readonly ageMs: number;
  readonly state: HeldState;
}

/** A finding for the held sends of one harness, or the one `ok` row when none is open. */
export interface HoldsFinding extends Finding {
  /** The harness as the entries name it. Absent on the one row that says no hold is open. */
  readonly harness?: string;
  /** The open holds, oldest first. */
  readonly holds: readonly HoldJson[];
}

const HOLDS_REMEDY =
  "open the pane on the phone, read the held row, and send or cancel it";
const HOLDS_BOX_REMEDY =
  "; if it keeps saying something is open at the box, tap Report a problem in the pane menu and paste `collie doctor --json` into the issue";

/** Every held entry in `<stateDir>/held/` that is open (state `held` or `running`), unsorted. `.tmp` leftovers and files that do not parse are skipped. */
export function readOpenHolds(deps: Pick<SendsDeps, "ctx" | "files">): HeldEntry[] {
  const dir = join(deps.ctx.stateDir, "held");
  const out: HeldEntry[] = [];
  for (const name of deps.files.list(dir)) {
    if (!name.endsWith(".json")) continue;
    const stem = name.slice(0, -".json".length);
    if (!REQUEST_ID.test(stem)) continue;
    const text = deps.files.read(join(dir, name));
    const entry = text === null ? null : parseHeldEntry(parseJson(text));
    if (entry !== null && entry.id === stem && entry.state !== "ended") out.push(entry);
  }
  return out;
}

/** `held 14 min for a running turn (req-a1b2c3d4)`, `, command` after the cause words for a command. */
function holdWords(entry: HeldEntry, ageMs: number): string {
  const minutes = String(Math.max(0, Math.floor(ageMs / 60_000)));
  const mode = entry.mode === "command" ? ", command" : "";
  return `held ${minutes} min for ${heldCauseWords(entry.cause, entry.versionUnread === true)}${mode} (${entry.id})`;
}

const NO_HOLDS: HoldsFinding = { ...ok("holds", "no held sends open"), holds: [] };

/**
 * The holds table: one row per harness with at least one open hold, in the order of the profile files and
 * then by name, each hold oldest first. No open hold at all is one `ok` row.
 */
export function holdFindings(deps: Pick<SendsDeps, "ctx" | "files" | "now">): HoldsFinding[] {
  const now = deps.now();
  const byHarness = new Map<string, HeldEntry[]>();
  for (const entry of readOpenHolds(deps)) {
    const harness = entry.harness === "" ? NO_HARNESS : entry.harness;
    const group = byHarness.get(harness);
    if (group === undefined) byHarness.set(harness, [entry]);
    else group.push(entry);
  }
  if (byHarness.size === 0) return [NO_HOLDS];
  return harnessOrder(byHarness.keys())
    .filter((harness) => byHarness.has(harness))
    .map((harness) => holdRow(harness, byHarness.get(harness)!, now));
}

/** One harness's holds row from its open holds. */
function holdRow(harness: string, open: readonly HeldEntry[], now: number): HoldsFinding {
  const entries = open.toSorted((a, b) => a.heldAt - b.heldAt || a.seq - b.seq);
  const holds = entries.map((entry): HoldJson => ({ requestId: entry.id, cause: entry.cause ?? null, ageMs: Math.max(0, now - entry.heldAt), state: entry.state }));
  const check = `holds-${harness}`;
  const detail = entries.map((entry, n) => holdWords(entry, holds[n]!.ageMs)).join(" · ");
  if (informational(harness)) return { ...ok(check, detail), harness, holds };
  if (!holds.some((hold) => hold.ageMs > HOLD_WARN_MS)) return { ...ok(check, detail), harness, holds };
  const atBox = entries.some((entry) => HELD_CAUSE_WORDS[entry.cause ?? "turn_running"] === HELD_CAUSE_WORDS.not_free);
  return { ...warn(check, detail, HOLDS_REMEDY + (atBox ? HOLDS_BOX_REMEDY : "")), harness, holds };
}

/** A finding for how often sends to one harness met a screen it could not type into. */
export interface ScreenFinding extends Finding {
  readonly harness: string;
}

const SCREEN_REMEDY =
  "focus the pane on the desktop or resize it so the screen redraws, then send again; if it keeps happening, tap Report a problem in the pane menu and paste `collie doctor --json` into the issue";

/** A screen row's detail when no send met a screen it could not type into. */
const SCREEN_CLEAN = "no stale screen, no probe failure";

const isProbeFailed = (record: Receipted): boolean => record.receipt.outcome === "refused" && record.receipt.reason === "probe_failed";
const isStale = (record: Receipted): boolean => isProbeFailed(record) && (record.receipt.detail ?? "").startsWith(STALE_SCREEN);

/** The longest run of `probe_failed` receipts with no other receipt between, by `acceptedAt`. */
function longestProbeRun(records: readonly Receipted[]): number {
  let longest = 0;
  let run = 0;
  for (const record of records.toSorted((a, b) => a.acceptedAt - b.acceptedAt)) {
    run = isProbeFailed(record) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** One screen row per harness with a receipt in its sends window (the same window as the `sends-*` rows). */
export function screenFindings(deps: SendsDeps): ScreenFinding[] {
  return windowsOf(deps).filter(({ records }) => records.length > 0).map(({ harness, records }) => screenRow(harness, records));
}

function screenRow(harness: string, records: readonly Receipted[]): ScreenFinding {
  const check = `screen-${harness}`;
  const stale = records.filter(isStale).length;
  const other = records.filter(isProbeFailed).length - stale;
  const run = longestProbeRun(records);
  if (stale + other === 0) return { ...ok(check, SCREEN_CLEAN), harness };
  const detail = `stale screen ${String(stale)} · probe failed ${String(other)} · longest run ${String(run)}`;
  if (run < PROBE_RUN_WARN || informational(harness)) return { ...ok(check, detail), harness };
  return { ...warn(check, detail, `${String(run)} sends to ${harness} in a row met a screen Collie could not type into; ${SCREEN_REMEDY}`), harness };
}

/** A row of the sends section. */
export type SendsSectionFinding = SendsFinding | HoldsFinding | ScreenFinding;

/** The whole sends section in print order: `sends-*`, then `holds-*`, then `screen-*`. The receipts are read once. */
export function sendsSection(deps: SendsDeps): SendsSectionFinding[] {
  const windows = windowsOf(deps);
  return [
    ...windows.map(({ harness, records, capped }) => row(harness, records, capped)),
    ...holdFindings(deps),
    ...windows.filter(({ records }) => records.length > 0).map(({ harness, records }) => screenRow(harness, records)),
  ];
}

// ── The rows Report a problem carries (M71 spec 05) ──────────────────────────

/** Whether a row says only "nothing here": no sends in its window, no hold open, no stale screen. */
function quiet(finding: SendsSectionFinding): boolean {
  if ("window" in finding) return finding.window.count === 0;
  if ("holds" in finding) return finding.holds.length === 0;
  return finding.status === "ok" && finding.detail === SCREEN_CLEAN;
}

/**
 * The sends section as the bridge's report route takes it (bridge/report.ts): the same rows doctor
 * prints, in its order, as check, status, detail and harness, and whether each says only "nothing
 * here". No remedy, and no field of a hold: the route picks from these and copies them field by field.
 */
export function sendsReportRows(deps: SendsDeps): DoctorRowSource[] {
  return sendsSection(deps).map((finding) => ({
    check: finding.check,
    status: finding.status,
    detail: finding.detail,
    harness: finding.harness ?? null,
    quiet: quiet(finding),
  }));
}
