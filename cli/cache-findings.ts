import { allCacheRules, allResetRules } from "../bridge/cache/rules/index.ts";
import { claimAgeDays, staleClaims } from "../bridge/cache/claims.ts";
import type { CacheOverride } from "../bridge/cache/engine.ts";
import { validateOperatorCacheRules } from "../bridge/operator-cache-rules.ts";
import type { CliContext } from "./context.ts";
import { ok, warn, type Finding } from "./finding.ts";
import type { Files } from "./sys.ts";

// ── Is the cache chip telling the truth? ─────────────────────────────────────
//
// A prompt-cache TTL is vendor behaviour, and a vendor can move it in a blog post. Two mechanisms
// guard against shipping a year-old number and there is no third (ADR 0041):
//
//   (a) this section warns per claim over 180 days, against the WALL CLOCK, because `doctor` is a live
//       check of a live machine — and a unit test fails the build over 365 days against the
//       CHANGELOG's own release date, because a tag's verdict must never change after the tag;
//   (b) `cache-rules.toml` lets the operator move a number, and must carry the page they read and the
//       date they read it, or the row is dropped and named here.
//
// A third finding, `cache-env`, exists for the one thing the bridge deliberately cannot see. Claude
// Code reads `ENABLE_PROMPT_CACHING_1H` and `FORCE_PROMPT_CACHING_5M` from the agent's own
// environment; the bridge is a `systemd --user` unit whose `process.env` belongs to the wrong process,
// so it never reads them. `doctor` runs in the operator's own shell, so its environment IS the
// operator's — and all it does with that is say when the shell and the config file disagree.
//
// ALL THREE ARE `warn` AND NEVER `error`, so `collie doctor` still exits 0 (`cli/doctor.ts:219`). The
// build gate is the unit test, not the verb.

/** How old a claim may get before `doctor` says so. The build gate's 365 days is a separate number. */
export const CLAIM_WARN_DAYS = 180;

/** The two Claude Code variables that change a TTL, and which `cache-env` reports a mismatch with. */
export const CLAUDE_TTL_VARS: readonly string[] = ["ENABLE_PROMPT_CACHING_1H", "FORCE_PROMPT_CACHING_5M"];

/** The rule ids `cache-env` considers "already mirrored" when an override names one of them. */
const CLAUDE_RULE_IDS: ReadonlySet<string> = new Set(["claude.api", "claude.subscription"]);

/** What this section reaches: the context, one file read, and the shell's own environment. */
export interface CacheDeps {
  readonly ctx: CliContext;
  readonly files: Pick<Files, "read">;
  /**
   * INJECTED rather than read from `process.env` inside, so `cache-env` is a table test. In the verb
   * it is `deps.ctx.env`, which is the operator's shell merged with their `.env`.
   */
  readonly env: Record<string, string | undefined>;
  /** Epoch ms. The 180-day warning is the one clock in this feature that is deliberately live. */
  readonly now: () => number;
}

/** Every line of the cache section, in the order an operator would read them. */
export function cacheFindings(deps: CacheDeps): Finding[] {
  return [claims(deps), overrides(deps), env(deps)];
}

/** A claim below `documented` must say what could not be confirmed. */
function unnoted(claim: { confidence: string; note?: string }): boolean {
  return claim.confidence !== "documented" && claim.confidence !== "observed" && (claim.note ?? "") === "";
}

/**
 * `cache-claims` — every shipped TTL's date, every reset rule's date, and every honest hole's note.
 *
 * The note check is folded in here rather than living in its own line so that `doctor` and the unit
 * test say the same thing about the same claim: a rule below `documented` that records no note is a
 * number nobody can audit, whichever of the two notices it first. A reset rule (an action that drops the
 * cache, issue #236) is a claim of the same kind and is judged the same way.
 */
function claims(deps: CacheDeps): Finding {
  const check = "cache-claims";
  const rules = allCacheRules();
  const resetRules = allResetRules();
  const at = new Date(deps.now());
  const stale = staleClaims(rules, CLAIM_WARN_DAYS, at, resetRules);
  const unexplained = [
    ...rules.filter((r) => unnoted(r.ttlSeconds)).map((r) => ({ id: r.id, confidence: r.ttlSeconds.confidence })),
    ...resetRules.filter((r) => unnoted(r.resets)).map((r) => ({ id: r.id, confidence: r.resets.confidence })),
  ];
  const summary =
    `${String(rules.length)} cache rules and ${String(resetRules.length)} reset rules, ` +
    "every claim carrying the page it was read on";
  if (stale.length === 0 && unexplained.length === 0) {
    const oldest = rules
      .map((r) => claimAgeDays(r.ttlSeconds.source, at))
      .reduce((a, b) => Math.max(a, b), 0);
    return ok(check, `${summary}; the oldest was checked ${String(oldest)} days ago`);
  }
  const lines = [
    ...stale.map(
      (s) =>
        `cache rule ${s.ruleId} last checked ${s.source.retrievedAt === "" ? "never" : s.source.retrievedAt}, ` +
        `${String(s.ageDays)} days ago`,
    ),
    ...unexplained.map((r) => `cache rule ${r.id} is "${r.confidence}" and carries no note`),
  ];
  return warn(
    check,
    `${summary}; ${lines.join("; ")}`,
    "re-read each vendor page named above, then update `retrievedAt` and the quote in" +
      " `bridge/cache/rules/` — or move the number in `cache-rules.toml` if the vendor changed it",
  );
}

/**
 * `cache-rules` — the operator's own overrides, judged by the grammar the BRIDGE applies.
 *
 * It calls `validateOperatorCacheRules` rather than re-reading the file its own way, so `doctor` and
 * the bridge can never disagree about which row is valid. A row that is dropped is named with the
 * reason the validator gave; the rest of the file still applies, which is why this is one `warn` line
 * listing rows rather than a verdict on the file.
 */
function overrides(deps: CacheDeps): Finding {
  const check = "cache-rules";
  const read = readOverrides(deps);
  const path = read.path;
  // No file is the ordinary case of an operator who declared nothing, not a fault.
  if (read.absent) return ok(check, `no ${path} — every TTL is the shipped rule`);
  if (read.parseError !== null) {
    return warn(
      check,
      `${path} is not valid TOML (${read.parseError}) — the bridge is holding the last rows that parsed`,
      "fix the file; `collie doctor` reads it again with no restart",
    );
  }
  const { kept, rejected } = read;
  const applied = `${String(kept.length)} override(s) applied: ${kept.map((r) => `${r.ruleId} → ${String(r.ttlSeconds)}s`).join(", ")}`;
  if (rejected.length === 0) {
    return ok(check, kept.length === 0 ? `${path} declares no rows` : applied);
  }
  return warn(
    check,
    `${kept.length === 0 ? `${path} applies nothing` : applied}; ${rejected.join("; ")}`,
    "every row needs an `id` this build ships, a whole `ttl_seconds` from 1 to 86400, a `source_url`" +
      " and a `retrieved` date at or before today — see cache-rules.toml.example",
  );
}

/** One reading of `cache-rules.toml`, judged by the grammar the BRIDGE applies. */
interface OverrideRead {
  /** Where the file would sit, named whether or not it is there. */
  readonly path: string;
  /** True when the operator declared no file at all. */
  readonly absent: boolean;
  /** Set when the file is not TOML; the bridge then holds its last good rows. */
  readonly parseError: string | null;
  /** The rows that VALIDATE. A commented-out row is not one of them. */
  readonly kept: readonly CacheOverride[];
  /** One line per dropped row, in the validator's own words. */
  readonly rejected: readonly string[];
}

/**
 * Read, parse and validate the operator's file once, for both lines that need it.
 *
 * `cache-rules` and `cache-env` share this so neither can answer from the file's TEXT. A plain search
 * for a rule id credits the shipped example, whose rows are all commented out, with an override that
 * applies to nothing — which is the bug this function exists to make unrepresentable.
 */
function readOverrides(deps: CacheDeps): OverrideRead {
  const path = cacheRulesPath(deps.ctx);
  const text = deps.files.read(path);
  if (text === null) return { path, absent: true, parseError: null, kept: [], rejected: [] };
  const rejected: string[] = [];
  try {
    // SAFETY: `Bun.TOML.parse` answers a parsed document and `validateOperatorCacheRules` is its only
    // reader — every field it names is checked before it is believed, so this assertion claims nothing
    // beyond "a document came back". Exactly the assertion `operator-file.ts` makes.
    const doc = Bun.TOML.parse(text) as { rule?: unknown };
    const kept = validateOperatorCacheRules(doc, (m) => rejected.push(m), deps.now);
    return { path, absent: false, parseError: null, kept, rejected };
  } catch (err) {
    return { path, absent: false, parseError: String(err), kept: [], rejected: [] };
  }
}

/**
 * `cache-env` — the operator's shell says one thing, their config file says another.
 *
 * This is a hint about a difference between two places the operator controls, and nothing more. It
 * never changes a TTL, it never writes a rule, and the bridge never sees either variable.
 */
function env(deps: CacheDeps): Finding {
  const check = "cache-env";
  const set = CLAUDE_TTL_VARS.filter((name) => (deps.env[name] ?? "").trim() !== "");
  if (set.length === 0) return ok(check, "no Claude Code cache variable is set in this shell");
  const named = set.map((name) => `${name}=${(deps.env[name] ?? "").trim()}`).join(", ");
  if (overrideNamesClaude(deps)) {
    return ok(check, `${named} in this shell, and cache-rules.toml already moves a claude rule to match`);
  }
  return warn(
    check,
    `${named} is set in this shell, so Claude Code is on a TTL the shipped rule does not describe;` +
      " the bridge cannot read the agent's environment, so the chip still shows the shipped number",
    "mirror this into cache-rules.toml with the page you read and today's date — it changes the chip" +
      " only on a Claude pane with no measured reading, because a measurement outranks the file",
  );
}

/**
 * Does `cache-rules.toml` move a claude rule at all?
 *
 * It asks the VALIDATOR, not the text: a `claude.api` id in a commented-out row, which is exactly what
 * the shipped example carries, moves nothing and must not read as an override. The grammar that
 * decides a valid row lives in `bridge/operator-cache-rules.ts` and is the bridge's to apply; this
 * line only asks whether a row that survives it names a Claude rule, not whether the number matches
 * the variable.
 */
function overrideNamesClaude(deps: CacheDeps): boolean {
  return readOverrides(deps).kept.some((row) => CLAUDE_RULE_IDS.has(row.ruleId));
}

/** Where the operator's `cache-rules.toml` sits — beside the other five, in their config dir. */
export function cacheRulesPath(ctx: CliContext): string {
  return `${ctx.configDir}/cache-rules.toml`;
}
