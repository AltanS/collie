import { answersThisBuild } from "../bridge/version.ts";
import {
  inFlight,
  parseUpdateLock,
  parseUpdateRun,
  resolveUpdateRun,
  UPDATE_RUN_SCHEMA,
  updateLockPath,
  updateRunPath,
  type UpdateLock,
  type UpdateRun,
  type UpdateRunState,
} from "../bridge/update-run.ts";
import { STANDBY_HEALTH_PATH, STANDBY_VERSION_HEADER, standbyPortOf } from "../bridge/pack/standby.ts";
import { parseTrustStore, trustStorePath } from "../bridge/pack/trust-store.ts";
import type { Environment } from "./context.ts";
import type { Exec, Files, Net } from "./sys.ts";

// The detached updater's state machine, its lock, its health gate and the two ways it gets launched
// (M15/04).
//
// ── WHY A SECOND PROCESS AT ALL ──────────────────────────────────────────────
// Step three of an update is "restart the service". The bridge IS the service, so a bridge that ran
// the update would be killed halfway through it — there would be nobody left to notice that the new
// version never came up, and nobody left to flip `current` back. So the swap-and-verify half runs in
// a process with its own lifetime, and everything it knows is written to `<state dir>/update.json`
// for the bridge to read when it comes back (`bridge/update-run.ts` owns that record).
//
// ── THE MACHINE IS A PURE REDUCER ────────────────────────────────────────────
// {@link reduce} is a total function from (record, event) to record. It flips no symlink, restarts
// no service and reads no clock — `now` is a parameter. The impure half is {@link driveApply}, which
// does nothing but call injected effects and feed their answers to the reducer. That split is what
// makes "health times out, we roll back, the rollback fails too, we stop" a table of unit tests
// instead of a machine nobody can run without systemd.

// ── The state machine ────────────────────────────────────────────────────────

/** What can happen to a run. Every one of these is a transition the reducer names explicitly. */
export type RunEvent =
  /** A run starts. From `idle` or from any terminal state — the record is a log of the LAST run. */
  | {
      readonly kind: "begin";
      readonly from: string | null;
      readonly to: string | null;
      readonly pid: number;
      /**
       * The run's id, when one was handed down (M16/04): the operator's confirm on the phone mints
       * it, and `collie update --run-id` carries it here. Absent — or empty — on every run started
       * from a terminal, which is a run with no id, never a run with a blank one.
       */
      readonly runId?: string | null;
    }
  /** Preflight passed; the new version is being built or laid down. */
  | { readonly kind: "stage" }
  /** `current` has been flipped and the service is being restarted. */
  | { readonly kind: "restart" }
  /** The restart returned; the health gate is now polling. */
  | { readonly kind: "verify" }
  /** The health gate passed. */
  | { readonly kind: "pass" }
  /**
   * The health gate failed. `rollbackTo` is the version directory still on disk to fall back to, or
   * null when there is none — and null is what turns the FIRST failure straight into `stuck`.
   */
  | {
      readonly kind: "fail";
      readonly reason: string;
      readonly logTail: string;
      readonly recovery: string;
      readonly rollbackTo: string | null;
    }
  /** Preflight or staging gave up. Nothing had moved, so the record returns to `idle` with a reason. */
  | { readonly kind: "abort"; readonly reason: string }
  /** Nobody is driving this run any more (see `bridge/update-run.ts`'s staleness rule). */
  | { readonly kind: "interrupt"; readonly reason: string };

/** The record a machine that has never updated starts from. */
export function idleRun(now: number): UpdateRun {
  return {
    schema: UPDATE_RUN_SCHEMA,
    state: "idle",
    from: null,
    to: null,
    startedAt: now,
    updatedAt: now,
    pid: 0,
    attempt: 0,
  };
}

/** A transition this machine has no meaning for. Thrown rather than ignored: a silently dropped
 *  event is a run that reports a state it never reached. */
class BadTransition extends Error {
  constructor(state: UpdateRunState, kind: RunEvent["kind"]) {
    super(`update run: no transition for \`${kind}\` from \`${state}\``);
  }
}

function expect(run: UpdateRun, kind: RunEvent["kind"], states: readonly UpdateRunState[]): void {
  if (!states.includes(run.state)) throw new BadTransition(run.state, kind);
}

/** `run` with the fields every transition rewrites, and the optional ones cleared. */
function moved(run: UpdateRun, state: UpdateRunState, now: number): UpdateRun {
  return { ...run, state, updatedAt: now };
}

/**
 * The whole state machine: `idle` → `preflight` → `staging` → `restarting` → `verifying` →
 * `done` | `rolled-back` | `stuck` | `interrupted`.
 *
 * **There is exactly one rollback.** A `fail` while `attempt` is 0 does not end the run — it puts it
 * back into `restarting` with `attempt` 1, which is the rollback restart. A `fail` after that is
 * `stuck`: the record carries the log tail and the manual recovery command, and nothing restarts
 * again. A loop of restarts on a machine that will not come up turns one fault into an outage, and
 * the counter is the only thing that stops it.
 *
 * `from` and `to` always name the run's FORWARD intent, whatever the attempt — `attempt > 0` is how
 * a reader knows the run is heading back to `from` rather than on to `to`.
 */
export function reduce(run: UpdateRun, event: RunEvent, now: number): UpdateRun {
  switch (event.kind) {
    case "begin": {
      if (inFlight(run.state)) throw new BadTransition(run.state, event.kind);
      const begun: UpdateRun = {
        schema: UPDATE_RUN_SCHEMA,
        state: "preflight",
        from: event.from,
        to: event.to,
        startedAt: now,
        updatedAt: now,
        pid: event.pid,
        attempt: 0,
      };
      // Assigned, never conditionally spread: a run with no id must carry NO such key rather than one
      // whose value is `undefined`, or it would serialise as a key the reader has to guess about.
      const id = event.runId ?? null;
      return id === null || id === "" ? begun : { ...begun, runId: id };
    }
    case "stage":
      expect(run, event.kind, ["preflight"]);
      return moved(run, "staging", now);
    case "restart":
      expect(run, event.kind, ["staging"]);
      return moved(run, "restarting", now);
    case "verify":
      expect(run, event.kind, ["restarting"]);
      return moved(run, "verifying", now);
    case "pass":
      expect(run, event.kind, ["verifying"]);
      // The rollback's own health check passing is not a successful update. It is the fallback
      // holding, which is a different sentence and a different colour on the phone.
      return moved(run, run.attempt === 0 ? "done" : "rolled-back", now);
    case "fail": {
      expect(run, event.kind, ["verifying"]);
      const failed = { ...moved(run, "stuck", now), reason: event.reason, logTail: event.logTail };
      if (run.attempt > 0 || event.rollbackTo === null) {
        return { ...failed, recovery: event.recovery };
      }
      return { ...failed, state: "restarting", attempt: run.attempt + 1 };
    }
    case "abort":
      expect(run, event.kind, ["preflight", "staging"]);
      // `idle`, not a terminal failure: nothing was flipped and nothing was restarted, so there is
      // no state on this machine for an operator to recover from — only a reason to read.
      return { ...moved(run, "idle", now), reason: event.reason };
    case "interrupt":
      if (!inFlight(run.state)) throw new BadTransition(run.state, event.kind);
      return { ...moved(run, "interrupted", now), reason: event.reason };
  }
}

// ── The record on disk ───────────────────────────────────────────────────────

/** The file mode the record and the lock are written with. Both name a pid and a version path. */
const RUN_FILE_MODE = 0o600;

/**
 * Write the record, atomically: a scratch file beside it, then one `rename(2)` onto the real name.
 * A reader — the bridge on its snapshot poll, the standby door on the phone's — therefore sees the
 * old record or the new one and never half of either.
 */
export function writeRun(files: Files, stateDir: string, run: UpdateRun): void {
  const at = updateRunPath(stateDir);
  const scratch = `${at}.tmp`;
  files.mkdirp(stateDir, 0o700);
  files.write(scratch, `${JSON.stringify(run, null, 2)}\n`, RUN_FILE_MODE);
  files.rename(scratch, at);
}

/** The record on disk as of `now`, resolved through the staleness rule, or null when there is none. */
export function readRun(
  files: Files,
  stateDir: string,
  now: number,
  alive: (pid: number) => boolean,
): UpdateRun | null {
  const run = parseUpdateRun(files.read(updateRunPath(stateDir)));
  return run === null ? null : resolveUpdateRun(run, now, alive(run.pid));
}

// ── The lock ─────────────────────────────────────────────────────────────────

/** Whether a run may start, and the sentence explaining a refusal. */
export type LockVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly held: UpdateLock };

/**
 * May a new run start?
 *
 * A lock whose pid is alive holds, whatever its age — a long build is not a stuck one. A lock older
 * than ten minutes whose pid is gone does not hold: it is the crash, the kill or the reboot, and the
 * same single rule `bridge/update-run.ts` reads a stale marker with. A YOUNG lock with a dead pid
 * still holds, so a retry cannot race the tail of a run that is only just finishing.
 */
export function lockVerdict(held: UpdateLock | null, now: number, alive: boolean, staleAfterMs: number): LockVerdict {
  if (held === null) return { ok: true };
  if (!alive && now - held.at >= staleAfterMs) return { ok: true };
  const who = alive ? `pid ${held.pid} is still running it` : `pid ${held.pid} took it`;
  return {
    ok: false,
    held,
    reason: `another update is in flight — ${who} at ${new Date(held.at).toISOString()}`,
  };
}

/** The lock on disk, or null. */
export function readLock(files: Files, stateDir: string): UpdateLock | null {
  return parseUpdateLock(files.read(updateLockPath(stateDir)));
}

/** Take the lock for `pid`. The caller has already asked {@link lockVerdict} whether it may. */
export function takeLock(files: Files, stateDir: string, pid: number, now: number): void {
  files.mkdirp(stateDir, 0o700);
  files.write(updateLockPath(stateDir), `${JSON.stringify({ pid, at: now })}\n`, RUN_FILE_MODE);
}

/** Drop the lock. Always, on every exit path — a run that ends holding one blocks the next retry. */
export function releaseLock(files: Files, stateDir: string): void {
  files.remove(updateLockPath(stateDir));
}

// ── The health gate ──────────────────────────────────────────────────────────

/** The env name that moves the health budget, and the default it moves off. */
export const HEALTH_TIMEOUT_ENV = "COLLIE_UPDATE_HEALTH_TIMEOUT_MS";
/**
 * 30 s, which is a MEASURED bound and not a law: it has to clear a cold start on the slowest lane
 * actually in use, and a timeout tuned on fast hardware turns a healthy slow machine into a spurious
 * rollback. The slowest lane measured so far (minibuch, the tmux mux) takes **190 ms** from unit stop
 * to listening, so 30 s is two orders of magnitude of headroom and stays the default.
 * `COLLIE_UPDATE_HEALTH_TIMEOUT_MS` is how a machine slower than that says so.
 */
export const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
/** How often the gate asks. `/api/health` answers in milliseconds; a second between tries is polite. */
export const HEALTH_POLL_MS = 1_000;

export function healthTimeoutMs(env: Environment): number {
  const asked = Number.parseInt(env[HEALTH_TIMEOUT_ENV] ?? "", 10);
  return Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_HEALTH_TIMEOUT_MS;
}

/** What `/api/health` said, flattened — a request that never landed is a failure with a sentence. */
export type HealthAnswer =
  | { readonly ok: true; readonly version: string; readonly deposed: boolean }
  | { readonly ok: false; readonly reason: string };

/** The health gate's verdict on one answer. */
export type HealthVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Did the service come up as the version we flipped to?
 *
 * Three ways to fail, and the third is the one that gets missed: a DEPOSED pack member answers, and
 * answering is not the same as being live (`bridge/pack/deposed.ts` — a deposed collie serves one
 * page and fails its health check). Counting that as a successful update would leave the operator on
 * a machine that routes nothing.
 */
export function healthVerdict(answer: HealthAnswer, version: string, commit: string): HealthVerdict {
  if (!answer.ok) return { ok: false, reason: answer.reason };
  const up = aliveVerdict(answer);
  if (!up.ok) return up;
  if (!answersThisBuild(answer.version, version, commit)) {
    return { ok: false, reason: `the service came back as ${answer.version}, not ${version}` };
  }
  return { ok: true };
}

/**
 * The weaker half of the gate: the service answers and is not deposed, whatever version it names.
 *
 * This is what the ROLLBACK is verified against. The version a rolled-back collie must answer with
 * is its own — the one that was running before this update — and the runner deliberately does not
 * carry that string: it is whatever that build stamped itself, read from a directory this process
 * did not build. "It came back up" is the whole question there.
 */
export function aliveVerdict(answer: HealthAnswer): HealthVerdict {
  if (!answer.ok) return { ok: false, reason: answer.reason };
  if (answer.deposed) {
    return { ok: false, reason: "the service answers, but as a DEPOSED pack member — nothing routes there" };
  }
  return { ok: true };
}

// ── Waiting on somebody else's run ───────────────────────────────────────────
// The runner is detached, so a caller that wants to know how it ended cannot await a promise — it
// reads the record. `collie pack update` does exactly that when it updates the lead before any peer
// (M15/06): it hands off through the same path `collie update` uses and then waits here.

/** How a run somebody else was driving ended, as a waiting caller reads it. */
export type RunOutcome =
  | { readonly kind: "done" }
  /** A terminal state that is not `done` — the reason and the recovery are the record's own. */
  | {
      readonly kind: "failed";
      readonly state: UpdateRunState;
      readonly reason: string;
      readonly recovery: string | null;
    }
  /** The budget ran out while the run was still in flight, or there was no record to read at all. */
  | { readonly kind: "timeout"; readonly reason: string };

/** The clock, the wait and the two budgets {@link awaitRunRecord} polls on. */
export interface RunWait {
  now(): number;
  sleep(ms: number): Promise<void>;
  readonly timeoutMs: number;
  readonly pollMs: number;
}

/**
 * Poll `read` until the run it names reaches a terminal state, or the budget runs out.
 *
 * The record is the only thing a waiter may read: the runner is another process, so its exit code is
 * not ours to collect and its output goes to the service log. `read` is expected to have applied the
 * staleness rule already ({@link readRun}), which is what turns a killed updater into `interrupted`
 * rather than a wait that runs to the full budget.
 *
 * The number of polls is bounded as well as the clock, so a caller whose clock does not move — every
 * test in this tree — still terminates.
 */
export async function awaitRunRecord(read: () => UpdateRun | null, e: RunWait): Promise<RunOutcome> {
  const deadline = e.now() + e.timeoutMs;
  const tries = Math.max(1, Math.ceil(e.timeoutMs / Math.max(1, e.pollMs)));
  let last: UpdateRun | null = null;
  for (let i = 0; i < tries; i++) {
    last = read();
    if (last !== null && !inFlight(last.state)) return settledOutcome(last);
    if (i + 1 >= tries || e.now() >= deadline) break;
    await e.sleep(e.pollMs);
  }
  const where = last === null ? "no update record was ever written" : `it is still ${last.state}`;
  return { kind: "timeout", reason: `the updater did not finish within ${Math.round(e.timeoutMs / 1000)}s — ${where}` };
}

/** A terminal record, read as an outcome. `idle` is an aborted preflight: nothing moved, but nothing landed either. */
function settledOutcome(run: UpdateRun): RunOutcome {
  if (run.state === "done") return { kind: "done" };
  return {
    kind: "failed",
    state: run.state,
    reason: run.reason ?? `the run ended as ${run.state}`,
    recovery: run.recovery ?? null,
  };
}

// ── Where the gate knocks ────────────────────────────────────────────────────
// `http://127.0.0.1:<port>/api/health` is right for most installs and WRONG for two real ones, both
// measured on live machines rather than imagined:
//
//   1. A wide bind. `COLLIE_HOST=100.64.0.8` with `COLLIE_ALLOW_NON_LOOPBACK_BIND=1` is a listener
//      that is not on loopback at all, so the loopback URL connects to nothing.
//   2. A PEER. A collie that pins a lead serves its main port behind mutual TLS
//      (`peerListenerTls`, ADR 0013/§8.1), so a plain-HTTP GET there gets an empty reply — BoringSSL
//      refuses the handshake long before any route is reached.
//
// A peer's plain-HTTP door is its STANDBY door, and it answers `/standby/health` on both of its
// states. `503` there means "do not route to me", never "I am not up" — a cold door is the ordinary
// case for a peer that is not standing by — so the gate reads the STATUS as evidence of nothing and
// takes the build off the answer instead.

/** Where the health gate knocks, and which of the two answers it is about to read. */
export type ProbeTarget =
  | { readonly kind: "front-door"; readonly url: string }
  | { readonly kind: "standby"; readonly url: string };

/** The facts the rule is decided from. All four are read off this instance's own configuration. */
export interface ProbeConfig {
  /** `COLLIE_HOST` as configured. Empty ⇒ the loopback default, which is the usual case. */
  readonly host: string;
  readonly port: number;
  /** `COLLIE_STANDBY_PORT`, or null when this instance binds no second door. */
  readonly standbyPort: number | null;
  /** Does this collie pin a lead? A peer's front door is mutual TLS and answers no plain HTTP. */
  readonly pinsALead: boolean;
}

/**
 * The rule, pure: a peer with a standby door is asked there, and everything else is asked at its own
 * front door on the address it actually bound.
 *
 * A peer WITHOUT a standby door has no plain-HTTP surface at all, and the front-door URL is returned
 * for it deliberately: the gate then fails with the connection error, which is the honest report of
 * a configuration where nothing local can ask this machine how it is.
 */
export function probeTarget(c: ProbeConfig): ProbeTarget {
  if (c.pinsALead && c.standbyPort !== null) {
    // Loopback, always: the standby door binds `COLLIE_STANDBY_HOST` but this process is ON the
    // machine, and a door bound wide is reachable on loopback too.
    return { kind: "standby", url: `http://127.0.0.1:${c.standbyPort}${STANDBY_HEALTH_PATH}` };
  }
  const host = c.host.trim() === "" ? "127.0.0.1" : c.host.trim();
  return { kind: "front-door", url: `http://${host}:${c.port}/api/health` };
}

/** {@link ProbeConfig} read off this instance's environment and its trust store. */
export function probeConfigOf(env: Environment, files: Files, stateDir: string, port: number): ProbeConfig {
  const raw = files.read(trustStorePath(stateDir));
  const trust = raw === null ? null : parseTrustStore(raw);
  return {
    host: env.COLLIE_HOST ?? "",
    port,
    standbyPort: standbyPortOf(env),
    // The same fact `bridge/index.ts` builds its pinned listener from: a store that names a lead.
    pinsALead: trust !== null && trust.lead !== null,
  };
}

/** The health gate's one request, at whichever door {@link probeTarget} named. */
export function healthProbe(net: Net, target: ProbeTarget): () => Promise<HealthAnswer> {
  if (target.kind === "standby") return standbyAnswer(net, target.url);
  return async () => {
    const got = await net.getJson(target.url);
    if (!got.ok) return { ok: false, reason: got.failure.message };
    // SAFETY: `Net.getJson` hands back what `Response.json()` produced, which IS a JSON value by
    // construction. Both fields are checked here before use, and a body that carries neither reads
    // as "not up yet" — which is what an unparseable answer means to a gate that is polling.
    const body = got.value as { version?: string; deposed?: boolean };
    const version = body.version ?? "";
    if (version === "") return { ok: false, reason: "the health answer named no version" };
    return { ok: true, version, deposed: body.deposed === true };
  };
}

/**
 * The standby door's answer, read for the one thing the gate wants: what is running there.
 *
 * The header first, the body second. They carry the same string by construction
 * (`bridge/pack/standby.ts`), and reading both is what keeps this working against a peer whose door
 * predates the header — which, on the day of an update, is every peer being updated.
 */
function standbyAnswer(net: Net, url: string): () => Promise<HealthAnswer> {
  return async () => {
    const got = await net.probe(url, STANDBY_VERSION_HEADER);
    if (!got.ok) return { ok: false, reason: got.failure.message };
    // SAFETY: the parsed body of a JSON answer, with every field checked here before use. A body
    // that is not an object at all reads every one of them as `undefined`.
    const body = (got.body ?? {}) as { version?: string; state?: string };
    const version = got.header ?? body.version ?? "";
    if (version === "") {
      return { ok: false, reason: `the standby door answered ${got.status} without naming a version` };
    }
    // A deposed collie answers 503 here too, and its state word is the only thing that tells the two
    // apart. It is not up in the sense that matters: nothing routes to it.
    return { ok: true, version, deposed: body.state === "deposed" };
  };
}

// ── The log tail ─────────────────────────────────────────────────────────────

/** The tail's two bounds. The record is read by the phone; it is a hint, not an archive. */
export const LOG_TAIL_LINES = 40;
export const LOG_TAIL_BYTES = 8 * 1024;

/**
 * Keys whose VALUE is a credential wherever it appears — in a log line, a shell echo, an env dump.
 * The word may sit anywhere INSIDE the identifier, because that is how they are spelled in practice:
 * `COLLIE_PACK_SECRET`, `x-api-key`, `vapidPrivateKey`.
 */
const SECRET_KEY = /[A-Za-z0-9_.-]*(?:secret|token|password|passwd|passphrase|api[_-]?key|apikey|credential|authorization|auth[_-]?key|private[_-]?key|bearer)[A-Za-z0-9_.-]*/i;
/** `key: value`, `key=value`, `key = "value"` — the three spellings a log actually carries. */
const KEYED_SECRET = new RegExp(`(${SECRET_KEY.source})([ \\t]*[:=][ \\t]*)("[^"]*"|'[^']*'|\\S+)`, "gi");
/** A bare high-entropy run: 32+ of the alphabet a token, a hash or a base64url blob is drawn from. */
const BARE_SECRET = /\b[A-Za-z0-9_+/=-]{32,}\b/g;

export const REDACTED = "⟨redacted⟩";

/**
 * Strip anything credential-shaped out of `text`.
 *
 * This tail is written into a file the bridge serves and the phone renders, so it leaves the
 * machine. Two passes, deliberately blunt in the safe direction: a keyed value goes whatever it
 * looks like, and any long opaque run goes whether or not anything named it. Over-redacting a
 * commit sha in a log tail costs the operator nothing; under-redacting a bearer token costs them
 * their collie.
 */
export function scrubSecrets(text: string): string {
  return text.replaceAll(KEYED_SECRET, (_all, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .replaceAll(BARE_SECRET, REDACTED);
}

/** The last {@link LOG_TAIL_LINES} lines of `text`, capped at {@link LOG_TAIL_BYTES}. */
export function boundTail(text: string): string {
  const lines = text.split("\n").filter((l) => l !== "");
  const tail = lines.slice(-LOG_TAIL_LINES).join("\n");
  // From the END: the last lines are the ones that say why it failed.
  return tail.length <= LOG_TAIL_BYTES ? tail : tail.slice(tail.length - LOG_TAIL_BYTES);
}

/**
 * A bounded, scrubbed tail of the service's own log — `journalctl --user -u <unit>` where systemd
 * runs the service, and the unsupervised/launchd log file everywhere else.
 *
 * Best effort by construction: a failure to read the log is one blank field on a record that already
 * says what went wrong, and must never be what stops a rollback.
 */
export function serviceLogTail(
  deps: { readonly exec: Exec; readonly files: Files; readonly platform: string },
  unit: string,
  logPath: string,
): string {
  if (deps.platform === "linux" && deps.exec.which("journalctl") !== null) {
    const r = deps.exec.capture("journalctl", [
      "--user",
      "-u",
      unit,
      "-n",
      String(LOG_TAIL_LINES),
      "--no-pager",
    ]);
    if (r.found && r.code === 0) return scrubSecrets(boundTail(r.stdout));
  }
  return scrubSecrets(boundTail(deps.files.read(logPath) ?? ""));
}

// ── The launch seam ──────────────────────────────────────────────────────────

/** How the runner was detached, and with what. `note` is the line the transcript prints. */
export interface LaunchPlan {
  readonly kind: "systemd-run" | "setsid" | "fork";
  readonly command: string[];
  readonly note: string;
}

/**
 * The command that detaches the runner from whoever asked for the update.
 *
 * **Linux: `systemd-run --user --collect`.** The user manager owns the child, so it survives this
 * process, the shell that launched it and the bridge it is about to restart. `--collect` is what
 * keeps a transient unit that FAILED from lingering as garbage the operator has to `reset-failed`
 * by hand.
 *
 * **macOS: a `setsid` double fork.** Not launchd: submitting a job for a one-shot run that must
 * start now is more moving parts than the guarantee needs, and leaving the caller's process group is
 * the whole of what is required. `setsid` does the second half; the spawn is already detached with
 * its stdio pointed at a file.
 *
 * **Linux without `systemd-run` falls back to the same double fork**, and the record says so — an
 * unsupervised host is a real deployment (`cli/lifecycle.ts`'s `unsupervised` tier), not a
 * misconfiguration to refuse.
 */
export function launchPlan(a: {
  readonly platform: string;
  readonly binary: string;
  readonly args: readonly string[];
  readonly unit: string;
  readonly stamp: string;
  readonly hasSystemdRun: boolean;
  readonly hasSetsid: boolean;
}): LaunchPlan {
  if (a.platform === "linux" && a.hasSystemdRun) {
    return {
      kind: "systemd-run",
      command: [
        "systemd-run",
        "--user",
        "--collect",
        "--unit",
        `${a.unit}-update-${a.stamp}`,
        a.binary,
        ...a.args,
      ],
      note: `handed off to systemd-run --user --collect (transient unit ${a.unit}-update-${a.stamp})`,
    };
  }
  if (a.hasSetsid) {
    return {
      kind: "setsid",
      command: ["setsid", a.binary, ...a.args],
      note: "handed off to a setsid double-forked child",
    };
  }
  return {
    kind: "fork",
    command: [a.binary, ...a.args],
    note: "handed off to a detached child (neither systemd-run nor setsid is available here)",
  };
}

// ── The driver ───────────────────────────────────────────────────────────────

/** What the runner is being asked to do. Everything here is a directory NAME or a version string. */
export interface ApplyPlan {
  /** The version directory to make live. */
  readonly to: string;
  /** The version directory still on disk to fall back to, or null when this is the first one. */
  readonly from: string | null;
  /** The dotted version `to` must ANSWER with, and the commit it was built from (may be ""). */
  readonly version: string;
  readonly commit: string;
  /** The command carried by `stuck` — the one thing an operator can run when nothing else will. */
  readonly recovery: string;
}

/** Every impure thing the driver does, injected. No systemd, no service and no clock in a test. */
export interface ApplyEffects {
  /** Point `current` at a version directory. False when the rename itself failed. */
  readonly flip: (dir: string) => boolean;
  readonly restart: () => Promise<boolean>;
  readonly health: () => Promise<HealthAnswer>;
  /** Retention, called on success and ONLY on success — never on a run that rolled back. */
  readonly prune: () => void;
  readonly logTail: () => string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Persist a transition. Called on every one of them. */
  readonly write: (run: UpdateRun) => void;
  readonly timeoutMs: number;
  readonly pollMs: number;
}

/**
 * Poll the health gate until it passes or the budget runs out. A restart that failed outright still
 * polls: `systemctl restart` can report non-zero on a unit that comes up a second later, and the
 * question this gate asks is "is it answering", not "did the command exit 0".
 */
async function awaitHealth(e: ApplyEffects, judge: (a: HealthAnswer) => HealthVerdict): Promise<HealthVerdict> {
  const deadline = e.now() + e.timeoutMs;
  let last: HealthVerdict = judge(await e.health());
  while (!last.ok && e.now() < deadline) {
    await e.sleep(e.pollMs);
    last = judge(await e.health());
  }
  return last;
}

/**
 * Flip, restart, verify — and roll back once if it does not come up.
 *
 * `start` is the record this run reached before it detached (`staging`). Every transition below is
 * written before the next effect runs, so a reader that arrives mid-flight always finds the state the
 * runner is actually in.
 */
export async function driveApply(e: ApplyEffects, plan: ApplyPlan, start: UpdateRun): Promise<UpdateRun> {
  let run = reduce(start, { kind: "restart" }, e.now());
  e.write(run);

  const fail = (reason: string): UpdateRun =>
    reduce(
      run,
      {
        kind: "fail",
        reason,
        logTail: e.logTail(),
        recovery: plan.recovery,
        // The rollback target is gone the moment we are already on it — a second failure has
        // nowhere left to go, and saying so is what makes `stuck` the honest answer.
        rollbackTo: run.attempt === 0 ? plan.from : null,
      },
      e.now(),
    );

  if (!e.flip(plan.to)) {
    // Nothing moved, so there is nothing to roll back: `current` still points where it always did,
    // and the service is still the one that was running. `stuck` names it and stops.
    run = reduce(run, { kind: "verify" }, e.now());
    run = reduce(
      run,
      {
        kind: "fail",
        reason: `\`current\` could not be pointed at ${plan.to} — nothing was swapped`,
        logTail: e.logTail(),
        recovery: plan.recovery,
        rollbackTo: null,
      },
      e.now(),
    );
    e.write(run);
    return run;
  }
  await e.restart();
  run = reduce(run, { kind: "verify" }, e.now());
  e.write(run);

  const verdict = await awaitHealth(e, (a) => healthVerdict(a, plan.version, plan.commit));
  if (verdict.ok) {
    run = reduce(run, { kind: "pass" }, e.now());
    e.write(run);
    // Retention runs HERE and nowhere else: the version this run may still have needed is only
    // expendable once the new one has answered. A rolled-back run prunes nothing at all.
    if (run.state === "done") e.prune();
    return run;
  }

  run = fail(verdict.reason);
  e.write(run);
  if (run.state !== "restarting") return run;

  // The one rollback. `plan.from` is non-null here by the reducer's own rule.
  const back = plan.from ?? plan.to;
  if (!e.flip(back)) {
    run = { ...run, state: "stuck", updatedAt: e.now(), recovery: plan.recovery };
    e.write(run);
    return run;
  }
  await e.restart();
  run = reduce(run, { kind: "verify" }, e.now());
  e.write(run);

  // The rolled-back version is the one that WAS running, so its own build is what it answers with —
  // never the version we tried to install. `aliveVerdict` asks the only question left: is it up?
  const settled = await awaitHealth(e, aliveVerdict);
  run = settled.ok
    ? reduce(run, { kind: "pass" }, e.now())
    : reduce(
        run,
        { kind: "fail", reason: settled.reason, logTail: e.logTail(), recovery: plan.recovery, rollbackTo: null },
        e.now(),
      );
  e.write(run);
  return run;
}
