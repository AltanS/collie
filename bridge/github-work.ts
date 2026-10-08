// ── GITHUB WORK: THE HOST'S OWN `gh` USER, READ-ONLY ─────────────────────────
//
// `GET /api/github` answers "what is stuck and why" for the HOST's `gh` user: their open pull requests
// with checks, review and merge state, the pull requests waiting on their review, and the issues
// assigned to them. Opt-in (`COLLIE_GITHUB`, default off), because the bridge otherwise makes no
// outbound call and collects nothing (ADR 0034).
//
// Three rules hold this file together:
//   1. ONE `gh api graphql` per refresh, argv only and never a shell, with the token `gh` already
//      holds. The query is a constant that starts with `query ` and never names a mutation.
//   2. A fetch is started only by a paired device's request, never by a timer, and at most one `gh`
//      child runs at a time (single-flight). An answer is reused for {@link GITHUB_TTL_MS}; an
//      expired one is served at once as `stale` while ONE background refresh runs.
//   3. `?peek=1` never spawns. A failed refresh never throws away the last good answer.
//
// Everything that touches the process (the spawn, the clock, where `gh` is) is a dependency, so
// `bun test` drives the whole cache with a fake runner and never reaches the network.

import { withoutGitRelocators } from "../cli/sys.ts";
import type { Environment } from "../cli/context.ts";
import type { JsonValue } from "./json.ts";
import { redactText } from "./redact.ts";
import { jsonNumberField, jsonRecord, jsonStringField } from "./stt/json.ts";
import type {
  GithubCheckCounts,
  GithubChecks,
  GithubIssue,
  GithubList,
  GithubMergeable,
  GithubPr,
  GithubReview,
  GithubWorkResponse,
} from "./types.ts";

/**
 * The one GraphQL document a refresh sends, verified live against api.github.com on 2026-10-08
 * (cost: 2 points). 30 items per list: 50 made GitHub answer HTTP 502 at about 11 s.
 */
export const GITHUB_WORK_QUERY = `query GithubWork($mine: String!, $review: String!, $issues: String!) {
  viewer { login }
  mine: search(query: $mine, type: ISSUE, first: 30) { issueCount nodes { ...pr } }
  review: search(query: $review, type: ISSUE, first: 30) { issueCount nodes { ...pr } }
  issues: search(query: $issues, type: ISSUE, first: 30) { issueCount nodes { ...issue } }
}
fragment pr on PullRequest {
  number title url isDraft updatedAt mergeable reviewDecision
  author { login }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state
    contexts(first: 0) { totalCount checkRunCountsByState { state count }
      statusContextCountsByState { state count } } } } } }
}
fragment issue on Issue {
  number title url updatedAt
  author { login }
  repository { nameWithOwner }
  labels(first: 5) { nodes { name color } }
}`;

/** The three searches, passed as GraphQL variables. Authored issues are out on purpose (v1). */
export const GITHUB_SEARCHES = {
  mine: "is:open is:pr author:@me archived:false sort:updated-desc",
  review: "is:open is:pr review-requested:@me archived:false sort:updated-desc",
  issues: "is:open is:issue assignee:@me archived:false sort:updated-desc",
} as const;

/** How long `gh` may take: 30 items per list measured at 7 to 9 s. Killed past it. */
export const GH_TIMEOUT_MS = 20_000;
/** The most `gh` output read before the child is killed: far past three lists of 30. */
export const GH_MAX_BYTES = 4 * 1024 * 1024;
/** How long one answer is served as fresh. */
export const GITHUB_TTL_MS = 60_000;
/** The shortest gap between two fetch STARTS a `?fresh=1` may force. */
export const GITHUB_FRESH_FLOOR_MS = 10_000;
/** The longest `unavailable` message, and the longest `error` on a stale answer. */
const MESSAGE_MAX = 300;

/** The argv one refresh runs, `gh` first. */
export function ghArgv(gh: string): string[] {
  return [
    gh,
    "api",
    "graphql",
    "-f",
    `query=${GITHUB_WORK_QUERY}`,
    "-f",
    `mine=${GITHUB_SEARCHES.mine}`,
    "-f",
    `review=${GITHUB_SEARCHES.review}`,
    "-f",
    `issues=${GITHUB_SEARCHES.issues}`,
  ];
}

/** The environment a `gh` child is started with: every value set, none `undefined`. */
export interface GhChildEnvironment {
  [name: string]: string;
}

/**
 * The environment `gh` gets: the bridge's own minus every `COLLIE_*` name (stt/local-cli.ts's
 * `childEnv` rule) and minus the git relocators (ADR 0049), plus the three switches that keep `gh`
 * from prompting, colouring or checking for its own updates. `GH_TOKEN`, `GH_HOST`, `HOME` and
 * `XDG_CONFIG_HOME` pass through untouched: that is where `gh` keeps its login.
 */
export function ghEnv(source: Environment): GhChildEnvironment {
  const out: GhChildEnvironment = {};
  for (const [name, value] of Object.entries(withoutGitRelocators(source))) {
    if (value === undefined || name.startsWith("COLLIE_")) continue;
    out[name] = value;
  }
  out.GH_PROMPT_DISABLED = "1";
  out.NO_COLOR = "1";
  out.GH_NO_UPDATE_NOTIFIER = "1";
  return out;
}

/** What one `gh` run came back with. */
export interface GhRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Killed by the {@link GH_TIMEOUT_MS} timer. */
  timedOut: boolean;
  /** Output passed {@link GH_MAX_BYTES} and the child was killed. */
  capped: boolean;
}

/** Runs one argv with one environment. Throws only when the child could not be started at all. */
export type GhRunner = (argv: readonly string[], env: GhChildEnvironment) => Promise<GhRun>;

/** A stream read up to `max` bytes; `over` when there was more and reading stopped. */
async function collect(stream: ReadableStream<Uint8Array>, max: number): Promise<{ bytes: Buffer; over: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    if (size + chunk.byteLength > max) {
      chunks.push(chunk.subarray(0, max - size));
      return { bytes: Buffer.concat(chunks), over: true };
    }
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  return { bytes: Buffer.concat(chunks), over: false };
}

/**
 * The real runner, on `runGit`'s pattern (bridge/changes.ts): argv only, no shell, killed at the
 * timeout, output read up to a cap and the child killed past it. Both pipes are read at once, so a
 * chatty stderr can never block the child on a full pipe.
 */
export async function spawnGh(
  argv: readonly string[],
  env: GhChildEnvironment,
  timeoutMs: number = GH_TIMEOUT_MS,
  maxBytes: number = GH_MAX_BYTES,
): Promise<GhRun> {
  const proc = Bun.spawn([...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [out, err] = await Promise.all([collect(proc.stdout, maxBytes), collect(proc.stderr, maxBytes)]);
    const capped = out.over || err.over;
    if (capped) proc.kill();
    const code = await proc.exited;
    return { code, stdout: out.bytes.toString("utf8"), stderr: err.bytes.toString("utf8"), timedOut, capped };
  } finally {
    clearTimeout(timer);
  }
}

// ── Normalising GitHub's answer into the wire types ───────────────────────────

/** The answer without the per-request fields (`machine`, `stale`, `error`). */
export interface GithubWorkData {
  login: string;
  fetchedAt: string;
  mine: GithubList<GithubPr>;
  review: GithubList<GithubPr>;
  issues: GithubList<GithubIssue>;
}

/** Why a fetch produced no answer, as the wire names it. */
export type GithubFailureReason = "gh-missing" | "gh-unauthenticated" | "timeout" | "error";

export interface GithubFailure {
  reason: GithubFailureReason;
  message: string;
}

export type GithubFetchOutcome = { ok: true; data: GithubWorkData } | { ok: false; failure: GithubFailure };

/** Which count a check-run or status-context state adds to. A state in neither table counts only in `total`. */
type CheckBucket = "failing" | "pending" | "passing";
/** A GitHub state name → the count it adds to. A name the table lacks adds to none. */
type BucketTable = Partial<Record<string, CheckBucket>>;

/** `checkRunCountsByState` rows: GitHub's CheckStatusState and CheckConclusionState values. */
const CHECK_RUN_BUCKET = {
  FAILURE: "failing",
  ERROR: "failing",
  TIMED_OUT: "failing",
  CANCELLED: "failing",
  ACTION_REQUIRED: "failing",
  STARTUP_FAILURE: "failing",
  QUEUED: "pending",
  IN_PROGRESS: "pending",
  WAITING: "pending",
  PENDING: "pending",
  REQUESTED: "pending",
  SUCCESS: "passing",
  NEUTRAL: "passing",
  SKIPPED: "passing",
} satisfies BucketTable;

/** `statusContextCountsByState` rows: GitHub's StatusState values. */
const CONTEXT_BUCKET = {
  FAILURE: "failing",
  ERROR: "failing",
  PENDING: "pending",
  EXPECTED: "pending",
  SUCCESS: "passing",
} satisfies BucketTable;

/** A JSON array's members, or none when the value is not an array. */
function jsonArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/** `{ login }` → the login, or null for a deleted account (GitHub's "ghost") or anything else. */
function loginOf(value: JsonValue | undefined): string | null {
  return jsonStringField(jsonRecord(value)?.login);
}

export function checksOf(rollupState: string | null): GithubChecks {
  if (rollupState === "SUCCESS") return "success";
  if (rollupState === "FAILURE" || rollupState === "ERROR") return "failure";
  if (rollupState === "PENDING" || rollupState === "EXPECTED") return "pending";
  return "none";
}

export function reviewOf(decision: string | null): GithubReview {
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes-requested";
  if (decision === "REVIEW_REQUIRED") return "required";
  return "none";
}

/** `UNKNOWN` (GitHub has not computed it yet) is unknown, never "no conflict". */
export function mergeableOf(state: string | null): GithubMergeable {
  if (state === "MERGEABLE") return "mergeable";
  if (state === "CONFLICTING") return "conflicting";
  return "unknown";
}

/** Adds every `{ state, count }` row of `rows` into `counts`, in the bucket `table` gives its state. */
function tally(counts: GithubCheckCounts, rows: JsonValue | undefined, table: BucketTable): void {
  for (const row of jsonArray(rows)) {
    const r = jsonRecord(row);
    const state = jsonStringField(r?.state);
    const count = jsonNumberField(r?.count);
    if (state === null || count === null) continue;
    const bucket = Object.hasOwn(table, state) ? table[state] : undefined;
    if (bucket !== undefined) counts[bucket] += count;
  }
}

function prOf(node: JsonValue): GithubPr | null {
  const pr = jsonRecord(node);
  if (pr === null) return null;
  const number = jsonNumberField(pr.number);
  const url = jsonStringField(pr.url);
  const repo = jsonStringField(jsonRecord(pr.repository)?.nameWithOwner);
  if (number === null || url === null || repo === null) return null;
  // The rollup of the newest commit; a PR whose head has no checks at all has none.
  const head = jsonRecord(jsonArray(jsonRecord(pr.commits)?.nodes)[0]);
  const rollup = jsonRecord(jsonRecord(head?.commit)?.statusCheckRollup);
  const contexts = jsonRecord(rollup?.contexts);
  const checkCounts: GithubCheckCounts = {
    failing: 0,
    pending: 0,
    passing: 0,
    total: jsonNumberField(contexts?.totalCount) ?? 0,
  };
  tally(checkCounts, contexts?.checkRunCountsByState, CHECK_RUN_BUCKET);
  tally(checkCounts, contexts?.statusContextCountsByState, CONTEXT_BUCKET);
  return {
    repo,
    number,
    title: jsonStringField(pr.title) ?? "",
    url,
    author: loginOf(pr.author),
    draft: pr.isDraft === true,
    updatedAt: jsonStringField(pr.updatedAt) ?? "",
    checks: rollup === null ? "none" : checksOf(jsonStringField(rollup.state)),
    checkCounts,
    review: reviewOf(jsonStringField(pr.reviewDecision)),
    mergeable: mergeableOf(jsonStringField(pr.mergeable)),
  };
}

/** GitHub's own default label colour, for a label whose colour is not six hex digits. */
const DEFAULT_LABEL_COLOR = "ededed";

function issueOf(node: JsonValue): GithubIssue | null {
  const issue = jsonRecord(node);
  if (issue === null) return null;
  const number = jsonNumberField(issue.number);
  const url = jsonStringField(issue.url);
  const repo = jsonStringField(jsonRecord(issue.repository)?.nameWithOwner);
  if (number === null || url === null || repo === null) return null;
  const labels: GithubIssue["labels"] = [];
  for (const raw of jsonArray(jsonRecord(issue.labels)?.nodes)) {
    const label = jsonRecord(raw);
    const name = jsonStringField(label?.name);
    if (name === null) continue;
    const color = jsonStringField(label?.color);
    labels.push({ name, color: color !== null && /^[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_LABEL_COLOR });
  }
  return {
    repo,
    number,
    title: jsonStringField(issue.title) ?? "",
    url,
    author: loginOf(issue.author),
    updatedAt: jsonStringField(issue.updatedAt) ?? "",
    labels,
  };
}

function listOf<T>(value: JsonValue | undefined, item: (node: JsonValue) => T | null): GithubList<T> {
  const search = jsonRecord(value);
  const items: T[] = [];
  for (const node of jsonArray(search?.nodes)) {
    const parsed = item(node);
    if (parsed !== null) items.push(parsed);
  }
  return { items, total: jsonNumberField(search?.issueCount) ?? items.length };
}

/**
 * GitHub's GraphQL answer → the three wire lists, or the reason there is none. Pure: `fetchedAt` is
 * the caller's. A body with no `data` (GitHub's `errors` alone) or no `viewer.login` is not an
 * answer, because a list nobody can say whose it is would be read as "you have nothing".
 */
export function normalizeGithubWork(
  raw: JsonValue,
  fetchedAt: string,
): { ok: true; data: GithubWorkData } | { ok: false; message: string } {
  const body = jsonRecord(raw);
  const data = jsonRecord(body?.data);
  const login = loginOf(data?.viewer);
  if (data === null || login === null) {
    const first = jsonStringField(jsonRecord(jsonArray(body?.errors)[0])?.message);
    return { ok: false, message: ghMessage(first ?? "GitHub answered without data") };
  }
  return {
    ok: true,
    data: {
      login,
      fetchedAt,
      mine: listOf(data.mine, prOf),
      review: listOf(data.review, prOf),
      issues: listOf(data.issues, issueOf),
    },
  };
}

// ── Classifying a failure ──────────────────────────────────────────────────────

/**
 * One line a phone may show: the first non-blank line of `text`, control characters dropped, every
 * known secret shape masked whatever `COLLIE_REDACT` says (a `gh` message has no business carrying a
 * token, and this makes sure it does not), and at most {@link MESSAGE_MAX} characters.
 */
export function ghMessage(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const printable = [...line]
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();
  const masked = redactText(printable);
  return masked.length > MESSAGE_MAX ? `${masked.slice(0, MESSAGE_MAX - 1)}…` : masked;
}

const GH_MISSING = "gh is not on the bridge's PATH or in the usual install folders";

/** What a finished run means: an answer, or which of the four failures it is. */
export function classifyGhRun(run: GhRun, fetchedAt: string): GithubFetchOutcome {
  if (run.timedOut) {
    return { ok: false, failure: { reason: "timeout", message: `gh did not answer within ${GH_TIMEOUT_MS / 1000} s` } };
  }
  if (run.capped) {
    return { ok: false, failure: { reason: "error", message: `gh's answer was over ${GH_MAX_BYTES / (1024 * 1024)} MiB` } };
  }
  if (run.code !== 0) {
    // gh exits 4 when it holds no login; older builds say so only in words.
    const unauthenticated = run.code === 4 || /gh auth login/i.test(run.stderr);
    const message = ghMessage(run.stderr);
    if (unauthenticated) {
      return { ok: false, failure: { reason: "gh-unauthenticated", message: message || "gh is not logged in" } };
    }
    return { ok: false, failure: { reason: "error", message: message || `gh exited with code ${run.code}` } };
  }
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; every field below is read through
    // the narrowing readers in bridge/stt/json.ts.
    parsed = JSON.parse(run.stdout) as JsonValue;
  } catch {
    return { ok: false, failure: { reason: "error", message: "gh's answer was not JSON" } };
  }
  const normalized = normalizeGithubWork(parsed, fetchedAt);
  return normalized.ok ? normalized : { ok: false, failure: { reason: "error", message: normalized.message } };
}

// ── The cache ──────────────────────────────────────────────────────────────────

/** What a fetch needs from the process. {@link realGhDeps} is the real set. */
export interface GhDeps {
  readonly run: GhRunner;
  /** Where `gh` is, or null when it is not on the bridge's PATH. Asked on every fetch. */
  readonly ghPath: () => string | null;
  readonly env: Environment;
  readonly now: () => number;
}

/**
 * Where a package manager puts `gh` when the service's PATH does not say. A launchd agent starts
 * with `/usr/bin:/bin:/usr/sbin:/sbin` and a systemd user unit with little more, so a `gh` that the
 * operator's shell finds (Homebrew, nix-darwin, a Nix profile, Linuxbrew, snap) is invisible to the
 * bridge unless it also looks here. The service's own PATH is asked first and wins.
 */
export function ghFallbackDirs(env: Environment): string[] {
  const home = env.HOME ?? "";
  const user = env.USER ?? "";
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/run/current-system/sw/bin", "/nix/var/nix/profiles/default/bin"];
  if (user !== "") dirs.push(`/etc/profiles/per-user/${user}/bin`);
  if (home !== "") dirs.push(`${home}/.nix-profile/bin`, `${home}/.local/bin`);
  dirs.push("/home/linuxbrew/.linuxbrew/bin", "/snap/bin");
  return dirs;
}

/** `gh` on the PATH, else in {@link ghFallbackDirs}; null when neither has it. */
export function findGh(env: Environment, which: (cmd: string, path?: string) => string | null): string | null {
  return which("gh", env.PATH) ?? which("gh", ghFallbackDirs(env).join(":"));
}

/** `Bun.which`, shaped for {@link findGh}: the default PATH, or the one it names. */
const bunWhich = (cmd: string, path?: string): string | null => Bun.which(cmd, path === undefined ? {} : { PATH: path });

/** The bridge's own: {@link findGh} over its environment, its own environment, the wall clock. */
export function realGhDeps(): GhDeps {
  return { run: (argv, env) => spawnGh(argv, env), ghPath: () => findGh(process.env, bunWhich), env: process.env, now: Date.now };
}

/** One fetch, start to finish. Never throws: every failure is one of the four reasons. */
export async function fetchGithubWork(deps: GhDeps): Promise<GithubFetchOutcome> {
  const gh = deps.ghPath();
  if (gh === null) return { ok: false, failure: { reason: "gh-missing", message: GH_MISSING } };
  let run: GhRun;
  try {
    run = await deps.run(ghArgv(gh), ghEnv(deps.env));
  } catch (err) {
    if (!(err instanceof Error)) return { ok: false, failure: { reason: "error", message: "gh could not be started" } };
    // `gh` vanished between the lookup and the spawn: still "not there", not a fault.
    if ("code" in err && err.code === "ENOENT") return { ok: false, failure: { reason: "gh-missing", message: GH_MISSING } };
    return { ok: false, failure: { reason: "error", message: ghMessage(err.message) || "gh could not be started" } };
  }
  return classifyGhRun(run, new Date(deps.now()).toISOString());
}

/**
 * The answer cache: one per process, holding the last good answer and the last failure.
 *
 * A fetch starts only inside {@link GithubWork.answer}, so only when a device asks. It starts when
 * the last START is at least {@link GITHUB_TTL_MS} old ({@link GITHUB_FRESH_FLOOR_MS} for
 * `?fresh=1`), and never while one is running: the running one is joined instead. Timing on the
 * START, not on the last success, is what stops a broken `gh` from being spawned on every request.
 */
export class GithubWork {
  private good: { data: GithubWorkData; startedAt: number } | null = null;
  /** The failure of the most recent fetch, cleared by the next one that works. */
  private failure: GithubFailure | null = null;
  private inflight: Promise<void> | null = null;
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: GhDeps) {}

  /**
   * The answer to a request. With nothing good cached it waits for a fetch (or the one running).
   * With a good answer it never waits unless `fresh` asked for one past the floor: an expired answer
   * comes back at once as `stale` while one background refresh runs.
   */
  async answer(machine: string, fresh: boolean): Promise<GithubWorkResponse> {
    const due = this.deps.now() - this.lastStart >= (fresh ? GITHUB_FRESH_FLOOR_MS : GITHUB_TTL_MS);
    if (this.good === null || fresh) {
      if (this.inflight !== null || due) await this.refresh();
    } else if (due) {
      void this.refresh();
    }
    return this.current(machine);
  }

  /** What is cached, without ever starting a fetch: `cold`, the last good answer, or the last failure. */
  peek(machine: string): GithubWorkResponse {
    return this.current(machine);
  }

  private refresh(): Promise<void> {
    if (this.inflight !== null) return this.inflight;
    const startedAt = this.deps.now();
    this.lastStart = startedAt;
    this.inflight = this.settle(startedAt).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** One fetch, recorded: a success replaces the answer and clears the failure; a failure keeps it. */
  private async settle(startedAt: number): Promise<void> {
    const outcome = await fetchGithubWork(this.deps);
    if (outcome.ok) {
      this.good = { data: outcome.data, startedAt };
      this.failure = null;
    } else {
      this.failure = outcome.failure;
    }
  }

  private current(machine: string): GithubWorkResponse {
    if (this.good !== null) {
      const { data, startedAt } = this.good;
      const answer: GithubWorkResponse = {
        state: "ok",
        machine,
        login: data.login,
        fetchedAt: data.fetchedAt,
        stale: this.deps.now() - startedAt >= GITHUB_TTL_MS || this.failure !== null,
        mine: data.mine,
        review: data.review,
        issues: data.issues,
      };
      if (this.failure !== null) answer.error = this.failure.message;
      return answer;
    }
    if (this.failure !== null) return { state: "unavailable", machine, ...this.failure };
    return { state: "cold", machine };
  }
}

/** What `GET /api/github` needs: this machine's name, as the crew and Machines name it, and the cache. */
export interface GithubWorkSurface {
  readonly machine: () => string;
  readonly work: GithubWork;
}

/**
 * The body `GET /api/github` answers, once the gate and the host resolver have let it through.
 * `enabled` is `COLLIE_GITHUB`: off answers `off` and touches nothing else, so a bridge that never
 * opted in never looks for `gh`, let alone runs it.
 */
export function githubAnswer(enabled: boolean, surface: GithubWorkSurface, url: URL): Promise<GithubWorkResponse> {
  const machine = surface.machine();
  if (!enabled) return Promise.resolve({ state: "off", machine });
  if (url.searchParams.get("peek") === "1") return Promise.resolve(surface.work.peek(machine));
  return surface.work.answer(machine, url.searchParams.get("fresh") === "1");
}
