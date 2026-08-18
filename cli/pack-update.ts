import { DEFAULT_PORT } from "../bridge/config.ts";
import type { OpsRecord } from "../bridge/pack/ops-store.ts";
import type { TrustedMember, TrustStoreData } from "../bridge/pack/trust-store.ts";
import { collieVersionBare } from "./context.ts";
import { EXIT } from "./io.ts";
import { parsePackArgs, probeMembers } from "./pack.ts";
import {
  errorLine,
  firstLine,
  gitOut,
  manifestVersionAt,
  restartScript,
  runInstall,
  runProbe,
  transportFailure,
  type PackAddDeps,
  type Probe,
  type RemoteRunner,
} from "./remote.ts";
import { plainUpdate, type UpdateEvent, type UpdateOutcome, type UpdateRow } from "./render.ts";

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

/** `pack update`'s seams. Exactly `pack add`'s set — the transport, the prompts and the bundle. */
export interface PackUpdateDeps extends PackAddDeps {
  /** Where every line this verb says goes as STRUCTURE. Absent ⇒ the plain replay. */
  emitUpdate?(event: UpdateEvent): void;
}

/** {@link PackUpdateDeps} once the sink is resolved — the shape every step below takes. */
type Wired = PackUpdateDeps & { emitUpdate(event: UpdateEvent): void };

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
      { ...deps, emitUpdate: deps.emitUpdate ?? ((event) => plainUpdate(deps.io, event)) },
      args,
    );
  }
  // The rich path: `io` and `confirm` are BOTH replaced for the length of the run, which is the whole
  // of the one-writer rule (`cli/render.ts`). Nothing below knows which renderer it is talking to.
  const wired: Wired = {
    ...deps,
    io: surface.io,
    emitUpdate: surface.emit,
    confirm: surface.confirm,
  };
  try {
    return await updateRun(wired, args);
  } finally {
    await surface.close();
  }
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
    const ready = await planAll(deps, targets, commit, outcomes, runners);
    if (ready.length > 0) {
      const consent = await confirmBatch(deps, ready, outcomes, version, commit);
      if (consent !== EXIT.OK) return consent;
      await workAll(deps, data, ready, { commit, version, expected, outcomes });
    }
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
    `update ${ready.length} member${ready.length === 1 ? "" : "s"} to ${version} (${commit.slice(0, 12)})` +
    ` over ssh: ${named}${aside.length === 0 ? "" : ` — ${aside.join(", ")}`}?`;
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

/** Every consented member, one at a time. A failure is recorded and the run continues. */
async function workAll(
  deps: Wired,
  data: TrustStoreData,
  ready: readonly Planned[],
  o: { commit: string; version: string; expected: string; outcomes: Map<string, UpdateRow> },
): Promise<void> {
  // Bundled ONCE for the whole run: the commit is one artifact, and re-running `git bundle` per
  // member would be N copies of the same bytes with N chances for HEAD to have moved underneath.
  let bundle: string | null = null;
  for (const planned of ready) {
    const id = planned.target.member.memberId;
    deps.emitUpdate({ kind: "member-start", memberId: id });
    if (bundle === null) {
      bundle = await deps.gitBundle(o.commit, deps.io);
      if (bundle === null) {
        deps.io.err(`error: could not bundle ${o.commit.slice(0, 12)} from ${deps.ctx.root}.`);
        fail(deps, id, o.outcomes, "nothing to push — the bundle failed here");
        // Nothing can be sent to anyone: stop rather than repeat the same failure per member.
        for (const rest of ready.slice(ready.indexOf(planned) + 1)) {
          fail(deps, rest.target.member.memberId, o.outcomes, "not attempted — the bundle failed here");
        }
        return;
      }
    }
    const from = planned.probe.version || planned.probe.commit.slice(0, 12) || "unbuilt";
    const done = await workOne(deps, data, planned, { ...o, bundle });
    if (done) {
      o.outcomes.set(id, { memberId: id, outcome: "updated", detail: `${from} → ${o.version}` });
      deps.emitUpdate({ kind: "member-done", memberId: id, outcome: "updated" });
    }
  }
}

/** One member's three legs. `false` means it failed and has already been recorded. */
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
): Promise<boolean> {
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

  // ── verify ─────────────────────────────────────────────────────────────────
  // The lead's own view decides, not the ssh exit code: the member answers `hello` over the pack link
  // and says which version it is running. That is the same fact `pack status` renders as skew, so a
  // run that ends green here is a run whose skew warning has actually gone.
  deps.emitUpdate({ kind: "leg-start", memberId: id, leg: "verify" });
  const probes = await probeMembers(deps, data, [target.member]);
  const outcome = probes.get(id);
  if (outcome?.ok !== true) {
    deps.io.err(`error: ${id} was updated, but this lead cannot reach it at ${target.member.address}.`);
    deps.io.err(`       Run \`collie doctor\` on ${host}: it names the bind, the ACL and the clock.`);
    return legFailed(deps, id, "verify", o.outcomes, `updated, but unreachable at ${target.member.address}`);
  }
  const reported = outcome.value.version;
  const skewed = reported !== null && !answersThisBuild(reported, o.version, o.commit);
  if (skewed) {
    line(deps, `warn: ${id} answers as ${reported}, not ${o.expected} — check the build there.`, "warn", "err");
  }
  deps.emitUpdate({
    kind: "leg-done",
    memberId: id,
    leg: "verify",
    ok: true,
    // The row and the warning above it must never say opposite things about the same string: when the
    // answer is the one that was pushed it stands alone, and when it is not, the row names both.
    detail:
      `answers at ${target.member.address} · ${reported ?? "no version reported"}` +
      (skewed ? ` (expected ${o.expected})` : ""),
  });

  await remember(deps, planned);
  return true;
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
 * Does `reported` name the build that was pushed?
 *
 * The build metadata is compared as an ABBREVIATION of the commit rather than byte for byte: git
 * chooses that length per repository, so the far machine may spell the same commit with more digits
 * than this one does — and it stays a mismatch the moment the digits disagree, or a `-dirty`/`-dev`
 * marker says the build is not that commit. A member with no build stamp at all can only report its
 * manifest version; that is the version it was given, and it is not evidence against the push.
 */
export function answersThisBuild(reported: string, version: string, commit: string): boolean {
  const plus = reported.indexOf("+");
  if (plus < 0) return reported === version;
  if (reported.slice(0, plus) !== version) return false;
  const build = reported.slice(plus + 1);
  return build.length >= 4 && commit.toLowerCase().startsWith(build.toLowerCase());
}

/** Refresh the ops record when the operator steered this run by hand. */
async function remember(deps: Wired, planned: Planned): Promise<void> {
  if (!planned.target.overridden) return;
  const record: OpsRecord = {
    sshHost: planned.target.sshHost,
    path: planned.root,
    port: planned.target.port,
    recordedAt: deps.now(),
  };
  if (!(await deps.ops.record(planned.target.member.memberId, record))) {
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
  deps.emitUpdate({ kind: "summary", rows, verdict, ok: failed === 0 });
  return failed === 0 ? EXIT.OK : EXIT.FAIL;
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
): false {
  deps.emitUpdate({ kind: "leg-done", memberId, leg, ok: false, detail });
  fail(deps, memberId, outcomes, detail);
  return false;
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
