// `--record`: write a canary-verified agent version into the ledger of spec M37/01.
//
// The ledger is `web/src/lib/harness/verified-versions.json`, shaped
// `{ "agents": { "<agent>": { "version", "verified", "how", "adapter", "evidence", "journal"? } } }`,
// where the top level is the SCREEN reader's line and `journal` is the journal reader's (M41/05). This
// module reads it by that documented shape and rewrites only the one entry it was asked to, so the
// other entries, their order and every field it does not own stay as they were. It never creates
// the file: a missing ledger is spec 01's to add, not the canary's.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { asJsonBoolean, asJsonObject, parseJson, type JsonObject } from "../../web/src/lib/json";

export const LEDGER_FILE = new URL("../../web/src/lib/harness/verified-versions.json", import.meta.url).pathname;

/** The JOURNAL reader's half of one entry: the same three facts about the other reader. */
export interface JournalRecord {
  readonly version: string;
  readonly verified: string;
  readonly evidence: string;
}

export interface LedgerRecord {
  readonly agent: string;
  /** Plain x.y.z, as the agent's `--version` printed it. */
  readonly version: string;
  /** ISO date, YYYY-MM-DD. */
  readonly verified: string;
  /** Whether Collie has an adapter for the agent; kept from the entry when it already has one. */
  readonly adapter: boolean;
  /** Where the proof is: the canary run id and what passed. */
  readonly evidence: string;
  /**
   * What the `journal` scenario proved about the OTHER reader (spec M41/05), when it ran.
   *
   * Beside the screen reader's line rather than replacing it, because the two drift apart on one
   * agent version: a vendor can change what it paints without changing what it writes, and either
   * half can be the one that broke. Absent leaves the entry's existing journal block untouched.
   */
  journal?: JournalRecord;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The ledger text with `rec` written in. Pure: the file I/O is {@link recordVerified}. */
export function withRecord(text: string, rec: LedgerRecord): string {
  if (!VERSION.test(rec.version)) throw new Error(`ledger: "${rec.version}" is not a plain x.y.z version`);
  if (!DATE.test(rec.verified)) throw new Error(`ledger: "${rec.verified}" is not an ISO date`);
  const doc = asJsonObject(parseJson(text));
  const agents = asJsonObject(doc?.agents);
  if (doc === undefined || agents === undefined) throw new Error("ledger: expected { \"agents\": { ... } }");
  const before = asJsonObject(agents[rec.agent]);
  const entry: JsonObject = {
    ...before,
    version: rec.version,
    verified: rec.verified,
    how: "canary",
    adapter: asJsonBoolean(before?.adapter) ?? rec.adapter,
    evidence: rec.evidence,
  };
  // Written only where the entry ALREADY has a journal block, which is this build's way of saying
  // the agent has a journal adapter at all (`verified-versions.test.ts` pins that both ways). A
  // block is added by hand, never by a run: the canary refreshes facts, it does not decide which
  // readers an agent has.
  const journal = asJsonObject(before?.journal);
  if (rec.journal !== undefined && journal !== undefined) {
    if (!VERSION.test(rec.journal.version)) throw new Error(`ledger: "${rec.journal.version}" is not a plain x.y.z version`);
    if (!DATE.test(rec.journal.verified)) throw new Error(`ledger: "${rec.journal.verified}" is not an ISO date`);
    entry.journal = {
      ...journal,
      version: rec.journal.version,
      verified: rec.journal.verified,
      how: "canary",
      evidence: rec.journal.evidence,
    };
  }
  const next: JsonObject = { ...doc, agents: { ...agents, [rec.agent]: entry } };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** Rewrite the ledger file in place. Throws when it does not exist yet. */
export function recordVerified(rec: LedgerRecord, path = LEDGER_FILE): void {
  if (!existsSync(path)) throw new Error(`ledger: ${path} does not exist (spec M37/01 adds it); nothing recorded`);
  writeFileSync(path, withRecord(readFileSync(path, "utf8"), rec));
}
