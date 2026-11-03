// WHERE A MULTIPLEXER'S MACHINE LIST AND THIS CREW DIFFER (M84/04).
//
// `collie start`, `collie doctor` and `collie crew status` print the same lines from this one
// function: one per multiplexer that knows machines this crew does not have, and one per member that
// came from such a list and is no longer on it. It TELLS and never acts. A multiplexer's list is a
// source of candidates, not a crew (ADR 0036 (c)), so nothing here adds, drops, writes or dials.
//
// ── THE PICKER'S PIECES, NOT A SECOND COPY ───────────────────────────────────
// `collie crew add` offers the same lists, and the three helpers it needs are defined HERE and
// imported by `./remote.ts`: {@link candidateProbe}, {@link leadRoster} and
// {@link muxCandidateSources}. The picker adds the ssh config on top of the multiplexers. This
// module does NOT: a config lists every host a person ever reached, and "ssh config knows 40
// machines" is noise on a line that prints at every start.
//
// ── READ-ONLY, AND BOUNDED ───────────────────────────────────────────────────
// Every call runs on THIS machine: a multiplexer's machine list is client-side state, and `ssh -G`
// prints the configuration that would be used without opening a socket. No peer is dialled and no
// file is written. Each shell-out has the picker's budget, CANDIDATE_TIMEOUT_MS (3 s). The worst case is one
// machine-list call per registered multiplexer that offers one, plus one `ssh -G` per DISTINCT
// target (the listed machines and the members' recorded hosts together, because the probe is
// memoised for the run): (providers + distinct targets) x 3 s, and in practice a few milliseconds.
// An unanswered or broken list is silent here; the picker is the verb that warns about it.
//
// ── WHAT COUNTS AS EVIDENCE ──────────────────────────────────────────────────
// A member is "forgotten" only when its recorded `source` names a multiplexer that ANSWERED, in THIS
// run, with at least one machine, and none of them is the member. A source that is absent (tool not
// installed, nothing running) or unhealthy (timeout, unreadable output) says nothing either way: a
// laptop with its list service stopped must not look like a crew that lost every machine. A member
// with no recorded source (typed by hand, or enrolled before the field existed) is never reported.
//
// A peer and a Windows host print nothing and run nothing: a peer has no crew to compare, and
// crews are refused on Windows. `collie crew status` asks only when a trust store exists and this
// machine leads it; on a machine in no crew it prints its own block and never calls in here. `start`
// and `doctor` do ask on a solo collie, where the list is the reason to start a crew.

import type { HostProbe } from "../bridge/mux/host-candidates.ts";
import { muxHostCandidates } from "../bridge/mux/registry.ts";
import type { CrewOpsStore } from "../bridge/crew/ops-store.ts";
import type { TrustStore } from "../bridge/crew/trust-store.ts";
import type { Host } from "../bridge/host.ts";
import {
  markCandidates,
  mergeCandidates,
  offeredCandidates,
  resolvedSshTarget,
  type RosterEntry,
  type SourcedCandidates,
} from "./candidates.ts";
import type { Exec } from "./sys.ts";

/**
 * The candidate providers' world, over the seam this suite already fakes.
 *
 * `Exec` and not a remote runner: every call runs on THIS machine — `ssh -G` resolves a local config
 * file without connecting, and a multiplexer's machine list is local client-side state. `warn` says
 * the one line a present-but-broken provider has to say; the picker prints it, the delta drops it.
 */
export function candidateProbe(deps: { readonly exec: Exec }, warn: (line: string) => void): HostProbe {
  return {
    run: (tool, args, timeoutMs) => deps.exec.capture(tool, args, timeoutMs),
    warn,
  };
}

/**
 * This lead's own roster, as a join the candidate list can mark against.
 *
 * The enrolled peers come from the trust store and how each was reached comes from the ops store
 * (`bridge/crew/ops-store.ts`, ADR 0016) — `crew add` has WRITTEN `sshHost` since M7/01 and this is
 * the first read of it here, with the `source` M84/02 records beside it. Empty on a peer and on a
 * solo collie: neither has members to mark.
 */
export async function leadRoster(
  deps: { readonly store: Pick<TrustStore, "load">; readonly ops: Pick<CrewOpsStore, "load"> },
  probe: HostProbe,
): Promise<readonly RosterEntry[]> {
  const trust = await deps.store.load();
  if (trust === null || trust.lead !== null) return [];
  const { data } = await deps.ops.load();
  if (data === null) return [];
  const roster: RosterEntry[] = [];
  for (const peer of trust.peers) {
    const record = data.members[peer.memberId];
    if (record === undefined) continue;
    const sshHost = record.sshHost;
    roster.push({
      memberId: peer.memberId,
      sshHost,
      key: resolvedSshTarget(sshHost, probe) ?? sshHost,
      source: record.source ?? null,
    });
  }
  return roster;
}

/**
 * Every multiplexer that answered with at least one machine, in registry order.
 *
 * A provider that is absent, stopped or unhealthy yields nothing and so has no entry: the registry
 * drops empty answers, which is what "healthy with at least one machine" means to the delta.
 */
export function muxCandidateSources(probe: HostProbe): readonly SourcedCandidates[] {
  return muxHostCandidates(probe).map((answer) => ({ source: answer.mux, candidates: answer.candidates }));
}

/** What differs between a multiplexer's list and this crew. Both arrays empty is the quiet case. */
export interface CrewDelta {
  /** Per multiplexer, the machines it lists that no member covers, by the name the list gave them. */
  readonly missing: readonly { readonly source: string; readonly targets: readonly string[] }[];
  /** Members that came from a multiplexer's list that answered and no longer names them. */
  readonly forgotten: readonly { readonly memberId: string; readonly source: string }[];
}

const NO_DELTA: CrewDelta = { missing: [], forgotten: [] };

/** The seams the delta reads through. All of them are reads. */
export interface CrewDeltaDeps {
  readonly exec: Exec;
  readonly store: Pick<TrustStore, "load">;
  readonly ops: Pick<CrewOpsStore, "load">;
  readonly host: Pick<Host, "platform">;
}

/** One probe that answers a repeated shell-out once, so a target is resolved once per run. */
function memoised(probe: HostProbe): HostProbe {
  const answers = new Map<string, ReturnType<HostProbe["run"]>>();
  return {
    warn: probe.warn,
    run: (tool, args, timeoutMs) => {
      const key = JSON.stringify([tool, args]);
      const known = answers.get(key);
      if (known !== undefined) return known;
      const fresh = probe.run(tool, args, timeoutMs);
      answers.set(key, fresh);
      return fresh;
    },
  };
}

/**
 * Compare each multiplexer's machine list with this crew. A peer and a Windows host get the empty
 * delta without a single spawn.
 */
export async function crewDelta(deps: CrewDeltaDeps): Promise<CrewDelta> {
  if (deps.host.platform === "win32") return NO_DELTA;
  const trust = await deps.store.load();
  if (trust !== null && trust.lead !== null) return NO_DELTA;
  const probe = memoised(candidateProbe(deps, () => {}));
  const sources = muxCandidateSources(probe);
  if (sources.length === 0) return NO_DELTA;
  const roster = await leadRoster(deps, probe);
  const resolve = (target: string): string | null => resolvedSshTarget(target, probe);

  const missing: { source: string; targets: string[] }[] = [];
  const forgotten: { memberId: string; source: string }[] = [];
  for (const source of sources) {
    // One source at a time: a machine two lists name is reported under each, and a member is judged
    // by the list that suggested it.
    const rows = mergeCandidates([source], resolve);
    const targets = offeredCandidates(markCandidates(rows, roster)).map((row) => row.label ?? row.target);
    if (targets.length > 0) missing.push({ source: source.source, targets });
    for (const entry of roster) {
      if (entry.source !== source.source) continue;
      const listed = rows.some((row) => row.key === entry.key || row.names.includes(entry.sshHost));
      if (!listed) forgotten.push({ memberId: entry.memberId, source: source.source });
    }
  }
  return { missing, forgotten };
}

/** The delta as the lines the three verbs print: the missing machines first, then the forgotten members. */
export function deltaLines(delta: CrewDelta): readonly string[] {
  const lines: string[] = [];
  for (const { source, targets } of delta.missing) {
    const one = targets.length === 1;
    lines.push(
      `${source} knows ${targets.length} ${one ? "machine" : "machines"} that ${one ? "is" : "are"} not in this crew: ${targets.join(", ")}. ` +
        `Add ${one ? "it" : "them"} with \`collie crew add\`.`,
    );
  }
  for (const { memberId, source } of delta.forgotten) {
    lines.push(
      `${memberId} is in this crew, but ${source} no longer lists it. Keep it, or drop it with \`collie crew remove ${memberId}\`.`,
    );
  }
  return lines;
}
