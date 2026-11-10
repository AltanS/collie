import { describe, expect, test } from "bun:test";

import { compareSemver } from "./update.ts";
import { crewNeedsLevelling, leadLevelsCrew, legStillFailed, memberBehind, type CrewUpdateRow } from "./update-action.ts";
import { developmentBase } from "./version.ts";
import { compareSemver as phoneCompareSemver } from "../web/src/lib/semver.ts";
import {
  crewNeedsLevelling as phoneCrewNeedsLevelling,
  developmentBase as phoneDevelopmentBase,
  leadLevelsCrew as phoneLeadLevelsCrew,
  legStillFailed as phoneLegStillFailed,
  memberBehind as phoneMemberBehind,
} from "../web/src/lib/crew-level.ts";

// ONE RULE FOR "IS THERE ANYTHING FOR A CREW RUN TO DO?", WRITTEN TWICE.
//
// The phone decides whether to offer "Update crew" / "Retry crew update" (`web/src/lib/crew-level.ts`)
// and this bridge decides whether to accept the peers-only start the button sends
// (`bridge/update-action.ts`). The trees cannot import one another, so each side has its own copy and
// its own tests, and either could change alone and stay green. This file is the one that does not:
// it imports across the boundary on purpose, as `auth-path-contract.test.ts` does, and runs ONE list
// of cases through both copies. Both web modules are pure and import nothing but types.

const LEAD = "1.9.1";

const member = (name: string, version: string | null, over: Partial<CrewUpdateRow> = {}): CrewUpdateRow => ({
  name,
  version,
  verdict: "green",
  reasons: [],
  asOf: 1,
  ...over,
});

describe("the version order is the same on both sides", () => {
  const PAIRS: readonly [string, string][] = [
    ["1.9.1", "1.9.0"],
    ["1.9.0", "1.9.0"],
    ["1.10.0", "1.9.9"],
    ["2.0.0", "1.99.99"],
    ["1.0.0-beta.9", "1.0.0-beta.10"],
    ["1.0.0-rc.1", "1.0.0"],
    ["1.0.0-beta", "1.0.0-beta.1"],
    ["1.0.0-1", "1.0.0-alpha"],
    ["1.0.0+ab12cd3", "1.0.0"],
    ["unknown", "1.0.0"],
  ];
  for (const [a, b] of PAIRS) {
    test(`${a} vs ${b}`, () => {
      expect(phoneCompareSemver(a, b)).toBe(compareSemver(a, b));
      expect(phoneCompareSemver(b, a)).toBe(compareSemver(b, a));
    });
  }
});

describe("memberBehind: strictly lower by semver, known, and not packaged", () => {
  const CASES: readonly { case: string; member: CrewUpdateRow; behind: boolean }[] = [
    { case: "a member a release back", member: member("minibuch", "1.9.0"), behind: true },
    { case: "a member on the lead's own version", member: member("minibuch", LEAD), behind: false },
    { case: "a member that levelled itself PAST the lead", member: member("minibuch", "1.10.0"), behind: false },
    { case: "a member whose version nobody could learn", member: member("minibuch", null), behind: false },
    {
      case: "a packaged member a release back",
      member: member("minibuch", "1.9.0", { installKind: "packaged" }),
      behind: false,
    },
    { case: "a member on a prerelease of the lead's version", member: member("minibuch", "1.9.1-rc.1"), behind: true },
    // A DEVELOPMENT BUILD IS LEVELLED BY ITS BASE (2026-11-09): the lead's own release plus commits.
    { case: "a development build of the lead's version", member: member("minibuch", "1.9.1-dev+b178eb63f2"), behind: false },
    { case: "a development build with no sha", member: member("minibuch", "1.9.1-dev"), behind: false },
    { case: "a development build of an OLDER version", member: member("minibuch", "1.9.0-dev+b178eb63f2"), behind: true },
    { case: "a development build of a NEWER version", member: member("minibuch", "1.10.0-dev+b178eb63f2"), behind: false },
    {
      case: "a development build of an older Edge build",
      member: member("minibuch", "1.9.1-edge.1-dev+b178eb63f2"),
      behind: true,
    },
  ];
  for (const c of CASES) {
    test(c.case, () => {
      expect(memberBehind(c.member, LEAD)).toBe(c.behind);
      expect(phoneMemberBehind(c.member, LEAD)).toBe(c.behind);
    });
  }
});

describe("legStillFailed: a failed leg counts until the census shows its member level", () => {
  const CASES: readonly {
    case: string;
    leg: { name: string; state: string };
    crew: CrewUpdateRow[];
    counts: boolean;
  }[] = [
    {
      case: "a rolled-back leg whose member is still behind",
      leg: { name: "minibuch", state: "rolled-back" },
      crew: [member("minibuch", "1.9.0")],
      counts: true,
    },
    {
      case: "a STALE rolled-back leg whose member has since levelled itself",
      leg: { name: "minibuch", state: "rolled-back" },
      crew: [member("minibuch", LEAD)],
      counts: false,
    },
    {
      case: "a stale unreachable leg whose member is now ahead of the lead",
      leg: { name: "minibuch", state: "unreachable" },
      crew: [member("minibuch", "1.10.0")],
      counts: false,
    },
    {
      case: "a failed leg whose member's version is UNKNOWN",
      leg: { name: "minibuch", state: "rolled-back" },
      crew: [member("minibuch", null)],
      counts: true,
    },
    {
      case: "a failed leg with no census row at all",
      leg: { name: "attic", state: "unreachable" },
      crew: [member("minibuch", LEAD)],
      counts: true,
    },
    {
      case: "a leg from an older bridge that ended stuck",
      leg: { name: "minibuch", state: "stuck" },
      crew: [member("minibuch", "1.9.0")],
      counts: true,
    },
    {
      // A packaged member that has gone quiet reads `unreachable`, not `package-managed` (`legOf`,
      // crew/follow.ts), and nothing the phone can start would ever clear it. A sleeping laptop must
      // not leave "Retry crew update" standing for good.
      case: "a failed leg on a PACKAGED member, whose version no run from here can move",
      leg: { name: "minibuch", state: "unreachable" },
      crew: [member("minibuch", "1.9.0", { installKind: "packaged" })],
      counts: false,
    },
    {
      case: "an unreachable leg whose member runs a development build of the lead's version",
      leg: { name: "minibuch", state: "unreachable" },
      crew: [member("minibuch", "1.9.1-dev+b178eb63f2")],
      counts: false,
    },
    {
      case: "an unreachable leg whose member runs a development build of an older version",
      leg: { name: "minibuch", state: "unreachable" },
      crew: [member("minibuch", "1.9.0-dev+b178eb63f2")],
      counts: true,
    },
    {
      case: "a leg that arrived is not a failed leg",
      leg: { name: "minibuch", state: "done" },
      crew: [member("minibuch", "1.9.0")],
      counts: false,
    },
  ];
  for (const c of CASES) {
    test(c.case, () => {
      expect(legStillFailed(c.leg, c.crew, LEAD)).toBe(c.counts);
      expect(phoneLegStillFailed(c.leg, c.crew, LEAD)).toBe(c.counts);
    });
  }
});

describe("crewNeedsLevelling: the button and the route agree on the whole crew", () => {
  const CASES: readonly {
    case: string;
    crew: CrewUpdateRow[];
    legs: { name: string; state: string }[];
    build?: string;
    needs: boolean;
  }[] = [
    { case: "every member on the lead's version", crew: [member("a", LEAD), member("b", LEAD)], legs: [], needs: false },
    { case: "one member ahead, one level", crew: [member("a", "1.10.0"), member("b", LEAD)], legs: [], needs: false },
    { case: "one member behind", crew: [member("a", "1.9.0"), member("b", LEAD)], legs: [], needs: true },
    {
      case: "the last run's failed leg, since levelled",
      crew: [member("a", LEAD)],
      legs: [{ name: "a", state: "rolled-back" }],
      needs: false,
    },
    {
      case: "the last run's failed leg, version unknown",
      crew: [member("a", null)],
      legs: [{ name: "a", state: "rolled-back" }],
      needs: true,
    },
    {
      case: "a release lead over a member a release back",
      crew: [member("a", "1.9.0")],
      legs: [],
      build: `${LEAD}+047ee5bbd0`,
      needs: true,
    },
    {
      case: "an Edge lead over a member a release back",
      crew: [member("a", "1.9.0")],
      legs: [],
      build: `${LEAD}-edge.2+047ee5bbd0`,
      needs: true,
    },
    {
      // A DEVELOPMENT-BUILD LEAD STATES NO RELEASE, so no member takes a turn from it (2026-11-09).
      case: "a development-build lead over a member a release back offers no run",
      crew: [member("a", "1.9.0")],
      legs: [{ name: "a", state: "unreachable" }],
      build: `${LEAD}-dev+047ee5bbd0`,
      needs: false,
    },
    {
      case: "the live dev lane: a development lead, dev members, three unreachable legs",
      crew: [member("a", `${LEAD}-dev+b178eb63f2`), member("b", `${LEAD}-dev+047ee5bbd0`), member("c", `${LEAD}-dev+b178eb63f2`)],
      legs: [
        { name: "a", state: "unreachable" },
        { name: "b", state: "unreachable" },
        { name: "c", state: "unreachable" },
      ],
      build: `${LEAD}-dev+047ee5bbd0`,
      needs: false,
    },
  ];
  for (const c of CASES) {
    test(c.case, () => {
      const a = { crew: c.crew, legs: c.legs, current: LEAD, build: c.build };
      expect(crewNeedsLevelling(a)).toBe(c.needs);
      expect(phoneCrewNeedsLevelling(a)).toBe(c.needs);
    });
  }
});

describe("a development build is read the same way on both sides", () => {
  const STAMPS: readonly string[] = [
    "1.28.0-dev+047ee5bbd0",
    "1.28.0-dev",
    "1.28.0-edge.4-dev+9ef26fb6e",
    "1.28.0",
    "1.28.0+b178eb63f2",
    "1.28.0-edge.4+9ef26fb6e",
    "1.28.0+dev",
    "-dev",
    "unknown",
  ];
  for (const stamp of STAMPS) {
    test(stamp, () => {
      expect(phoneDevelopmentBase(stamp)).toBe(developmentBase(stamp));
      expect(phoneLeadLevelsCrew(stamp)).toBe(leadLevelsCrew(stamp));
    });
  }
  test("no build reported reads as a lead that levels", () => {
    expect(leadLevelsCrew(undefined)).toBe(true);
    expect(phoneLeadLevelsCrew(undefined)).toBe(true);
  });
});
