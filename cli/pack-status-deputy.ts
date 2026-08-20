import { deposedOutcomeLines } from "../bridge/pack/deposed.ts";
import type { OpsRecord } from "../bridge/pack/ops-store.ts";
import { armThresholdMs as bridgeArmThresholdMs } from "../bridge/pack/standby.ts";
import { checkpointStale, type PackRuntimeMarker } from "../bridge/pack/staleness.ts";
import type { TrustStoreData, Warrant } from "../bridge/pack/trust-store.ts";
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
//   • the LEAD knows storage exactly — every member reports its generation on `hello` — and knows
//     anchoring only as "did I restart that machine over ssh", which is what `pack-ops.json` records.
//     That is a lower bound, and the line it produces names the remedy rather than accusing the peer.
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
  if (stored === null || stored.warrant.deputyMemberId === null) {
    if (enrolled.length === 0) return [];
    const why = stored === null ? "" : ` (revoked at generation ${stored.warrant.generation})`;
    return [
      line(`deputy none${why} — no peer may take over; name one with \`collie pack deputy <member>\``, "warn"),
    ];
  }
  const w = stored.warrant;
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
 * The warning RFC §5 asks for when the one machine that may take over is the one not answering.
 *
 * It is not an error and it refuses nothing: a deputy that is merely asleep comes back. What it
 * changes is what the operator should do *now*, while the lead is still healthy enough to sign —
 * which is exactly the window this whole feature exists to use.
 */
export function deputyUnreachableLines(data: TrustStoreData, reachable: (memberId: string) => boolean): TonedLine[] {
  const deputy = currentWarrant(data)?.warrant.deputyMemberId ?? null;
  if (deputy === null || reachable(deputy)) return [];
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
 */
export function memberWarrantLines(
  data: TrustStoreData,
  reported: number | null | undefined,
  record: OpsRecord | null,
  memberId: string,
): TonedLine[] {
  const stored = currentWarrant(data);
  if (stored === null || stored.warrant.deputyMemberId === null) return [];
  const w = stored.warrant;
  const verdict = storedVerdict(w, reported);
  if (verdict === "silent") {
    return [
      line("    warrant reports none — this build predates warrants, so it can hold no deputy", "dim"),
    ];
  }
  if (verdict === "behind") {
    return [
      line(`    warrant generation ${reported} — BEHIND this lead's ${w.generation}; the next sweep pushes it`, "warn"),
    ];
  }
  if (!anchored(w, record)) {
    // RFC §5's exact shape, and §8.2's "enrolled but INACTIVE" note is its sibling: a fact that is on
    // disk over there and not yet in the process that would have to act on it.
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
  const silence = Math.max(0, now - Math.max(dialled ?? 0, marker.bootedAt));
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
  if (anchoredGeneration === w.generation) {
    return [line(head, "good"), line("       verified · anchored at this boot", "good")];
  }
  return [
    line(head, "warn"),
    line("       verified · stored, NOT anchored — this collie's listener was built before it landed.", "warn"),
    line("       Restart here to arm it: `herdr plugin action invoke restart --plugin herdr.collie`.", "dim"),
  ];
}
