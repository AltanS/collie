import { DEFAULT_PORT, resolveBridgeHost } from "../bridge/config.ts";
import type { JsonValue } from "../bridge/json.ts";
import { bindIsWildcard } from "../bridge/crew/config.ts";
import { parseCrewRows, type CrewUpdateRow } from "../bridge/update-action.ts";
import type { OpsRecord } from "../bridge/crew/ops-store.ts";
import type { TrustedMember, TrustStoreData } from "../bridge/crew/trust-store.ts";
import { STALE_AFTER_MS, type UpdateRun } from "../bridge/update-run.ts";
import { parsePrereleaseTag } from "../bridge/update.ts";
import { answersThisBuild } from "../bridge/version.ts";
import { collieVersionBare } from "./context.ts";
import { updateDeps } from "./deps.ts";
import { INSTALLER_SH } from "./installer-embed.ts";
import { detectInstall, PACKAGED_SENTENCE, updateRepoOf, type InstallKind } from "./install-kind.ts";
import { realLinkFs } from "./link.ts";
import { EXIT, type Io } from "./io.ts";
import { parseCrewArgs, probeMembers } from "./crew.ts";
import {
  errorLine,
  firstLine,
  gitOut,
  installerErrorLine,
  manifestVersionAt,
  memberInstallKind,
  releaseOf,
  restartScript,
  routeOf,
  runInstall,
  runInstallRelease,
  runProbe,
  runUpdateStatus,
  transportFailure,
  type CrewAddDeps,
  type MemberKind,
  type Probe,
  type RemoteResult,
  type RemoteRunner,
  type Route,
} from "./remote.ts";
import { plainUpdate, type UpdateEvent, type UpdateOutcome, type UpdateRow } from "./render.ts";
import { cmdUpdate } from "./update.ts";
import {
  preflight,
  updateCheckDeps,
  type PreflightCheck,
  type MemberRoute,
  type PreflightMember,
  type PreflightOptions,
  type PreflightReport,
} from "./update-check.ts";
import { awaitRunRecord, healthTimeoutMs, HEALTH_POLL_MS, readRun } from "./update-run.ts";

// The tolerant `<semver>+<sha>` comparison lives in `bridge/version.ts` now — the health gate of the
// detached updater (M15/04) asks the same question of a machine restarting under it, and one
// implementation is the only way the two can never disagree. Re-exported because every caller and
// test here already spells it `from "./crew-update.ts"`.
export { answersThisBuild };

// `collie crew update [<member>…] [--all]` — level peers to the lead's current build (M7/02).
//
// ── IT RIDES THE OPERATOR'S SSH, NEVER THE CREW WIRE (ADR 0016) ──────────────
// The code goes the same way `crew add` sent it, and by the same two routes (`routeOf`, #248): a
// lead that runs from a git checkout sends its own commit as a `git bundle`, and a lead installed by
// install.sh or by a package has no commit, so it sends Collie's own installer and the member
// downloads the release the lead runs. Both ride an
// ssh connection the operator authenticates. Nothing about an update crosses `/crew/v1/*` — the crew
// link carries runtime data and admits nobody, and a lead that could push code down it would be a
// code-execution credential on every peer it leads. That is the whole of the reasoning, and it lives
// in ADR 0016 because it closes a road (an "update all peers" route) that will be proposed again.
//
// ── WHAT IS SHARED WITH `crew add`, AND WHAT IS NOT ──────────────────────────
// Shared: the transport seam, the leg SCRIPTS, and the three emit-free step runners in
// `cli/remote.ts` (`runProbe`, `runInstall`, `restartScript`). Not shared: a single word of output.
// `crew add` is one host walking four legs and it says so in its own voice; this is N members walking
// three, and it has a table at the end. Two verbs, one set of things that run on the far machine.
//
// ── ONE CONSENT, NOT N ───────────────────────────────────────────────────────
// Every member is probed read-only FIRST, and then the whole operation is confirmed once. That
// replaces `crew add`'s per-member replace prompt, because the operator is being asked one question —
// "level these machines to this build" — and asking it five times is not five consents, it is one
// consent with four chances to answer the wrong one by reflex. What stays per-member is the DIRTY
// checkout refusal: that is not consent, it is Collie declining to discard work it did not create.
//
// ── ONE SEQUENCE, AND IT STOPS AT THE FIRST FAILURE (M15/06) ─────────────────
// Preflight every machine this run intends to touch (spec 03's `collie update --check`, over the
// same ssh); then this LEAD, if it is not yet running the build it is about to hand out; then the
// peers, one at a time, each gated on the member coming back answering that build. The first failure
// ends the run and every member after it is left untouched and reported as "not attempted".
//
// That is a deliberate reversal of "record it and carry on", and the reason is CREW_PROTOCOL.md
// §7.1: version skew inside a protocol version is tolerated by design, so a half-updated crew is a
// SUPPORTED state and stopping is cheap. Pressing on after one machine failed is not — it multiplies
// one unexplained fault across every machine still to come, and the operator then has N failures to
// read instead of one. The output says this out loud when it aborts.
//
// ── TERMINAL-ONLY, THIS MILESTONE ────────────────────────────────────────────
// The phone drives the machine it is talking to and nothing else. A crew-wide update needs the one
// TTY consent below, and there is still no `--yes`. The credential that would let a phone push to
// peers is written up as a PROPOSED amendment to ADR 0016 and is not decided; until it is, this verb
// is the only way a peer is levelled.

/** How this lead's OWN update is asked for and watched — `collie update`'s detached runner (M15/04). */
export interface LeadUpdate {
  /** Stage and hand off, exactly as `collie update` does. `EXIT.OK` ⇒ the runner is away. */
  start(): Promise<number>;
  /** That runner's record as of now, through the one staleness rule. Null ⇒ nothing has been written. */
  record(): UpdateRun | null;
}

/** `crew update`'s seams: `crew add`'s set, plus the preflight, this lead's own update and a wait. */
export interface CrewUpdateDeps extends CrewAddDeps {
  /** Where every line this verb says goes as STRUCTURE. Absent ⇒ the plain replay. */
  emitUpdate?(event: UpdateEvent): void;
  /**
   * Spec 03's read-only preflight (`cli/update-check.ts`), behind a seam.
   *
   * A seam rather than a call for the reason every other one here is: this verb's tests must never
   * spawn ssh, and the preflight reaches every member over it.
   */
  preflight?(opts?: PreflightOptions): Promise<PreflightReport>;
  /**
   * What this lead's RUNNING BRIDGE already heard from each member over the crew link (§19, M16/03).
   *
   * A seam for the same reason the preflight is one, and read through this collie's own
   * `GET /api/update/check` because that is where the sweep banks it — this process holds no crew
   * link of its own, and opening one to ask would be a second dial for a fact already in hand.
   * Nothing here blocks: an answer that does not come is an empty list and a quieter transcript.
   */
  peerReported?(): Promise<readonly CrewUpdateRow[]>;
  /** This lead's own update. Absent ⇒ the real `collie update`, resolved on first use. */
  readonly lead?: LeadUpdate;
  /** How this verb waits between polls. Absent ⇒ a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * THIS lead's own install kind — the same `classifyInstall` answer `collie update` and `doctor`
   * read, behind a seam so no test probes a real filesystem.
   *
   * A seam and not a second probe: one detection, one answer (`cli/install-kind.ts`). It is read
   * for one question only — which ROUTE this lead levels its members by (`routeOf`) — because a
   * packaged root and a binary (install.sh) root have no commit to push, and hand out the release
   * they run instead (#248).
   */
  installKind?(): InstallKind;
}

/** {@link CrewUpdateDeps} once the sink and the defaults are resolved — the shape every step takes. */
type Wired = CrewUpdateDeps & {
  emitUpdate(event: UpdateEvent): void;
  preflight(opts?: PreflightOptions): Promise<PreflightReport>;
  peerReported(): Promise<readonly CrewUpdateRow[]>;
  readonly lead: LeadUpdate;
  readonly sleep: (ms: number) => Promise<void>;
  installKind(): InstallKind;
};

const USAGE = [
  "usage: collie crew update <member>…   # level these peers to this lead's build",
  "       collie crew update --all       # every enrolled peer",
  "                      [--host <ssh-host>] [--path <remote-checkout>] [--port <n>]",
];

/** One target, resolved from the roster plus the ops record — everything a member's turn needs. */
interface Target {
  readonly member: TrustedMember;
  readonly sshHost: string;
  readonly path: string | null;
  readonly port: number;
  /** True when the operator named a route on this command line, so the record is refreshed after. */
  readonly overridden: boolean;
}

/** A target after its probe: what it runs now, and whether anything should be sent to it. */
interface Planned {
  readonly target: Target;
  readonly probe: Probe;
  readonly runner: RemoteRunner;
  /**
   * The Collie the restart and the verify address — what the probe FOUND, never a path this side
   * invented. On the release route that is the member's `<install root>/current`, which is the
   * binary that will be running once the installer has swapped the symlink.
   */
  readonly root: string;
  /**
   * The `<dir>` of the member's `<dir>/current` + `<dir>/versions` layout — where the installer
   * lays the next release down. `""` on the bundle route, which has no such layout to write to.
   */
  readonly installRoot: string;
}

/**
 * What every member is being levelled TO, and the way it gets there. Decided once, read by every
 * step below, so no two steps can disagree about which route this run is on.
 */
interface Build {
  readonly route: Route;
  /**
   * bundle: the version the pushed commit carries, read out of that commit.
   * release: the release this lead runs, bare (`1.11.1`) — `v`-prefixed it is {@link tag}.
   */
  readonly version: string;
  /**
   * bundle: the commit being pushed, in full.
   * release: always `""`. There is no commit on that route, and this lead's own build stamp is not
   * one — see {@link answersThisRun} for why the stamp may not stand in for it.
   */
  readonly commit: string;
  /**
   * What a levelled member is expected to come back as, in the operator's words.
   *
   * bundle: the full string this lead itself answers with, `<version>+<sha>`, because the member
   * builds the very commit that was pushed. release: the TAG, `v<version>`, because that is the
   * whole of the contract on that route — the stamp under it belongs to whoever built the release.
   */
  readonly expected: string;
  /** release only: the tag every member installs, and the `owner/repo` it takes that tag from. */
  readonly tag: string;
  readonly repo: string;
}

/**
 * `collie crew update` — probe every target, confirm once, then work them one at a time.
 *
 * Exit codes reuse `EXIT`'s meanings: `USAGE` for a command line that names nothing to do, `STATE`
 * for a collie that is not a lead or an operator who said no, `FAIL` when any member failed.
 */
export async function cmdCrewUpdate(deps: CrewUpdateDeps, args: readonly string[]): Promise<number> {
  const surface = deps.ui?.crewUpdate?.() ?? null;
  if (surface === null) {
    return await updateRun(
      wire({ ...deps, emitUpdate: deps.emitUpdate ?? ((event) => plainUpdate(deps.io, event)) }),
      args,
    );
  }
  // The rich path: `io` and `confirm` are BOTH replaced for the length of the run, which is the whole
  // of the one-writer rule (`cli/render.ts`). Nothing below knows which renderer it is talking to.
  const wired = wire({
    ...deps,
    io: surface.io,
    emitUpdate: surface.emit,
    confirm: surface.confirm,
  });
  try {
    return await updateRun(wired, args);
  } finally {
    await surface.close();
  }
}

/** The three defaults, filled in once. Everything here is a seam a test replaces with a value. */
function wire(deps: CrewUpdateDeps & { emitUpdate(event: UpdateEvent): void }): Wired {
  return {
    ...deps,
    preflight: deps.preflight ?? ((opts) => preflight(updateCheckDeps(deps.io), opts)),
    peerReported: deps.peerReported ?? (() => bankedPeerVerdicts(deps)),
    lead: deps.lead ?? lazyLead(deps.io),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    // `link` is the one thing `probeInstall` needs that `CrewDeps` does not carry, and it is a
    // pure reader — the same `realLinkFs` `updateDeps` hands `collie update`.
    installKind: deps.installKind ?? (() => detectInstall({ ...deps, link: realLinkFs })),
  };
}

/**
 * The real `collie update`, resolved on FIRST USE and not before.
 *
 * `updateDeps` loads the context a second time and reaches the filesystem to do it, and most runs of
 * this verb never touch the lead at all — so a run where the lead is already current must not pay
 * for it, and must not print a context complaint it had no reason to provoke.
 */
function lazyLead(io: Io): LeadUpdate {
  let resolved: LeadUpdate | null = null;
  const real = (): LeadUpdate => {
    if (resolved === null) {
      const deps = updateDeps(io);
      resolved = {
        start: () => cmdUpdate(deps, []),
        record: () =>
          readRun(deps.files, deps.ctx.stateDir, deps.now(), (pid) => deps.exec.processCommand(pid) !== null),
      };
    }
    return resolved;
  };
  return { start: () => real().start(), record: () => real().record() };
}

async function updateRun(deps: Wired, args: readonly string[]): Promise<number> {
  const { positional, flags, bare } = parseCrewArgs(args, ["force", "all"]);

  const data = await deps.store.load();
  if (data === null || data.crew === null) {
    deps.io.err("error: this collie is not in a crew — there are no peers to level.");
    deps.io.err("       This machine's own update is `collie update`.");
    return EXIT.STATE;
  }
  if (data.lead !== null) {
    deps.io.err(`error: this collie is a peer of "${data.lead.memberId}" — peers are updated from the lead.`);
    deps.io.err("       This machine's own update is `collie update` here.");
    return EXIT.STATE;
  }
  const roster = data.peers.filter((p) => p.status === "enrolled");
  if (roster.length === 0) {
    deps.io.err("error: this lead has no enrolled peers — nothing to update.");
    return EXIT.STATE;
  }

  const port = parsePort(flags.port);
  if (port === null) {
    deps.io.err(`error: --port ${flags.port} is not a port number.`);
    return EXIT.USAGE;
  }
  const targets = await resolveTargets(deps, data, roster, { positional, flags, bare, port });
  if (!Array.isArray(targets)) return targets;

  // ── WHICH ROUTE THIS LEAD LEVELS ITS MEMBERS BY ────────────────────────────
  // Read from this lead's own install kind through the ONE function `crew add` reads it through
  // (#248). A packaged or binary lead used to be refused here and sent to the phone's Updates page;
  // it now levels its members from the terminal too, by handing each the release it runs itself.
  // The two verbs must never disagree about the route: a member added by release and then levelled
  // by bundle would take a commit into a layout that has no git checkout to receive it.
  const kind = deps.installKind();
  const decided = routeOf(kind) === "release" ? releaseBuild(deps, kind) : bundleBuild(deps);
  if ("code" in decided) return decided.code;
  const { build } = decided;
  const { version } = build;
  // No commit is printed on the release route, because there is none — a title that showed twelve
  // characters of a build stamp would name a thing the operator cannot look up.
  deps.emitUpdate({ kind: "title", version, commit: build.route === "bundle" ? build.commit : null });
  if (build.route === "bundle" && gitOut(deps, ["status", "--porcelain"]) !== "") {
    line(deps, "warn: this checkout has uncommitted changes — the bundle carries the COMMIT, so they are", "warn", "err");
    line(deps, `      not shipped. Every member below gets ${version} at ${build.commit.slice(0, 12)}.`, "warn", "err");
  }

  const outcomes = new Map<string, UpdateRow>();
  const runners: RemoteRunner[] = [];
  try {
    // 1. THE PREFLIGHT. Every machine this run intends to touch, asked spec 03's question, before a
    //    single one of them is touched. One red is the whole run.
    const gate = await preflightGate(deps, targets);
    if (gate.exit !== null) return gate.exit;

    const ready = await planAll(deps, targets, build, outcomes, runners, gate.packaged);
    // 2. A member the probe refused has already failed, and the probe touched nothing at all — so
    //    the abort rule applies here too, one step earlier and for free.
    const refused = [...outcomes.values()].find((row) => row.outcome === "failed");
    if (refused !== undefined) {
      return stop(deps, targets, outcomes, version, {
        memberId: refused.memberId,
        recovery: `collie crew update ${refused.memberId}`,
      });
    }
    if (ready.length === 0) return report(deps, targets, outcomes, version);

    // 3. THE ONE CONSENT, and it names the lead when the lead is part of what is being consented to.
    //    A binary or packaged lead is never behind what it is handing out: the release it hands out
    //    IS the one it is running, so there is nothing for its own updater to do first.
    const behind = build.route === "bundle" && leadIsBehind(deps, version, build.commit);
    const consent = await confirmBatch(deps, ready, outcomes, build, behind);
    if (consent !== EXIT.OK) return consent;

    // 4. THE LEAD FIRST. A lead that is not running the build it is handing out gets it first, and a
    //    lead that cannot take it is a lead whose peers must not take it either.
    if (behind && !(await updateLead(deps, version))) {
      leaveRest(deps, targets, outcomes, "not attempted — this lead's own update did not land");
      return report(deps, targets, outcomes, version, false);
    }

    // 5. THE PEERS, one at a time, stopping at the first failure.
    const stopped = await workAll(deps, data, ready, { build, outcomes });
    if (stopped !== null) return stop(deps, targets, outcomes, version, stopped);
    return report(deps, targets, outcomes, version);
  } finally {
    // Every exit path, including a throw: each of these is a live authenticated channel.
    for (const runner of runners) runner.close();
  }
}

// ── What is being handed out, per route ──────────────────────────────────────

/**
 * What the route decision produced: the build to hand out, or the code the run ends with.
 *
 * Told apart by a FIELD rather than by what a value looks like — the same shape `crew add`'s leg 2
 * uses, and for the same reason: two outcomes that are not each other's failure.
 */
type Decided = { readonly code: number } | { readonly build: Build };

/**
 * The BUNDLE route's build: this checkout's commit, and the version that commit carries.
 *
 * The version is read out of the COMMIT rather than the working tree, exactly as `crew add` reads
 * it, because the bundle ships the commit. A `code` instead of a build means the run stops there.
 */
function bundleBuild(deps: Wired): Decided {
  const commit = gitOut(deps, ["rev-parse", "HEAD"]);
  if (commit === null) {
    deps.io.err(`error: cannot read this checkout's commit — ${deps.ctx.root} is not a git checkout.`);
    return { code: EXIT.FAIL };
  }
  const version = manifestVersionAt(deps, commit);
  if (version === null) {
    deps.io.err(`error: cannot read herdr-plugin.toml at ${commit.slice(0, 12)} — nothing to pin the push to.`);
    return { code: EXIT.FAIL };
  }
  // What a levelled member should answer `hello` with — the version the commit carries PLUS that
  // commit's build metadata, which is what this lead itself runs after building the same commit.
  const expected = expectedAnswer(deps, version, commit);
  return { build: { route: "bundle", version, commit, expected, tag: "", repo: "" } };
}

/**
 * The RELEASE route's build: the release this lead is itself running (#248).
 *
 * A version this build cannot read leaves no tag to level anybody to, and that is refused before the
 * first ssh byte rather than discovered after N probes — the same rule `crew add` follows.
 *
 * **THE TAG IS THE WHOLE CONTRACT HERE, and this lead's own build stamp is no part of it.** The
 * member installs the GitHub release tarball, whose stamp is the release commit; a packaged lead
 * (nix, AUR, brew) or any lead built from that same tag elsewhere carries a different stamp, or
 * none. So `expected` is the tag, {@link Build.commit} stays empty, and nothing on this route ever
 * compares a stamp against a stamp.
 */
function releaseBuild(deps: Wired, kind: InstallKind): Decided {
  // Cut back to the release it names: this lead may answer `1.11.1+ab12cd3`, and the tag is neither
  // half of that string on its own.
  const version = releaseOf(collieVersionBare(deps.ctx.root, (p) => deps.files.read(p)));
  if (parsePrereleaseTag(`v${version}`) === null) {
    deps.io.err("error: cannot read this lead's version, so there is no release to level the members to.");
    deps.io.err(`       ${deps.ctx.root} is a ${kind.kind} install, so \`crew update\` levels each member to`);
    deps.io.err("       the release this lead runs. `collie version` here is the value it needs.");
    return { code: EXIT.FAIL };
  }
  const tag = `v${version}`;
  return {
    build: { route: "release", version, commit: "", expected: tag, tag, repo: updateRepoOf(deps.ctx.env) },
  };
}

// ── Targets ──────────────────────────────────────────────────────────────────

/**
 * Which members this run is about. A **bare** `crew update` is a usage error rather than "all": a
 * verb that SSHes into every machine you lead must not do so because a word was left off.
 */
async function resolveTargets(
  deps: Wired,
  data: TrustStoreData,
  roster: readonly TrustedMember[],
  o: {
    positional: readonly string[];
    flags: Readonly<Record<string, string>>;
    bare: ReadonlySet<string>;
    port: number;
  },
): Promise<Target[] | number> {
  const all = o.bare.has("all");
  if (all && o.positional.length > 0) {
    deps.io.err("error: `--all` names every peer already — drop the member names, or drop `--all`.");
    return EXIT.USAGE;
  }
  if (!all && o.positional.length === 0) {
    for (const usage of USAGE) deps.io.err(usage);
    deps.io.err("");
    deps.io.err("this lead's peers:");
    for (const row of await rosterLines(deps, data, roster)) deps.io.err(row);
    return EXIT.USAGE;
  }
  const named: TrustedMember[] = [];
  for (const name of o.positional) {
    if (name === data.self.memberId) {
      deps.io.err(`error: "${name}" is this machine — a lead updates itself with \`collie update\`.`);
      return EXIT.USAGE;
    }
    const member = roster.find((m) => m.memberId === name);
    if (member === undefined) {
      deps.io.err(`error: no enrolled member "${name}" in this roster — \`collie crew status\` lists them.`);
      return EXIT.STATE;
    }
    if (!named.includes(member)) named.push(member);
  }
  const chosen = all ? roster : named;

  const overridden = ["host", "path", "port"].some((f) => o.flags[f] !== undefined);
  if (overridden && chosen.length !== 1) {
    deps.io.err("error: --host/--path/--port describe ONE machine — name a single member with them.");
    return EXIT.USAGE;
  }

  const targets: Target[] = [];
  for (const member of chosen) {
    const record = await deps.ops.get(member.memberId);
    const sshHost = o.flags.host ?? record?.sshHost ?? "";
    targets.push({
      member,
      sshHost,
      path: o.flags.path ?? record?.path ?? null,
      port: o.flags.port !== undefined ? o.port : (record?.port ?? o.port),
      overridden,
    });
  }
  const unreadable = (await deps.ops.load()).unreadable;
  if (unreadable) {
    deps.io.err("warn: the ops file beside the trust store is not one this build can read, so no member has");
    deps.io.err("      a remembered ssh host. It was left untouched — pass `--host`, or fix the file.");
  }
  return targets;
}

/** The roster, with what each member reports over the crew link — the bare verb's listing. */
async function rosterLines(
  deps: Wired,
  data: TrustStoreData,
  roster: readonly TrustedMember[],
): Promise<string[]> {
  const ours = collieVersionBare(deps.ctx.root, (p) => deps.files.read(p));
  const probes = await probeMembers(deps, data, roster);
  const lines: string[] = [];
  for (const member of roster) {
    const outcome = probes.get(member.memberId);
    const reported = outcome?.ok === true ? (outcome.value.version ?? "pre-1.0.0-alpha.12 (not reported)") : null;
    const state = reported === null ? "did not answer" : reported === ours ? `${reported} — current` : reported;
    lines.push(`  ${member.memberId}  ${state}`);
  }
  lines.push(`  this lead runs ${ours}.`);
  return lines;
}

// ── The probe phase ──────────────────────────────────────────────────────────

/** Probe every target read-only, banking a verdict for each. Returns the ones worth pushing to. */
async function planAll(
  deps: Wired,
  targets: readonly Target[],
  build: Build,
  outcomes: Map<string, UpdateRow>,
  runners: RemoteRunner[],
  packaged: ReadonlySet<string>,
): Promise<readonly Planned[]> {
  const ready: Planned[] = [];
  for (const target of targets) {
    const id = target.member.memberId;
    if (target.sshHost === "") {
      plan(deps, id, "skipped", "no ssh record — run `collie crew add <host>` once to teach it");
      outcomes.set(id, { memberId: id, outcome: "skipped", detail: NO_ROUTE_DETAIL });
      continue;
    }
    // A PACKAGED PEER IS SKIPPED, NOT PUSHED TO (ADR 0035). Before the probe, before the runner:
    // there is nothing to learn over ssh that changes the answer, and the leg that would follow —
    // a `git bundle` pushed into a root that is not a git checkout and is not this ssh user's to
    // write — fails deep inside the push with a git or a permission error instead of one sentence
    // naming the boundary. Skipped rather than fatal, exactly as an `ops-record` red is: a machine
    // this run cannot level is not a reason to leave the machines it can level un-levelled.
    if (packaged.has(id)) {
      plan(deps, id, "skipped", PACKAGED_SENTENCE);
      outcomes.set(id, { memberId: id, outcome: "skipped", detail: PACKAGED_DETAIL });
      continue;
    }
    const runner = deps.remote(target.sshHost);
    runners.push(runner);
    const { result, probe } = await runProbe(runner, { path: target.path, port: target.port });
    const transport = transportFailure(deps.io, target.sshHost, result);
    if (transport !== null) {
      blocked(deps, id, outcomes, `ssh could not reach ${target.sshHost}`);
      continue;
    }
    if (probe === null || result.code !== 0) {
      deps.io.err(`error: ${target.sshHost} answered the probe with ${probe === null ? "something this build cannot read" : `exit ${result.code}`} — ${firstLine(result.stderr)}`);
      blocked(deps, id, outcomes, `${target.sshHost} did not answer the probe`);
      continue;
    }
    if (probe.checkout === "") {
      deps.io.err(`error: no Collie at ${target.sshHost}${target.path === null ? "" : ` (${target.path})`}.`);
      deps.io.err("       `collie crew update` levels an existing one; `collie crew add` installs the first.");
      blocked(deps, id, outcomes, "no Collie there");
      continue;
    }
    // The route is proven the moment the probe answers with a checkout: the host was reachable and
    // the path names a real Collie. Remembering it HERE, before the one consent and before any leg
    // that can fail, is what closes the bug a `--host` run used to have — a build or restart failure
    // downstream must not cost the operator the route they just typed correctly.
    await remember(deps, target, probe);
    // WHAT KIND OF COLLIE IS THERE, from the two shapes leg 1 reports and from nothing else. It
    // decides one thing on each route: which members this run can advance, and what the rest are
    // told instead of being written over (#248).
    const memberKind = memberInstallKind(probe);
    if (build.route === "release") {
      planRelease(deps, { target, probe, runner, memberKind }, build, outcomes, ready);
      continue;
    }
    if (memberKind === "binary") {
      // Seen for the first time since #248 taught the probe to look behind `<dir>/current`. Before
      // that this member answered "no Collie there" and the operator was told a falsehood about a
      // machine that has one. It is named rather than pushed to: a `git bundle` into an install.sh
      // layout would clone a second Collie beside the one that is running.
      plan(
        deps,
        id,
        "skipped",
        `${BINARY_MEMBER_DETAIL} at ${probe.installroot}, which takes releases — the phone's Updates page levels it`,
      );
      outcomes.set(id, { memberId: id, outcome: "skipped", detail: BINARY_MEMBER_DETAIL });
      continue;
    }
    if (memberKind === "git" && probe.dirty === "yes") {
      // Refused, never prompted — the same rule `crew add` applies, for the same reason: a y/N in
      // front of a `git checkout` that discards someone's work is consent theatre, and the remedy is
      // one command on that machine. Asked of a git member alone: a binary member has no working
      // tree, so its `dirty` answer is empty and means nothing.
      deps.io.err(`error: the Collie checkout at ${probe.checkout} has uncommitted changes:`);
      deps.io.err(`       ${probe.dirtyfiles}`);
      deps.io.err(`       \`git stash\` or commit them on ${target.sshHost}, then re-run. Collie will not`);
      deps.io.err("       discard work it did not create.");
      blocked(deps, id, outcomes, "uncommitted changes there");
      continue;
    }
    if (probe.commit === build.commit) {
      plan(deps, id, "current", `already at ${probe.version || "this commit"} (${build.commit.slice(0, 12)})`);
      outcomes.set(id, { memberId: id, outcome: "current", detail: probe.version || build.commit.slice(0, 12) });
      continue;
    }
    plan(
      deps,
      id,
      "ready",
      `${probe.version || "(unbuilt)"} at ${probe.commit.slice(0, 12) || "?"} · ${target.sshHost}:${probe.checkout}`,
    );
    ready.push({ target, probe, runner, root: probe.checkout, installRoot: "" });
  }
  return ready;
}

/**
 * One member's verdict on the RELEASE route — the lead has no commit, so only a member that takes
 * releases can be advanced from here (#248).
 *
 * A git checkout is SKIPPED rather than failed: it is somebody's working tree, converting it from
 * here would move it, and the remedy is one command typed on that machine. Skipped and not fatal for
 * the reason a packaged peer is — a machine this run cannot level is no reason to leave the machines
 * it can level un-levelled. A Collie that is neither shape is blocked, because there is nothing this
 * run could safely do to it and nothing to name as the fix.
 *
 * `probe.dirty` is never read here: a binary member has no working tree to be dirty.
 */
function planRelease(
  deps: Wired,
  o: { target: Target; probe: Probe; runner: RemoteRunner; memberKind: MemberKind },
  build: Build,
  outcomes: Map<string, UpdateRow>,
  ready: Planned[],
): void {
  const { target, probe, runner } = o;
  const id = target.member.memberId;
  if (o.memberKind === "git") {
    plan(
      deps,
      id,
      "skipped",
      `a git checkout at ${probe.checkout}, and this lead has no commit to push — run \`collie update --to-tag ${build.tag}\` there`,
    );
    outcomes.set(id, { memberId: id, outcome: "skipped", detail: SOURCE_CHECKOUT_DETAIL });
    return;
  }
  if (o.memberKind === "other") {
    deps.io.err(`error: the Collie at ${probe.checkout} on ${target.sshHost} is neither a git checkout nor an`);
    deps.io.err(`       install.sh layout, so this lead has no safe way to level it — run \`collie update\` there.`);
    blocked(deps, id, outcomes, "neither a checkout nor an install.sh layout");
    return;
  }
  // The build stamp is not a version difference: a built Collie answers `1.11.1+ab12cd3` and the tag
  // is `v1.11.1`, so both sides are cut back to the release they name.
  if (releaseOf(probe.version) === build.version) {
    plan(deps, id, "current", `already at ${probe.version} — this lead's own release`);
    outcomes.set(id, { memberId: id, outcome: "current", detail: probe.version });
    return;
  }
  plan(deps, id, "ready", `${probe.version || "(unreadable)"} · ${target.sshHost}:${probe.installroot}`);
  ready.push({ target, probe, runner, root: probe.checkout, installRoot: probe.installroot });
}

// ── The preflight gate ───────────────────────────────────────────────────────

/**
 * Spec 03's preflight over this lead and every member this run means to touch. `null` means go.
 *
 * **A red here costs nothing to obey.** Nothing has been pushed, built or restarted at this point,
 * so the whole run is still free to be one sentence naming a machine and a reason. The alternative —
 * discovering the same fact on the third member, mid-push — is the failure this gate exists to move
 * to the front.
 *
 * Two ids are deliberately not gated on. `ops-record` is a member this run already treats as
 * SKIPPED, because it has no route to it and never touches it; a preflight red about a machine
 * nobody is going to reach must not stop the machines that can be reached. Amber never blocks, by
 * spec 03's own rule: a gate that fires on a healthy host is a gate the operator learns to bypass.
 *
 * **It also reads each member's install KIND.** A packaged peer's report is green throughout —
 * nothing is wrong with such an install — so nothing here can block on it, and nothing should: the
 * fact it carries is not "this machine is unhealthy" but "this machine is not ours to write to". It
 * is returned rather than acted on, because the place that acts on it is the member walk
 * ({@link planAll}), which is where every other "leave this one alone" decision is already made.
 */
/** Each target's route as THIS command line resolved it, keyed for the member walk to read. */
function routeOverrides(targets: readonly Target[]) {
  const entries: readonly (readonly [string, MemberRoute])[] = targets.map((t) => [
    t.member.memberId,
    { sshHost: t.sshHost, path: t.path, port: t.port },
  ]);
  return Object.fromEntries(entries);
}

async function preflightGate(deps: Wired, targets: readonly Target[]): Promise<Gate> {
  const routed = targets.filter((t) => t.sshHost !== "");
  const named = new Set(routed.map((t) => t.member.memberId));
  // The walk gets THIS run's route for every target, not the one the ops file remembers. Without
  // this a stale record fails the gate before the `--host/--path/--port` that corrects it is ever
  // read, and the red's own remedy is to pass those flags — a loop no operator can leave.
  const checked = await deps.preflight({ overrides: routeOverrides(targets) });
  // What each member said about ITSELF over the crew link (§19, M16/03), beside what this walk found
  // over ssh. Printed, never preferred: see {@link peerReportLines}.
  for (const said of peerReportLines(checked.crew ?? [], await deps.peerReported(), named, deps.now())) {
    line(deps, said);
  }
  const reds: { readonly who: string; readonly check: PreflightCheck }[] = [
    ...checked.checks.filter(blocks).map((check) => ({ who: "this lead", check })),
    ...(checked.crew ?? [])
      .filter((m) => named.has(m.memberId))
      .flatMap((m) => m.checks.filter(blocks).map((check) => ({ who: m.memberId, check }))),
  ];
  const packaged = packagedMembers(checked.crew ?? []);
  if (reds.length === 0) {
    line(deps, `preflight: nothing red on this lead${routed.length === 0 ? "" : ` or on ${nMembers(routed.length)}`}.`);
    return { exit: null, packaged };
  }
  for (const { who, check } of reds) {
    deps.io.err(`error: the preflight is red on ${who} — ${check.reason}`);
    if (check.remedy !== undefined) deps.io.err(`       clear it with: ${check.remedy}`);
  }
  deps.io.err("       Nothing was pushed, built or restarted, on any member.");
  return { exit: EXIT.FAIL, packaged };
}

/** What the gate learned: whether to stop, and which members are not this run's to write to. */
interface Gate {
  /** Non-null ⇒ the run stops here with this exit code. Nothing has been touched. */
  readonly exit: number | null;
  /** Every member whose own report named its install kind as `packaged`. */
  readonly packaged: ReadonlySet<string>;
}

/**
 * Every member whose own preflight reports a `packaged` install.
 *
 * **The KIND is what is read, never a check id.** A check id labels a sentence; the kind is the
 * fact, and it rides on the member's report as {@link PreflightMember.installKind}. Matching on an
 * id would make a rename of one green line silently un-skip a packaged peer, with a `git bundle`
 * pushed into a package manager's folder as the first symptom.
 *
 * A member that names no kind — one older than the field, or one this run never reached — is not
 * packaged, which is exactly how such a member behaved before this existed.
 *
 * Pure, and exported for the test: the whole of "does the walk recognise a packaged peer" is one
 * report in and one set out.
 */
export function packagedMembers(crew: readonly PreflightMember[]): ReadonlySet<string> {
  const packaged = new Set<string>();
  for (const member of crew) if (member.installKind === "packaged") packaged.add(member.memberId);
  return packaged;
}

/** The row detail a member skipped for having no route carries — and the count's discriminator. */
const NO_ROUTE_DETAIL = "no ssh record";

/** The same, for a member this run may not write to at all. Short: it is a table column. */
const PACKAGED_DETAIL = "packaged";

/** A member running from git that a lead with no commit cannot advance (#248). Its own column word. */
const SOURCE_CHECKOUT_DETAIL = "source checkout";

/** A member that takes releases, on a lead that hands out a commit. The mirror of the row above. */
const BINARY_MEMBER_DETAIL = "binary install";

/** How long this verb waits on its own bridge for a fact it can also do without. */
const BANKED_BUDGET_MS = 2000;

/**
 * The `crew` array off THIS collie's own `GET /api/update/check`, or an empty list.
 *
 * A read, on the address the bridge BOUND (`cli/doctor.ts`'s `ownSnapshot` is the precedent and the
 * reasoning): a peer sets `COLLIE_HOST` and never answers on loopback, and a wildcard bind answers
 * everywhere. Every failure — no bridge, a gate, a body this build cannot read — is the same empty
 * answer, because this is a nicety on a transcript and never a gate.
 */
async function bankedPeerVerdicts(deps: CrewUpdateDeps): Promise<readonly CrewUpdateRow[]> {
  const host = resolveBridgeHost(deps.ctx.env);
  const dialled = bindIsWildcard(host) ? "127.0.0.1" : host;
  const bracketed = dialled.includes(":") && !dialled.startsWith("[") ? `[${dialled}]` : dialled;
  try {
    const answer = await deps.fetch(`http://${bracketed}:${String(deps.ctx.port)}/api/update/check`, {
      signal: AbortSignal.timeout(BANKED_BUDGET_MS),
    });
    if (!answer.ok) return [];
    // SAFETY: `Response.json()` answers a JSON value, and `parseCrewRows` validates every field of
    // it below — a row missing any of them is dropped rather than half-read. Nothing here becomes a
    // path, a command or a credential; it is printed.
    return parseCrewRows((await answer.json()) as JsonValue);
  } catch {
    return [];
  }
}

/** Does this check stop the run? See {@link preflightGate} for the one id that does not. */
const blocks = (c: PreflightCheck): boolean => c.verdict === "red" && c.id !== "ops-record";

// ── The peer-reported verdict, beside the ssh one (M16/03) ───────────────────

/**
 * What this run PRINTS about the verdict each member published over the crew link (§19).
 *
 * **It changes nothing.** Consent, ordering and abort behaviour are untouched: the ssh walk above is
 * still the gate, because it is the only one that reached the machine this run is about to write to.
 * What the link adds is a second, independent opinion — produced by the member itself, on its own
 * clock — and a disagreement between the two is a fact worth a line rather than something to resolve
 * by silently preferring one. The commonest cause is simply age: a link verdict from six hours ago
 * and an ssh verdict from four seconds ago are different claims, so every line carries the stamp.
 *
 * A member the link has nothing on prints nothing: no line is better than a line about silence.
 */
export function peerReportLines(
  ssh: readonly PreflightMember[],
  reported: readonly CrewUpdateRow[],
  named: ReadonlySet<string>,
  now: number,
): string[] {
  const out: string[] = [];
  for (const row of reported) {
    if (!named.has(row.name)) continue;
    const reason = row.reasons[0] === undefined ? "" : ` — ${row.reasons[0]}`;
    out.push(`preflight: ${row.name} reports ${row.verdict} over the link${reason} (${ageOf(row.asOf, now)})`);
    const walked = ssh.find((m) => m.memberId === row.name);
    if (walked === undefined || walked.verdict === row.verdict) continue;
    out.push(
      `           they disagree: ssh says ${walked.verdict}, the link says ${row.verdict} — this run follows the ssh walk`,
    );
  }
  return out;
}

/** How old a member's own stamp is, in the plainest words. `null` ⇒ it has never produced one. */
function ageOf(asOf: number | null, now: number): string {
  if (asOf === null) return "never checked there";
  const seconds = Math.max(0, Math.round((now - asOf) / 1000));
  if (seconds < 90) return `as of ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `as of ${minutes}m ago`;
  return `as of ${Math.round(minutes / 60)}h ago`;
}

const nMembers = (n: number): string => `${n} member${n === 1 ? "" : "s"}`;

// ── The lead's own turn ──────────────────────────────────────────────────────

/**
 * Is this lead running the build it is about to hand out?
 *
 * The question is asked of what this machine ANSWERS with, not of what its checkout says: a checkout
 * that has advanced without being built is exactly the case where the peers would end up on a build
 * their lead has never run.
 */
function leadIsBehind(deps: Wired, version: string, commit: string): boolean {
  return !answersThisBuild(collieVersionBare(deps.ctx.root, (p) => deps.files.read(p)), version, commit);
}

/**
 * The lead's leg: hand off to its own updater, then WAIT for the record to settle.
 *
 * It is the same runner `collie update` uses and the same record `collie update --status` reads —
 * the health gate and the one rollback come with it (M15/04), so a lead that does not come up rolls
 * itself back and this run stops before a single peer is touched.
 *
 * The wait is bounded by the record's own staleness rule rather than by the health budget: this leg
 * covers a full build, which is minutes on small hardware, and a killed updater is reported as
 * `interrupted` by that rule long before the ten minutes are up.
 */
async function updateLead(deps: Wired, version: string): Promise<boolean> {
  const ours = collieVersionBare(deps.ctx.root, (p) => deps.files.read(p));
  line(deps, "");
  line(deps, `this lead: ${ours} — it takes ${version} first, before any peer does.`);
  const started = await deps.lead.start();
  if (started !== EXIT.OK) {
    deps.io.err(`error: this lead's own update would not start (exit ${started}) — no peer was touched.`);
    deps.io.err("       Run `collie update` here, then re-run this command.");
    return false;
  }
  const outcome = await awaitRunRecord(() => deps.lead.record(), {
    now: deps.now,
    sleep: deps.sleep,
    timeoutMs: STALE_AFTER_MS,
    pollMs: LEAD_POLL_MS,
  });
  if (outcome.kind === "done") {
    line(deps, `  ✓ this lead is running ${version} — the peers can have it.`);
    return true;
  }
  const what = outcome.kind === "timeout" ? "did not finish" : `ended as ${outcome.state}`;
  deps.io.err(`error: this lead's own update ${what} — ${outcome.reason}.`);
  if (outcome.kind === "failed" && outcome.recovery !== null) {
    deps.io.err(`       recover with: ${outcome.recovery}`);
  }
  deps.io.err("       No peer was touched, and none is behind anything this lead is running.");
  skewNote(deps);
  return false;
}

/** How often the lead's record is read. A build is minutes; a second between reads buys nothing. */
const LEAD_POLL_MS = 2_000;

// ── The one confirmation ─────────────────────────────────────────────────────

/**
 * The whole operation, in one question. `EXIT.OK` means go.
 *
 * isTTY-gated exactly as `crew add` is, and for the same reason: a `confirm` nobody can answer must
 * abort legibly rather than read EOF as yes. There is deliberately **no `--yes`** — a flag that skips
 * this is a flag that turns one typo into N rebuilt machines, and the consent story stays the one
 * `crew add` already tells.
 */
async function confirmBatch(
  deps: Wired,
  ready: readonly Planned[],
  outcomes: ReadonlyMap<string, UpdateRow>,
  build: Build,
  leadFirst: boolean,
): Promise<number> {
  const named = ready
    .map((p) => `${p.target.member.memberId} (${p.probe.version || "unbuilt"})`)
    .join(", ");
  const banked = [...outcomes.values()];
  const current = banked.filter((r) => r.outcome === "current").length;
  // Two reasons a member is skipped, and they are counted apart: "3 skipped" that folds a peer with
  // no ssh record into a peer this run may not write to would be one number the operator cannot act
  // on. The row detail is the discriminator because it is also the word the summary table prints.
  const skipped = (detail: string): number =>
    banked.filter((r) => r.outcome === "skipped" && r.detail === detail).length;
  const unrouted = skipped(NO_ROUTE_DETAIL);
  const owned = skipped(PACKAGED_DETAIL);
  const source = skipped(SOURCE_CHECKOUT_DETAIL);
  const binary = skipped(BINARY_MEMBER_DETAIL);
  const refused = banked.filter((r) => r.outcome === "failed").length;
  const aside = [
    current === 0 ? "" : `${current} already current`,
    unrouted === 0 ? "" : `${unrouted} without an ssh record`,
    owned === 0 ? "" : `${owned} packaged`,
    source === 0 ? "" : `${source} on a source checkout`,
    binary === 0 ? "" : `${binary} on a binary install`,
    refused === 0 ? "" : `${refused} the probe refused`,
  ].filter((s) => s !== "");
  // The release route names the TAG and no commit, because there is no commit — a question that
  // printed twelve characters of a build stamp would name a thing nobody can look up.
  const to = build.route === "release" ? build.tag : `${build.version} (${build.commit.slice(0, 12)})`;
  const question =
    `update ${nMembers(ready.length)} to ${to}` +
    ` over ssh: ${named}${aside.length === 0 ? "" : ` — ${aside.join(", ")}`}` +
    // Said in the SAME question, never as a second one: the lead is part of the operation being
    // consented to, not an operation of its own.
    `${leadFirst ? ", this lead first" : ""}?`;
  const answer = await deps.confirm(question);
  if (answer === null) {
    deps.io.err(`error: this run is not interactive, and it would have asked: ${question}`);
    deps.io.err("       Nothing was sent. Re-run from a terminal.");
    return EXIT.FAIL;
  }
  if (!answer) {
    deps.io.err("error: left alone — nothing was pushed, built or restarted.");
    return EXIT.STATE;
  }
  return EXIT.OK;
}

// ── The work ─────────────────────────────────────────────────────────────────

/** Where a run stopped, and the one command that clears it. */
interface Stopped {
  readonly memberId: string;
  readonly recovery: string;
}

/**
 * Every consented member, one at a time. **The first failure ends the run.**
 *
 * `null` means every member took the build. Anything else names the member that failed — it has
 * already rolled itself back or been left exactly as its failing leg found it — and every member
 * after it in the order is recorded as "not attempted" without being touched.
 */
async function workAll(
  deps: Wired,
  data: TrustStoreData,
  ready: readonly Planned[],
  o: { build: Build; outcomes: Map<string, UpdateRow> },
): Promise<Stopped | null> {
  // Bundled ONCE for the whole run: the commit is one artifact, and re-running `git bundle` per
  // member would be N copies of the same bytes with N chances for HEAD to have moved underneath.
  // Never bundled at all on the release route: there is no commit to bundle, and what travels
  // instead is Collie's own installer, which is a constant in this binary (#248).
  let bundle: string | null = null;
  for (const [index, planned] of ready.entries()) {
    const id = planned.target.member.memberId;
    deps.emitUpdate({ kind: "member-start", memberId: id });
    if (o.build.route === "bundle" && bundle === null) {
      bundle = await deps.gitBundle(o.build.commit, deps.io);
      if (bundle === null) {
        deps.io.err(`error: could not bundle ${o.build.commit.slice(0, 12)} from ${deps.ctx.root}.`);
        fail(deps, id, o.outcomes, "nothing to push — the bundle failed here");
        // Nothing can be sent to anyone: the rest are untouched for a reason of their own.
        untouched(deps, ready.slice(index + 1), o.outcomes, "not attempted — the bundle failed here");
        return { memberId: id, recovery: `collie crew update ${id}` };
      }
    }
    const from = planned.probe.version || planned.probe.commit.slice(0, 12) || "unbuilt";
    const failure = await workOne(deps, data, planned, { ...o, bundle });
    if (failure !== null) {
      untouched(deps, ready.slice(index + 1), o.outcomes, `not attempted — the run stopped at ${id}`);
      return failure;
    }
    o.outcomes.set(id, { memberId: id, outcome: "updated", detail: `${from} → ${o.build.version}` });
    deps.emitUpdate({ kind: "member-done", memberId: id, outcome: "updated" });
  }
  return null;
}

/** The members after the one that failed. Recorded, never dialled — that is the whole point. */
function untouched(
  deps: Wired,
  rest: readonly Planned[],
  outcomes: Map<string, UpdateRow>,
  detail: string,
): void {
  for (const planned of rest) {
    const id = planned.target.member.memberId;
    outcomes.set(id, { memberId: id, outcome: "skipped", detail });
    deps.emitUpdate({ kind: "member-done", memberId: id, outcome: "skipped" });
  }
}

/** One member's four legs. Non-null means it failed, and the failure has already been recorded. */
async function workOne(
  deps: Wired,
  data: TrustStoreData,
  planned: Planned,
  o: {
    build: Build;
    /** The bundle every member on the bundle route takes. `null` on the release route. */
    bundle: string | null;
    outcomes: Map<string, UpdateRow>;
  },
): Promise<Stopped | null> {
  const { target, runner, root } = planned;
  const id = target.member.memberId;
  const host = target.sshHost;
  const release = o.build.route === "release";

  // ── push ───────────────────────────────────────────────────────────────────
  // ONE LEG, TWO ROUTES, and the leg keeps its id in both so no transcript reader needs a new word
  // for it. What changes is the line under it: the bundle route says "pushing <commit>" and the
  // release route says "installing <tag>" (#248).
  deps.emitUpdate({ kind: "leg-start", memberId: id, leg: "push" });
  const { result, version: built } = await pushLeg(deps, planned, o);
  if (transportFailure(deps.io, host, result) !== null) {
    const what = release ? `the install on ${host}` : `the push to ${host}`;
    return legFailed(deps, id, "push", o.outcomes, `ssh dropped during ${what}`);
  }
  if (result.code !== 0) {
    if (release) {
      deps.io.err(`error: the install failed on ${host} — ${installerErrorLine(result.stderr)}`);
      deps.io.err(`       ${root} still runs what it ran before; nothing was restarted.`);
      return legFailed(deps, id, "push", o.outcomes, "the install failed there");
    }
    deps.io.err(`error: the build failed on ${host} — ${errorLine(result.stderr)}`);
    deps.io.err(`       The checkout at ${root} was left as the install found it; nothing was restarted.`);
    return legFailed(deps, id, "push", o.outcomes, "the build failed there");
  }
  if (built === null) {
    deps.io.err(`error: the install on ${host} reported nothing this build can read.`);
    return legFailed(deps, id, "push", o.outcomes, "the install reported nothing readable");
  }
  deps.emitUpdate({ kind: "leg-done", memberId: id, leg: "push", ok: true, detail: `${built} at ${root}` });

  // ── restart ────────────────────────────────────────────────────────────────
  // The far machine's bridge is still running the code it booted with; only its own service manager
  // can move it, so its own `collie restart` is what runs — never a unit name guessed from here.
  deps.emitUpdate({ kind: "leg-start", memberId: id, leg: "restart" });
  const restarted = await runner.run(restartScript(root));
  if (transportFailure(deps.io, host, restarted) !== null) {
    return legFailed(deps, id, "restart", o.outcomes, `ssh dropped during the restart on ${host}`);
  }
  if (restarted.code !== 0) {
    deps.io.err(`error: \`collie restart\` exited ${restarted.code} on ${host} — ${errorLine(restarted.stderr)}`);
    deps.io.err(`       ${id} has the new build on disk and the old one still running. Run \`collie restart\` there.`);
    return legFailed(deps, id, "restart", o.outcomes, "built, but its bridge did not come back");
  }
  deps.emitUpdate({ kind: "leg-done", memberId: id, leg: "restart", ok: true, detail: "its bridge came back" });

  // ── verify: the health gate ────────────────────────────────────────────────
  // The lead's own view decides, not the ssh exit code: the member answers `hello` over the crew link
  // and says which version it is running. That is the same fact `crew status` renders as skew, so a
  // run that ends green here is a run whose skew warning has actually gone.
  //
  // It POLLS, on the same budget the local health gate uses (M15/04), because a bridge that has just
  // been restarted is not up the instant `collie restart` returns — a single ask a second too early
  // would call a healthy member a failure. And it is a GATE, not a warning: a member that never comes
  // back running what was pushed stops the run, and the members after it keep the build they have.
  deps.emitUpdate({ kind: "leg-start", memberId: id, leg: "verify" });
  const health = await awaitPeerBuild(deps, data, planned, o);
  if (!health.ok) {
    // Asked over ssh, never over the crew link: the member's own updater record is the only thing
    // that knows whether it rolled back, and `curl` is not assumed to exist on anybody's machine.
    const record = await peerRun(planned);
    const detail = record === null ? health.reason : `${health.reason}; its own updater reports ${record.state}`;
    deps.io.err(`error: ${id} did not come back running ${o.build.expected} — ${detail}.`);
    if (record?.reason !== undefined) deps.io.err(`       ${id} says: ${record.reason}`);
    deps.io.err(`       Run \`collie doctor\` on ${host}: it names the bind, the ACL and the clock.`);
    const recovery =
      record?.recovery === undefined ? `collie crew update ${id}` : `ssh ${host} -- ${record.recovery}`;
    return legFailed(deps, id, "verify", o.outcomes, detail, recovery);
  }
  deps.emitUpdate({
    kind: "leg-done",
    memberId: id,
    leg: "verify",
    ok: true,
    detail: `answers at ${target.member.address} · ${health.reported ?? "no version reported"}`,
  });

  // The route was already remembered once the probe proved it, in `planAll` — well before this leg
  // runs, and well before the one consent. Nothing left to do here.
  return null;
}

/**
 * The push leg's ONE remote call, whichever route this run is on. The same `{ result, version }`
 * shape comes back from both, so the caller's success and failure handling is one piece of code.
 *
 * The bundle route sends this lead's commit and the member builds it. The release route sends
 * Collie's own installer, out of this binary, and the member downloads the release the lead runs
 * and verifies its sha256 against the release manifest (#248). Neither leg pipes anything into a
 * shell, and neither fetches a script.
 */
function pushLeg(
  deps: Wired,
  planned: Planned,
  o: { build: Build; bundle: string | null },
): Promise<{ readonly result: RemoteResult; readonly version: string | null }> {
  const { runner, root, installRoot, target } = planned;
  const { build } = o;
  if (build.route === "release") {
    line(deps, `  installing ${build.tag} from ${build.repo} at ${installRoot} on ${target.sshHost}…`);
    return runInstallRelease(
      runner,
      { installRoot, tag: build.tag, repo: build.repo, version: build.version },
      INSTALLER_SH,
    );
  }
  // `??` rather than an assertion: `workAll` makes the bundle before the first member on this route,
  // and a run that could not make one never reaches here.
  const bundle = o.bundle ?? "";
  line(deps, `  pushing ${build.commit.slice(0, 12)} (${Math.round(bundle.length / 1024)} KiB base64) to ${root}…`);
  return runInstall(runner, { root, commit: build.commit, version: build.version }, bundle);
}

/**
 * Does a levelled member's answer name what this run handed out?
 *
 * ONE QUESTION, TWO CONTRACTS. On the BUNDLE route this lead pushed a real commit and the member
 * built that commit, so `answersThisBuild` compares the member's `+<sha>` against it as an
 * abbreviation (`bridge/version.ts`): the commit is the thing that was handed out, and the stamp
 * names it.
 *
 * **On the RELEASE route the RELEASE alone decides, and the stamp is never compared.** What was
 * handed out is a tag. The member installs that tag's GitHub tarball, whose stamp is the release
 * commit — while this lead's own stamp is whoever built THIS copy: a packaged lead (nix, AUR, brew)
 * or any lead built from the same tag elsewhere carries a different one, or none at all. Comparing
 * the two would fail a member that is running exactly the release it was told to run. Found in the
 * VM rehearsal of #248.
 *
 * A member that reports no version at all passes on both routes, upstream of here: an unstamped
 * Collie can only name its manifest, and that is not evidence against what it took.
 */
function answersThisRun(reported: string, build: Build): boolean {
  if (build.route === "release") return releaseOf(reported) === build.version;
  return answersThisBuild(reported, build.version, build.commit);
}

/** What the health gate saw: the version the member answers with, or why it never answered it. */
type PeerHealth =
  | { readonly ok: true; readonly reported: string | null }
  | { readonly ok: false; readonly reason: string };

/**
 * Poll one member until it answers the build that was pushed, or the budget runs out.
 *
 * The budget is the local gate's — `COLLIE_UPDATE_HEALTH_TIMEOUT_MS`, 30 s by default — because it is
 * the same question about the same kind of machine, and two numbers for one wait is two numbers to
 * tune. The poll count is bounded as well as the clock, so a caller whose clock does not move still
 * terminates.
 *
 * A member that reports NO version at all passes: an unstamped Collie can only name its manifest,
 * and that is not evidence against the build (`bridge/version.ts`).
 */
async function awaitPeerBuild(
  deps: Wired,
  data: TrustStoreData,
  planned: Planned,
  o: { build: Build },
): Promise<PeerHealth> {
  const id = planned.target.member.memberId;
  const budget = healthTimeoutMs(deps.ctx.env);
  const deadline = deps.now() + budget;
  const tries = Math.max(1, Math.ceil(budget / HEALTH_POLL_MS));
  let reason = "it never answered at all";
  for (let i = 0; i < tries; i++) {
    const outcome = (await probeMembers(deps, data, [planned.target.member])).get(id);
    if (outcome?.ok !== true) {
      reason = `this lead cannot reach it at ${planned.target.member.address}`;
    } else {
      const reported = outcome.value.version;
      if (reported === null || answersThisRun(reported, o.build)) return { ok: true, reported };
      reason = `it answers as ${reported}, not ${o.build.expected}`;
    }
    if (i + 1 >= tries || deps.now() >= deadline) break;
    await deps.sleep(HEALTH_POLL_MS);
  }
  return { ok: false, reason: `${reason} after ${Math.round(budget / 1000)}s` };
}

/**
 * The member's own update record, read over the ssh this run already holds open.
 *
 * Best effort, and silent when it fails: this is a diagnosis attached to a failure that has already
 * been decided, and a member too old to know `collie update --status` must not turn one clear failure
 * into two confusing ones.
 */
async function peerRun(planned: Planned): Promise<UpdateRun | null> {
  const { result, run } = await runUpdateStatus(planned.runner, planned.root);
  if (!result.spawned || result.code === 255) return null;
  return run;
}

// ── What "it came back running what we pushed" means ─────────────────────────
// A built Collie reports `<semver>+<short sha>` (`bridge/version.ts`, from the build stamp) — so the
// version the MANIFEST carries is only half of the string a levelled member answers with. Comparing
// against that half alone is what made the first field run warn `answers as 1.0.0-beta.4+fd1a9b3,
// not 1.0.0-beta.4` about a member that was running exactly the commit this lead had just pushed,
// directly under a ✓ that called the same string a success.

/** The full string this lead expects back: the commit's version, stamped with the commit's own sha. */
function expectedAnswer(deps: Wired, version: string, commit: string): string {
  // `--short` rather than a fixed slice: git's abbreviation length is what the build stamp records,
  // so this is the string this lead itself answers with once it has built the same commit.
  const short = gitOut(deps, ["rev-parse", "--short", commit]) || commit.slice(0, 7);
  return `${version}+${short}`;
}

/**
 * Refresh the ops record when the operator steered this run by hand, as soon as the probe has
 * PROVEN the route: the ssh host answered and the path is a Collie checkout. That is deliberately
 * earlier than "the member is fully updated" — a route the operator typed correctly is worth
 * remembering even when the build or the restart fails on a later leg, and a run that forgot it
 * anyway is the bug this closes.
 */
async function remember(deps: Wired, target: Target, probe: Probe): Promise<void> {
  if (!target.overridden) return;
  const record: OpsRecord = {
    sshHost: target.sshHost,
    path: probe.checkout,
    port: target.port,
    recordedAt: deps.now(),
  };
  if (!(await deps.ops.record(target.member.memberId, record))) {
    line(deps, "warn: the ops file could not be updated, so this route was not remembered.", "warn", "err");
  }
}

// ── The closing table ────────────────────────────────────────────────────────

/** The per-member summary and the one line a script should read. */
function report(
  deps: Wired,
  targets: readonly Target[],
  outcomes: ReadonlyMap<string, UpdateRow>,
  version: string,
  // A run can fail without any MEMBER failing — a lead that could not take its own update leaves
  // every peer merely "not attempted". The table must not print a ✓ over that.
  landed = true,
): number {
  const rows: UpdateRow[] = targets.map(
    (t) =>
      outcomes.get(t.member.memberId) ?? {
        memberId: t.member.memberId,
        outcome: "skipped",
        detail: "not attempted",
      },
  );
  const count = (outcome: UpdateOutcome): number => rows.filter((r) => r.outcome === outcome).length;
  const failed = count("failed");
  const behind = failed + count("skipped");
  const parts = [
    `${count("updated")} updated`,
    `${count("current")} already current`,
    `${count("skipped")} skipped`,
    `${failed} failed`,
  ];
  const verdict =
    behind === 0
      ? `${parts.join(", ")} — every member named runs ${version}`
      : `${parts.join(", ")} — ${behind} still behind this lead's ${version}`;
  const ok = failed === 0 && landed;
  deps.emitUpdate({ kind: "summary", rows, verdict, ok });
  return ok ? EXIT.OK : EXIT.FAIL;
}

/**
 * The table, then the abort: what stopped the run, how to clear it, and why stopping was safe.
 *
 * The order matters. The operator reads the table to see where the crew stands and the paragraph
 * under it to see what to do about it, and the recovery command names ONE member — the one that
 * failed — because every member after it was never touched.
 */
function stop(
  deps: Wired,
  targets: readonly Target[],
  outcomes: Map<string, UpdateRow>,
  version: string,
  stopped: Stopped,
): number {
  leaveRest(deps, targets, outcomes, `not attempted — the run stopped at ${stopped.memberId}`);
  const code = report(deps, targets, outcomes, version, false);
  deps.io.err(`error: the run stopped at ${stopped.memberId} — every member after it was left untouched.`);
  deps.io.err(`       recover with: ${stopped.recovery}`);
  deps.io.err("       Then re-run this command; the members that already took the build are current.");
  skewNote(deps);
  return code;
}

/** Every target no leg ever reached. Recorded so the table has a row and a reason for each. */
function leaveRest(
  deps: Wired,
  targets: readonly Target[],
  outcomes: Map<string, UpdateRow>,
  detail: string,
): void {
  for (const target of targets) {
    const id = target.member.memberId;
    if (outcomes.has(id)) continue;
    outcomes.set(id, { memberId: id, outcome: "skipped", detail });
    deps.emitUpdate({ kind: "member-done", memberId: id, outcome: "skipped" });
  }
}

/** Why a half-updated crew is a place it is safe to stop. Printed on every abort, for that reason. */
function skewNote(deps: Wired): void {
  deps.io.err("       A half-updated crew keeps working: CREW_PROTOCOL.md §7.1 tolerates version skew");
  deps.io.err("       inside a protocol version, which is what makes stopping at the first failure safe.");
}

// ── Small shared spellings ───────────────────────────────────────────────────

function line(deps: Wired, text: string, tone: "info" | "warn" | "error" = "info", stream: "out" | "err" = "out"): void {
  deps.emitUpdate({ kind: "line", text, tone, stream });
}

function plan(deps: Wired, memberId: string, state: "ready" | "current" | "skipped", detail: string): void {
  deps.emitUpdate({ kind: "plan", memberId, state, detail });
}

/** A member the probe refused. Recorded as failed — a run that could not look is not a run that passed. */
function blocked(deps: Wired, memberId: string, outcomes: Map<string, UpdateRow>, detail: string): void {
  deps.emitUpdate({ kind: "plan", memberId, state: "blocked", detail });
  outcomes.set(memberId, { memberId, outcome: "failed", detail });
  deps.emitUpdate({ kind: "member-done", memberId, outcome: "failed" });
}

function legFailed(
  deps: Wired,
  memberId: string,
  leg: "push" | "restart" | "verify",
  outcomes: Map<string, UpdateRow>,
  detail: string,
  recovery = `collie crew update ${memberId}`,
): Stopped {
  deps.emitUpdate({ kind: "leg-done", memberId, leg, ok: false, detail });
  fail(deps, memberId, outcomes, detail);
  return { memberId, recovery };
}

function fail(deps: Wired, memberId: string, outcomes: Map<string, UpdateRow>, detail: string): void {
  outcomes.set(memberId, { memberId, outcome: "failed", detail });
  deps.emitUpdate({ kind: "member-done", memberId, outcome: "failed" });
}

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && n < 65536 ? n : null;
}
