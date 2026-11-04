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

/**
 * One member of this lead's own crew, as the roster join sees it.
 *
 * Every trust-store peer is one, whether or not `crew add` left an ops record for it
 * (`bridge/crew/ops-store.ts`): a member joined by hand, or one whose run was finished by hand, has
 * none, and it is still in the crew.
 */
export interface RosterEntry {
  readonly memberId: string;
  /** The ssh destination the lead recorded for it, as the operator typed it; `null` without an ops record. */
  readonly sshHost: string | null;
  /** That destination resolved, or the destination itself when resolution was unavailable; `null` without one. */
  readonly key: string | null;
  /**
   * The host part of the address the trust store dials it at (`host:port`, port dropped, IPv6
   * brackets dropped); `null` or absent when there is none. Read from the store, never resolved.
   */
  readonly addressHost?: string | null;
  /** Which multiplexer's list suggested it when `crew add` enrolled it (`OpsRecord.source`); `null` or absent when none. */
  readonly source?: string | null;
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
  /**
   * Member ids that MAY be this machine: they matched only on the host of their trust-store address
   * or on the member id read as a name, never on the route `crew add` recorded. Empty when none did,
   * and always empty when {@link CandidateRow.memberId} is set. A weak match never hides a row: it
   * stays numbered and pickable, because the row carries no certificate to prove the match, and a
   * wrong "already in this crew" would keep a real machine off the phone.
   */
  readonly maybeMemberIds: readonly string[];
  /**
   * Why this machine cannot be added, or `null`. Set only when EVERY source that named it blocked
   * it: a source that proves a way in (an ssh config `Host`) clears the block. A blocked row is shown
   * with its reason, has no number, and is never picked.
   */
  readonly blocked: string | null;
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
  // `--` ends ssh's options, so a destination that begins with `-` is a host name to ssh and never a flag.
  return port === null ? ["-G", "--", destination] : ["-G", "-p", port, "--", destination];
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
          maybeMemberIds: [],
          blocked: candidate.blocked,
        });
        continue;
      }
      // A block holds only while every source agrees on it. When a later source clears it, the row
      // adopts that source's spelling too: the blocked spelling is the one that cannot be dialled.
      const cleared = existing.blocked !== null && candidate.blocked === null;
      // The FIRST source's spelling stays the target — `ssh config` is listed first, so the name the
      // operator maintains by hand is the one `crew add` is handed and the one the row leads with.
      rows.set(key, {
        ...existing,
        target: cleared ? target : existing.target,
        names: existing.names.includes(target) ? existing.names : [...existing.names, target],
        sources: existing.sources.includes(source) ? existing.sources : [...existing.sources, source],
        label: existing.label ?? candidate.label,
        blocked: existing.blocked === null || candidate.blocked === null ? null : existing.blocked,
      });
    }
  }
  return [...rows.values()];
}

/**
 * The `user@host` (and `:port` when it is not 22) that `ssh` will dial for this row, for the confirm.
 *
 * Read off the merge key, which is `ssh -G`'s answer, so an alias in the operator's config shows the
 * machine it really leads to, and a name that maps to an address the operator did not expect is
 * visible before anything is written there. When ssh could not resolve it, the target as given.
 */
export function dialedTarget(row: CandidateRow): string {
  const match = /^([^@]*)@(.+):(\d*)$/u.exec(row.key);
  if (match === null || match[2] === "") return row.target;
  const user = match[1] === "" ? "" : `${match[1]}@`;
  const port = match[3] === "" || match[3] === "22" ? "" : `:${match[3]}`;
  return `${user}${match[2]}${port}`;
}

/**
 * The hostname inside a merge key, lowercased, or `null` when the key is not a resolved one.
 *
 * A resolved key is `user@hostname:port` ({@link parseResolvedSshTarget}); the port is the last
 * colon's digits, so an IPv6 hostname keeps its own colons.
 */
function keyHostname(key: string): string | null {
  const match = /^[^@]*@(.+):\d*$/u.exec(key);
  return match === null ? null : match[1]!.toLowerCase();
}

/** Every host a row can be reached at: the resolved hostname, and the host part of each spelling. */
function rowHosts(row: CandidateRow): ReadonlySet<string> {
  const hosts = new Set(row.names.map((name) => splitSshTarget(name).host.toLowerCase()));
  const resolved = keyHostname(row.key);
  if (resolved !== null) hosts.add(resolved);
  return hosts;
}

/** The recorded ssh route: the merge key, or the recorded destination verbatim. */
function matchesRoute(entry: RosterEntry, row: CandidateRow): boolean {
  if (entry.key !== null && entry.key === row.key) return true;
  return entry.sshHost !== null && row.names.includes(entry.sshHost);
}

/** The host of the address the trust store dials, against every host the row can be reached at. */
function matchesAddress(entry: RosterEntry, hosts: ReadonlySet<string>): boolean {
  const host = entry.addressHost?.toLowerCase() ?? "";
  return host !== "" && hosts.has(host);
}

/** The member id, case-insensitively, against the row's label and the host part of its spellings. */
function matchesMemberId(entry: RosterEntry, row: CandidateRow, hosts: ReadonlySet<string>): boolean {
  const id = entry.memberId.toLowerCase();
  return row.label?.toLowerCase() === id || hosts.has(id);
}

/**
 * Stamp each row with the member this lead already has for it.
 *
 * ONE key is strong enough to say "this machine is in the crew": the recorded ssh route, which is
 * the merge key (both sides went through the same resolution, so an alias in the config and the
 * destination the lead recorded meet there), or the recorded destination verbatim, which is what
 * answers when nothing could be resolved. `crew add` wrote it after it reached the machine.
 *
 * Two keys are WEAK and never mark a row: the host of the address the trust store dials, against the
 * row's resolved hostname and the host part of each spelling (what a member joined by hand still
 * has), and the member id, case-insensitively, against the row's label and those same host parts.
 * Neither proves the row is the pinned machine: two peers can share an address host on different
 * ports, and a member id is a name a person chose and can be reused for another box. The row has no
 * certificate to compare with the pin, and this module dials nothing, so a weak match is listed on
 * {@link CandidateRow.maybeMemberIds} and nothing more.
 */
export function markCandidates(
  rows: readonly CandidateRow[],
  roster: readonly RosterEntry[],
): readonly CandidateRow[] {
  return rows.map((row) => {
    const route = roster.find((entry) => matchesRoute(entry, row));
    if (route !== undefined) return { ...row, memberId: route.memberId, maybeMemberIds: [] };
    const hosts = rowHosts(row);
    const maybe = roster
      .filter((entry) => matchesAddress(entry, hosts) || matchesMemberId(entry, row, hosts))
      .map((entry) => entry.memberId);
    return maybe.length === 0 ? row : { ...row, maybeMemberIds: maybe };
  });
}

/** Is the row accounted for by a member, strongly or by a weak match? What the delta lines read. */
export function coveredByMember(row: CandidateRow): boolean {
  return row.memberId !== null || row.maybeMemberIds.length > 0;
}

/** A row the operator may pick: one this lead does not already lead and no source blocked. */
export function offeredCandidates(rows: readonly CandidateRow[]): readonly CandidateRow[] {
  return rows.filter((row) => row.memberId === null && row.blocked === null);
}

/**
 * The offered rows no member may account for: what `all` takes and what the delta names. A row with
 * a weak match is still offered by number and by name, but it is not swept in by `all`, because
 * re-adding a hand-joined member to every run would ask one confirm for each of them.
 */
export function unclaimedCandidates(rows: readonly CandidateRow[]): readonly CandidateRow[] {
  return offeredCandidates(rows).filter((row) => row.maybeMemberIds.length === 0);
}

/**
 * The list, as lines.
 *
 * A numbered row is one that can be picked. A blocked row keeps its place, loses its number and ends
 * with the reason. An already-enrolled row keeps its place and loses its number: it is shown so the operator can see the machine is accounted for, and not offered because
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
    if (row.maybeMemberIds.length > 0) columns.push(`may be enrolled as ${row.maybeMemberIds.map((id) => `"${id}"`).join(", ")}`);
    if (row.blocked !== null) columns.push(`cannot be added: ${row.blocked}`);
    const gutter = number === undefined ? "   " : `${number.padStart(2, " ")} `;
    lines.push(`  ${gutter} ${row.target.padEnd(width)}  ${columns.join("  ")}`.trimEnd());
  }
  lines.push("");
  return lines;
}

// ── NAMES FROM ANOTHER PROGRAM'S JSON ARE NOT TRUSTED ────────────────────────
// A multiplexer's machine list is another program's output. Its `target` ends up in an `ssh` argv
// and its name on the operator's terminal, so a value that could be read as an ssh option, split
// into two words, run by a shell or repaint the terminal never becomes a row. It is refused with
// one line and the rest of the list stays. Every `ssh` Collie starts also puts `--` before the
// destination (`cli/remote.ts`, {@link sshResolveArgs}), so a name that slipped past this check is
// still a host name and never a flag.

/** A control character in any script: C0, DEL and C1. These repaint or escape a terminal. */
const CONTROL = /\p{Cc}/u;
/** Whitespace of any script: it would split one destination into two words. */
const SPACE = /\s/u;
/** What a shell reads as syntax. `[` and `]` stay: an IPv6 literal is written `[fd00::1]:22`. */
const SHELL_SYNTAX = /[;&|$`<>(){}*?!#"'\\~]/u;

/**
 * Why this value cannot be an ssh destination, or `null` when it can. Judges the three parts of
 * `[user@]host[:port]` and refuses a part that begins with `-`.
 */
export function hostRefusal(target: string): string | null {
  if (target === "") return "it is empty";
  if (CONTROL.test(target)) return "it holds a control character";
  if (SPACE.test(target)) return "it holds whitespace";
  if (SHELL_SYNTAX.test(target)) return "it holds a character a shell reads as syntax";
  if (target.startsWith("-")) return "it begins with a dash, so ssh would read it as an option";
  const { user, host } = splitSshTarget(target);
  if (host === "") return "it names no host";
  if (host.startsWith("-") || (user !== null && user.startsWith("-"))) {
    return "a part of it begins with a dash, so ssh would read it as an option";
  }
  return null;
}

/** A value for a message: control characters shown as `\xNN`, never sent to the terminal as bytes. */
function visible(value: string): string {
  return value.replaceAll(/\p{Cc}/gu, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * The candidates one source gave, minus the ones that must never reach an ssh argv or a terminal.
 *
 * A blocked row is never dialled, and its target may be a COMMAND (the core's `--via`), so only the
 * control-character rule applies to it. `noun` is the words the refusal line uses for a name from
 * this source, `warn` receives each refusal.
 */
export function screenCandidates(
  noun: string,
  candidates: readonly HostCandidate[],
  warn: (line: string) => void,
): readonly HostCandidate[] {
  const kept: HostCandidate[] = [];
  for (const candidate of candidates) {
    const unfit =
      candidate.blocked !== null
        ? CONTROL.test(candidate.target)
        : hostRefusal(candidate.target) !== null;
    const label = candidate.label !== null && CONTROL.test(candidate.label);
    if (unfit || label) {
      warn(`refused: ${noun} "${visible(label ? candidate.label! : candidate.target)}" is not a valid host`);
      continue;
    }
    kept.push(candidate);
  }
  return kept;
}

/** The question. One line, so the plain path's `prompt` fits on a terminal row. */
export const CANDIDATE_QUESTION = "Which hosts? (numbers or names, `all`, or blank to stop) ";

/** The tokens of an answer: split on spaces and commas, empty pieces dropped. */
function answerTokens(answer: string): readonly string[] {
  return answer.split(/[\s,]+/u).filter((token) => token !== "");
}

/**
 * The row one token names, or `null` when it names none.
 *
 * A number picks an offered row. Anything else is matched against every name on every row — the
 * enrolled ones included, because typing a name is the operator's own decision and the existing
 * refusals are what answer it. A blocked row's name names nothing: no source can reach it.
 */
function rowOfToken(rows: readonly CandidateRow[], token: string): CandidateRow | null {
  if (/^\d+$/u.test(token)) return offeredCandidates(rows)[Number(token) - 1] ?? null;
  const named = rows.find((row) => row.names.includes(token));
  return named === undefined || named.blocked !== null ? null : named;
}

/**
 * Read the operator's answer as a list of rows, or `null` when any part of it names nothing.
 *
 * Tokens split on spaces and commas. A token is an offered row's number or any name on any row, and
 * `all` is every offered row. A row named twice is picked once, in the order it was first named.
 * **One unknown token refuses the WHOLE answer**: a partial pick would add machines the operator did
 * not read back, and the one that failed would be easy to miss in a long line. A blank answer names
 * nothing and is `null` too; the caller handles blank before it asks.
 */
export function pickCandidates(rows: readonly CandidateRow[], answer: string): readonly CandidateRow[] | null {
  const tokens = answerTokens(answer);
  if (tokens.length === 0) return null;
  const picked = new Map<string, CandidateRow>();
  for (const token of tokens) {
    const chosen = token === "all" ? unclaimedCandidates(rows) : [rowOfToken(rows, token)];
    for (const row of chosen) {
      if (row === null) return null;
      if (!picked.has(row.key)) picked.set(row.key, row);
    }
  }
  return picked.size === 0 ? null : [...picked.values()];
}

/**
 * The first token of a refused answer, and the reason when it is a blocked row's name. `null` when
 * the answer is not refused. The caller prints it instead of the generic "not one of the candidates"
 * line, so a greyed row's name does not read as a typo and a long answer says WHICH token failed.
 */
export function refusedToken(
  rows: readonly CandidateRow[],
  answer: string,
): { readonly token: string; readonly blocked: string | null } | null {
  for (const token of answerTokens(answer)) {
    if (token === "all" || rowOfToken(rows, token) !== null) continue;
    return { token, blocked: blockedReason(rows, token) };
  }
  return null;
}

/** The reason a typed name is refused, or `null` when the name is not a blocked row's. */
export function blockedReason(rows: readonly CandidateRow[], answer: string): string | null {
  const trimmed = answer.trim();
  return rows.find((row) => row.blocked !== null && row.names.includes(trimmed))?.blocked ?? null;
}
