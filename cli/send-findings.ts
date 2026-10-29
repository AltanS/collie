import { join } from "node:path";
import { parseSendRecord, type SendRecord } from "../bridge/surface/requests.ts";
import { parseJson } from "../web/src/lib/json.ts";
import { troubleStep } from "../web/src/lib/report/trouble.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";
import { REQUEST_ID, SEND_OUTCOMES, type SendOutcome, type SendReceipt } from "../web/src/lib/surface/send.ts";
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

/** `12 sent · 3 unknown (no_evidence 2, crash 1)`: most frequent first, ties in `SEND_OUTCOMES` order. */
/** A row's outcome counts, and the words the detail prints for them. */
interface Counted {
  readonly counts: Partial<Record<SendOutcome, number>>;
  readonly words: readonly string[];
}

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

/**
 * The sends table: one row per harness with a profile, in the order of the profile files, then one per
 * other harness a receipt names, by name. A harness with no receipt in its window is one `ok` row.
 */
export function sendFindings(deps: SendsDeps): SendsFinding[] {
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
  const profiled = [...loadProfiles().keys()];
  const others = [...byHarness.keys()].filter((harness) => !profiled.includes(harness)).toSorted();
  return [...profiled, ...others].map((harness) => {
    const all = byHarness.get(harness) ?? [];
    return row(harness, all.slice(0, SENDS_WINDOW_COUNT), all.length > SENDS_WINDOW_COUNT);
  });
}
