import { allCacheRules } from "../bridge/cache/rules/index.ts";
import { claimAgeDays, staleClaims } from "../bridge/cache/claims.ts";
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
const CLAUDE_RULE_IDS: readonly string[] = ["claude.api", "claude.subscription"];

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
  return [claims(deps), env(deps)];
}

/**
 * `cache-claims` — every shipped TTL's date, and every honest hole's note.
 *
 * The note check is folded in here rather than living in its own line so that `doctor` and the unit
 * test say the same thing about the same claim: a rule below `documented` that records no note is a
 * number nobody can audit, whichever of the two notices it first.
 */
function claims(deps: CacheDeps): Finding {
  const check = "cache-claims";
  const rules = allCacheRules();
  const at = new Date(deps.now());
  const stale = staleClaims(rules, CLAIM_WARN_DAYS, at);
  const unexplained = rules.filter(
    (r) =>
      r.ttlSeconds.confidence !== "documented" &&
      r.ttlSeconds.confidence !== "observed" &&
      (r.ttlSeconds.note ?? "") === "",
  );
  const summary = `${String(rules.length)} cache rules, every TTL carrying the page it was read on`;
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
    ...unexplained.map((r) => `cache rule ${r.id} is "${r.ttlSeconds.confidence}" and carries no note`),
  ];
  return warn(
    check,
    `${summary}; ${lines.join("; ")}`,
    "re-read each vendor page named above, then update `retrievedAt` and the quote in" +
      " `bridge/cache/rules/` — or move the number in `cache-rules.toml` if the vendor changed it",
  );
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
    "mirror this into cache-rules.toml with the page you read and today's date",
  );
}

/**
 * Does `cache-rules.toml` move a claude rule at all?
 *
 * Deliberately a COARSE read: it asks whether a `claude.api` or `claude.subscription` id appears in the
 * file, not whether the number matches the variable. The grammar that decides a valid row lives in
 * `bridge/operator-cache-rules.ts` and is the bridge's to apply; this line only needs to know whether
 * the operator has said anything about Claude's TTL at all, and a file mid-edit must not flip the
 * finding to a false warning.
 */
function overrideNamesClaude(deps: CacheDeps): boolean {
  const text = deps.files.read(cacheRulesPath(deps.ctx));
  if (text === null) return false;
  return CLAUDE_RULE_IDS.some((id) => text.includes(`"${id}"`) || text.includes(`'${id}'`));
}

/** Where the operator's `cache-rules.toml` sits — beside the other five, in their config dir. */
export function cacheRulesPath(ctx: CliContext): string {
  return `${ctx.configDir}/cache-rules.toml`;
}
