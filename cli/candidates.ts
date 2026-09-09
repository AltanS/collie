// THE CANDIDATE LIST `collie crew add` OFFERS WHEN IT IS GIVEN NO TARGET (M22/07).
//
// Two lists already exist on the operator's machine and neither is a multiplexer's business: the
// `Host` entries in `~/.ssh/config` (`./ssh-config.ts`) and a machine-linking multiplexer's own
// saved targets (`bridge/mux/host-candidates.ts`, ADR 0036 (c)). This module merges them, marks the
// ones this lead already leads, and renders the rows. It decides nothing else: the operator picks,
// and `crew add` then runs unchanged from that point, confirm included.
//
// ── ONE MACHINE IS ONE ROW, AND THE KEY IS THE RESOLVED TARGET ───────────────
// The two sources will name the same machine twice. `~/.ssh/config` calls it `attic`; the
// multiplexer's saved profile calls it `op@attic.lan:22`. Two rows for one machine is a WORSE list
// than no list, because the operator cannot tell whether they own one machine or two. So the merge
// key is what `ssh -G` reports — the user, the host and the port — asked of ssh itself rather than
// re-derived here, because `~/.ssh/config` is ssh's file and its resolution rules (`Match`,
// `Include`, `CanonicalizeHostname`, a per-host `User`) are ssh's to apply.
//
// **`ssh -G` NEVER CONNECTS.** It prints the configuration that WOULD be used and exits; no socket
// is opened, no `ProxyCommand` runs, no key is offered, no host key is checked. That is what makes
// it safe to run over every alias in a config file the moment the operator types `collie crew add`.
// It runs behind the injected `HostProbe` seam under one shared budget
// ({@link CANDIDATE_TIMEOUT_MS}), so a hung resolution cannot hang the picker and no test spawns it.
//
// **Resolution is best-effort, and its absence degrades to today.** A machine with no ssh binary, or
// a config ssh refuses to read, yields no resolved target — and then the alias AS TYPED is the key.
// Two aliases are never assumed to be one machine on a guess.
//
// ── THE MARK IS A HINT, NEVER A VERDICT ──────────────────────────────────────
// A row carrying a member id says "this lead already has it". It does NOT decide anything: the
// refusals in `cli/remote.ts` ask the FAR machine what crew it is in, and `cli/crew.ts` refuses a
// second join on the joining machine. The lead's own roster cannot know that a machine joined some
// other crew behind its back. So the mark saves the operator a refused run and replaces neither
// refusal.

import type { HostCandidate, HostProbe } from "../bridge/mux/host-candidates.ts";
import { CANDIDATE_TIMEOUT_MS } from "../bridge/mux/host-candidates.ts";

export { CANDIDATE_TIMEOUT_MS };

/** How the ssh-config provider names itself on a row. Not a multiplexer, so not a registry name. */
export const SSH_CONFIG_SOURCE = "ssh config";

/** One provider's answer, tagged with the source that will appear on the row. */
export interface SourcedCandidates {
  readonly source: string;
  readonly candidates: readonly HostCandidate[];
}

/** One member of this lead's own crew, as the roster join sees it (`bridge/crew/ops-store.ts`). */
export interface RosterEntry {
  readonly memberId: string;
  /** The ssh destination the lead recorded for it, as the operator typed it. */
  readonly sshHost: string;
  /** That destination resolved, or the destination itself when resolution was unavailable. */
  readonly key: string;
}

/** One machine, after the merge. */
export interface CandidateRow {
  /** What `crew add` is handed when this row is picked — the first source's spelling. */
  readonly target: string;
  /** Every spelling a source gave this machine, in source order, deduplicated. */
  readonly names: readonly string[];
  /** Which sources named it: `ssh config`, a multiplexer's name, or both. */
  readonly sources: readonly string[];
  /** The merge key — the resolved ssh target, or the target as typed. Not shown to the operator. */
  readonly key: string;
  /** A human name a source carried, or `null`. */
  readonly label: string | null;
  /** This lead's own member id for the machine, or `null`. A hint; see this module's header. */
  readonly memberId: string | null;
}

/**
 * `ssh -G <target>` and nothing else, under the shared budget.
 *
 * `null` on every unhappy answer — no ssh, a non-zero exit, a timeout, output without a hostname.
 * The caller treats that as "unresolved" and falls back to the alias, which is why this never
 * distinguishes the causes: they all mean the same thing to a merge key.
 */
export function resolvedSshTarget(target: string, probe: HostProbe): string | null {
  const asked = probe.run("ssh", sshResolveArgs(target), CANDIDATE_TIMEOUT_MS);
  if (!asked.found || asked.code !== 0) return null;
  return parseResolvedSshTarget(asked.stdout);
}

/**
 * The argv for a resolution, from a target in any of the three spellings a source may use:
 * `host`, `user@host`, `user@host:port`.
 *
 * The port leaves the destination and becomes `-p`, because `ssh` has never accepted `host:port` as
 * a destination and would resolve `attic.lan:22` as a hostname of that name.
 */
export function sshResolveArgs(target: string): readonly string[] {
  const { user, host, port } = splitSshTarget(target);
  const destination = user === null ? host : `${user}@${host}`;
  return port === null ? ["-G", destination] : ["-G", "-p", port, destination];
}

/** A target's three parts, none of them judged. */
export interface SshTargetParts {
  readonly user: string | null;
  readonly host: string;
  readonly port: string | null;
}

/** `[user@]host[:port]`, split without judging any of the three parts. */
export function splitSshTarget(target: string): SshTargetParts {
  const at = target.lastIndexOf("@");
  const user = at === -1 ? null : target.slice(0, at);
  const rest = at === -1 ? target : target.slice(at + 1);
  // `[fd00::1]:22` — the bracketed form is the only way a port may follow an IPv6 literal, and it
  // is checked first so the literal's own colons are never read as one.
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/u.exec(rest);
  if (bracketed !== null) return { user, host: bracketed[1]!, port: bracketed[2] ?? null };
  // Otherwise a trailing `:<digits>` is a port only when there is exactly one colon. A bare IPv6
  // literal is full of them and carries no port, so `fd00::1` stays a host.
  const colon = /^([^:]+):(\d+)$/u.exec(rest);
  if (colon === null) return { user, host: rest, port: null };
  return { user, host: colon[1]!, port: colon[2]! };
}

/**
 * `ssh -G`'s output as one comparable string, `user@hostname:port`, or `null` without a hostname.
 *
 * ssh prints one lowercase keyword per line with its resolved value. Only three of them decide
 * whether two aliases are the same machine, so only three are read; the first occurrence wins,
 * which is ssh's own precedence.
 */
export function parseResolvedSshTarget(stdout: string): string | null {
  const seen = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^(user|hostname|port)\s+(\S+)/u.exec(line.trim());
    if (match === null || seen.has(match[1]!)) continue;
    seen.set(match[1]!, match[2]!);
  }
  const hostname = seen.get("hostname");
  if (hostname === undefined || hostname === "") return null;
  return `${seen.get("user") ?? ""}@${hostname}:${seen.get("port") ?? ""}`;
}

/**
 * Merge every provider's candidates into one row per machine, in first-seen order.
 *
 * `resolve` is called at most once per distinct target, so the number of `ssh -G` calls is the
 * number of names the operator actually has, never the number of sources times that.
 */
export function mergeCandidates(
  sources: readonly SourcedCandidates[],
  resolve: (target: string) => string | null,
): readonly CandidateRow[] {
  const resolved = new Map<string, string>();
  const rows = new Map<string, CandidateRow>();
  for (const { source, candidates } of sources) {
    for (const candidate of candidates) {
      const target = candidate.target;
      if (!resolved.has(target)) resolved.set(target, resolve(target) ?? target);
      const key = resolved.get(target)!;
      const existing = rows.get(key);
      if (existing === undefined) {
        rows.set(key, {
          target,
          names: [target],
          sources: [source],
          key,
          label: candidate.label,
          memberId: null,
        });
        continue;
      }
      // The FIRST source's spelling stays the target — `ssh config` is listed first, so the name the
      // operator maintains by hand is the one `crew add` is handed and the one the row leads with.
      rows.set(key, {
        ...existing,
        names: existing.names.includes(target) ? existing.names : [...existing.names, target],
        sources: existing.sources.includes(source) ? existing.sources : [...existing.sources, source],
        label: existing.label ?? candidate.label,
      });
    }
  }
  return [...rows.values()];
}

/**
 * Stamp each row this lead already leads with its member id.
 *
 * The join is on the merge key first — both sides went through the same resolution, so an alias in
 * the config and the destination the lead recorded meet there — and on the recorded destination
 * verbatim second, which is what answers when nothing could be resolved.
 */
export function markCandidates(
  rows: readonly CandidateRow[],
  roster: readonly RosterEntry[],
): readonly CandidateRow[] {
  return rows.map((row) => {
    const member = roster.find((entry) => entry.key === row.key || row.names.includes(entry.sshHost));
    return member === undefined ? row : { ...row, memberId: member.memberId };
  });
}

/** A row the operator may pick: one this lead does not already lead. */
export function offeredCandidates(rows: readonly CandidateRow[]): readonly CandidateRow[] {
  return rows.filter((row) => row.memberId === null);
}

/**
 * The list, as lines.
 *
 * A numbered row is one that can be picked. An already-enrolled row keeps its place and loses its
 * number: it is shown so the operator can see the machine is accounted for, and not offered because
 * picking it would only earn the far machine's own refusal.
 *
 * The source tag and the member-id mark are SEPARATE columns, deliberately. "Where this name came
 * from" and "this lead already has it" are different facts, and a row that ran them together would
 * read as though a multiplexer's machine list and the crew were linked. They are not
 * (`docs/crew.md`).
 */
export function renderCandidateList(rows: readonly CandidateRow[]): readonly string[] {
  const offered = offeredCandidates(rows);
  const numbers = new Map(offered.map((row, index) => [row.key, String(index + 1)]));
  const width = Math.max(...rows.map((row) => row.target.length), 1);
  const lines = ["Candidate hosts on this machine:", ""];
  for (const row of rows) {
    const number = numbers.get(row.key);
    const columns = [row.sources.join(", ")];
    const others = row.names.filter((name) => name !== row.target);
    if (others.length > 0) columns.push(`also ${others.join(", ")}`);
    if (row.memberId !== null) columns.push(`already enrolled as "${row.memberId}"`);
    const gutter = number === undefined ? "   " : `${number.padStart(2, " ")} `;
    lines.push(`  ${gutter} ${row.target.padEnd(width)}  ${columns.join("  ")}`.trimEnd());
  }
  lines.push("");
  return lines;
}

/** The question. One line, so the plain path's `prompt` fits on a terminal row. */
export const CANDIDATE_QUESTION = "Which host? (a number, a name, or blank to stop) ";

/**
 * Read the operator's answer as a target, or `null` when it names nothing on the list.
 *
 * A number picks an offered row. Anything else is matched against every name on every row — the
 * enrolled ones included, because typing a name is the operator's own decision and the existing
 * refusals are what answer it. An answer that matches nothing is refused rather than guessed at.
 */
export function pickCandidate(rows: readonly CandidateRow[], answer: string): string | null {
  const trimmed = answer.trim();
  if (trimmed === "") return null;
  if (/^\d+$/u.test(trimmed)) {
    const offered = offeredCandidates(rows);
    return offered[Number(trimmed) - 1]?.target ?? null;
  }
  const named = rows.find((row) => row.names.includes(trimmed));
  return named === undefined ? null : named.target;
}
