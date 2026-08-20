import type { OpsRecord } from "../bridge/pack/ops-store.ts";
import type { TrustedMember, TrustStoreData, Warrant } from "../bridge/pack/trust-store.ts";
import { commitPackChange } from "../bridge/pack/enrollment.ts";
import { currentWarrant, mintWarrant, warrantExpired, type WarrantPush } from "../bridge/pack/warrant.ts";
import { EXIT } from "./io.ts";
import { clientFor, failureLine, linkOf, parsePackArgs } from "./pack.ts";
import { firstLine, restartScript, runProbe, transportFailure, type PackAddDeps, type RemoteRunner } from "./remote.ts";

// `collie pack deputy <member>` / `--revoke` — the operator names the ONE peer that may take the
// crown, and arms it (RFC §3, §4.4, §5; PACK_PROTOCOL.md §18).
//
// ── IT IS A MEMBERSHIP VERB, SO IT WRITES AND RESTARTS ───────────────────────
// The warrant is minted by `mintWarrant` (`bridge/pack/warrant.ts`) and committed through
// `commitPackChange`, exactly like every other membership change — this module holds argument
// parsing, ordering, and the words an operator reads, and decides nothing about what a trust store
// should contain. Then it restarts the LOCAL bridge, because a collie reads its trust store at most
// once per process (§8.1's 2026-08-07 amendment): a verb that only wrote the file would leave the
// running lead issuing a warrant it has never heard of.
//
// ── ARMING IS TWO PHASES, AND THE SECOND IS A RESTART ON ANOTHER MACHINE ─────
// A peer's listener is built with `ca: [<its lead's certificate>]` and `server.reload({tls})` does
// not swap a pinned `ca` (`bridge/pack/transport.ts`). So a warrant that lands on a peer is **inert
// at the transport until that peer restarts** — a takeover from there is impossible, not merely
// refused. That makes the restart load-bearing rather than tidy, which is why this verb performs it
// rather than printing it (RFC §16, decision 7).
//
// ── OVER THE OPERATOR'S OWN SSH, NEVER THE PACK WIRE (ADR 0015/0016) ─────────
// Same channel `pack add` and `pack update` use, same leg scripts, same remembered route in
// `pack-ops.json`. The pack link carries runtime data and is not a control channel; a lead that
// could restart a peer down it would be a reboot credential on every machine it leads.
//
// ── ONE CONSENT FOR THE BATCH, AND NO `--yes` ────────────────────────────────
// Every target is probed read-only first, then the whole operation is confirmed once — `pack
// update`'s shape, for `pack update`'s reason: asking five times is not five consents, it is one
// consent with four chances to answer wrong by reflex. A restart is also the least disruptive remote
// act in this CLI's repertoire — it moves no code and drops one poll. Non-interactive aborts
// legibly; there is deliberately no flag that skips the question.

const USAGE = [
  "usage: collie pack deputy <member>   # name the one peer that may take over (on the lead)",
  "       collie pack deputy --revoke   # name NOBODY — supersedes the standing warrant",
];

/** What one member's arming attempt came to. Rendered as one row each, at the end. */
type AnchorOutcome = "armed" | "inactive" | "already";

interface Row {
  readonly memberId: string;
  readonly stored: boolean;
  readonly anchor: AnchorOutcome;
  readonly detail: string;
}

/** A member this run intends to restart: the roster entry plus the route the operator taught us. */
interface Target {
  readonly member: TrustedMember;
  readonly record: OpsRecord;
}

/** A target whose probe answered — what it runs now, and the connection to run the restart over. */
interface Planned {
  readonly target: Target;
  readonly runner: RemoteRunner;
  /** The checkout the restart runs from — what the probe FOUND, never a path this side invented. */
  readonly root: string;
}

/**
 * `collie pack deputy` — mint or re-sync the warrant, push it, then arm every peer.
 *
 * Exit codes reuse `EXIT`'s meanings: `USAGE` for a command line that names nothing, `STATE` for a
 * collie that is not a lead, a member it does not pin, or an operator who said no, `FAIL` when the
 * mint itself could not be committed or the run was not interactive.
 */
export async function cmdPackDeputy(deps: PackAddDeps, args: readonly string[]): Promise<number> {
  const { positional, bare } = parsePackArgs(args, ["force", "revoke"]);
  const revoking = bare.has("revoke");

  const data = await deps.store.load();
  if (data === null || data.pack === null) {
    deps.io.err("error: this collie is not in a pack — there is no crown to deputise for.");
    return EXIT.STATE;
  }
  if (data.lead !== null) {
    deps.io.err(`error: this collie is a peer of "${data.lead.memberId}" — a deputy is named on the lead,`);
    deps.io.err("       which is the machine whose key signs the warrant.");
    return EXIT.STATE;
  }

  const named = revoking ? ok(null) : refuseOrName(deps, data, positional[0]);
  if (!named.ok) return named.code;

  const minted = await mintOrReuse(deps, data, named.memberId, revoking);
  if (!minted.ok) return minted.code;

  // The local bridge first, and unconditionally: the push below is made by THIS process, but the
  // running lead is what refreshes the warrant on every sweep thereafter (§18.4) and what answers
  // for it. A lead that never restarted would keep issuing the previous generation.
  await restartLocally(deps, minted.reused ? "the re-synced warrant" : "the new warrant");

  const rows = await pushToPeers(deps, data, minted.warrant);
  const anchorCode = await armPeers(deps, data, minted.warrant, rows);
  report(deps, data, minted.warrant, rows);
  return anchorCode;
}

/**
 * A step's answer: the value it resolved, or the exit code the verb stops on.
 *
 * A tagged pair rather than `T | number`, because "is this a number" is a question about the
 * REPRESENTATION and the caller is asking about the outcome. The two happen to be distinguishable
 * here and would stop being so the day a step's value is itself a number.
 */
type Step<T> = { readonly ok: true; readonly memberId: T } | { readonly ok: false; readonly code: number };

const ok = <T,>(memberId: T): Step<T> => ({ ok: true, memberId });
const stop = <T,>(code: number): Step<T> => ({ ok: false, code });

// ── Who may be named (RFC §3's validation, spelled out) ──────────────────────

/**
 * The refusal matrix, answered HERE rather than by `mintWarrant`'s `null`.
 *
 * The engine is right to collapse every bad designation into "no" — it is a pure transition and its
 * job is the store's shape. But an operator who typed a name deserves to know *which* no: a typo, a
 * member that was dropped by a rotation, and a member that is simply behind are three different
 * next actions, and the same list `pack approve-promote` refuses from.
 */
function refuseOrName(deps: PackAddDeps, data: TrustStoreData, memberId: string | undefined): Step<string | null> {
  if (memberId === undefined) {
    for (const u of USAGE) deps.io.err(u);
    const enrolled = data.peers.filter((p) => p.status === "enrolled");
    if (enrolled.length > 0) {
      deps.io.err("");
      deps.io.err("this lead's peers:");
      for (const p of enrolled) deps.io.err(`  ${p.memberId}  ${p.address}`);
    }
    return stop(EXIT.USAGE);
  }
  if (memberId === data.self.memberId) {
    deps.io.err(`error: "${memberId}" is this machine — a lead cannot deputise itself.`);
    deps.io.err("       A deputy is the machine you would take over TO, and this is the one you would");
    deps.io.err("       be taking over from.");
    return stop(EXIT.STATE);
  }
  const member = data.peers.find((p) => p.memberId === memberId);
  if (member === undefined) {
    deps.io.err(`error: no member "${memberId}" in this roster — \`collie pack status\` lists them.`);
    return stop(EXIT.STATE);
  }
  if (member.status !== "enrolled") {
    deps.io.err(`error: "${memberId}" is unenrolled — it was dropped by a rotation it was offline for (§8.4).`);
    deps.io.err("       Re-join it first: `collie pack invite` here, `collie join` there. A warrant naming a");
    deps.io.err("       machine that is not a member is a permission nothing would honour.");
    return stop(EXIT.STATE);
  }
  if (member.secretGeneration !== data.pack?.secretGeneration) {
    deps.io.err(`error: "${memberId}" has not picked up the current pack secret (it holds generation`);
    deps.io.err(`       ${member.secretGeneration}, this pack is at ${data.pack?.secretGeneration}). Let it catch up, then re-run.`);
    return stop(EXIT.STATE);
  }
  return ok(memberId);
}

// ── The mint, and why a re-run does not mint ─────────────────────────────────

/**
 * {@link mintOrReuse}'s answer, in the same tagged shape {@link Step} uses. `reused` is true when the
 * standing warrant was re-signed-by-nobody — i.e. left exactly as it was and merely re-synced.
 */
type MintStep =
  | { readonly ok: true; readonly warrant: Warrant; readonly reused: boolean }
  | { readonly ok: false; readonly code: number };

/**
 * Mint generation *N+1*, **or re-use the standing warrant when it already names this member**.
 *
 * RFC §4.4 says naming a deputy mints a new generation, and that is right for a *change*. It is
 * wrong for a *retry*, and a retry is the common case this verb has: the operator names `nas`, one
 * machine has no ssh record, they fix it and run the same command again. Minting there would climb
 * the generation on every attempt and make every peer that was already armed stale again — the
 * re-run would undo the arming it was run to finish. So a re-run that names the deputy already
 * standing re-pushes and re-arms the warrant that exists, and says so.
 *
 * A warrant that has EXPIRED is not re-used: it is dead on every clock that holds it (§18.4), and
 * re-pushing it would arm nothing. That one mints.
 */
async function mintOrReuse(
  deps: PackAddDeps,
  data: TrustStoreData,
  named: string | null,
  revoking: boolean,
): Promise<MintStep> {
  const standing = currentWarrant(data)?.warrant ?? null;
  if (
    named !== null &&
    standing !== null &&
    standing.deputyMemberId === named &&
    !warrantExpired(standing, deps.now())
  ) {
    deps.io.out(`"${named}" is already this pack's deputy at warrant generation ${standing.generation}.`);
    deps.io.out("  Re-syncing rather than minting: a new generation would make every peer already armed");
    deps.io.out("  stale again, which is the opposite of what a re-run is for.");
    return { ok: true, warrant: standing, reused: true };
  }

  const warrant = await commitPackChange(deps.store, deps.audit, (current) =>
    current === null ? null : mintWarrant(current, named, deps.now()),
  );
  if (warrant === null) {
    if (revoking) {
      // Not an error: the operator asked for "no deputy" and that is the state. A revocation with
      // nothing to revoke writes nothing, because an absence cannot be distinguished from a lost
      // message and there is nothing here to make into a positive statement (RFC §4.4).
      deps.io.out("nothing was revoked — this pack names no deputy.");
      return { ok: false, code: EXIT.OK };
    }
    deps.io.err("error: the warrant could not be minted. Nothing was written and nothing was sent.");
    return { ok: false, code: EXIT.FAIL };
  }
  return { ok: true, warrant, reused: false };
}

// ── Phase 1 — stored (over the pack link) ────────────────────────────────────

/**
 * Push the warrant to every enrolled peer (RFC §5, phase 1).
 *
 * Concurrent, one budget for the sweep — and a peer that is offline right now is **not** a failure
 * of this verb: the lead's own sweep re-pushes on any poll where that member reports a generation
 * behind (§18.4's re-push rule), so the warrant arrives on its own. What the operator is told is
 * simply which machines have it *now*.
 */
async function pushToPeers(deps: PackAddDeps, data: TrustStoreData, warrant: Warrant): Promise<Map<string, Row>> {
  const rows = new Map<string, Row>();
  const enrolled = data.peers.filter((p) => p.status === "enrolled");
  if (enrolled.length === 0) return rows;
  const client = clientFor(deps, data, data.pack?.secret ?? "");
  await Promise.all(
    enrolled.map(async (member) => {
      const outcome = await client.warrant(linkOf(member), payloadFor(data, warrant));
      rows.set(member.memberId, {
        memberId: member.memberId,
        stored: outcome.ok,
        anchor: "inactive",
        detail: outcome.ok ? "warrant stored" : `not stored — ${failureLine(outcome)}`,
      });
    }),
  );
  return rows;
}

/**
 * The body of `POST /pack/v1/warrant` (§18.5).
 *
 * The deputy's certificate rides along because **a peer has no roster beyond its lead** and so
 * cannot look it up; it is accepted there only when `sha256(certPem)` equals the fingerprint the
 * warrant names — §8.2's enrollment rule, for §8.2's reason. A revocation names nobody and therefore
 * carries nothing.
 */
function payloadFor(data: TrustStoreData, warrant: Warrant): WarrantPush {
  if (warrant.deputyMemberId === null) return { warrant };
  const deputy = data.peers.find((p) => p.memberId === warrant.deputyMemberId);
  return deputy === undefined ? { warrant } : { warrant, deputyCertPem: deputy.certPem };
}

// ── Phase 2 — anchored (over the operator's ssh) ─────────────────────────────

/**
 * Restart every peer so its listener is rebuilt with the deputy in its anchor list.
 *
 * **Every enrolled peer, including the deputy itself.** The deputy gains no anchor from its own
 * certificate, but it does need to learn that it holds a warrant naming it — and a verb that skipped
 * it would leave one machine in the pack running a process that has never read the warrant on its
 * own disk.
 *
 * A revocation restarts them too, and for the mirror-image reason: a peer that has stored a
 * revocation still ADMITS the old deputy's certificate until its listener is rebuilt. Storing the
 * revocation is what makes it provable; restarting is what makes it take effect.
 */
async function armPeers(
  deps: PackAddDeps,
  data: TrustStoreData,
  warrant: Warrant,
  rows: Map<string, Row>,
): Promise<number> {
  const targets: Target[] = [];
  for (const member of data.peers.filter((p) => p.status === "enrolled")) {
    const record = await deps.ops.get(member.memberId);
    if (record === null || record.sshHost === "") {
      // Reported, never silently skipped (RFC §5): this is the difference between a pack that is
      // armed and one that only looks it, and it is the exact shape §8.2's "enrolled but INACTIVE"
      // note already established for the same class of problem.
      mark(rows, member.memberId, "inactive", `no ssh record — run \`collie pack add\` once, then re-run`);
      continue;
    }
    if ((record.anchoredGeneration ?? null) !== null && (record.anchoredGeneration ?? 0) >= warrant.generation) {
      mark(rows, member.memberId, "already", "already armed for this generation");
      continue;
    }
    targets.push({ member, record });
  }
  if (targets.length === 0) return EXIT.OK;

  const runners: RemoteRunner[] = [];
  try {
    const ready = await planAll(deps, targets, rows, runners);
    if (ready.length === 0) return EXIT.OK;
    const consent = await confirmBatch(deps, ready, warrant);
    if (consent !== EXIT.OK) return consent;
    await restartAll(deps, ready, warrant, rows);
    return EXIT.OK;
  } finally {
    // Every exit path, including a throw: each of these is a live authenticated channel.
    for (const runner of runners) runner.close();
  }
}

/** Probe every target read-only. A machine that cannot be looked at is not one to restart blind. */
async function planAll(
  deps: PackAddDeps,
  targets: readonly Target[],
  rows: Map<string, Row>,
  runners: RemoteRunner[],
): Promise<readonly Planned[]> {
  const ready: Planned[] = [];
  for (const target of targets) {
    const id = target.member.memberId;
    const host = target.record.sshHost;
    const runner = deps.remote(host);
    runners.push(runner);
    const { result, probe } = await runProbe(runner, { path: target.record.path, port: target.record.port });
    if (transportFailure(deps.io, host, result) !== null) {
      mark(rows, id, "inactive", `ssh could not reach ${host}`);
      continue;
    }
    if (probe === null || result.code !== 0) {
      deps.io.err(`error: ${host} answered the probe with ${probe === null ? "something this build cannot read" : `exit ${result.code}`} — ${firstLine(result.stderr)}`);
      mark(rows, id, "inactive", `${host} did not answer the probe`);
      continue;
    }
    if (probe.checkout === "") {
      deps.io.err(`error: no Collie checkout at ${host}${target.record.path === null ? "" : ` (${target.record.path})`}.`);
      mark(rows, id, "inactive", "no Collie checkout there");
      continue;
    }
    deps.io.out(`  ${id} — will restart collie at ${host}:${probe.checkout}`);
    ready.push({ target, runner, root: probe.checkout });
  }
  return ready;
}

/**
 * The whole batch, in one question. `EXIT.OK` means go.
 *
 * isTTY-gated exactly as `pack add` and `pack update` are, and for the same reason: a `confirm`
 * nobody can answer must abort legibly rather than read EOF as yes.
 */
async function confirmBatch(deps: PackAddDeps, ready: readonly Planned[], warrant: Warrant): Promise<number> {
  const named = ready.map((p) => p.target.member.memberId).join(", ");
  const what =
    warrant.deputyMemberId === null
      ? "to retire the old deputy's anchor"
      : `to arm the deputy "${warrant.deputyMemberId}"`;
  const question = `restart collie on ${named} ${what}? [y/N]`;
  const answer = await deps.confirm(question);
  if (answer === null) {
    deps.io.err(`error: this run is not interactive, and it would have asked: ${question}`);
    deps.io.err("       The warrant IS minted and pushed; only the restarts were not attempted. Re-run");
    deps.io.err("       from a terminal, or restart those machines yourself.");
    return EXIT.FAIL;
  }
  if (!answer) {
    deps.io.err("error: left alone — nothing was restarted. The warrant is stored and inert until it is.");
    return EXIT.STATE;
  }
  return EXIT.OK;
}

/** One `collie restart` per consented machine, one at a time, recording what each came to. */
async function restartAll(
  deps: PackAddDeps,
  ready: readonly Planned[],
  warrant: Warrant,
  rows: Map<string, Row>,
): Promise<void> {
  for (const planned of ready) {
    const id = planned.target.member.memberId;
    const host = planned.target.record.sshHost;
    // The far machine's own `collie restart` is what runs — never a unit name guessed from here.
    const result = await planned.runner.run(restartScript(planned.root));
    if (transportFailure(deps.io, host, result) !== null) {
      mark(rows, id, "inactive", `ssh dropped during the restart on ${host}`);
      continue;
    }
    if (result.code !== 0) {
      deps.io.err(`error: \`collie restart\` exited ${result.code} on ${host} — ${firstLine(result.stderr)}`);
      mark(rows, id, "inactive", "its bridge did not come back");
      continue;
    }
    mark(rows, id, "armed", "restarted — its listener now anchors the deputy");
    await remember(deps, planned, warrant);
  }
}

/**
 * Record which generation this operator armed on that machine.
 *
 * It lands in `pack-ops.json` beside the ssh route, never in the trust store: it is an observation
 * about what the operator did from here, not trust material (ADR 0016). `pack status` reads it as
 * the anchor column, and a member with none reports `anchor INACTIVE`.
 */
async function remember(deps: PackAddDeps, planned: Planned, warrant: Warrant): Promise<void> {
  const record: OpsRecord = {
    ...planned.target.record,
    path: planned.root,
    anchoredGeneration: warrant.generation,
    anchoredAt: deps.now(),
  };
  if (!(await deps.ops.record(planned.target.member.memberId, record))) {
    deps.io.err("warn: the ops file could not be updated, so this arming was not remembered. It happened —");
    deps.io.err("      `collie pack status` will simply keep reporting the anchor as INACTIVE.");
  }
}

// ── What the operator reads at the end ───────────────────────────────────────

/**
 * Fold one member's anchoring result onto whatever the push already said about it.
 *
 * The two phases are recorded as ONE sentence rather than two rows, because they are two halves of
 * one answer to one question — "can this machine take over?" — and a member that took the warrant
 * and could not be restarted must read differently from one that did neither. The push's verdict is
 * never overwritten: it is the half that says whether the warrant is even there.
 */
function mark(rows: Map<string, Row>, memberId: string, anchor: AnchorOutcome, detail: string): void {
  const previous = rows.get(memberId);
  const said = previous?.detail ?? "";
  rows.set(memberId, {
    memberId,
    stored: previous?.stored ?? false,
    anchor,
    detail: said === "" ? detail : `${said}, ${detail}`,
  });
}

/** The per-member summary, and the sentence that says what state the pack is actually in. */
function report(deps: PackAddDeps, data: TrustStoreData, warrant: Warrant, rows: Map<string, Row>): void {
  const revoking = warrant.deputyMemberId === null;
  deps.io.out("");
  deps.io.out(
    revoking
      ? `✓ warrant generation ${warrant.generation} names NOBODY — this pack has no deputy.`
      : `✓ "${warrant.deputyMemberId}" is this pack's deputy at warrant generation ${warrant.generation}.`,
  );
  for (const member of data.peers.filter((p) => p.status === "enrolled")) {
    const row = rows.get(member.memberId);
    if (row === undefined) continue;
    if (row.stored && row.anchor === "inactive") {
      // RFC §5's exact shape, so this line and `pack status`'s are the same words.
      deps.io.out(`  ${member.memberId}: warrant stored, anchor INACTIVE — restart ${member.memberId}`);
      deps.io.out(`             (${row.detail})`);
      continue;
    }
    deps.io.out(`  ${member.memberId}: ${row.detail}`);
  }
  if (revoking) {
    const stale = [...rows.values()].filter((r) => r.anchor !== "armed").map((r) => r.memberId);
    if (stale.length > 0) {
      deps.io.out("");
      deps.io.out(`⚠ still anchoring the old deputy until they restart: ${stale.join(", ")}`);
      deps.io.out("  A revocation they have STORED is provable — that is why it is a positive statement");
      deps.io.out("  rather than an absence — but their listeners were built with the old certificate and");
      deps.io.out("  `server.reload` cannot re-pin one. Re-run this verb once they are reachable.");
    }
    return;
  }
  deps.io.out("");
  deps.io.out("  Nothing has changed about what that machine does today: a deputy is still a peer, it");
  deps.io.out("  publishes no front door and it promotes nothing by itself. What it now has is a standing,");
  deps.io.out("  signed permission — spendable only by you, and only from a machine you are holding.");
}

/** Restart the local service so the running lead issues the warrant it just signed. */
async function restartLocally(deps: PackAddDeps, what: string): Promise<void> {
  deps.io.out(`  restarting the bridge so ${what} takes effect…`);
  const code = await deps.restart();
  if (code !== EXIT.OK) {
    deps.io.err("warn: the restart failed — the trust store IS updated, but the running bridge still holds");
    deps.io.err("      the previous warrant. Run `collie restart` before relying on this change.");
  }
}
