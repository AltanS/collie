import { compareSemver, majorOf, parsePrereleaseTag } from "../update.ts";
import type { PeerRunReport, PreflightReport } from "../update-action.ts";
import { firstRed } from "../update-action.ts";
import type { UpdateRun } from "../update-run.ts";
import { inFlight } from "../update-run.ts";

// THE PACK FOLLOWS THE PHONE (M16/04): a peer levels itself to the release its lead is running.
//
// ── WHAT DOES NOT HAPPEN HERE, AND WHY IT MATTERS MORE THAN WHAT DOES ────────
// No code crosses the pack link. `.adr/0016-updates-ride-the-operators-ssh.md` says code
// distribution to a peer is credentialed by the operator's own SSH and by nothing else, and this
// module keeps both halves of that: the peer pulls its artifact from **GitHub**, over anonymous
// HTTPS, so no lead is ever a distribution point; and the lead sends no ref, no URL and no command —
// only the version it is itself running, and a member name with an opaque run id.
//
// There is therefore no new `/pack/v1/*` route, no inbound update surface on a peer, and no verb.
// Two additive-optional REQUEST headers ride the sweep the lead already makes (PACK_PROTOCOL.md §6,
// §20), `X-Pack-Protocol` stays `1`, and **a peer that ignores both headers is a correct peer**.
//
// ── EVERY GUARD IS ON THE PEER ───────────────────────────────────────────────
// Neither header is an order. The lead states a fact and hands out a turn; the peer decides, and it
// decides eight times before it spawns anything. That asymmetry is the whole security argument: a
// lead that is buggy, or that has been taken, can at worst cause a peer to refuse eight times and
// try at most once an hour.

/**
 * `X-Pack-Lead-Release: <bare version>` — the release the LEAD is itself running, sent only when
 * that version is a strict release and the lead's own health gate has settled it (§20).
 *
 * It cannot express any other version: it is read from the same `collieVersionBare` the lead answers
 * `hello` and `/api/health` with. A peer that receives a version its lead is not running is a peer
 * whose lead lied about itself, which gains an attacker nothing they did not already have (§8.5).
 *
 * Absent means the lead is on a dev or prerelease build, or is mid-run — and absent means the peer
 * does nothing at all.
 */
export const LEAD_RELEASE_HEADER = "X-Pack-Lead-Release";

/**
 * `X-Pack-Update-Turn: <member-name>;<run-id>` — whose turn it is, and which run it belongs to (§20).
 *
 * It carries **no version, no ref, no URL and no command**: a member name and an opaque run id,
 * nothing else. It is a mutex token with a receipt, sent to at most one member at a time, and a peer
 * ignores a turn that does not name itself — the lead cannot address one peer and have another act.
 */
export const UPDATE_TURN_HEADER = "X-Pack-Update-Turn";

/** The separator inside {@link UPDATE_TURN_HEADER}'s value. A member id never contains one. */
const TURN_SEPARATOR = ";";

/** At most one self-level attempt per hour, whatever the headers say. See {@link followDecision}. */
export const FOLLOW_ATTEMPT_INTERVAL_MS = 60 * 60 * 1000;

/** How many sweeps a member may miss before its turn moves on and it reads as `unreachable`. */
export const TURN_MISSED_SWEEPS = 3;

// ── The lead's half: what it may state, and to whom ──────────────────────────

/**
 * The value of {@link LEAD_RELEASE_HEADER}, or `null` when this lead may state nothing.
 *
 * **Settled** is the lead's own health gate having passed for the version it is running: the last
 * `UpdateRun` reached `done` for this version, or the lead has been running this version since
 * before any recorded run. A lead mid-flight (`preflight`, `staging`, `restarting`, `verifying`)
 * states nothing, because a lead that announced a version it has not finished taking would send its
 * whole pack after a release it may itself be about to roll back from.
 */
export function leadReleaseHeader(a: { version: string; run: UpdateRun | null }): string | null {
  const bare = bareVersion(a.version);
  if (bare === null) return null;
  // A dev or prerelease build states nothing. `parsePrereleaseTag` answers a non-null `prerelease`
  // for `1.4.1-dev+ab12cd3`, which is exactly the build the dev lane runs.
  if (!isStrictRelease(bare)) return null;
  const run = a.run;
  if (run === null) return bare;
  if (inFlight(run.state)) return null;
  // A run that ended anywhere but `done` leaves this machine on whatever it fell back to. It may
  // still be a perfectly good release — the version string is the fact, and the run is only asked
  // whether it is still moving toward something else.
  if (run.state === "done" && run.to !== null && bareVersion(run.to) !== bare) return null;
  return bare;
}

/** The value of {@link UPDATE_TURN_HEADER} for one member. One spelling, so the parser cannot drift. */
export function formatTurn(memberName: string, runId: string): string {
  return `${memberName}${TURN_SEPARATOR}${runId}`;
}

/** A turn as the peer reads it, or `null` for every shape that is not one. Absent means closed. */
export function parseTurn(raw: string | null | undefined): { member: string; runId: string } | null {
  if (raw === null || raw === undefined) return null;
  const at = raw.indexOf(TURN_SEPARATOR);
  if (at <= 0) return null;
  const member = raw.slice(0, at).trim();
  const runId = raw.slice(at + 1).trim();
  if (member === "" || runId === "") return null;
  // Anything after a second separator is a value this build does not know how to read, and a header
  // read half-way is a header that means something its sender did not say.
  if (runId.includes(TURN_SEPARATOR)) return null;
  return { member, runId };
}

// ── The peer's half: the eight guards ────────────────────────────────────────

/** Why a peer is not following. Every refusal is recorded, and every one of them names itself. */
export type FollowRefusal =
  | "own-build-not-a-release"
  | "lead-states-nothing"
  | "not-higher"
  | "crosses-a-major"
  | "already-rolled-back"
  | "rate-limited"
  | "no-turn"
  | "preflight-red"
  | "tag-does-not-resolve"
  | "already-running";

/** What the peer decided, and the sentence that goes in the record beside it. */
export type FollowDecision =
  | { readonly kind: "follow"; readonly tag: string; readonly runId: string }
  | { readonly kind: "refuse"; readonly reason: FollowRefusal; readonly detail: string };

const refuse = (reason: FollowRefusal, detail: string): FollowDecision => ({ kind: "refuse", reason, detail });

/** Everything the pure guards decide from. All of it is already on this machine. */
export interface FollowFacts {
  /** This peer's own running version, bare — the same string it answers `hello` with. */
  readonly own: string;
  /** This peer's own member id, which is the name a turn addresses. */
  readonly self: string;
  /** {@link LEAD_RELEASE_HEADER} as it arrived, or null. */
  readonly leadRelease: string | null;
  /** {@link UPDATE_TURN_HEADER} as it arrived, or null. */
  readonly turn: string | null;
  /** This peer's own run record, which is the whole of its memory. There is no second state file. */
  readonly run: UpdateRun | null;
  readonly now: number;
}

/**
 * Guards 1 to 5, plus the turn and the rate limit — everything decidable without spending a
 * subprocess or a socket, in the order a refusal is cheapest to make.
 *
 * The preflight (guard 6) and the tag resolution (guard 8) are deliberately NOT here: they cost a
 * subprocess, and the spec's own sentence for the preflight is "synchronously, immediately before
 * spawning the updater" — a check run and then sat on is a check about a machine that has moved.
 * {@link followDecision} runs them in that position.
 */
export function followGuards(f: FollowFacts): FollowDecision {
  // ── 1. RELEASE BUILDS ONLY ─────────────────────────────────────────────────
  // A `1.4.1-dev+ab12cd3` build never self-levels, full stop. **This is what keeps the dev lane
  // still**: the dev pack's peer is the `~/apps/collie-next` checkout on minibuch, built from a
  // working copy that its operator is editing, and a machine that levelled itself to a published
  // release would silently discard the very build it exists to test.
  const own = bareVersion(f.own);
  if (own === null || !isStrictRelease(own)) {
    return refuse("own-build-not-a-release", `this build (${f.own}) is not a strict release, so it never self-levels`);
  }

  // ── 2. THE HEADER MUST BE PRESENT AND A STRICT RELEASE ────────────────────
  const lead = f.leadRelease === null ? null : bareVersion(f.leadRelease);
  if (lead === null || !isStrictRelease(lead)) {
    return refuse("lead-states-nothing", "the lead states no settled release, so there is nothing to follow");
  }

  // ── 3. STRICTLY HIGHER, BY SEMVER ─────────────────────────────────────────
  // Equal is nothing. Lower is nothing, ever: there is no downgrade path here and no flag that makes
  // one, which is why nothing on this link can ever step a peer down.
  if (compareSemver(lead, own) <= 0) {
    return refuse("not-higher", `the lead runs ${lead}, which is not higher than this machine's ${own}`);
  }

  // ── 4. NOT A MAJOR CROSSING ───────────────────────────────────────────────
  // ADR 0020's consent is a named operator choice, and a header is not one. A lead on a higher major
  // is reported as skew (§7.1) and left alone.
  const ourMajor = majorOf(own);
  const theirMajor = majorOf(lead);
  if (ourMajor !== null && theirMajor !== null && theirMajor !== ourMajor) {
    return refuse("crosses-a-major", `the lead runs ${lead}, which crosses a major from ${own}`);
  }

  // ── 7. THE TURN ───────────────────────────────────────────────────────────
  // Read before the two expensive guards, because a peer with no turn has nothing to spend a
  // subprocess on. A turn that names somebody else is the same as no turn: the lead cannot address
  // one peer and have another act.
  const turn = parseTurn(f.turn);
  if (turn === null || turn.member !== f.self) {
    return refuse("no-turn", "no turn names this member, so it waits");
  }

  // ── 5. NOT A TAG THIS PEER ALREADY ROLLED BACK FROM, IN THIS RUN ──────────
  // The memory is the peer's own `<state dir>/update.json`, keyed by **(tag, run id)**. There is no
  // second state file, and there is deliberately no automatic retry: a NEW run id — which only a
  // fresh confirm on the phone produces — is what permits exactly one further attempt at that tag.
  const wanted = `v${lead}`;
  if (rolledBackFrom(f.run, lead, turn.runId)) {
    return refuse(
      "already-rolled-back",
      `this machine already rolled back from ${wanted} in this run; a new confirm on the phone permits one more attempt`,
    );
  }

  // A run that is still being driven is a run this must not race. The updater's own lock says the
  // same thing one layer down; saying it here means the refusal has a reason rather than a lock
  // error.
  if (f.run !== null && inFlight(f.run.state)) {
    return refuse("already-running", `an update is already running here (${f.run.state})`);
  }

  // ── THE RATE LIMIT ────────────────────────────────────────────────────────
  // At most one self-level attempt per hour, regardless of what the headers say. This is not a
  // tuning knob: it is the guard against a buggy or hostile lead cycling a peer through restarts,
  // and it is on the peer because that is the only side that can enforce it. The clock is the peer's
  // own last attempt, read off the run record, so it survives this machine's restart.
  const since = attemptAgeMs(f.run, f.now);
  if (since !== null && since < FOLLOW_ATTEMPT_INTERVAL_MS) {
    const minutes = Math.ceil((FOLLOW_ATTEMPT_INTERVAL_MS - since) / 60_000);
    return refuse("rate-limited", `this machine attempted an update ${Math.floor(since / 60_000)} minutes ago; it tries again in ${minutes}`);
  }

  return { kind: "follow", tag: wanted, runId: turn.runId };
}

/** The two guards that cost a subprocess, injected so the decision is testable without spawning one. */
export interface FollowEffects {
  /**
   * Run `collie update --check --local --json --to-tag <tag>` **now** and answer its report.
   *
   * Two guards ride this one run, and it is one run on purpose. Guard 6 is the report's own verdict:
   * not the cached one from §19 — that is what the lead's page showed a moment ago — but the fresh
   * one, because a disk that filled in between is exactly the case this catches. Guard 8 is the
   * `upstream` check inside it, which resolves `<tag>` against **this peer's own** configured repo
   * through `listTags()` and `anonymousTagUrl()` — anonymous HTTPS to a public repository, no
   * credential of any kind. `null` means the check could not be run, which refuses.
   */
  readonly preflight: (tag: string) => Promise<PreflightReport | null>;
}

/** The id of the `upstream` check — the one that resolves the tag (`cli/update-check.ts`). */
export const UPSTREAM_CHECK_ID = "upstream";

/**
 * The whole decision: the pure guards, then the fresh preflight, then the tag.
 *
 * Nothing is spawned here. The caller ({@link PackFollower}) owns the one detached-updater spawn,
 * because there must be exactly one spawner in this process and it is already
 * `updateStartCommand(...)`.
 */
export async function followDecision(f: FollowFacts, e: FollowEffects): Promise<FollowDecision> {
  const guarded = followGuards(f);
  if (guarded.kind === "refuse") return guarded;

  // ── 6. THIS PEER'S OWN PREFLIGHT, RE-RUN NOW ──────────────────────────────
  const report = await e.preflight(guarded.tag);
  if (report === null) {
    return refuse("preflight-red", "this machine's own preflight could not be run, which is not the same as green");
  }
  const red = firstRed(report);
  if (red !== null) {
    // ── 8. THE TAG MUST RESOLVE UPSTREAM ────────────────────────────────────
    // The same run answers both: the `upstream` check IS the tag resolution when the report was
    // asked for one exact release, so a tag the lead named and the peer's repo does not publish
    // lands here with the remote's own sentence rather than a guess of ours.
    const reason = red.id === UPSTREAM_CHECK_ID ? "tag-does-not-resolve" : "preflight-red";
    return refuse(reason, red.reason);
  }
  return guarded;
}

// ── The peer runtime ─────────────────────────────────────────────────────────

/** What the follower needs from the process around it. Every one of them is a seam index.ts fills. */
export interface PackFollowerDeps {
  /** This peer's own bare version and member id, resolved once at boot like every other identity. */
  readonly self: () => { readonly version: string; readonly self: string };
  /** The run record on disk as of now, resolved. Re-read every time — that is the memory. */
  readonly run: () => UpdateRun | null;
  readonly preflight: FollowEffects["preflight"];
  /**
   * Spawn the detached updater with `--to-tag <tag> --run-id <id>`.
   *
   * It is `updateStartCommand(...)` and it is the SAME spawn the phone's own button takes: the same
   * lock, the same staging, the same health gate, the same one rollback. There is exactly one
   * detached-updater spawner in this process, and adding a second would be adding a second answer to
   * "what does an update do here".
   */
  readonly start: (a: { tag: string; runId: string }) => { ok: true } | { ok: false; reason: string };
  readonly now?: () => number;
}

/**
 * The peer's side of the follow, driven by the headers on the sweep its lead already makes.
 *
 * **It arms no timer.** `bridge/pack/router.ts` calls {@link PackFollower.observe} when a snapshot
 * request carries the headers, so the follow rides the poll for the same reason the sweep does
 * (§10.1, §11): a second timer would be a second opinion about how often anything happens.
 */
export class PackFollower {
  private readonly now: () => number;
  /** One decision in flight at a time. A sweep that lands mid-decision is skipped, never queued. */
  private deciding = false;
  private lastDecision: FollowDecision | null = null;

  constructor(private readonly deps: PackFollowerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The last thing this peer decided, for the log and for the tests. Never on the wire. */
  last(): FollowDecision | null {
    return this.lastDecision;
  }

  /**
   * One sweep's worth of headers. Never throws and never awaits on the request path: the router
   * hands the headers over and answers its snapshot, exactly as it does today.
   */
  observe(headers: { readonly leadRelease: string | null; readonly turn: string | null }): void {
    if (this.deciding) return;
    const id = this.deps.self();
    const facts: FollowFacts = {
      own: id.version,
      self: id.self,
      leadRelease: headers.leadRelease,
      turn: headers.turn,
      run: this.deps.run(),
      now: this.now(),
    };
    // The cheap guards run synchronously, so a peer with nothing to do costs one comparison per
    // sweep and never a promise.
    const guarded = followGuards(facts);
    if (guarded.kind === "refuse") {
      this.lastDecision = guarded;
      return;
    }
    this.deciding = true;
    void this.decide(facts);
  }

  /** The expensive half, off the request path. Never throws — a follow that did would take a peer's
   *  own snapshot answer down with it, and §10.2's "failure is a value" has to hold here too. */
  private async decide(facts: FollowFacts): Promise<void> {
    try {
      const decision = await followDecision(facts, { preflight: this.deps.preflight });
      this.lastDecision = decision;
      if (decision.kind === "follow") {
        const started = this.deps.start({ tag: decision.tag, runId: decision.runId });
        if (!started.ok) {
          this.lastDecision = refuse("preflight-red", `the updater could not be started: ${started.reason}`);
        }
      }
    } catch (err) {
      this.lastDecision = refuse("preflight-red", err instanceof Error ? err.message : String(err));
    } finally {
      this.deciding = false;
    }
  }
}

// ── The lead's turn queue ────────────────────────────────────────────────────

/** One peer's leg of a pack-wide run, as `GET /api/update/check` reports it. */
export type PeerLegState = "waiting" | "updating" | "done" | "rolled-back" | "unreachable";

/** One leg on the wire. Every field past the name is optional — a leg the lead knows little about. */
export interface PeerLeg {
  readonly name: string;
  readonly state: PeerLegState;
  readonly version: string | null;
  readonly reason?: string;
  readonly updatedAt?: number;
}

/** What the lead knows about one member on one sweep. All of it banked, none of it dialled for. */
export interface TurnMember {
  readonly memberId: string;
  /** The trust store's `enrolledAt` — the only stable ordering the roster carries (§18). */
  readonly enrolledAt: number;
  /** The version the sweep last banked, or null when the member has reported none. */
  readonly version: string | null;
  /** That member's own banked preflight verdict, or `null` — which is **unknown**, never green. */
  readonly verdict: "green" | "amber" | "red" | null;
  /** Did this member answer THIS sweep? Three consecutive misses release its turn. */
  readonly answered: boolean;
  /** That member's own run record as it reported it (§20), or null. */
  readonly run: PeerRunReport | null;
}

const PEER_IN_FLIGHT: ReadonlySet<string> = new Set(["preflight", "staging", "restarting", "verifying"]);
const PEER_FAILED: ReadonlySet<string> = new Set(["rolled-back", "stuck", "interrupted"]);

/**
 * The lead's turn queue — **in memory, and never persisted**.
 *
 * §18.9's argument for `lastDialledAt` applies here unchanged: the queue describes a *process*, and
 * a persisted turn would survive the restart it is meant to describe. So a lead that restarts
 * re-derives the queue from the roster and re-grants, and a member that has already reported the new
 * version is simply not in it.
 *
 * It grants one turn at a time, in trust-store enrolment order — stated so it is stable and
 * explainable rather than incidental.
 */
export class UpdateTurns {
  private run: { readonly runId: string; readonly target: string } | null = null;
  private held: string | null = null;
  private readonly missed = new Map<string, number>();
  private readonly legs = new Map<string, PeerLeg>();

  /** A run has started on this lead. Every peer behind `target` becomes a candidate. */
  begin(runId: string, target: string): void {
    if (this.run?.runId === runId) return;
    this.run = { runId, target: bareVersion(target) ?? target };
    this.held = null;
    this.missed.clear();
    this.legs.clear();
  }

  /** No run is being driven. The queue empties; nothing about it was ever on disk. */
  end(): void {
    this.run = null;
    this.held = null;
    this.missed.clear();
    this.legs.clear();
  }

  /** The run this lead is currently driving, or null. */
  current(): { readonly runId: string; readonly target: string } | null {
    return this.run;
  }

  /** The turn value for `memberId`, or null when it does not hold one. */
  turnFor(memberId: string): string | null {
    if (this.run === null || this.held !== memberId) return null;
    return formatTurn(memberId, this.run.runId);
  }

  /** Every member's leg, as the sweep banked it. The route that reads this dials nobody. */
  peerLegs(): PeerLeg[] {
    return [...this.legs.values()];
  }

  /**
   * Fold one sweep, and answer whether a turn was RELEASED — which is one of the three events that
   * earns an immediate re-sweep, so a waiting peer starts within one sweep of its turn rather than
   * within the periodic cadence.
   *
   * The turn is released on exactly three things and nothing else: the member reports the new
   * version, the member reports `rolled-back`, or it misses three consecutive sweeps.
   */
  observe(members: readonly TurnMember[], now: number): TurnSweep {
    if (this.run === null) return { released: false };
    const target = this.run.target;
    const runId = this.run.runId;
    let released = false;

    const ordered = [...members].toSorted((a, b) => a.enrolledAt - b.enrolledAt || a.memberId.localeCompare(b.memberId));
    for (const m of ordered) {
      const misses = m.answered ? 0 : (this.missed.get(m.memberId) ?? 0) + 1;
      this.missed.set(m.memberId, misses);
      const leg = legOf(m, { target, runId, misses, now });
      this.legs.set(m.memberId, leg);
      if (this.held === m.memberId && leg.state !== "waiting" && leg.state !== "updating") {
        this.held = null;
        released = true;
      }
    }

    if (this.held === null) {
      const next = ordered.find((m) => eligible(m, this.legs.get(m.memberId)));
      this.held = next?.memberId ?? null;
    }
    return { released };
  }
}

/** What one folded sweep answers. Named, because a turn being released is what earns a re-sweep. */
export interface TurnSweep {
  /** A turn ended on this sweep, so the caller fires an immediate one rather than waiting a cadence. */
  readonly released: boolean;
}

/** Whether a member may be handed the turn: behind, reachable, and preflight-clean. */
function eligible(m: TurnMember, leg: PeerLeg | undefined): boolean {
  if (leg === undefined || leg.state !== "waiting") return false;
  // `null` is UNKNOWN and it blocks, exactly as it does on the card (§19): "we could not check this
  // machine" is not "this machine is fine".
  return m.verdict === "green" || m.verdict === "amber";
}

/** One member's leg, from what the sweep banked. Pure — the fold above owns the state. */
function legOf(
  m: TurnMember,
  a: { target: string; runId: string; misses: number; now: number },
): PeerLeg {
  const version = m.version === null ? null : bareVersion(m.version);
  const base = { name: m.memberId, version: m.version };
  // Not behind is DONE — equal, and higher too. A member ahead of its lead is not a member to move:
  // there is no downgrade path on this link and there will not be one, so the queue must not spend a
  // turn on it. That leaves the accepted gap intact and visible: a lead rolled back by hand after
  // its peers advanced sits below them, §7.1 makes the skew harmless, and the remedy is
  // `collie pack update <member>` over the operator's own SSH.
  if (version !== null && compareSemver(version, a.target) >= 0) {
    return { ...base, state: "done", updatedAt: a.now };
  }
  if (m.run !== null && m.run.runId === a.runId) {
    if (PEER_IN_FLIGHT.has(m.run.state)) {
      return withStamp({ ...base, state: "updating" }, m.run.updatedAt);
    }
    if (PEER_FAILED.has(m.run.state)) {
      return withStamp(
        { ...base, state: "rolled-back", reason: m.run.reason ?? `that machine's run ended ${m.run.state}` },
        m.run.updatedAt,
      );
    }
  }
  if (a.misses >= TURN_MISSED_SWEEPS) {
    return { ...base, state: "unreachable", reason: `${m.memberId} has missed ${a.misses} sweeps` };
  }
  return { ...base, state: "waiting" };
}

/** `leg` with the member's own stamp when it carried one. Passed through untouched, never derived. */
function withStamp(leg: PeerLeg, updatedAt: number | null): PeerLeg {
  return updatedAt === null ? leg : { ...leg, updatedAt };
}

// ── Small shared readings ────────────────────────────────────────────────────

/** `1.4.1+ab12cd3` and `v1.4.1` both read as `1.4.1`. `null` for anything that is not a version. */
function bareVersion(value: string): string | null {
  const trimmed = value.trim();
  const named = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  const parsed = parsePrereleaseTag(named.split("+")[0] ?? named);
  if (parsed === null) return null;
  const bare = named.slice(1).split("+")[0] ?? "";
  return bare === "" ? null : bare;
}

/** A strict release has no `-` tail — `strictOnly`'s predicate, applied to a running version. */
function isStrictRelease(bare: string): boolean {
  const parsed = parsePrereleaseTag(`v${bare}`);
  return parsed !== null && parsed.prerelease === null;
}

/**
 * Whether this machine already rolled back from `version` **in this run**.
 *
 * Keyed by the pair, never by the tag alone: an operator who has read the reason and fixed the
 * machine gets one more attempt from a fresh confirm, and a peer that is simply broken never loops.
 */
function rolledBackFrom(run: UpdateRun | null, version: string, runId: string): boolean {
  if (run === null || run.state !== "rolled-back") return false;
  if (run.runId !== runId) return false;
  return run.to !== null && bareVersion(run.to) === version;
}

/** How long ago this machine last STARTED a run, or null when it has never started one. */
function attemptAgeMs(run: UpdateRun | null, now: number): number | null {
  if (run === null || run.startedAt <= 0) return null;
  const since = now - run.startedAt;
  return since < 0 ? 0 : since;
}
