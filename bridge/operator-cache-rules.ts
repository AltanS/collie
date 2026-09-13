import type { CacheOverride } from "./cache/engine.ts";
import { cacheRuleById } from "./cache/rules/index.ts";
import type { JsonObject } from "./json.ts";
import { createOperatorFileReader, diskIo, type OperatorFileIo } from "./operator-file.ts";

// The operator's own `cache-rules.toml`, read from next to their `.env` — the sixth file on the
// contract `commands.toml`, `keys.toml`, `quick-replies.toml`, `theme.toml` and `launchers.toml`
// already share, down to the mtime-checked live reload (operator-file.ts owns both).
//
// WHAT IT IS FOR. A vendor can move a cache lifetime in a blog post, and the shipped rule is then a
// confidently wrong number until somebody re-reads the page and cuts a release. This file is the lever
// in between: it moves ONE rule id, and nothing else.
//
// WHY IT MUST CARRY PROVENANCE. An override without `source_url` and `retrieved` is rejected, not
// defaulted. The whole point of the rule catalog is that no number exists in this tree without a page
// and a date behind it (ADR 0041); an operator may move a number, they may not remove its provenance.
// The rejected row is dropped on its own and `collie doctor`'s `cache-rules` finding names it, so a
// typo costs one rule rather than the file.
//
// WHY A FILE RATHER THAN AN ENVIRONMENT VARIABLE. Two reasons, and only the first is the one
// `commands.toml` gives. (1) `.env` is dual-parsed — bash sources it, systemd reads it as an
// EnvironmentFile — and a url with its own quoting would be wounded by that. (2) The bridge is a
// `systemd --user` unit, so its environment is not the agent's: an operator who set
// `ENABLE_PROMPT_CACHING_1H` in their shell profile has told the agent something the bridge cannot
// read. This file is where they tell the bridge. `collie doctor`'s `cache-env` finding is the nudge.
//
// ```toml
// [[rule]]
// id = "claude.api"
// ttl_seconds = 3600
// source_url = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching"
// retrieved = "2026-09-12"
// note = "our gateway sends ttl 1h on every request"
// ```

/** The bounds a TTL must sit inside — one second to one day, the same range the claim test pins. */
const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 86_400;

/** A `YYYY-MM-DD` date, and it must also be a real one: `2026-13-40` matches this and is rejected. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A parsed `cache-rules.toml` document, before a byte of it is believed. */
interface CacheRulesDocument {
  rule?: unknown;
}

/**
 * Turn a parsed TOML document into override rows, dropping anything malformed with one warning line.
 *
 * Pure and total: it never throws and never reads a file, so the grammar is unit-testable without fs —
 * and `collie doctor` runs this very function, so the verb and the bridge can never disagree about
 * what a valid row is.
 *
 * A row is kept only when `id` names a SHIPPED rule, `ttl_seconds` is an integer from 1 to 86400,
 * `source_url` is a non-empty string and `retrieved` parses as a real `YYYY-MM-DD` date that is not
 * after today. A later row for the same id replaces the earlier one IN PLACE, so correcting a row
 * does not reorder the file's effect.
 *
 * The clock is a parameter so the grammar stays unit-testable; it is read for one comparison only.
 */
export function validateOperatorCacheRules(
  doc: CacheRulesDocument | null | undefined,
  warn: (message: string) => void = defaultWarn,
  now: () => number = Date.now,
): CacheOverride[] {
  const rows = doc?.rule;
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) {
    warn("`rule` must be an array of [[rule]] tables — ignoring the file's rows");
    return [];
  }
  const out: CacheOverride[] = [];
  const at = new Map<string, number>();
  for (const [index, raw] of rows.entries()) {
    const where = `row ${String(index + 1)}`;
    if (typeof raw !== "object" || raw === null || raw === undefined || Array.isArray(raw)) {
      warn(`${where}: not a [[rule]] table`);
      continue;
    }
    const row: JsonObject = raw;

    // `id` must name a rule this build ships. A typo'd id is dropped rather than remembered: an
    // override nothing can apply to is indistinguishable from a rule the operator thinks they moved.
    if (typeof row.id !== "string" || row.id.trim() === "") {
      warn(`${where}: "id" is missing or not a string`);
      continue;
    }
    const ruleId = row.id.trim();
    if (cacheRuleById(ruleId) === undefined) {
      warn(`${where}: "${ruleId}" is not a rule this build ships`);
      continue;
    }

    if (typeof row.ttl_seconds !== "number" || !Number.isInteger(row.ttl_seconds)) {
      warn(`${where}: "ttl_seconds" must be a whole number of seconds`);
      continue;
    }
    const ttlSeconds = row.ttl_seconds;
    if (ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
      warn(`${where}: "ttl_seconds" must be between 1 and 86400, not ${String(ttlSeconds)}`);
      continue;
    }

    if (typeof row.source_url !== "string" || row.source_url.trim() === "") {
      warn(`${where}: "source_url" is required — an override may move a number, not remove its source`);
      continue;
    }
    const sourceUrl = row.source_url.trim();

    if (typeof row.retrieved !== "string" || !isRealDate(row.retrieved.trim())) {
      warn(`${where}: "retrieved" is not a YYYY-MM-DD date`);
      continue;
    }
    const retrieved = row.retrieved.trim();

    // A date nobody can have read on yet is a typo, not provenance, so it drops the row like any
    // other bad field. Both sides are UTC day strings, so the comparison is a string comparison.
    if (retrieved > utcDay(now())) {
      warn(`${where}: "retrieved" is in the future`);
      continue;
    }

    // `note` is optional, and a present-but-wrong one drops the row rather than being ignored: the
    // same fail-closed reading the five sibling validators give an optional field.
    let note: string | undefined;
    if (row.note !== undefined) {
      if (typeof row.note !== "string" || row.note.trim() === "") {
        warn(`${where}: "note" must be a non-empty string`);
        continue;
      }
      note = row.note.trim();
    }

    const parsed: CacheOverride = { ruleId, ttlSeconds, sourceUrl, retrieved };
    if (note !== undefined) parsed.note = note;
    const prev = at.get(ruleId);
    if (prev !== undefined) {
      warn(`${where}: "${ruleId}" redefined — the later row wins`);
      out[prev] = parsed;
      continue;
    }
    at.set(ruleId, out.length);
    out.push(parsed);
  }
  return out;
}

/** A `YYYY-MM-DD` string that names a day that exists. `2026-02-31` is shaped right and is not a day. */
function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(at)) return false;
  return new Date(at).toISOString().slice(0, 10) === value;
}

/** The `YYYY-MM-DD` day an epoch-ms instant falls on, in UTC — the calendar `retrieved` is written in. */
function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function defaultWarn(message: string): void {
  console.warn(`[cache-rules] ${message}`);
}

/**
 * A reader for the operator's `cache-rules.toml` — the same mtime cache, the same "no file is not an
 * error" rule and the same hold-the-last-good-rows failure posture its five siblings get, because it
 * is literally the same reader (operator-file.ts). An unparseable file is a HOLD, never a 500.
 */
export function createCacheRulesReader(
  path: string,
  io: OperatorFileIo = diskIo,
  warn = defaultWarn,
): () => Promise<CacheOverride[]> {
  return createOperatorFileReader(path, validateOperatorCacheRules, io, warn);
}

/** The io shape this reader is driven with in tests. */
export type CacheRulesFileIo = OperatorFileIo;
