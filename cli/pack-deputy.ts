import type { OpsRecord } from "../bridge/pack/ops-store.ts";
import type { PeerClient, PeerOutcome } from "../bridge/pack/peer-client.ts";
import type { TrustedMember, TrustStoreData, Warrant } from "../bridge/pack/trust-store.ts";
import { commitPackChange } from "../bridge/pack/enrollment.ts";
import { currentWarrant, mintWarrant, warrantExpired, type WarrantPush } from "../bridge/pack/warrant.ts";
import { EXIT } from "./io.ts";
import { clientFor, failureLine, linkOf, parsePackArgs } from "./pack.ts";
import { pairedRegistryOf } from "./pairing.ts";
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
type AnchorOutcome =
  /** Restarted by this run: its listener is rebuilt and the warrant is live there. */
  | "armed"
  /** Stored, not armed — no ssh route, or a restart that did not happen. The pack is half-armed. */
  | "inactive"
  /** Already armed for this generation, so this run had nothing to do there. */
  | "already"
  /**
   * The warrant is **not** on that machine, so there is nothing an anchor could anchor.
   *
   * Its own outcome rather than a flavour of `inactive`, because the two demand opposite handling:
   * an `inactive` member is one restart away and its warrant is already there, while this one must
   * not be restarted, must not have an anchor recorded for it, and must fail the run. A restart
   * here would rebuild a listener around a warrant the machine does not hold — which is how a
   * `not stored … now anchors the deputy` line came to be printed at all.
   */
  | "failed";

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
  if (!revoking && !refuseUnpaired(deps)) return EXIT.STATE;

  const minted = await mintOrReuse(deps, data, named.memberId, revoking);
  if (!minted.ok) return minted.code;

  // ── DISTRIBUTE, THEN RESTART — the order is load-bearing ───────────────────
  // It is `pack rotate`'s order and it was `pack deputy`'s bug. Restarting first boots a lead whose
  // sweep immediately sees every peer behind on the warrant and fires its OWN pushes, signed with
  // the same key as this verb's, into a route that advances a per-member replay floor
  // (`MEMBERSHIP_PATHS`). The two collide and whichever lands second is refused. Pushed FIRST, the
  // still-running old process holds the PREVIOUS warrant — which no peer is behind on — so
  // `warrantPushNeeded` is false for it and it pushes nothing at all. The window closes rather than
  // narrowing. The restart still happens, unconditionally, because the running lead is what
  // refreshes the warrant on every sweep thereafter (§18.4) and what answers for it.
  const rows = await pushToPeers(deps, data, minted.warrant);
  await restartLocally(deps, minted.reused ? "the re-synced warrant" : "the new warrant");

  const anchorCode = await armPeers(deps, data, minted.warrant, rows);
  report(deps, data, minted.warrant, rows);
  // A member whose store this verb could not confirm fails the run, even when the restarts it DID
  // reach all succeeded: the operator asked for an armed pack and did not get one. The consent
  // codes win over it — "you said no" and "nobody was there to ask" are answers about this run,
  // not about a member, and overwriting them with a generic failure would lose which happened.
  if (anchorCode !== EXIT.OK) return anchorCode;
  return [...rows.values()].some((r) => !r.stored) ? EXIT.FAIL : EXIT.OK;
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

/**
 * **A lead with nothing paired gets no deputy** (RFC §6.4). `false` ⇒ the verb stops, having minted,
 * written and sent nothing.
 *
 * The standby door is authenticated by the phone's own pairing credential and by nothing else, and
 * `PairingStore.enforced()` is *the registry is non-empty* — so a lead with an empty registry would
 * sync an empty one, and the door would refuse to arm rather than arm ungated. Every step of the
 * designation would succeed and the result would be a door that can never open. The refusal is here
 * rather than at the door because this is where the operator is standing, and the remedy is one verb.
 *
 * **A revocation is never refused by this.** Un-naming a deputy must work on any pack, in any state;
 * it is the un-doing, and a state that blocks the un-doing is a trap.
 */
function refuseUnpaired(deps: PackAddDeps): boolean {
  if (pairedRegistryOf(deps.files, deps.ctx.stateDir).devices.length > 0) return true;
  deps.io.err("error: this lead has no paired device, so a deputy's standby door could never arm.");
  deps.io.err("       That door is authenticated by the phone's own pairing credential and by nothing");
  deps.io.err("       else (RFC §6.4) — with an empty registry there is nothing to check a takeover");
  deps.io.err("       against, so it refuses to arm rather than arming ungated. Nothing was minted,");
  deps.io.err("       written or sent. Pair the phone you would take over FROM first:");
  deps.io.err("         collie pair");
  return false;
}

/**
 * The same-origin prerequisite, said once, at designation time (RFC §14.2; RFC §16, decision 4).
 *
 * **A warning, never a refusal.** A pack without a failover proxy keeps every other part of this
 * feature — the warrant, the deposition, the self-heal — and its recovery path is `collie promote`
 * from a keyboard, which is unchanged. What it does not get is the phone-first half, and that is
 * worth one paragraph rather than a veto: Collie cannot see the operator's ingress from here, and a
 * verb that refused on a heuristic about somebody else's proxy would be refusing on a guess.
 *
 * `COLLIE_PUBLIC_URL` is the signal because it is already the one place this deployment names its
 * real front-door origin (PACK_PROTOCOL.md §5's address ladder). Unset means nothing here knows of a
 * shared origin — not that none exists.
 */
function sameOriginNotice(deps: PackAddDeps): void {
  if ((deps.ctx.env.COLLIE_PUBLIC_URL ?? "").trim() !== "") return;
  deps.io.out("");
  deps.io.out("note: COLLIE_PUBLIC_URL is unset here, so this machine knows of no shared origin.");
  deps.io.out("  The phone's pairing credential and its installed app are BOTH per-origin, so a standby");
  deps.io.out("  page served under a different hostname is a page that phone cannot authenticate to.");
  deps.io.out("  The deputy is real either way and `collie promote` from a keyboard still works — what");
  deps.io.out("  needs one failover proxy in front of both machines is the phone-first half (RFC §14.2).");
  deps.io.out("  Collie grows no second credential to work around it.");
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
 * Push the warrant to every enrolled peer, and **confirm** that it landed (RFC §5, phase 1).
 *
 * ── WHY A PUSH IS RETRIED ONCE, AND WHY THAT IS NOT PAPERING OVER ANYTHING ───
 * `POST /pack/v1/warrant` is in `MEMBERSHIP_PATHS` (`bridge/pack/router.ts`), so **every accepted
 * push advances this lead's persisted replay floor on that peer** (`recordSignedRequest`), and
 * §8.6's rule refuses any later signature stamped at or before it. Two processes on this machine
 * sign warrant pushes with the same key — the running bridge's sweep (`lead.ts` → `distributeWarrant`)
 * and this verb — so their stamps can collide, and the one that lands second is refused as a replay
 * of a stamp the peer has already burned. That is a **stamp** problem, not a permission one, and
 * `signing.ts` names the remedy in its own words: *"refusing the second costs a retry"*. So the retry
 * carries a fresh stamp, and it costs one small body.
 *
 * ── AND WHY IT STILL ASKS ────────────────────────────────────────────────────
 * A retry closes the common race, not the general case. The authority on whether a peer holds the
 * warrant is **the peer**, so a push this verb could not confirm is followed by one `hello`, whose
 * `warrantGeneration` (§18.7) is the same field the lead's own sweep decides re-pushes from. Three
 * outcomes, and the operator is told which one it was rather than a word this side guessed:
 *
 *   • it reports this generation or newer — **stored**, and by whom is immaterial: the sweep may
 *     simply have got there first, which is a race won, not a failure;
 *   • it answers and reports less — it is **there and did not take it**. Reachable, refused;
 *   • it does not answer — it is **not there**. Unreachable, and the sweep will deliver on its next
 *     successful dial (§18.4's re-push rule).
 *
 * Nothing downstream may claim an anchor for a member this function did not mark `stored`.
 */
async function pushToPeers(deps: PackAddDeps, data: TrustStoreData, warrant: Warrant): Promise<Map<string, Row>> {
  const rows = new Map<string, Row>();
  const enrolled = data.peers.filter((p) => p.status === "enrolled");
  if (enrolled.length === 0) return rows;
  const client = clientFor(deps, data, data.pack?.secret ?? "");
  const payload = payloadFor(data, warrant);
  await Promise.all(
    enrolled.map(async (member) => {
      const link = linkOf(member);
      const first = await client.warrant(link, payload);
      // The retry rides a new timestamp because `PeerClient` stamps every dial from its own clock —
      // there is no stamp to reuse and nothing to reset.
      const outcome = first.ok ? first : await client.warrant(link, payload);
      if (outcome.ok) {
        rows.set(member.memberId, { memberId: member.memberId, stored: true, anchor: "inactive", detail: "warrant stored" });
        return;
      }
      rows.set(member.memberId, await confirmStored(client, member, warrant, outcome));
    }),
  );
  return rows;
}

/**
 * Ask the peer itself whether it holds this generation, after a push this verb could not land.
 *
 * The refusal that came back is deliberately **not** the sentence printed here. `PeerClient` maps a
 * `401` onto the `unreachable` state, correctly — §10.2's table has three states and the phone's
 * answer is the same for an auth failure as for a dead host — but "unreachable" is then the wrong
 * WORD for a machine that answered, and printing it produced the contradiction this fixed
 * (`not stored — unreachable — … refused by the peer (unauthorized)` about a peer that was up).
 * Rather than sniff the reason string for which kind of failure it was, this asks a question whose
 * answer settles it.
 */
async function confirmStored(
  client: PeerClient,
  member: TrustedMember,
  warrant: Warrant,
  refusal: PeerOutcome<unknown>,
): Promise<Row> {
  const row = (stored: boolean, detail: string): Row => ({ memberId: member.memberId, stored, anchor: "inactive", detail });
  const hello = await client.hello(linkOf(member));
  if (!hello.ok) return row(false, `NOT STORED — that machine is not answering: ${failureLine(hello)}`);
  if ((hello.value.warrantGeneration ?? 0) >= warrant.generation) {
    return row(true, "warrant stored (this lead's own sweep delivered it first)");
  }
  const why = refusal.ok ? "" : ` (${refusal.reason})`;
  return row(false, `NOT STORED — that machine is up and did not take the warrant${why}`);
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
  const client = clientFor(deps, data, data.pack?.secret ?? "");
  for (const member of data.peers.filter((p) => p.status === "enrolled")) {
    // PHASE 2 IS GATED ON PHASE 1, per member. A machine that does not hold the warrant has nothing
    // for a restart to arm, so it is not probed, not restarted, and no anchor is recorded for it.
    if (rows.get(member.memberId)?.stored !== true) {
      mark(rows, member.memberId, "failed", "not restarted — it does not hold the warrant");
      continue;
    }
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
    // ── ASK THE MACHINE BEFORE RESTARTING IT (§18.17) ───────────────────────
    // The record above is this operator's own lower bound: it moves only when THIS verb's restart leg
    // completes, so a machine restarted any other way — an update, its unit, a hand on a keyboard —
    // is armed and unrecorded. A re-run that trusted the record alone asked the operator to restart a
    // pack that was already armed, which the live drill did. The member's own report settles it, and
    // it costs one small read-only dial per member that the record does not already vouch for.
    const reported = await activeGenerationAt(client, member);
    if (reported !== null && reported >= warrant.generation) {
      mark(rows, member.memberId, "already", "already armed for this generation — that machine reports it active");
      await rememberReported(deps, member.memberId, record, reported);
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
 * What that member's listener says it activated, or `null` (§18.17).
 *
 * `null` for a member that is not answering, for a pre-amendment build, and for one that reports
 * nothing active — three cases with one closed reading, because each of them means *this run cannot
 * see an armed listener there*, and the answer to that is the restart this verb performs. A failed
 * dial is never an error here: the machine is about to be probed over ssh anyway, which is where an
 * unreachable one is reported in the operator's own terms.
 */
async function activeGenerationAt(client: PeerClient, member: TrustedMember): Promise<number | null> {
  const hello = await client.hello(linkOf(member));
  return hello.ok ? hello.value.warrantActiveGeneration : null;
}

/**
 * Write down an arming this verb did NOT perform, so the offline view converges (§18.17).
 *
 * The record is meant to answer "is that machine armed", and a `pack status --no-probe` reading it
 * would otherwise keep saying INACTIVE about a machine this very run just confirmed. Silent on
 * failure: nothing here is trust material, the arming is true either way, and the next run asks again.
 */
async function rememberReported(
  deps: PackAddDeps,
  memberId: string,
  record: OpsRecord,
  generation: number,
): Promise<void> {
  await deps.ops.record(memberId, { ...record, anchoredGeneration: generation, anchoredAt: deps.now() });
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
    // An unstored member's row NEVER mentions an anchor, in any form. The composite that made this
    // rule necessary read `not stored — … , restarted — its listener now anchors the deputy`, which
    // is two contradictory claims about one machine in one line; the arming phase no longer produces
    // the second half, and this prints only the first.
    if (!row.stored) {
      deps.io.out(`  ${member.memberId}: ${row.detail}`);
      deps.io.out(`             Nothing was restarted there and no anchor was recorded for it.`);
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
  sameOriginNotice(deps);
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
