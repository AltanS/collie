import type { InstallKind } from "../../cli/install-kind.ts";
import { compareSemver, majorOf, parsePrereleaseTag } from "../update.ts";
import type { PeerRunReport, PreflightReport } from "../update-action.ts";
import { firstRed } from "../update-action.ts";
import type { UpdateRun } from "../update-run.ts";
import { inFlight } from "../update-run.ts";

// THE CREW FOLLOWS THE PHONE (M16/04): a peer levels itself to the release its lead is running.
//
// ── WHAT DOES NOT HAPPEN HERE, AND WHY IT MATTERS MORE THAN WHAT DOES ────────
// No code crosses the crew link. `.adr/0016-updates-ride-the-operators-ssh.md` says code
// distribution to a peer is credentialed by the operator's own SSH and by nothing else, and this
// module keeps both halves of that: the peer pulls its artifact from **GitHub**, over anonymous
// HTTPS, so no lead is ever a distribution point; and the lead sends no ref, no URL and no command —
// only the version it is itself running, and a member name with an opaque run id.
//
// There is therefore no new `/crew/v1/*` route, no inbound update surface on a peer, and no verb.
// Two additive-optional REQUEST headers ride the sweep the lead already makes (CREW_PROTOCOL.md §6,
// §20), `X-Crew-Protocol` stays `1`, and **a peer that ignores both headers is a correct peer**.
//
// ── EVERY GUARD IS ON THE PEER ───────────────────────────────────────────────
// Neither header is an order. The lead states a fact and hands out a turn; the peer decides, and it
// decides eight times before it spawns anything. That asymmetry is the whole security argument: a
// lead that is buggy, or that has been taken, can at worst cause a peer to refuse eight times and
// try at most once an hour.

/**
 * `X-Crew-Lead-Release: <bare version>` — the release the LEAD is itself running, sent only when
 * that version is a strict release and the lead's own health gate has settled it (§20).
 *
 * It cannot express any other version: it is read from the same `collieVersionBare` the lead answers
 * `hello` and `/api/health` with. A peer that receives a version its lead is not running is a peer
 * whose lead lied about itself, which gains an attacker nothing they did not already have (§8.5).
 *
 * Absent means the lead is on a dev or prerelease build, or is mid-run — and absent means the peer
 * does nothing at all.
 */
export const LEAD_RELEASE_HEADER = "X-Crew-Lead-Release";

/**
 * `X-Crew-Update-Turn: <member-name>;<run-id>` — whose turn it is, and which run it belongs to (§20).
 *
 * It carries **no version, no ref, no URL and no command**: a member name and an opaque run id,
 * nothing else. It is a mutex token with a receipt, sent to at most one member at a time, and a peer
 * ignores a turn that does not name itself — the lead cannot address one peer and have another act.
 */
export const UPDATE_TURN_HEADER = "X-Crew-Update-Turn";

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
 * whole crew after a release it may itself be about to roll back from.
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
  | "install-is-packaged"
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
  /**
   * This peer's own install kind (ADR 0035). A `packaged` peer never follows: it cannot replace
   * its own files, so `firstRed` — which the six-and-eight guards below rely on — finding nothing
   * red proves nothing here. A packaged install's preflight is GREEN BY DESIGN, so without this
   * guard a peer in that shape would sail through every other check, spawn a detached
   * `cli/update.ts` that refuses on its own packaged branch, and repeat once an hour forever —
   * the exact failure ADR 0035 exists to eliminate, on the crew-follow path instead of the phone tap.
   * Checked FIRST, before the release-build guard, because it costs one comparison and never a
   * subprocess, matching this function's own ordering rule (cheapest refusal first).
   */
  readonly installKind: InstallKind["kind"];
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
  // ── 0. THIS PEER CANNOT REPLACE ITS OWN FILES ─────────────────────────────
  // Ahead of guard 1 on purpose: a packaged install is disqualified regardless of what it is
  // running or what its lead states, so there is nothing upstream of this worth evaluating first.
  if (f.installKind === "packaged") {
    return refuse("install-is-packaged", "updates come from this machine's package manager (ADR 0035)");
  }

  // ── 1. RELEASE BUILDS ONLY ─────────────────────────────────────────────────
  // A `1.4.1-dev+ab12cd3` build never self-levels, full stop. **This is what keeps the dev lane
  // still**: the dev crew's peer is the `~/apps/collie-next` checkout on minibuch, built from a
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
 * Nothing is spawned here. The caller ({@link CrewFollower}) owns the one detached-updater spawn,
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
export interface CrewFollowerDeps {
  /**
   * This peer's own install kind. A plain value, not a getter: like the version and member id below,
   * it cannot change under a running process (`bridge/index.ts` probes it once, the same read the
   * update preflight and monitor share).
   */
  readonly installKind: InstallKind["kind"];
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
  /**
   * Where a `[crew] follow:` line goes — `console.log`, this peer's own journal, unless a caller
   * hands over something else. Injected for the same reason {@link UpdateTurns}'s is: a test reads
   * the lines instead of the process's stdout.
   */
  readonly log?: (line: string) => void;
}

/**
 * The peer's side of the follow, driven by the headers on the sweep its lead already makes.
 *
 * **It arms no timer.** `bridge/crew/router.ts` calls {@link CrewFollower.observe} when a snapshot
 * request carries the headers, so the follow rides the poll for the same reason the sweep does
 * (§10.1, §11): a second timer would be a second opinion about how often anything happens.
 */
export class CrewFollower {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** One decision in flight at a time. A sweep that lands mid-decision is skipped, never queued. */
  private deciding = false;
  private lastDecision: FollowDecision | null = null;
  /**
   * The key of the decision already on the journal, so a steady state costs one line and not one per
   * sweep. The DETAIL is deliberately not part of it: `rate-limited` counts the minutes left down in
   * its own sentence, and keying on that would put a line on the journal every minute for an hour.
   */
  private logged: string | null = null;

  constructor(private readonly deps: CrewFollowerDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** The last thing this peer decided, for the log and for the tests. Never on the wire. */
  last(): FollowDecision | null {
    return this.lastDecision;
  }

  /**
   * Keep one decision, and say it once.
   *
   * **This is the peer's half of "the lead keeps sight" (M20/11).** The rehearsal on 2026-09-08
   * found the hole: a peer that refuses to self-level says nothing at all, so the lead's leg sat on
   * `waiting` for the whole twenty minute wall clock and then failed with `no change for 20 minutes`
   * — a true sentence that names no cause. The peer knew the cause the whole time (`rate-limited`,
   * `preflight-red`, `crosses-a-major`), held it in {@link lastDecision}, and printed nothing.
   *
   * It stays OFF THE WIRE. §20's headers are the lead's, not the peer's, and a refusal reason coming
   * back over the link would be a new field on a protocol version that is frozen. The operator reads
   * it where the machine that decided it runs: `journalctl --user -u collie` on the peer.
   *
   * **A REFUSAL IS ONLY WORTH A LINE WHILE A TURN NAMES THIS MEMBER.** The first shape of this keyed
   * on the refusal's reason alone, and the rehearsal put a line on the journal roughly once a second:
   * the reason FLAPS between `no-turn`, `lead-states-nothing` and the real one, sweep by sweep, because
   * the lead drops its release header while its own run is in flight and addresses one member at a
   * time. Those two reasons both mean "nothing is being asked of this machine", which is not a cause
   * of anything and is true on most sweeps of most days. The line an operator needs is the other one:
   * the lead handed THIS member the turn and the member still declined. So a turn naming this member
   * is the gate, and the reason is the dedup key inside it.
   */
  private record(decision: FollowDecision, mine: boolean): void {
    this.lastDecision = decision;
    if (decision.kind === "refuse" && !mine) return;
    const key =
      decision.kind === "follow" ? `follow:${decision.tag}:${decision.runId}` : `refuse:${decision.reason}`;
    if (key === this.logged) return;
    this.logged = key;
    this.log(
      decision.kind === "follow"
        ? `[crew] follow: self-levelling to ${decision.tag} (run ${shortRunId(decision.runId)})`
        : `[crew] follow: not self-levelling (${decision.reason}) — ${decision.detail}`,
    );
  }

  /**
   * One sweep's worth of headers. Never throws and never awaits on the request path: the router
   * hands the headers over and answers its snapshot, exactly as it does today.
   */
  observe(headers: { readonly leadRelease: string | null; readonly turn: string | null }): void {
    if (this.deciding) return;
    const id = this.deps.self();
    const facts: FollowFacts = {
      installKind: this.deps.installKind,
      own: id.version,
      self: id.self,
      leadRelease: headers.leadRelease,
      turn: headers.turn,
      run: this.deps.run(),
      now: this.now(),
    };
    // Whose turn the lead is stating, read once and handed to `record` — see there for why a
    // refusal is only worth a line while the turn names this machine.
    const mine = parseTurn(headers.turn)?.member === id.self;
    // The cheap guards run synchronously, so a peer with nothing to do costs one comparison per
    // sweep and never a promise.
    const guarded = followGuards(facts);
    if (guarded.kind === "refuse") {
      this.record(guarded, mine);
      return;
    }
    this.deciding = true;
    void this.decide(facts, mine);
  }

  /** The expensive half, off the request path. Never throws — a follow that did would take a peer's
   *  own snapshot answer down with it, and §10.2's "failure is a value" has to hold here too. */
  private async decide(facts: FollowFacts, mine: boolean): Promise<void> {
    try {
      const decision = await followDecision(facts, { preflight: this.deps.preflight });
      this.record(decision, mine);
      if (decision.kind === "follow") {
        const started = this.deps.start({ tag: decision.tag, runId: decision.runId });
        if (!started.ok) {
          this.record(refuse("preflight-red", `the updater could not be started: ${started.reason}`), mine);
        }
      }
    } catch (err) {
      this.record(refuse("preflight-red", err instanceof Error ? err.message : String(err)), mine);
    } finally {
      this.deciding = false;
    }
  }
}

// ── The lead's turn queue ────────────────────────────────────────────────────

/**
 * One peer's leg of a crew-wide run, as `GET /api/update/check` reports it.
 *
 * `package-managed` is TERMINAL in the same sense `done` is: the queue never waits on it and a run
 * completes with one present. It says the member's files belong to a package manager (ADR 0035), so
 * nothing the lead can do moves that machine. It is additive-optional on the wire (CREW_PROTOCOL.md
 * §7.1): a reader that does not know the value renders it as it renders any unknown state, and
 * nothing ever branches on it to take an action.
 */
export type PeerLegState = "waiting" | "updating" | "done" | "rolled-back" | "unreachable" | "package-managed";

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
  /**
   * That member's own install kind as its preflight reported it (§19), or absent.
   *
   * **Absent means unknown, and unknown is NOT packaged** — a member older than the field, or one
   * this sweep never reached, behaves exactly as it did before the field existed. The kind is read,
   * never a check id: an id labels a sentence and can be renamed, the kind is the fact.
   */
  readonly installKind?: InstallKind["kind"];
  /** Did this member answer THIS sweep? Three consecutive misses release its turn. */
  readonly answered: boolean;
  /** That member's own run record as it reported it (§20), or null. */
  readonly run: PeerRunReport | null;
}

const PEER_IN_FLIGHT: ReadonlySet<string> = new Set(["preflight", "staging", "restarting", "verifying"]);
const PEER_FAILED: ReadonlySet<string> = new Set(["rolled-back", "stuck", "interrupted"]);

/** The two leg states a run is still waiting on. Everything else is terminal and settles a run. */
const LEG_OPEN: ReadonlySet<PeerLegState> = new Set<PeerLegState>(["waiting", "updating"]);

/**
 * How long one leg may sit on the same state before the run gives up on it.
 *
 * The 2026-09-07 drill is the argument: a peer that answered three dials as `incompatible` held a
 * run open for twelve and a half minutes, and nothing in the code could ever have closed it. A run
 * that cannot end is not a run, it is a claim the screen has to keep repeating. Twenty minutes is
 * comfortably longer than the slowest leg the drill has ever produced (a peer fetching, building and
 * restarting on slow hardware) and far shorter than the operator's patience.
 */
export const LEG_WALL_CLOCK_MS = 20 * 60_000;

/**
 * The sentence a leg carries when the wall clock, and not the peer, decided it.
 *
 * It says CHANGE and not "answer" on purpose. A queued member answers every sweep on time and is
 * simply not being asked to update yet, so "no answer" would be a false sentence about the peer.
 * What the wall clock actually measures is a run that has stopped moving.
 */
export const LEG_WALL_CLOCK_REASON = "no change for 20 minutes";

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
  /**
   * Which run the legs below describe. It OUTLIVES the run, exactly as the legs do.
   *
   * A composer that attaches these rows to whatever run is on screen would show the last run's peers,
   * and its failures, under the next run's record. The legs survive `end` so the outcome stays
   * readable; naming their run is what keeps that from becoming a claim about a different one.
   */
  private legsRunId: string | null = null;
  /** When each leg last CHANGED state. The wall clock below reads this, never the run's own start. */
  private readonly legChangedAt = new Map<string, number>();
  /**
   * The legs the WALL CLOCK failed in this run, by member id. Not a cache: it is the queue's own
   * memory of a verdict it reached, which `legOf` cannot re-derive from the member's facts. Cleared
   * by {@link begin} with everything else, and per member the moment that member answers with a
   * terminal state of its own. See the sweep, and M20/13.
   */
  private readonly expired = new Map<string, PeerLeg>();
  /** Whether this run's settling line has been written. One per run, never one per sweep. */
  private settledLogged = false;
  /** Whether any sweep has folded yet. A run cannot settle before it has looked at its roster once. */
  private swept = false;
  /**
   * When this run last MOVED: a leg changed state, or a turn was granted. Zero until the first fold.
   *
   * The wall clock below reads it for a member that is only QUEUED. Turns are serial, so a crew of
   * four peers on a seven minute build leaves the last one waiting nearly half an hour through no
   * fault of its own, and its own clock would fail it while it answered every sweep on time.
   */
  private progressAt = 0;
  /** When every leg first reached a terminal state, or null while the run is still moving. */
  private settled: number | null = null;

  /**
   * `log` is where a `[crew]` line goes — `console.log`, the bridge's journal, unless a caller
   * says otherwise. Injected so a test asserts the sentence and the suite stays silent.
   */
  constructor(private readonly log: (line: string) => void = (line) => console.log(line)) {}

  /** A run has started on this lead. Every peer behind `target` becomes a candidate. */
  begin(runId: string, target: string): void {
    if (this.run?.runId === runId) return;
    this.run = { runId, target: bareVersion(target) ?? target };
    this.held = null;
    this.missed.clear();
    this.legs.clear();
    this.legChangedAt.clear();
    this.expired.clear();
    this.settledLogged = false;
    this.swept = false;
    this.settled = null;
    this.progressAt = 0;
    this.legsRunId = runId;
  }

  /**
   * No run is being driven. Idempotent, and safe to call on a queue that has already ended.
   *
   * The QUEUE empties — no run, no turn, no miss counts — and the LEGS stay. That split is
   * deliberate. A queue that is over grants nothing, but the phone is still looking at the page it
   * confirmed on, and clearing the rows at the same instant would take the outcome off the screen at
   * the moment the operator earned it. {@link begin} is what clears them, so the last run's result
   * stays readable until a new run replaces it. Nothing here was ever on disk either way.
   */
  end(): void {
    this.run = null;
    this.held = null;
    this.missed.clear();
    this.swept = false;
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

  /** The run the legs describe, live or over, or null when this queue has never run. */
  legsRun(): string | null {
    return this.legsRunId;
  }

  /** Every member's leg, as the sweep banked it. The route that reads this dials nobody. */
  peerLegs(): PeerLeg[] {
    return [...this.legs.values()];
  }

  /**
   * When this run's legs all reached a terminal state, or null while one is still open.
   *
   * The ONE clock the band and the card both read (M20/04). Two surfaces deriving "is the crew still
   * moving" from two folds of the same rows is how the drill produced a band that had gone quiet
   * over a card that had not.
   */
  settledAt(): number | null {
    return this.settled;
  }

  /**
   * Whether the live run is still waiting on this member — which makes it DUE, whatever backoff its
   * `PeerMemory` holds (M20/01).
   *
   * A member with no leg yet counts as open: the run has not looked at it once, and the first sweep
   * of a run must reach everybody. This is a READ. The run never writes `PeerMemory`, so the peer's
   * real backoff survives the run untouched and is there again the moment the run ends.
   */
  hasOpenLeg(memberId: string): boolean {
    if (this.run === null) return false;
    const leg = this.legs.get(memberId);
    return leg === undefined || LEG_OPEN.has(leg.state);
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

    if (this.progressAt === 0) this.progressAt = now;

    const ordered = [...members].toSorted((a, b) => a.enrolledAt - b.enrolledAt || a.memberId.localeCompare(b.memberId));
    for (const m of ordered) {
      const misses = m.answered ? 0 : (this.missed.get(m.memberId) ?? 0) + 1;
      this.missed.set(m.memberId, misses);
      const fresh = legOf(m, { target, runId, misses, now });
      // A LEG THE WALL CLOCK ALREADY FAILED STAYS FAILED (M20/13). `legOf` reads the member's facts
      // and nothing else, and the facts of a member that answers every sweep and never moves do not
      // change when the clock runs out — so on the very next sweep it minted `waiting` again and
      // wrote the failure straight back out. Measured on the VM crew: `member waiting -> unreachable
      // (no change for 20 minutes)` at 11:05:37 and `member unreachable -> waiting` at 11:05:38. The
      // run then queued that member afresh, which is a run that cannot end, which is the one promise
      // this milestone is named after.
      //
      // What clears it is the member REACHING the target, and nothing else: `legOf` answers `done`
      // on version alone, so a machine that took the build after all is read as done on the sweep it
      // reports the new version. Any other terminal answer — `rolled-back`, `package-managed` — is
      // also the member's own account and also wins. Only an OPEN state is refused.
      const expired = this.expired.get(m.memberId);
      const leg = expired !== undefined && LEG_OPEN.has(fresh.state) ? expired : fresh;
      if (!LEG_OPEN.has(fresh.state)) this.expired.delete(m.memberId);
      const was = this.legs.get(m.memberId);
      // `legOf` mints a fresh object every sweep, so the STATE is compared and never the object.
      // That is what keeps a member sitting in `updating` for ten minutes to one line.
      if (was?.state !== leg.state) {
        this.legChangedAt.set(m.memberId, now);
        this.progressAt = now;
        this.log(
          `[crew] update ${shortRunId(runId)}: ${m.memberId} ${was?.state ?? "new"} -> ${leg.state} (${leg.version ?? "unknown"})`,
        );
      }
      // EVERY LEG CARRIES A CLOCK (M20/12). `legOf` stamps only the legs a MEMBER reported — the
      // ones it took from that member's own run record — so `waiting`, `unreachable` and
      // `package-managed` reached the phone with no `updatedAt` at all. The band reads its elapsed
      // time off the oldest moving leg's stamp, so a run whose legs were all queued had no elapsed
      // time to name and the card's "No action needed, this finishes on its own" never appeared:
      // exactly the run the sentence was written for. The fallback is `legChangedAt`, which is the
      // honest reading for these legs — since when has THIS LEAD seen this state — and it is the
      // same clock the twenty minute wall clock already runs on, so the two can never disagree.
      this.legs.set(
        m.memberId,
        leg.updatedAt === undefined ? { ...leg, updatedAt: this.legChangedAt.get(m.memberId) ?? now } : leg,
      );
      if (this.held === m.memberId && !LEG_OPEN.has(leg.state)) {
        this.held = null;
        released = true;
      }
    }
    if (this.expire(runId, now)) released = true;
    this.swept = true;
    // The settle check runs on EVERY tick, folded members or none. A leg that can move on the
    // evidence already in hand has to move on the tick that holds it, and the drill's run froze
    // precisely because a quiet sweep returned before reaching here.
    if (this.settleIfDone(runId, now)) return { released };

    if (this.held === null) {
      const next = ordered.find((m) => eligible(m, this.legs.get(m.memberId)));
      this.held = next?.memberId ?? null;
      // A GRANT is where the held member's wall clock starts, not the sweep that first saw it. The
      // member has been queued until now, and charging it the wait it spent behind another member's
      // build is how a healthy peer gets failed for somebody else's slow hardware.
      if (this.held !== null) {
        this.legChangedAt.set(this.held, now);
        this.progressAt = now;
      }
    }
    return { released };
  }

  /**
   * Fail every leg that has held one state past the wall clock, and answer whether a turn was
   * released doing it.
   *
   * `unreachable` is the verdict, and not a new state: it is what the crew already says about a
   * member nobody has heard from, every reader already renders it as a failure, and inventing a
   * seventh leg state would put a word on the wire that no older phone knows. The reason is what
   * separates the two, and the reason is the part an operator reads.
   */
  private expire(runId: string, now: number): boolean {
    // PASS ONE, the member the run is actually waiting on: the one holding the turn, and any member
    // that reported `updating`. Its clock is its own, and it started when the turn was granted.
    let released = false;
    let moved = false;
    for (const [memberId, leg] of this.legs) {
      if (!LEG_OPEN.has(leg.state)) continue;
      if (memberId !== this.held && leg.state !== "updating") continue;
      if (now - (this.legChangedAt.get(memberId) ?? now) < LEG_WALL_CLOCK_MS) continue;
      released = this.failLeg(runId, memberId, leg, now) || released;
      moved = true;
    }
    // Failing that member IS progress, and it hands the turn on, so the queue behind it gets the
    // whole wall clock again rather than expiring on the same tick.
    if (moved) {
      this.progressAt = now;
      return released;
    }
    // PASS TWO, the members merely QUEUED. They answer every sweep and are asked for nothing, so the
    // clock they are held to is the RUN's: a queue that is moving never expires, and a run where
    // nothing at all has moved for twenty minutes still ends, which is the whole point.
    for (const [memberId, leg] of this.legs) {
      if (!LEG_OPEN.has(leg.state)) continue;
      const since = Math.max(this.legChangedAt.get(memberId) ?? now, this.progressAt);
      if (now - since < LEG_WALL_CLOCK_MS) continue;
      released = this.failLeg(runId, memberId, leg, now) || released;
    }
    return released;
  }

  /** Flip one open leg to `unreachable` with the wall clock's reason, and say whether a turn fell. */
  private failLeg(runId: string, memberId: string, leg: PeerLeg, now: number): boolean {
    const failed: PeerLeg = { ...leg, state: "unreachable", reason: LEG_WALL_CLOCK_REASON, updatedAt: now };
    this.legs.set(memberId, failed);
    this.expired.set(memberId, failed);
    this.legChangedAt.set(memberId, now);
    this.log(`[crew] update ${shortRunId(runId)}: ${memberId} ${leg.state} -> unreachable (${LEG_WALL_CLOCK_REASON})`);
    if (this.held !== memberId) return false;
    this.held = null;
    return true;
  }

  /**
   * Settle the run when no leg is open any more: stamp the clock, say so once, and end the queue.
   *
   * This is the production caller {@link end} never had. Before it, `begin` was reachable and `end`
   * was not, so every run this lead ever started was still open when the process died.
   */
  private settleIfDone(runId: string, now: number): boolean {
    if (!this.swept) return false;
    if ([...this.legs.values()].some((l) => LEG_OPEN.has(l.state))) return false;
    this.settled = now;
    this.logSettled(runId);
    this.end();
    return true;
  }

  /**
   * Say that the run has stopped moving, once, the sweep every leg first reaches a terminal state.
   *
   * It is the line the 2026-09-07 drill wanted most: the crew levelled in seventeen seconds and the
   * lead's own record still read "moving" a quarter of an hour later, with nothing in the journal to
   * say which of the two was wrong.
   */
  private logSettled(runId: string): void {
    if (this.settledLogged || this.legs.size === 0) return;
    const legs = [...this.legs.values()];
    if (legs.some((l) => LEG_OPEN.has(l.state))) return;
    this.settledLogged = true;
    const count = (state: PeerLegState): number => legs.filter((l) => l.state === state).length;
    const parts = [`${count("done")} peer(s) done`];
    // Every other terminal state is named with its own count. Lumping them under "failed" would
    // report a packaged member, which nothing failed at, as a failure.
    for (const state of ["rolled-back", "unreachable", "package-managed"] as const) {
      if (count(state) > 0) parts.push(`${count(state)} ${state}`);
    }
    this.log(`[crew] update ${shortRunId(runId)}: settled, ${parts.join(", ")}`);
  }
}

/** A run id is long and opaque; eight characters is enough to grep one run out of a journal. */
function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

/** What one folded sweep answers. Named, because a turn being released is what earns a re-sweep. */
export interface TurnSweep {
  /** A turn ended on this sweep, so the caller fires an immediate one rather than waiting a cadence. */
  readonly released: boolean;
}

/** Whether a member may be handed the turn: behind, reachable, and preflight-clean. */
function eligible(m: TurnMember, leg: PeerLeg | undefined): boolean {
  // Every terminal state excludes, and `package-managed` is one of them — which is why a packaged
  // member never receives `X-Crew-Update-Turn` without a second rule stated here.
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
  // `collie crew update <member>` over the operator's own SSH.
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
  // A PACKAGE MANAGER OWNS THAT MACHINE (ADR 0035). It takes the place of `waiting` and NOTHING
  // else, which is why it is read last of all.
  //
  // Every branch above it is a fact this sweep OBSERVED, and each one outranks it for its own
  // reason. `done` is the truer sentence about a packaged member already on the target. A run
  // record the member reported itself wins because the member is the only witness to its own run,
  // and a packaged machine that is somehow moving is a thing the operator has to be able to see.
  // `unreachable` wins because a packaged peer that has stopped answering is a peer nobody has
  // heard from — saying "waits for its package manager" about it would state a calm fact about a
  // machine that may be off.
  if (m.installKind === "packaged") {
    return { ...base, state: "package-managed", reason: `${m.memberId} takes its updates from its package manager` };
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
