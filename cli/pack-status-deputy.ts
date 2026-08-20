import { deposedOutcomeLines } from "../bridge/pack/deposed.ts";
import type { OpsRecord } from "../bridge/pack/ops-store.ts";
import {
  armingReport,
  armThresholdMs as bridgeArmThresholdMs,
  armThresholdWarning,
  coldReason,
  humanSilence,
  silenceOf,
  standbyPortOf,
  STANDBY_PORT_ENV,
  warrantNamesSelf,
  type StandbyFacts,
} from "../bridge/pack/standby.ts";
import type { StandbyDevices } from "../bridge/pack/standby-devices.ts";
import { checkpointStale, type PackRuntimeMarker } from "../bridge/pack/staleness.ts";
import type { TrustedMember, TrustStoreData, Warrant } from "../bridge/pack/trust-store.ts";
import { currentWarrant, verifyWarrantSignature, warrantExpired, warrantExpiresAt } from "../bridge/pack/warrant.ts";
import type { Environment } from "./context.ts";
import type { Tone, TonedLine } from "./render.ts";

// What `collie pack status` says about the deputy — on the lead that named one, on the peer that
// holds the warrant, and on the machine that was deposed (RFC §10, §8.3, §5).
//
// ── EVERY FUNCTION HERE IS PURE ──────────────────────────────────────────────
// Data in, `TonedLine[]` out. `cmdPackStatus` does the probing and the emitting; this module does
// the words, so the whole render matrix — six warrant states, three deposed outcomes, three
// silences — is unit-testable without a store, a clock or a socket.
//
// ── THE TWO PHASES ARE NEVER BLURRED (RFC §5) ────────────────────────────────
// A warrant is **stored** the moment a peer verifies the push, and **anchored** only once that peer
// has restarted and built its listener with the deputy's certificate in its `ca` list. Until then a
// takeover from that peer's side is impossible rather than merely refused, so a surface that printed
// one word for both would be reporting a pack as armed that is not. Each side knows a different half:
//
//   • the PEER knows anchoring exactly — its own process built the listener, and the runtime marker
//     carries the generation it built it from (`bridge/pack/staleness.ts`);
//   • the LEAD knows storage exactly — every member reports its generation on `hello` — and learns
//     activation the same way since §18.17: `warrantActiveGeneration`, reported by the machine that
//     did it. `pack-ops.json`'s "did I restart that machine over ssh" survives as the fallback for a
//     member that is not answering, or is too old to say. Preferring the report is the fix for a live
//     drill in which the lead told the operator to restart a deputy that was already fully armed.
//
// ── ONE SILENCE CLOCK (RFC §10.1) ────────────────────────────────────────────
// The threshold this file prints against is the arming formula itself, because §10.1's rule is that
// the deputy's door and the peer's status line read the same number. A door that arms on a fact
// `pack status` does not print is a door nobody can explain.

/**
 * The arming threshold, RFC §6.3's formula rather than a constant.
 *
 * An operator who relaxes the idle poll to save a laptop's battery moves this with it, instead of
 * discovering months later that their idle pack arms its own standby door every night. The `30_000`
 * floor keeps a very tight poll from producing a hair-trigger.
 */
export function armThresholdMs(env: Environment): number {
  // Delegated, never re-implemented. §10.1's rule is that the deputy's door and this verb read the
  // SAME number, and two copies of a formula is exactly how they stop doing that. The bridge's copy
  // also honours the operator's `COLLIE_STANDBY_ARM_MS` override, which this line therefore does too.
  return bridgeArmThresholdMs(env);
}

/** How often the bridge re-stamps the runtime marker — the interval staleness is judged against. */
export const CHECKPOINT_INTERVAL_MS = 15_000;

/** A duration an operator reads at a glance. Coarse on purpose: nobody triages in milliseconds. */
export function humanAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const iso = (at: number): string => new Date(at).toISOString();

const line = (text: string, tone: Tone = "plain"): TonedLine => ({ text, tone });

// ── The deposed machine (RFC §8.2, §8.3) ─────────────────────────────────────

/**
 * What a deposed collie says about itself, **loudly and first**.
 *
 * The state lives in the running process (`bridge/pack/deposed.ts`) and reaches this verb through
 * the runtime marker, so a `pack status` on a machine whose bridge is down prints nothing here — and
 * that is honest: nothing is being served there either, and the trust store alone cannot distinguish
 * "healed to peer" from "always was a peer".
 *
 * The outcome paragraph is `deposedOutcomeLines`, verbatim — the same words the one page this
 * machine still serves prints. Two spellings of a terminal state is one spelling too many.
 */
export function deposedLines(marker: PackRuntimeMarker | null): TonedLine[] {
  const state = marker?.deposed ?? null;
  if (state === null) return [];
  const pack = state.packName === null ? "this pack" : `"${state.packName}"`;
  const lead = state.leadMemberId === null ? "another machine" : `"${state.leadMemberId}"`;
  return [
    line("", "plain"),
    line(`⚠ DEPOSED — this machine led pack ${pack} until ${iso(state.at)}.`, "bad"),
    line(`  The pack is now led by ${lead} (warrant generation ${state.generation}).`, "bad"),
    ...deposedOutcomeLines(state, state.outcome).map((t) => line(`  ${t}`, "warn")),
  ];
}

// ── The lead's view (RFC §5, §10.2) ──────────────────────────────────────────

/** Which of the six things a member's warrant column can be saying. */
type StoredVerdict = "current" | "behind" | "silent";

function storedVerdict(issued: Warrant, reported: number | null | undefined): StoredVerdict {
  if (reported === null || reported === undefined) return "silent";
  return reported >= issued.generation ? "current" : "behind";
}

/** Did this operator arm the deputy on that machine, for the generation currently issued? */
function anchored(issued: Warrant, record: OpsRecord | null): boolean {
  const at = record?.anchoredGeneration ?? null;
  return at !== null && at >= issued.generation;
}

/**
 * The lead's one-line summary of its own designation, printed beside `secret generation …`.
 *
 * A lead with peers and no warrant is a pack nobody may take over, and RFC §8.3 requires that to be
 * said out loud rather than inferred from an absent line — a takeover leaves exactly that state
 * behind, and an operator who cannot see it will not fix it.
 */
export function leadDeputyLines(data: TrustStoreData, now: number): TonedLine[] {
  const stored = currentWarrant(data);
  const enrolled = data.peers.filter((p) => p.status === "enrolled");
  // ── THE DESIGNATION IS THE SOURCE, NEVER THE WARRANT ────────────────────────
  // `data.deputy` is the operator's decision ON THIS LEAD; the warrant is the signed artefact of a
  // decision that may already be spent. After a takeover the new lead keeps the warrant — it carries
  // the generation counter and it is the proof for §9's reconciliation — and that warrant names
  // **this machine**. Reading the deputy off it made a lead report itself as its own deputy and then
  // warn that it was unreachable, which is what the live drill saw. `deputy` is written in the same
  // transition as every mint (`warrant.ts`), so the two can never disagree about who was named.
  const designated = data.deputy ?? null;
  if (designated === null || stored === null || stored.warrant.deputyMemberId === null) {
    if (enrolled.length === 0) return [];
    return [line(`deputy none${undesignatedReason(data, stored)} — no peer may take over; name one with \`collie pack deputy <member>\``, "warn")];
  }
  const w = stored.warrant;
  if (designated === data.self.memberId) {
    // A lead cannot be its own deputy under any reading — `mintWarrant` only ever names a member of
    // this collie's own roster, and a lead is not in it. Said rather than rendered as a live deputy.
    return [
      line(`deputy ${designated} — this machine names ITSELF, which cannot be armed`, "bad"),
      line("       A deputy is a peer that takes over from this lead; this lead taking over from", "dim"),
      line("       itself is not a recovery path. Name a peer: `collie pack deputy <member>`.", "dim"),
    ];
  }
  if (designated !== w.deputyMemberId) {
    // The two disagree, which the one-transition rule above makes impossible without a hand edit.
    // Named rather than resolved: picking a winner here would be inventing a designation.
    return [
      line(`deputy ${designated} — but the warrant on disk names "${w.deputyMemberId}"`, "bad"),
      line("       The designation and the signed warrant are written in one step, so this store was", "dim"),
      line("       edited by hand. Re-run `collie pack deputy <member>` to make them agree.", "dim"),
    ];
  }
  if (warrantExpired(w, now)) {
    return [
      line(`deputy ${w.deputyMemberId} — warrant generation ${w.generation} EXPIRED ${iso(warrantExpiresAt(w))}`, "bad"),
      line("       A warrant dies 30 days after its last refresh, so a pack that has been dark that", "dim"),
      line("       long disarms itself. Re-run `collie pack deputy` here to mint a live one.", "dim"),
    ];
  }
  return [
    line(
      `deputy ${w.deputyMemberId} — warrant generation ${w.generation}, refreshed ${humanAge(now - w.refreshedAt)} ago`,
      "plain",
    ),
  ];
}

/**
 * Why this lead names nobody — the parenthetical on `deputy none`, and there are three answers.
 *
 * **A takeover is the one that needs saying** (RFC §14.4's first follow-up): it leaves a lead holding
 * a warrant that names itself and designating no one, and an operator who reads that as "I never got
 * round to it" will not realise the pack has been without a deputy since the outage. A revocation and
 * a pack that never named one are the two innocent cases and are spelled as such.
 */
function undesignatedReason(data: TrustStoreData, stored: ReturnType<typeof currentWarrant>): string {
  const spentAt = data.deputySpentAt ?? null;
  if (spentAt !== null) return ` — spent by the takeover of ${iso(spentAt)}`;
  if (stored !== null && stored.warrant.deputyMemberId === null) {
    return ` (revoked at generation ${stored.warrant.generation})`;
  }
  return "";
}

/**
 * The warning RFC §5 asks for when the one machine that may take over is the one not answering.
 *
 * It is not an error and it refuses nothing: a deputy that is merely asleep comes back. What it
 * changes is what the operator should do *now*, while the lead is still healthy enough to sign —
 * which is exactly the window this whole feature exists to use.
 */
export function deputyUnreachableLines(data: TrustStoreData, reachable: (memberId: string) => boolean): TonedLine[] {
  // The DESIGNATION, for `leadDeputyLines`' reason — a spent warrant names this very machine, and
  // warning that this lead cannot reach itself is the absurd companion the live drill printed. A
  // designation that is not an enrolled peer is not warned about either: it is a different fault, and
  // `leadDeputyLines` above is where it is named.
  const deputy = data.deputy ?? null;
  if (deputy === null || deputy === data.self.memberId || reachable(deputy)) return [];
  if (!data.peers.some((p) => p.memberId === deputy && p.status === "enrolled")) return [];
  return [
    line(`⚠ deputy "${deputy}" is unreachable — appoint another with \`collie pack deputy <member>\``, "warn"),
    line("  A deputy that cannot be reached now is a deputy that cannot be armed later: the warrant is", "dim"),
    line("  still valid, but a machine that is not there takes over nothing.", "dim"),
  ];
}

/**
 * One member's warrant + anchor rows, under its `link` line in the roster block.
 *
 * `reported` is what that member answered `hello` with (§18.7): a number, or `null`/absent for a
 * build that predates warrants — which is a **capability** gap, not a failure, and is spelled as
 * one. Nothing here refuses anything.
 *
 * `active` is §18.17's second report — the generation that member's LISTENER came up holding. It
 * **outranks the ops record**, and that is the whole point: the record only ever moves when *this
 * verb's own restart leg* completes, so a restart performed any other way (an update, the unit, a
 * hand on a keyboard) left an armed machine rendered as `anchor INACTIVE — restart it`. A live drill
 * read that sentence on a deputy whose own `pack status` said `deputy role ACTIVE at this boot`.
 * Absent ⇒ the record's lower bound, which is the pre-amendment reading, unchanged.
 */
export function memberWarrantLines(
  data: TrustStoreData,
  reported: number | null | undefined,
  record: OpsRecord | null,
  memberId: string,
  active: number | null | undefined = null,
): TonedLine[] {
  const stored = currentWarrant(data);
  if (stored === null || stored.warrant.deputyMemberId === null) return [];
  const w = stored.warrant;
  const verdict = storedVerdict(w, reported);
  // The record is a claim about the PAST — "I restarted that machine for generation N" — and the
  // report is the machine speaking for itself now. When they disagree the machine wins: it cannot
  // have ANCHORED a generation it does not even STORE, so a record that outruns the report is
  // provably stale (the machine was re-installed, rolled back, or the restart never took). Rendered
  // rather than quietly dropped, because a disappearing anchor with no sentence is how an operator
  // learns to distrust the column instead of the record.
  const staleRecord = staleAnchorLines(record, reported);
  if (verdict === "silent") {
    return [
      line("    warrant reports none — this build predates warrants, so it can hold no deputy", "dim"),
      ...staleRecord,
    ];
  }
  if (verdict === "behind") {
    return [
      line(`    warrant generation ${reported} — BEHIND this lead's ${w.generation}; the next sweep pushes it`, "warn"),
      ...staleRecord,
    ];
  }
  // The MACHINE'S OWN WORD FIRST (§18.17). Activation happens in that peer's process, so the peer is
  // the authority on it and the ops record is only ever a lower bound on what this operator did from
  // here. When the report says the current generation is live, it is live — however it got restarted.
  if (active !== null && active !== undefined && active >= w.generation) {
    // Which word depends on the role, because the two roles activate two different things
    // (`bridge/index.ts`'s `activatedGeneration`): the machine the warrant NAMES arms its own deputy
    // role and anchors nothing — it does not anchor its own certificate — while every other peer adds
    // the deputy's certificate as a second TLS anchor. The lead can tell them apart without a wire
    // field: it knows who the warrant names.
    const role = memberId === w.deputyMemberId ? "its deputy role is ACTIVE" : "anchored";
    return [
      line(`    warrant generation ${w.generation} — stored, and ${role} (that machine reports it)`, "good"),
    ];
  }
  if (!anchored(w, record) || (active !== null && active !== undefined)) {
    // RFC §5's exact shape, and §8.2's "enrolled but INACTIVE" note is its sibling: a fact that is on
    // disk over there and not yet in the process that would have to act on it. A member that reports
    // an OLDER activation lands here even when the record claims otherwise — the record describes a
    // past restart, and the machine is describing the process running on it now.
    return [
      line(`    warrant stored, anchor INACTIVE — restart ${memberId}`, "warn"),
      line("            Its listener was built before the warrant landed, and `server.reload` cannot", "dim"),
      line("            re-pin one — so a takeover from there is impossible, not merely refused.", "dim"),
    ];
  }
  const when = record?.anchoredAt ?? null;
  return [
    line(
      `    warrant generation ${w.generation} — stored and anchored${when === null ? "" : ` (${iso(when)})`}`,
      "good",
    ),
  ];
}

/**
 * The line that fires when the ops record claims an anchor the peer's own report contradicts.
 *
 * Empty for every honest combination — no record, no report, or a report that is level with the
 * record or ahead of it. It is deliberately not silent about the disagreement: the record is the
 * only thing the lead-side anchor column is built from, so a stale one must be visible as stale,
 * not merely unused.
 */
function staleAnchorLines(record: OpsRecord | null, reported: number | null | undefined): TonedLine[] {
  const claimed = record?.anchoredGeneration ?? null;
  if (claimed === null) return [];
  if (reported !== null && reported !== undefined && reported >= claimed) return [];
  const holds = reported === null || reported === undefined ? "reports none at all" : `reports generation ${reported}`;
  return [
    line(`    anchor  RECORD IS STALE — this machine armed generation ${claimed} there, but it ${holds}`, "bad"),
    line("            A machine cannot anchor a warrant it does not hold, so the recorded arming no", "dim"),
    line("            longer describes it. Re-run `collie pack deputy` to store and arm it again.", "dim"),
  ];
}

// ── The peer's view (RFC §10.1, §5) ──────────────────────────────────────────

/**
 * Gap A, rendered: **when this peer's lead last called it** (RFC §10.1).
 *
 * Three sentences for three genuinely different states, and the threshold between the first two is
 * the arming formula rather than a number invented here. The third is not "never" — a receipt does
 * not survive a restart on purpose (§18.9) — so it says what it means: not since this collie started.
 */
export function leadContactLines(
  data: TrustStoreData,
  marker: PackRuntimeMarker | null,
  env: Environment,
  now: number,
): TonedLine[] {
  const lead = data.lead;
  if (lead === null) return [];
  if (marker === null) {
    return [line(`lead   ${lead.memberId} — no bridge has run here yet, so nothing has recorded its calls`, "dim")];
  }
  if (checkpointStale(marker, now, CHECKPOINT_INTERVAL_MS)) {
    return [
      line(
        `lead   ${lead.memberId} — no bridge is running here (last checkpoint ${humanAge(now - marker.checkpointedAt)} ago)`,
        "warn",
      ),
    ];
  }
  const dialled = marker.leadLastDialledAt;
  // The door's own formula, called rather than re-derived (§10.1's one-clock rule). The two used to
  // agree by having the same arithmetic written twice, which is not the same thing as agreeing.
  const silence = silenceOf(contactFacts(marker), now);
  const rows: TonedLine[] = [];
  if (dialled === null) {
    rows.push(
      line(`lead   ${lead.memberId} — has not called since this collie started ${humanAge(silence)} ago`, "warn"),
    );
  } else if (silence >= armThresholdMs(env)) {
    rows.push(line(`lead   ${lead.memberId} — has not called for ${humanAge(silence)}`, "warn"));
  } else {
    rows.push(line(`lead   ${lead.memberId} — last called ${humanAge(silence)} ago`, "good"));
  }
  // §8.4's rotation, seen from the side that was dropped. It is the difference between "my lead is
  // gone" and "my lead is calling and I am no longer in the pack", and only this collie can tell.
  if (marker.leadRefusedSecretAt !== null) {
    rows.push(
      line(`       refused on the pack SECRET ${humanAge(now - marker.leadRefusedSecretAt)} ago — the pack`, "bad"),
    );
    rows.push(line("       rotated while this machine was away (§8.4). Re-join it: `collie join <lead> <token>`.", "dim"));
  }
  return rows;
}

/**
 * The warrant this peer holds, and whether its listener is actually built with it (RFC §5).
 *
 * The signature is re-verified here against the lead this collie pins, rather than trusted because
 * the router once accepted it: the store is a file, an operator can edit it, and a status surface
 * that said "verified" on the strength of a past decision would be the one place that could not
 * notice. It costs one ECDSA verification per `pack status`.
 */
export function peerWarrantLines(
  data: TrustStoreData,
  marker: PackRuntimeMarker | null,
  now: number,
): TonedLine[] {
  const stored = currentWarrant(data);
  const lead = data.lead;
  if (lead === null) return [];
  if (stored === null) {
    return [line("warrant none — this collie holds no warrant, so this pack names no deputy it knows of", "dim")];
  }
  const w = stored.warrant;
  const anchoredGeneration = marker?.anchoredGeneration ?? null;
  if (w.deputyMemberId === null) {
    const rows = [line(`warrant generation ${w.generation} — REVOKED: this pack names no deputy`, "plain")];
    if (anchoredGeneration !== null) {
      rows.push(line("       This collie's listener still anchors the deputy it was built with. It stops", "warn"));
      rows.push(line("       doing so at its next restart; until then that certificate is still admitted.", "dim"));
    }
    return rows;
  }
  const self = w.deputyMemberId === data.self.memberId ? " — THIS machine is the deputy" : "";
  const head = `warrant generation ${w.generation} — deputy "${w.deputyMemberId}"${self}`;
  if (!verifyWarrantSignature(w, lead.certPem)) {
    return [
      line(head, "bad"),
      line(`       NOT VERIFIED against lead "${lead.memberId}" — this warrant arms nothing at all.`, "bad"),
      line("       A stored warrant that does not verify is a hand-edited store, not a stale message.", "dim"),
    ];
  }
  if (warrantExpired(w, now)) {
    return [
      line(head, "warn"),
      line(`       EXPIRED ${iso(warrantExpiresAt(w))} — a pack that has been dark 30 days disarms`, "warn"),
      line("       itself. Re-run `collie pack deputy` on the lead to mint a live one.", "dim"),
    ];
  }
  // Two roles activate two different things at a restart (`bridge/index.ts`'s `activatedGeneration`),
  // so the word has to follow the role: the machine the warrant NAMES arms its own deputy role and
  // anchors nothing — it does not anchor its own certificate — while every other peer adds the
  // deputy's certificate as a second anchor. One marker, two sentences, and neither is the other's.
  const isDeputy = w.deputyMemberId === data.self.memberId;
  if (anchoredGeneration === w.generation) {
    return [
      line(head, "good"),
      line(`       verified · ${isDeputy ? "deputy role ACTIVE at this boot" : "anchored at this boot"}`, "good"),
    ];
  }
  return [
    line(head, "warn"),
    line(
      `       verified · stored, NOT ${isDeputy ? "active" : "anchored"} — this collie's listener was built before it landed.`,
      "warn",
    ),
    line("       Restart here to arm it: `herdr plugin action invoke restart --plugin herdr.collie`.", "dim"),
  ];
}

// ── The deputy's own door (RFC §6.2, §6.3, §10.1) ────────────────────────────

/** The marker's two receipts, in the shape the door's own clock reads. One holder, one formula. */
function contactFacts(marker: PackRuntimeMarker) {
  return {
    lastDialledAt: marker.leadLastDialledAt,
    processStartedAt: marker.bootedAt,
    leadRefusedSecretAt: marker.leadRefusedSecretAt,
  };
}

/**
 * Break one of `standby.ts`'s own sentences into rows a terminal can hold.
 *
 * The words are the door's, unchanged. A second wording of "why this door is cold" is a second thing
 * to keep true, and the page an operator reads at 23:00 and the verb they ran at 22:00 disagreeing
 * about it is exactly the failure §10.1 exists to prevent.
 */
function wrapped(text: string, indent: string, width = 98): TonedLine[] {
  const rows: string[] = [];
  let row = "";
  for (const word of text.split(" ")) {
    if (row !== "" && `${indent}${row} ${word}`.length > width) {
      rows.push(row);
      row = word;
      continue;
    }
    row = row === "" ? word : `${row} ${word}`;
  }
  if (row !== "") rows.push(row);
  return rows.map((r) => line(`${indent}${r}`, "dim"));
}

/**
 * **The arming state of this machine's standby door** — the fact the door decides on, printed by the
 * verb (RFC §6.3, §10.1).
 *
 * Every input is the door's own function: {@link warrantNamesSelf} for the warrant, `silenceOf` for
 * the clock, `armThresholdMs` for the formula, `armingReport` for the verdict and `coldReason` for
 * the sentence. Nothing here re-derives any of them, because a `pack status` that computed its own
 * arming would be a second door — one that arms on paper while the real one stays shut, or the
 * reverse. It reads state and grants nothing.
 *
 * Silent on every machine that is not the named deputy: a peer with no warrant has no door, and a
 * heading about one would be four lines of nothing on every `pack status` in the pack.
 */
export function standbyDoorLines(
  data: TrustStoreData,
  marker: PackRuntimeMarker | null,
  devices: StandbyDevices | null,
  env: Environment,
  now: number,
): TonedLine[] {
  if (!warrantNamesSelf("peer", data, now)) return [];
  const port = standbyPortOf(env);
  if (port === null) {
    // RFC §6.2's "absent means closed", said out loud. The warrant is real and a keyboard promotion
    // still works; what is missing is the page a phone would tap, and nothing else says so.
    return [
      line(`standby door — CLOSED: ${STANDBY_PORT_ENV} is unset, so nothing is bound here`, "warn"),
      line("       This machine holds the warrant and could take over, but only from a keyboard", "dim"),
      line("       (`collie promote`). Set the port, restart here, and put both machines behind one", "dim"),
      line("       origin — the phone's credential and its installed app are per-origin (RFC §14.2).", "dim"),
    ];
  }
  if (marker === null || checkpointStale(marker, now, CHECKPOINT_INTERVAL_MS)) {
    // No live process, so no listener and no receipts. An arming verdict computed here would be a
    // statement about a door nobody is serving — the one thing this surface must never make.
    return [line(`standby door — configured on :${port}, but no bridge is running here to bind it`, "warn")];
  }
  const facts: StandbyFacts = {
    warrantsSelf: true,
    silentForMs: silenceOf(contactFacts(marker), now),
    armMs: armThresholdMs(env),
    deviceCount: devices?.devices.length ?? 0,
    // The witnesses step (b) would ask. It shapes the page's wording, never the verdict, so a peer's
    // short roster cannot make this line disagree with the door's own answer.
    witnessCount: data.peers.filter((p) => p.status === "enrolled").length,
    leadMemberId: data.lead?.memberId ?? null,
    selfMemberId: data.self.memberId,
    packName: data.pack?.name ?? null,
  };
  const report = armingReport(facts);
  const rows: TonedLine[] = report.armed
    ? [
        line(`standby door — ARMED on :${port} · silent for ${humanSilence(facts.silentForMs)}`, "bad"),
        line("       The page is live and its button is on it. Arming grants nothing by itself, and", "warn"),
        line("       the lead's next landed call disarms it — nothing is persisted either way.", "dim"),
      ]
    : [
        line(`standby door — cold on :${port} · arms after ${humanSilence(facts.armMs)} of silence`, "good"),
        ...wrapped(coldReason(facts, report), "       "),
      ];
  const warning = armThresholdWarning(env);
  return warning === null ? rows : [...rows, line(warning, "warn")];
}

// ── The lead's pairing sync (RFC §6.5; RFC §16, decision 6) ──────────────────

/**
 * The deputy refused the last pairing sync, because it already holds one of those labels (§18.14).
 *
 * It is the lead's operator who can fix it — the labels are theirs — so the finding is printed here
 * and nowhere else. It is read off the runtime marker rather than the trust store because it is an
 * observation of one process's traffic, and it clears itself: the lead re-offers the refused sync on
 * every sweep, so the rename takes effect with no verb and no restart.
 */
export function pairingCollisionLines(marker: PackRuntimeMarker | null, now: number): TonedLine[] {
  const collision = marker?.pairingCollision ?? null;
  if (collision === null) return [];
  const labels = collision.labels.map((l) => `"${l}"`).join(", ");
  return [
    line(`⚠ pairing sync REFUSED ${humanAge(now - collision.at)} ago — the deputy already has ${labels}`, "warn"),
    line("  Until it lands, that deputy's standby door has nothing to check a takeover against and", "dim"),
    line("  refuses to arm. A label is the revoke handle, so the sync refuses rather than renaming a", "dim"),
    line("  device you could then not revoke by name. Free the name on one side and the next sweep", "dim"),
    line("  syncs by itself — `collie devices revoke <label>` there, or re-pair under another name here.", "dim"),
  ];
}

// ── The new lead's unfinished business (RFC §7.1, §9) ────────────────────────

/**
 * One member a takeover could not reach, under its roster row.
 *
 * `rePinPending` is how §7.1's partial success is represented, and it names **no operator step on
 * purpose**: §9's reconciliation is this lead's own sweep, which pushes the proof on first contact
 * and clears the flag. So the remedy sentence says what is true — there is nothing to run — because a
 * row that looked like a task would be a task nobody can perform.
 */
export function memberRePinLines(member: TrustedMember): TonedLine[] {
  if (member.rePinPending !== true) return [];
  return [
    line("    re-pin  PENDING — this member has not been told the crown moved", "warn"),
    line("            It still follows the machine that led before the takeover, so it answers this", "dim"),
    line("            collie nothing. There is no step to run: this lead pushes the signed proof on", "dim"),
    line("            first contact and clears the row by itself (§9). A row that stays is a machine", "dim"),
    line("            that is simply not back yet.", "dim"),
  ];
}
