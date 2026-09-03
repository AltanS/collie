import { DEFAULT_PORT, resolveBridgeHost } from "../bridge/config.ts";
import type { JsonValue } from "../bridge/json.ts";
import { bindIsWildcard } from "../bridge/pack/config.ts";
import { parsePackRows, type PackUpdateRow } from "../bridge/update-action.ts";
import type { OpsRecord } from "../bridge/pack/ops-store.ts";
import type { TrustedMember, TrustStoreData } from "../bridge/pack/trust-store.ts";
import { STALE_AFTER_MS, type UpdateRun } from "../bridge/update-run.ts";
import { answersThisBuild } from "../bridge/version.ts";
import { collieVersionBare } from "./context.ts";
import { updateDeps } from "./deps.ts";
import { EXIT, type Io } from "./io.ts";
import { parsePackArgs, probeMembers } from "./pack.ts";
import {
  errorLine,
  firstLine,
  gitOut,
  manifestVersionAt,
  restartScript,
  runInstall,
  runProbe,
  runUpdateStatus,
  transportFailure,
  type PackAddDeps,
  type Probe,
  type RemoteRunner,
} from "./remote.ts";
import { plainUpdate, type UpdateEvent, type UpdateOutcome, type UpdateRow } from "./render.ts";
import { cmdUpdate } from "./update.ts";
import {
  preflight,
  updateCheckDeps,
  type PreflightCheck,
  type PreflightMember,
  type PreflightReport,
} from "./update-check.ts";
import { awaitRunRecord, healthTimeoutMs, HEALTH_POLL_MS, readRun } from "./update-run.ts";

// The tolerant `<semver>+<sha>` comparison lives in `bridge/version.ts` now — the health gate of the
// detached updater (M15/04) asks the same question of a machine restarting under it, and one
// implementation is the only way the two can never disagree. Re-exported because every caller and
// test here already spells it `from "./pack-update.ts"`.
export { answersThisBuild };

// `collie pack update [<member>…] [--all]` — level peers to the lead's current build (M7/02).
//
// ── IT RIDES THE OPERATOR'S SSH, NEVER THE PACK WIRE (ADR 0016) ──────────────
// The code goes the same way `pack add` sent it: this lead's own commit, as a `git bundle`, over an
// ssh connection the operator authenticates. Nothing about an update crosses `/pack/v1/*` — the pack
// link carries runtime data and admits nobody, and a lead that could push code down it would be a
// code-execution credential on every peer it leads. That is the whole of the reasoning, and it lives
// in ADR 0016 because it closes a road (an "update all peers" route) that will be proposed again.
//
// ── WHAT IS SHARED WITH `pack add`, AND WHAT IS NOT ──────────────────────────
// Shared: the transport seam, the leg SCRIPTS, and the three emit-free step runners in
// `cli/remote.ts` (`runProbe`, `runInstall`, `restartScript`). Not shared: a single word of output.
// `pack add` is one host walking four legs and it says so in its own voice; this is N members walking
// three, and it has a table at the end. Two verbs, one set of things that run on the far machine.
//
// ── ONE CONSENT, NOT N ───────────────────────────────────────────────────────
// Every member is probed read-only FIRST, and then the whole operation is confirmed once. That
// replaces `pack add`'s per-member replace prompt, because the operator is being asked one question —
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
// That is a deliberate reversal of "record it and carry on", and the reason is PACK_PROTOCOL.md
// §7.1: version skew inside a protocol version is tolerated by design, so a half-updated pack is a
// SUPPORTED state and stopping is cheap. Pressing on after one machine failed is not — it multiplies
// one unexplained fault across every machine still to come, and the operator then has N failures to
// read instead of one. The output says this out loud when it aborts.
//
// ── TERMINAL-ONLY, THIS MILESTONE ────────────────────────────────────────────
// The phone drives the machine it is talking to and nothing else. A pack-wide update needs the one
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

/** `pack update`'s seams: `pack add`'s set, plus the preflight, this lead's own update and a wait. */
export interface PackUpdateDeps extends PackAddDeps {
  /** Where every line this verb says goes as STRUCTURE. Absent ⇒ the plain replay. */
  emitUpdate?(event: UpdateEvent): void;
  /**
   * Spec 03's read-only preflight (`cli/update-check.ts`), behind a seam.
   *
   * A seam rather than a call for the reason every other one here is: this verb's tests must never
   * spawn ssh, and the preflight reaches every member over it.
   */
  preflight?(): Promise<PreflightReport>;
  /**
   * What this lead's RUNNING BRIDGE already heard from each member over the pack link (§19, M16/03).
   *
   * A seam for the same reason the preflight is one, and read through this collie's own
   * `GET /api/update/check` because that is where the sweep banks it — this process holds no pack
   * link of its own, and opening one to ask would be a second dial for a fact already in hand.
   * Nothing here blocks: an answer that does not come is an empty list and a quieter transcript.
   */
  peerReported?(): Promise<readonly PackUpdateRow[]>;
  /** This lead's own update. Absent ⇒ the real `collie update`, resolved on first use. */
  readonly lead?: LeadUpdate;
  /** How this verb waits between polls. Absent ⇒ a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** {@link PackUpdateDeps} once the sink and the defaults are resolved — the shape every step takes. */
type Wired = PackUpdateDeps & {
  emitUpdate(event: UpdateEvent): void;
  preflight(): Promise<PreflightReport>;
  peerReported(): Promise<readonly PackUpdateRow[]>;
  readonly lead: LeadUpdate;
  readonly sleep: (ms: number) => Promise<void>;
};

const USAGE = [
  "usage: collie pack update <member>…   # level these peers to this lead's build",
  "       collie pack update --all       # every enrolled peer",
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
  /** The checkout the push lands in — what the probe FOUND, never a path this side invented. */
  readonly root: string;
}

/**
 * `collie pack update` — probe every target, confirm once, then work them one at a time.
 *
 * Exit codes reuse `EXIT`'s meanings: `USAGE` for a command line that names nothing to do, `STATE`
 * for a collie that is not a lead or an operator who said no, `FAIL` when any member failed.
 */
export async function cmdPackUpdate(deps: PackUpdateDeps, args: readonly string[]): Promise<number> {
  const surface = deps.ui?.packUpdate?.() ?? null;
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
function wire(deps: PackUpdateDeps & { emitUpdate(event: UpdateEvent): void }): Wired {
  return {
    ...deps,
    preflight: deps.preflight ?? (() => preflight(updateCheckDeps(deps.io))),
    peerReported: deps.peerReported ?? (() => bankedPeerVerdicts(deps)),
    lead: deps.lead ?? lazyLead(deps.io),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
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
  const { positional, flags, bare } = parsePackArgs(args, ["force", "all"]);

  const data = await deps.store.load();
  if (data === null || data.pack === null) {
    deps.io.err("error: this collie is not in a pack — there are no peers to level.");
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

  // The build every target is being levelled to: this checkout's commit, and the version that commit
  // carries — read out of the commit rather than the working tree, exactly as `pack add` reads it,
  // because the bundle ships the commit.
  const commit = gitOut(deps, ["rev-parse", "HEAD"]);
  if (commit === null) {
    deps.io.err(`error: cannot read this checkout's commit — ${deps.ctx.root} is not a git checkout.`);
    return EXIT.FAIL;
  }
  const version = manifestVersionAt(deps, commit);
  if (version === null) {
    deps.io.err(`error: cannot read herdr-plugin.toml at ${commit.slice(0, 12)} — nothing to pin the push to.`);
    return EXIT.FAIL;
  }
  // What a levelled member should answer `hello` with — the version the commit carries PLUS that
  // commit's build metadata, which is what this lead itself runs after building the same commit.
  const expected = expectedAnswer(deps, version, commit);
  deps.emitUpdate({ kind: "title", version, commit });
  if (gitOut(deps, ["status", "--porcelain"]) !== "") {
    line(deps, "warn: this checkout has uncommitted changes — the bundle carries the COMMIT, so they are", "warn", "err");
    line(deps, `      not shipped. Every member below gets ${version} at ${commit.slice(0, 12)}.`, "warn", "err");
  }

  const outcomes = new Map<string, UpdateRow>();
  const runners: RemoteRunner[] = [];
  try {
    // 1. THE PREFLIGHT. Every machine this run intends to touch, asked spec 03's question, before a
    //    single one of them is touched. One red is the whole run.
    const red = await preflightGate(deps, targets);
    if (red !== null) return red;

    const ready = await planAll(deps, targets, commit, outcomes, runners);
    // 2. A member the probe refused has already failed, and the probe touched nothing at all — so
    //    the abort rule applies here too, one step earlier and for free.
    const refused = [...outcomes.values()].find((row) => row.outcome === "failed");
    if (refused !== undefined) {
      return stop(deps, targets, outcomes, version, {
        memberId: refused.memberId,
        recovery: `collie pack update ${refused.memberId}`,
      });
    }
    if (ready.length === 0) return report(deps, targets, outcomes, version);

    // 3. THE ONE CONSENT, and it names the lead when the lead is part of what is being consented to.
    const behind = leadIsBehind(deps, version, commit);
    const consent = await confirmBatch(deps, ready, outcomes, version, commit, behind);
    if (consent !== EXIT.OK) return consent;

    // 4. THE LEAD FIRST. A lead that is not running the build it is handing out gets it first, and a
    //    lead that cannot take it is a lead whose peers must not take it either.
    if (behind && !(await updateLead(deps, version))) {
      leaveRest(deps, targets, outcomes, "not attempted — this lead's own update did not land");
      return report(deps, targets, outcomes, version, false);
    }

    // 5. THE PEERS, one at a time, stopping at the first failure.
    const stopped = await workAll(deps, data, ready, { commit, version, expected, outcomes });
    if (stopped !== null) return stop(deps, targets, outcomes, version, stopped);
    return report(deps, targets, outcomes, version);
  } finally {
    // Every exit path, including a throw: each of these is a live authenticated channel.
    for (const runner of runners) runner.close();
  }
}

// ── Targets ──────────────────────────────────────────────────────────────────

/**
 * Which members this run is about. A **bare** `pack update` is a usage error rather than "all": a
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
      deps.io.err(`error: no enrolled member "${name}" in this roster — \`collie pack status\` lists them.`);
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

/** The roster, with what each member reports over the pack link — the bare verb's listing. */
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
  commit: string,
  outcomes: Map<string, UpdateRow>,
  runners: RemoteRunner[],
): Promise<readonly Planned[]> {
  const ready: Planned[] = [];
  for (const target of targets) {
    const id = target.member.memberId;
    if (target.sshHost === "") {
      plan(deps, id, "skipped", "no ssh record — run `collie pack add <host>` once to teach it");
      outcomes.set(id, { memberId: id, outcome: "skipped", detail: "no ssh record" });
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
      deps.io.err(`error: no Collie checkout at ${target.sshHost}${target.path === null ? "" : ` (${target.path})`}.`);
      deps.io.err("       `collie pack update` levels an existing one; `collie pack add` installs the first.");
      blocked(deps, id, outcomes, "no Collie checkout there");
      continue;
    }
    // The route is proven the moment the probe answers with a checkout: the host was reachable and
    // the path names a real Collie. Remembering it HERE, before the one consent and before any leg
    // that can fail, is what closes the bug a `--host` run used to have — a build or restart failure
    // downstream must not cost the operator the route they just typed correctly.
    await remember(deps, target, probe);
    if (probe.dirty === "yes") {
      // Refused, never prompted — the same rule `pack add` applies, for the same reason: a y/N in
      // front of a `git checkout` that discards someone's work is consent theatre, and the remedy is
      // one command on that machine.
      deps.io.err(`error: the Collie checkout at ${probe.checkout} has uncommitted changes:`);
      deps.io.err(`       ${probe.dirtyfiles}`);
      deps.io.err(`       \`git stash\` or commit them on ${target.sshHost}, then re-run. Collie will not`);
      deps.io.err("       discard work it did not create.");
      blocked(deps, id, outcomes, "uncommitted changes there");
      continue;
    }
    if (probe.commit === commit) {
      plan(deps, id, "current", `already at ${probe.version || "this commit"} (${commit.slice(0, 12)})`);
      outcomes.set(id, { memberId: id, outcome: "current", detail: probe.version || commit.slice(0, 12) });
      continue;
    }
    plan(
      deps,
      id,
      "ready",
      `${probe.version || "(unbuilt)"} at ${probe.commit.slice(0, 12) || "?"} · ${target.sshHost}:${probe.checkout}`,
    );
    ready.push({ target, probe, runner, root: probe.checkout });
  }
  return ready;
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
 */
async function preflightGate(deps: Wired, targets: readonly Target[]): Promise<number | null> {
  const routed = targets.filter((t) => t.sshHost !== "");
  const named = new Set(routed.map((t) => t.member.memberId));
  const checked = await deps.preflight();
  // What each member said about ITSELF over the pack link (§19, M16/03), beside what this walk found
  // over ssh. Printed, never preferred: see {@link peerReportLines}.
  for (const said of peerReportLines(checked.pack ?? [], await deps.peerReported(), named, deps.now())) {
    line(deps, said);
  }
  const reds: { readonly who: string; readonly check: PreflightCheck }[] = [
    ...checked.checks.filter(blocks).map((check) => ({ who: "this lead", check })),
    ...(checked.pack ?? [])
      .filter((m) => named.has(m.memberId))
      .flatMap((m) => m.checks.filter(blocks).map((check) => ({ who: m.memberId, check }))),
  ];
  if (reds.length === 0) {
    line(deps, `preflight: nothing red on this lead${routed.length === 0 ? "" : ` or on ${nMembers(routed.length)}`}.`);
    return null;
  }
  for (const { who, check } of reds) {
    deps.io.err(`error: the preflight is red on ${who} — ${check.reason}`);
    if (check.remedy !== undefined) deps.io.err(`       clear it with: ${check.remedy}`);
  }
  deps.io.err("       Nothing was pushed, built or restarted, on any member.");
  return EXIT.FAIL;
}

/** How long this verb waits on its own bridge for a fact it can also do without. */
const BANKED_BUDGET_MS = 2000;

/**
 * The `pack` array off THIS collie's own `GET /api/update/check`, or an empty list.
 *
 * A read, on the address the bridge BOUND (`cli/doctor.ts`'s `ownSnapshot` is the precedent and the
 * reasoning): a peer sets `COLLIE_HOST` and never answers on loopback, and a wildcard bind answers
 * everywhere. Every failure — no bridge, a gate, a body this build cannot read — is the same empty
 * answer, because this is a nicety on a transcript and never a gate.
 */
async function bankedPeerVerdicts(deps: PackUpdateDeps): Promise<readonly PackUpdateRow[]> {
  const host = resolveBridgeHost(deps.ctx.env);
  const dialled = bindIsWildcard(host) ? "127.0.0.1" : host;
  const bracketed = dialled.includes(":") && !dialled.startsWith("[") ? `[${dialled}]` : dialled;
  try {
    const answer = await deps.fetch(`http://${bracketed}:${String(deps.ctx.port)}/api/update/check`, {
      signal: AbortSignal.timeout(BANKED_BUDGET_MS),
    });
    if (!answer.ok) return [];
    // SAFETY: `Response.json()` answers a JSON value, and `parsePackRows` validates every field of
    // it below — a row missing any of them is dropped rather than half-read. Nothing here becomes a
    // path, a command or a credential; it is printed.
    return parsePackRows((await answer.json()) as JsonValue);
  } catch {
    return [];
  }
}

/** Does this check stop the run? See {@link preflightGate} for the one id that does not. */
const blocks = (c: PreflightCheck): boolean => c.verdict === "red" && c.id !== "ops-record";

// ── The peer-reported verdict, beside the ssh one (M16/03) ───────────────────

/**
 * What this run PRINTS about the verdict each member published over the pack link (§19).
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
  reported: readonly PackUpdateRow[],
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
 * isTTY-gated exactly as `pack add` is, and for the same reason: a `confirm` nobody can answer must
 * abort legibly rather than read EOF as yes. There is deliberately **no `--yes`** — a flag that skips
 * this is a flag that turns one typo into N rebuilt machines, and the consent story stays the one
 * `pack add` already tells.
 */
async function confirmBatch(
  deps: Wired,
  ready: readonly Planned[],
  outcomes: ReadonlyMap<string, UpdateRow>,
  version: string,
  commit: string,
  leadFirst: boolean,
): Promise<number> {
  const named = ready
    .map((p) => `${p.target.member.memberId} (${p.probe.version || "unbuilt"})`)
    .join(", ");
  const banked = [...outcomes.values()];
  const current = banked.filter((r) => r.outcome === "current").length;
  const skipped = banked.filter((r) => r.outcome === "skipped").length;
  const refused = banked.filter((r) => r.outcome === "failed").length;
  const aside = [
    current === 0 ? "" : `${current} already current`,
    skipped === 0 ? "" : `${skipped} without an ssh record`,
    refused === 0 ? "" : `${refused} the probe refused`,
  ].filter((s) => s !== "");
  const question =
    `update ${nMembers(ready.length)} to ${version} (${commit.slice(0, 12)})` +
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
  o: { commit: string; version: string; expected: string; outcomes: Map<string, UpdateRow> },
): Promise<Stopped | null> {
  // Bundled ONCE for the whole run: the commit is one artifact, and re-running `git bundle` per
  // member would be N copies of the same bytes with N chances for HEAD to have moved underneath.
  let bundle: string | null = null;
  for (const [index, planned] of ready.entries()) {
    const id = planned.target.member.memberId;
    deps.emitUpdate({ kind: "member-start", memberId: id });
    if (bundle === null) {
      bundle = await deps.gitBundle(o.commit, deps.io);
      if (bundle === null) {
        deps.io.err(`error: could not bundle ${o.commit.slice(0, 12)} from ${deps.ctx.root}.`);
        fail(deps, id, o.outcomes, "nothing to push — the bundle failed here");
        // Nothing can be sent to anyone: the rest are untouched for a reason of their own.
        untouched(deps, ready.slice(index + 1), o.outcomes, "not attempted — the bundle failed here");
        return { memberId: id, recovery: `collie pack update ${id}` };
      }
    }
    const from = planned.probe.version || planned.probe.commit.slice(0, 12) || "unbuilt";
    const failure = await workOne(deps, data, planned, { ...o, bundle });
    if (failure !== null) {
      untouched(deps, ready.slice(index + 1), o.outcomes, `not attempted — the run stopped at ${id}`);
      return failure;
    }
    o.outcomes.set(id, { memberId: id, outcome: "updated", detail: `${from} → ${o.version}` });
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
    commit: string;
    version: string;
    expected: string;
    bundle: string;
    outcomes: Map<string, UpdateRow>;
  },
): Promise<Stopped | null> {
  const { target, runner, root } = planned;
  const id = target.member.memberId;
  const host = target.sshHost;

  // ── push ───────────────────────────────────────────────────────────────────
  deps.emitUpdate({ kind: "leg-start", memberId: id, leg: "push" });
  line(deps, `  pushing ${o.commit.slice(0, 12)} (${Math.round(o.bundle.length / 1024)} KiB base64) to ${root}…`);
  const { result, version: built } = await runInstall(runner, { root, commit: o.commit, version: o.version }, o.bundle);
  if (transportFailure(deps.io, host, result) !== null) {
    return legFailed(deps, id, "push", o.outcomes, `ssh dropped during the push to ${host}`);
  }
  if (result.code !== 0) {
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
  // The lead's own view decides, not the ssh exit code: the member answers `hello` over the pack link
  // and says which version it is running. That is the same fact `pack status` renders as skew, so a
  // run that ends green here is a run whose skew warning has actually gone.
  //
  // It POLLS, on the same budget the local health gate uses (M15/04), because a bridge that has just
  // been restarted is not up the instant `collie restart` returns — a single ask a second too early
  // would call a healthy member a failure. And it is a GATE, not a warning: a member that never comes
  // back running what was pushed stops the run, and the members after it keep the build they have.
  deps.emitUpdate({ kind: "leg-start", memberId: id, leg: "verify" });
  const health = await awaitPeerBuild(deps, data, planned, o);
  if (!health.ok) {
    // Asked over ssh, never over the pack link: the member's own updater record is the only thing
    // that knows whether it rolled back, and `curl` is not assumed to exist on anybody's machine.
    const record = await peerRun(planned);
    const detail = record === null ? health.reason : `${health.reason}; its own updater reports ${record.state}`;
    deps.io.err(`error: ${id} did not come back running ${o.expected} — ${detail}.`);
    if (record?.reason !== undefined) deps.io.err(`       ${id} says: ${record.reason}`);
    deps.io.err(`       Run \`collie doctor\` on ${host}: it names the bind, the ACL and the clock.`);
    const recovery =
      record?.recovery === undefined ? `collie pack update ${id}` : `ssh ${host} -- ${record.recovery}`;
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
  o: { commit: string; version: string; expected: string },
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
      if (reported === null || answersThisBuild(reported, o.version, o.commit)) return { ok: true, reported };
      reason = `it answers as ${reported}, not ${o.expected}`;
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
 * The order matters. The operator reads the table to see where the pack stands and the paragraph
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

/** Why a half-updated pack is a place it is safe to stop. Printed on every abort, for that reason. */
function skewNote(deps: Wired): void {
  deps.io.err("       A half-updated pack keeps working: PACK_PROTOCOL.md §7.1 tolerates version skew");
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
  recovery = `collie pack update ${memberId}`,
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
