import { compareSemver } from "./semver";

// ── IS THERE ANYTHING FOR A CREW RUN TO DO? THE ONE RULE ─────────────────────────────────────────
//
// The phone decides whether to offer "Update crew" or "Retry crew update", and the bridge decides
// whether to accept the peers-only start that button sends (`peersNeedLevelling` in
// `bridge/update-action.ts`). Two answers to one question is how the button came to stay up over a
// crew that was already level, so the question has ONE rule, written on each side because the two
// trees cannot import one another, and pinned by `bridge/crew-level-contract.test.ts`, which runs one
// list of cases through both. The twin of each function below is the function of the same name in
// `bridge/update-action.ts`.
//
// Two parts, and each one closes a way the button used to stay up:
//
//   1. A member is BEHIND when its version is known and is strictly LOWER than the lead's, by semver.
//      "Not equal" counted a member that had levelled itself PAST the lead, and a member ahead of its
//      lead is not one a run can move: there is no downgrade path (`legOf` in `bridge/crew/follow.ts`
//      answers `done` for it).
//   2. A FAILED LEG stops counting once the live census shows that member at or above the lead's
//      version. The legs outlive the run that made them, so a member that rolled back and then
//      levelled itself (the self-follow in `bridge/crew/follow.ts`) kept its failed leg until the
//      next run replaced it. An UNKNOWN version keeps the leg counting: "we could not learn its
//      version" is not "it is level".
//
// Pure, and it imports nothing but `./semver`: not the i18n layer and not even `./types`, whose `@/`
// imports the root typecheck cannot resolve. So the two shapes below are structural, and an
// `UpdateCrewMember` or an `UpdatePeerLeg` fits them as it is.

/** The leg states that are a leg having gone wrong. The bridge's own legs only ever reach the first
 *  two; the other two are what a bridge from before the leg states split sent, and still read as
 *  failed rather than vanishing. */
export const LEG_FAILED: ReadonlySet<string> = new Set(["rolled-back", "unreachable", "stuck", "interrupted"]);

/** What the rule reads of a census row (`UpdateCrewMember`). */
interface Member {
  readonly name: string;
  readonly version: string | null;
  readonly installKind?: string;
}

/** What the rule reads of a peer leg (`UpdatePeerLeg`). */
interface Leg {
  readonly name: string;
  readonly state: string;
}

/**
 * Is this member a version BEHIND the lead? Known, strictly lower by semver, and not packaged.
 *
 * A packaged member is left out for the reason an unknown one is: the operator cannot clear it from
 * here. The tap the count sends them to refuses on that machine (ADR 0035). `current` empty means the
 * lead's own version is not known yet, and nothing is behind an unknown.
 */
export function memberBehind(member: Member, current: string): boolean {
  if (current === "" || member.version === null) return false;
  if (member.installKind === "packaged") return false;
  return compareSemver(levelVersion(member.version), current) < 0;
}

/**
 * The version a DEVELOPMENT build is built on, or null when `reported` is not one: `1.28.0-dev+b178eb6`
 * → `1.28.0`. The twin of `developmentBase` in `bridge/version.ts`, copied because this file imports
 * nothing but `./semver`; split at the `+` exactly as that one does.
 */
export function developmentBase(reported: string): string | null {
  const plus = reported.indexOf("+");
  const core = plus < 0 ? reported : reported.slice(0, plus);
  return core.endsWith(DEV_MARKER) && core.length > DEV_MARKER.length ? core.slice(0, -DEV_MARKER.length) : null;
}

const DEV_MARKER = "-dev";

/**
 * The version a member's report is LEVELLED by: a development build by its base, anything else as it
 * is. A `-dev` build is that release plus later commits, and no run can move it, so it is not behind
 * its own base; one of an OLDER base still is.
 */
function levelVersion(version: string): string {
  return developmentBase(version) ?? version;
}

/**
 * Can the lead hand a member the turn? Not on a development build: it states no release, so a crew
 * run from it waits for the wall clock (2026-11-09). `build` is `update.build`, the build the lead
 * answers the crew with; absent (an older bridge) reads as a release.
 */
export function leadLevelsCrew(build: string | undefined): boolean {
  return build === undefined || developmentBase(build) === null;
}

/**
 * Does this leg still count as a member the last run failed? Only a failed leg can, and it stops the
 * moment the census shows that member at or above the lead's version.
 */
export function legStillFailed(leg: Leg, crew: readonly Member[], current: string): boolean {
  if (!LEG_FAILED.has(leg.state)) return false;
  const member = crew.find((candidate) => candidate.name === leg.name);
  // A PACKAGED MEMBER IS NEVER A REASON TO OFFER A RUN, and its leg is no exception (ADR 0035). A
  // packaged member that has gone quiet reads `unreachable`, not `package-managed`
  // (`legOf` in `bridge/crew/follow.ts`, pinned there) — so a laptop that sleeps overnight would
  // otherwise leave a failed leg nothing can clear, and the button would stand over a machine the
  // phone cannot move. That is the bug this whole rule closes, left open for one member type.
  if (member?.installKind === "packaged") return false;
  if (current === "") return true;
  const version = member?.version ?? null;
  if (version === null) return true;
  return compareSemver(levelVersion(version), current) < 0;
}

/**
 * Is there anything for a peers-only run to do? Never from a lead on a development build. The twin of
 * `crewNeedsLevelling` on the bridge.
 */
export function crewNeedsLevelling(a: {
  readonly crew: readonly Member[];
  readonly legs: readonly Leg[];
  readonly current: string;
  readonly build?: string;
}): boolean {
  if (!leadLevelsCrew(a.build)) return false;
  return (
    a.crew.some((member) => memberBehind(member, a.current)) ||
    a.legs.some((leg) => legStillFailed(leg, a.crew, a.current))
  );
}
